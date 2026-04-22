const crypto = require('crypto');
const pool = require('./pool');
const {
  validateCreatorVpa,
  createRazorpayXPayout,
  normalizePayoutStatus,
  isRazorpayXValidationConfigured,
  isRazorpayXPayoutConfigured,
} = require('../payments/razorpay');
const RINGING_TIMEOUT_SECONDS = 35;
const TERMINAL_REASON_HINTS = new Set(['remote_left', 'network_drop_timeout']);
const BASIC_UPI_REGEX = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z0-9.-]{2,64}$/;
const ACTIVE_PAYOUT_REQUEST_STATUSES = new Set(['open', 'processing']);
const FAILED_PROVIDER_STATUSES = new Set(['failed', 'rejected', 'reversed']);
const ACTIVE_CALL_STATUSES = ['ringing', 'connected'];
const CREATOR_FREE_ALERT_TTL_HOURS = 1;

const parseMoney = (value) => {
  const amount = parseFloat(value);
  return Number.isFinite(amount) ? amount : 0;
};

const providerStatusCountsAsReserved = (status, paidAt) => {
  const normalized = String(status || '').trim().toLowerCase();
  if (paidAt && !FAILED_PROVIDER_STATUSES.has(normalized || 'processed')) {
    return true;
  }
  if (!normalized) {
    return false;
  }
  return !FAILED_PROVIDER_STATUSES.has(normalized);
};

const getUniqueInts = (values = []) => [...new Set(
  values
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0)
)];

const isPgUniqueViolation = (error, constraint) =>
  error?.code === '23505' && (!constraint || error?.constraint === constraint);

function buildCreatorAvailabilityFields({ creatorAlias = 'c', userAlias = 'u', activeAlias = 'active_call' } = {}) {
  return `
    CASE
      WHEN ${creatorAlias}.is_online IS NOT TRUE THEN 'offline'
      WHEN ${activeAlias}.has_active THEN 'busy'
      ELSE 'online'
    END AS availability,
    CASE
      WHEN ${creatorAlias}.is_online IS TRUE AND COALESCE(${activeAlias}.has_active, FALSE) = FALSE THEN TRUE
      ELSE FALSE
    END AS "canCall",
    CASE
      WHEN ${creatorAlias}.is_online IS TRUE AND COALESCE(${activeAlias}.has_active, FALSE) = FALSE THEN TRUE
      ELSE FALSE
    END AS "online",
    CASE
      WHEN ${creatorAlias}.is_online IS TRUE AND COALESCE(${activeAlias}.has_active, FALSE) = TRUE THEN TRUE
      ELSE FALSE
    END AS "busy"
  `;
}

function buildCreatorAvailabilityJoin({ userAlias = 'u', activeAlias = 'active_call' } = {}) {
  return `
    LEFT JOIN LATERAL (
      SELECT TRUE AS has_active
      FROM calls active_slot
      WHERE active_slot.receiver_id = ${userAlias}.id
        AND (
          active_slot.status = 'connected'
          OR (
            active_slot.status = 'ringing'
            AND active_slot.created_at >= NOW() - make_interval(secs => ${RINGING_TIMEOUT_SECONDS})
          )
        )
        AND active_slot.end_time IS NULL
      LIMIT 1
    ) ${activeAlias} ON TRUE
  `;
}

// ─── USERS ──────────────────────────────────────────────

async function findUserByPhone(phone) {
  const { rows } = await pool.query(
    'SELECT * FROM users WHERE phone = $1',
    [phone]
  );
  return rows[0] || null;
}

async function findUserById(id) {
  const { rows } = await pool.query(
    'SELECT u.*, w.balance FROM users u LEFT JOIN wallets w ON u.id = w.user_id WHERE u.id = $1',
    [id]
  );
  return rows[0] || null;
}

async function createNotification(userId, { title, body, type, data = {} } = {}, client = pool) {
  const { rows } = await client.query(`
    INSERT INTO notifications (user_id, title, body, type, data)
    VALUES ($1, $2, $3, $4, $5::jsonb)
    RETURNING *
  `, [userId, title, body, type, JSON.stringify(data || {})]);
  return rows[0] || null;
}

async function getNotificationsForUser(userId, limit = 50) {
  const { rows } = await pool.query(`
    SELECT id, title, body, type, data, read, created_at
    FROM notifications
    WHERE user_id = $1
    ORDER BY created_at DESC, id DESC
    LIMIT $2
  `, [userId, limit]);

  const { rows: unreadRows } = await pool.query(`
    SELECT COUNT(*)::int AS unread_count
    FROM notifications
    WHERE user_id = $1 AND read = FALSE
  `, [userId]);

  return {
    notifications: rows,
    unreadCount: unreadRows[0]?.unread_count || 0,
  };
}

async function markNotificationRead(userId, notificationId) {
  const { rows } = await pool.query(`
    UPDATE notifications
    SET read = TRUE
    WHERE id = $1 AND user_id = $2
    RETURNING *
  `, [notificationId, userId]);
  return rows[0] || null;
}

async function markAllNotificationsRead(userId) {
  const { rowCount } = await pool.query(`
    UPDATE notifications
    SET read = TRUE
    WHERE user_id = $1 AND read = FALSE
  `, [userId]);
  return { updatedCount: rowCount };
}

async function createUser(phone) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      'INSERT INTO users (phone, role) VALUES ($1, $2) RETURNING *',
      [phone, 'user']
    );
    const user = rows[0];

    // Every new user gets a wallet
    await client.query(
      'INSERT INTO wallets (user_id, balance) VALUES ($1, $2)',
      [user.id, 0]
    );

    await client.query('COMMIT');
    return { ...user, balance: 0 };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function updateUserName(id, name) {
  const { rows } = await pool.query(
    'UPDATE users SET name = $1 WHERE id = $2 RETURNING *',
    [name, id]
  );
  return rows[0] || null;
}

async function updateUserHandle(id, handle) {
  // Check uniqueness first
  const { rows: existing } = await pool.query(
    'SELECT id FROM users WHERE handle = $1 AND id != $2',
    [handle, id]
  );
  if (existing.length > 0) return { error: 'handle_taken' };

  const { rows } = await pool.query(
    'UPDATE users SET handle = $1 WHERE id = $2 RETURNING *',
    [handle, id]
  );
  return rows[0] || null;
}

async function isHandleAvailable(handle, excludeUserId = null) {
  const normalizedHandle = String(handle || '').trim().toLowerCase();
  if (!normalizedHandle) {
    return false;
  }

  const { rows } = await pool.query(
    'SELECT id FROM users WHERE handle = $1 AND ($2::int IS NULL OR id != $2) LIMIT 1',
    [normalizedHandle, excludeUserId]
  );
  return rows.length === 0;
}

// ─── CREATORS ───────────────────────────────────────────

async function getCreators(requestingUserId = null) {
  const { rows } = await pool.query(`
    SELECT
      u.id, COALESCE(u.name, u.phone, 'Creator') AS name, u.handle, u.role, u.bio,
      c.rate, c.video_rate AS "videoRate", c.languages, c.categories, c.image_color AS "imageColor",
      c.rating, c.total_calls AS "totalCalls",
      ${buildCreatorAvailabilityFields()}
    FROM users u
    JOIN creators c ON u.id = c.user_id
    ${buildCreatorAvailabilityJoin()}
    WHERE u.role = 'creator' AND u.name IS NOT NULL AND u.name != ''
      AND u.status = 'active'
      AND ($1::int IS NULL OR u.id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id = $1))
    ORDER BY
      CASE
        WHEN c.is_online IS TRUE AND COALESCE(active_call.has_active, FALSE) = FALSE THEN 0
        WHEN c.is_online IS TRUE AND COALESCE(active_call.has_active, FALSE) = TRUE THEN 1
        ELSE 2
      END,
      c.rating DESC NULLS LAST,
      u.id
  `, [requestingUserId]);
  return rows;
}

async function getCreatorById(id, requestingUserId = null) {
  const { rows } = await pool.query(`
    SELECT
      u.id, u.name, u.handle, u.role, u.bio,
      c.rate, c.video_rate AS "videoRate", c.languages, c.categories, c.image_color AS "imageColor",
      c.rating, c.total_calls AS "totalCalls",
      ${buildCreatorAvailabilityFields()}
    FROM users u
    JOIN creators c ON u.id = c.user_id
    ${buildCreatorAvailabilityJoin()}
    WHERE u.id = $1
      AND ($2::int IS NULL OR u.id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id = $2))
  `, [id, requestingUserId]);
  return rows[0] || null;
}

// ─── WALLETS ────────────────────────────────────────────

async function getWalletBalance(userId) {
  const { rows } = await pool.query(
    'SELECT balance FROM wallets WHERE user_id = $1',
    [userId]
  );
  return rows[0] ? parseFloat(rows[0].balance) : 0;
}

async function updateWalletBalance(userId, amount) {
  // amount can be positive (topup) or negative (deduction)
  const { rows } = await pool.query(`
    UPDATE wallets SET balance = balance + $1, updated_at = NOW()
    WHERE user_id = $2
    RETURNING balance
  `, [amount, userId]);
  return rows[0] ? parseFloat(rows[0].balance) : null;
}

// ─── TRANSACTIONS ───────────────────────────────────────

async function createTransaction(userId, amount, type, status = 'success', options = {}) {
  const client = options.client || pool;
  const sourceType = options.sourceType || null;
  const sourceId = options.sourceId == null ? null : String(options.sourceId);
  const { rows } = await client.query(`
    INSERT INTO transactions (user_id, amount, type, status, source_type, source_id)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (user_id, type, source_type, source_id)
    WHERE status = 'success' AND source_type IS NOT NULL AND source_id IS NOT NULL
    DO NOTHING
    RETURNING *
  `, [userId, amount, type, status, sourceType, sourceId]);

  if (rows[0]) {
    return rows[0];
  }

  if (status === 'success' && sourceType && sourceId) {
    const { rows: existingRows } = await client.query(`
      SELECT *
      FROM transactions
      WHERE user_id = $1
        AND type = $2
        AND status = 'success'
        AND source_type = $3
        AND source_id = $4
      LIMIT 1
    `, [userId, type, sourceType, sourceId]);
    return existingRows[0] || null;
  }

  return null;
}

async function getCreatorPendingEarningTransactions(creatorUserId, client = pool) {
  const { rows } = await client.query(`
    SELECT t.id, t.amount, t.created_at, t.source_id
    FROM transactions t
    WHERE t.user_id = $1
      AND t.type = 'call_earning'
      AND t.status = 'success'
      AND t.source_type = 'call'
      AND NOT EXISTS (
        SELECT 1
        FROM creator_payout_items cpi
        JOIN creator_payouts cp ON cp.id = cpi.payout_id
        WHERE cpi.transaction_id = t.id
          AND (
            cp.paid_at IS NOT NULL
            OR COALESCE(cp.provider_status, 'processing') NOT IN ('failed', 'rejected', 'reversed')
          )
      )
    ORDER BY t.created_at ASC, t.id ASC
  `, [creatorUserId]);

  return rows.map((row) => ({
    ...row,
    amount: parseMoney(row.amount),
  }));
}

function normalizeCreatorPayoutRequest(row) {
  if (!row) return null;
  return {
    id: row.id,
    requestedAmount: parseMoney(row.requested_amount),
    upiId: row.upi_id || null,
    status: row.status,
    reason: row.reason || null,
    payoutId: row.payout_id || null,
    providerStatus: row.provider_status || null,
    failureReason: row.failure_reason || null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function normalizeCreatorPayoutRow(row) {
  return {
    id: row.id,
    amount: parseMoney(row.amount),
    upiId: row.upi_id || null,
    externalReference: row.external_reference || null,
    note: row.note || null,
    paidAt: row.paid_at,
    createdAt: row.created_at,
    provider: row.provider || null,
    providerPayoutId: row.provider_payout_id || null,
    providerStatus: row.provider_status || null,
    idempotencyKey: row.idempotency_key || null,
    failureReason: row.failure_reason || null,
    approvedAt: row.approved_at || null,
    retryOfPayoutId: row.retry_of_payout_id || null,
  };
}

async function getCurrentCreatorPayoutRequest(userId, client = pool) {
  const { rows } = await client.query(`
    SELECT
      cpr.id,
      cpr.requested_amount,
      cpr.upi_id,
      cpr.status,
      cpr.reason,
      cpr.payout_id,
      cpr.created_at,
      cpr.resolved_at,
      cp.provider_status,
      cp.failure_reason
    FROM creator_payout_requests cpr
    LEFT JOIN creator_payouts cp ON cp.id = cpr.payout_id
    WHERE cpr.creator_user_id = $1
    ORDER BY
      CASE
        WHEN cpr.status = 'open' THEN 0
        WHEN cpr.status = 'processing' THEN 1
        WHEN cpr.status = 'failed' THEN 2
        ELSE 3
      END,
      cpr.created_at DESC,
      cpr.id DESC
    LIMIT 1
  `, [userId]);

  return normalizeCreatorPayoutRequest(rows[0]);
}

async function getCreatorPayoutSummary(userId, client = pool) {
  const { rows: creatorRows } = await client.query(`
    SELECT
      c.payout_upi_id,
      c.payout_upi_updated_at,
      c.payout_contact_id,
      c.payout_fund_account_id,
      c.payout_upi_verified_name,
      c.payout_upi_verified_at,
      c.payout_upi_last_error,
      c.payout_upi_verification_status
    FROM creators c
    WHERE c.user_id = $1
  `, [userId]);

  if (!creatorRows[0]) {
    return null;
  }

  const pendingTransactions = await getCreatorPendingEarningTransactions(userId, client);
  const pendingPayout = pendingTransactions.reduce((sum, row) => sum + parseMoney(row.amount), 0);

  const { rows: paidRows } = await client.query(`
    SELECT
      COALESCE(SUM(amount), 0) AS paid_out_till_date,
      MAX(paid_at) AS last_payout_date
    FROM creator_payouts
    WHERE creator_user_id = $1
      AND (
        paid_at IS NOT NULL
        OR COALESCE(provider_status, 'processed') = 'processed'
      )
      AND COALESCE(provider_status, 'processed') NOT IN ('failed', 'rejected', 'reversed')
  `, [userId]);

  const currentRequest = await getCurrentCreatorPayoutRequest(userId, client);
  const payoutMode = isRazorpayXValidationConfigured() ? 'razorpayx' : 'manual';
  const verificationStatus =
    payoutMode === 'manual' && creatorRows[0].payout_upi_id
      ? 'verified'
      : (creatorRows[0].payout_upi_verification_status || 'unverified');

  return {
    payoutMode,
    payoutUpiId: creatorRows[0].payout_upi_id || null,
    payoutUpiUpdatedAt: creatorRows[0].payout_upi_updated_at || null,
    payoutContactId: creatorRows[0].payout_contact_id || null,
    payoutFundAccountId: creatorRows[0].payout_fund_account_id || null,
    payoutUpiVerifiedName: creatorRows[0].payout_upi_verified_name || null,
    payoutUpiVerifiedAt: creatorRows[0].payout_upi_verified_at || null,
    payoutUpiLastError: creatorRows[0].payout_upi_last_error || null,
    payoutUpiVerificationStatus: verificationStatus,
    pendingPayout,
    paidOutTillDate: parseMoney(paidRows[0]?.paid_out_till_date),
    lastPayoutDate: paidRows[0]?.last_payout_date || null,
    currentRequest,
    hasOpenRequest: ACTIVE_PAYOUT_REQUEST_STATUSES.has(currentRequest?.status),
    hasActiveRequest: ACTIVE_PAYOUT_REQUEST_STATUSES.has(currentRequest?.status),
  };
}

async function getCreatorPayoutHistory(userId, client = pool) {
  const summary = await getCreatorPayoutSummary(userId, client);
  if (!summary) {
    return null;
  }

  const { rows: payoutRows } = await client.query(`
    SELECT
      id,
      amount,
      upi_id,
      external_reference,
      note,
      paid_at,
      created_at,
      provider,
      provider_payout_id,
      provider_status,
      idempotency_key,
      failure_reason,
      approved_at,
      retry_of_payout_id
    FROM creator_payouts
    WHERE creator_user_id = $1
    ORDER BY COALESCE(paid_at, created_at) DESC, id DESC
  `, [userId]);

  const { rows: requestRows } = await client.query(`
    SELECT
      cpr.id,
      cpr.requested_amount,
      cpr.upi_id,
      cpr.status,
      cpr.reason,
      cpr.payout_id,
      cpr.created_at,
      cpr.resolved_at,
      cp.provider_status,
      cp.failure_reason
    FROM creator_payout_requests cpr
    LEFT JOIN creator_payouts cp ON cp.id = cpr.payout_id
    WHERE creator_user_id = $1
    ORDER BY cpr.created_at DESC, cpr.id DESC
  `, [userId]);

  return {
    summary,
    payouts: payoutRows.map(normalizeCreatorPayoutRow),
    requests: requestRows.map(normalizeCreatorPayoutRequest),
  };
}

async function updateCreatorPayoutDetails(userId, upiId) {
  const normalizedUpi = String(upiId || '').trim().toLowerCase();
  if (normalizedUpi && !BASIC_UPI_REGEX.test(normalizedUpi)) {
    return { error: 'invalid_upi' };
  }

  const { rows: creatorRows } = await pool.query(`
    SELECT
      c.user_id,
      c.payout_upi_id,
      c.payout_upi_verification_status,
      c.payout_contact_id,
      u.name,
      u.phone
    FROM creators c
    JOIN users u ON u.id = c.user_id
    WHERE c.user_id = $1
  `, [userId]);

  if (!creatorRows[0]) {
    return null;
  }

  if (!normalizedUpi) {
    const { rows } = await pool.query(`
      UPDATE creators
      SET payout_upi_id = NULL,
          payout_upi_updated_at = NULL,
          payout_contact_id = NULL,
          payout_fund_account_id = NULL,
          payout_upi_verified_name = NULL,
          payout_upi_verified_at = NULL,
          payout_upi_last_error = NULL,
          payout_upi_verification_status = 'unverified'
      WHERE user_id = $1
      RETURNING *
    `, [userId]);
    return rows[0] || null;
  }

  if (!isRazorpayXValidationConfigured()) {
    const { rows } = await pool.query(`
      UPDATE creators
      SET payout_upi_id = $1,
          payout_upi_updated_at = NOW(),
          payout_contact_id = NULL,
          payout_fund_account_id = NULL,
          payout_upi_verified_name = NULL,
          payout_upi_verified_at = NULL,
          payout_upi_last_error = NULL,
          payout_upi_verification_status = 'verified'
      WHERE user_id = $2
      RETURNING *
    `, [normalizedUpi, userId]);

    return rows[0]
      ? {
          ...rows[0],
          manualFallback: true,
        }
      : null;
  }

  const verification = await validateCreatorVpa({
    existingContactId: creatorRows[0].payout_contact_id || null,
    name: creatorRows[0].name || 'TIYO Creator',
    phone: creatorRows[0].phone || '',
    referenceId: `tiyo_creator_${userId}`,
    vpa: normalizedUpi,
  });

  if (!verification.ok) {
    const shouldFlipToFailed =
      !creatorRows[0].payout_upi_id ||
      creatorRows[0].payout_upi_id === normalizedUpi ||
      creatorRows[0].payout_upi_verification_status !== 'verified';

    await pool.query(`
      UPDATE creators
      SET payout_upi_last_error = $1,
          payout_upi_verification_status = CASE
            WHEN $2::boolean THEN 'failed'
            ELSE COALESCE(payout_upi_verification_status, 'verified')
          END
      WHERE user_id = $3
    `, [verification.message || 'Verification failed', shouldFlipToFailed, userId]);

    return {
      error: verification.errorCode,
      message: verification.message || 'Could not verify this UPI ID',
    };
  }

  const { rows } = await pool.query(`
    UPDATE creators
    SET payout_upi_id = $1,
        payout_upi_updated_at = NOW(),
        payout_contact_id = $2,
        payout_fund_account_id = $3,
        payout_upi_verified_name = $4,
        payout_upi_verified_at = NOW(),
        payout_upi_last_error = NULL,
        payout_upi_verification_status = 'verified'
    WHERE user_id = $5
    RETURNING *
  `, [
    normalizedUpi,
    verification.contactId || null,
    verification.fundAccountId || null,
    verification.verifiedName || null,
    userId,
  ]);

  if (!rows[0]) {
    return null;
  }

  return {
    ...rows[0],
    verificationBypass: Boolean(verification.verificationBypass),
  };
}

async function createCreatorPayoutRequest(userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: creatorRows } = await client.query(`
      SELECT payout_upi_id, payout_upi_verification_status
      FROM creators
      WHERE user_id = $1
      FOR UPDATE
    `, [userId]);

    if (!creatorRows[0]) {
      await client.query('ROLLBACK');
      return { error: 'creator_not_found' };
    }

    const payoutUpiId = creatorRows[0].payout_upi_id || null;
    if (!payoutUpiId) {
      await client.query('ROLLBACK');
      return { error: 'payout_upi_required' };
    }
    if (isRazorpayXValidationConfigured() && creatorRows[0].payout_upi_verification_status !== 'verified') {
      await client.query('ROLLBACK');
      return { error: 'payout_upi_not_verified' };
    }

    const { rows: openRequestRows } = await client.query(`
      SELECT id
      FROM creator_payout_requests
      WHERE creator_user_id = $1 AND status IN ('open', 'processing')
      LIMIT 1
    `, [userId]);
    if (openRequestRows[0]) {
      await client.query('ROLLBACK');
      return { error: 'request_already_open' };
    }

    const pendingTransactions = await getCreatorPendingEarningTransactions(userId, client);
    if (pendingTransactions.length === 0) {
      await client.query('ROLLBACK');
      return { error: 'no_pending_payout' };
    }

    const requestedAmount = pendingTransactions.reduce((sum, row) => sum + parseMoney(row.amount), 0);

    const { rows } = await client.query(`
      INSERT INTO creator_payout_requests (creator_user_id, requested_amount, upi_id, status)
      VALUES ($1, $2, $3, 'open')
      RETURNING *
    `, [userId, requestedAmount, payoutUpiId]);

    await client.query('COMMIT');

    return {
      request: {
        id: rows[0].id,
        requestedAmount: parseMoney(rows[0].requested_amount),
        upiId: rows[0].upi_id || null,
        status: rows[0].status,
        createdAt: rows[0].created_at,
      },
      summary: await getCreatorPayoutSummary(userId),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getUserTransactions(userId) {
  // Get top-up transactions
  const { rows: topups } = await pool.query(`
    SELECT id, amount, type, status, created_at AS timestamp
    FROM transactions
    WHERE user_id = $1 AND type = 'topup' AND status = 'success'
    ORDER BY created_at DESC
  `, [userId]);

  // Get call deductions (as caller)
  const { rows: calls } = await pool.query(`
    SELECT
      c.id, c.total_cost, c.duration_seconds,
      u.name AS creator_name,
      c.created_at AS timestamp
    FROM calls c
    JOIN users u ON c.receiver_id = u.id
    WHERE c.caller_id = $1
    ORDER BY c.created_at DESC
  `, [userId]);

  // Get call earnings (as creator)
  const { rows: earnings } = await pool.query(`
    SELECT
      c.id, c.total_cost, c.duration_seconds,
      u.name AS caller_name,
      c.created_at AS timestamp
    FROM calls c
    JOIN users u ON c.caller_id = u.id
    WHERE c.receiver_id = $1 AND c.status = 'completed' AND c.total_cost > 0
    ORDER BY c.created_at DESC
  `, [userId]);

  // Get the user's wallet creation time for the "initial balance" entry
  const { rows: walletRows } = await pool.query(`
    SELECT created_at FROM wallets WHERE user_id = $1
  `, [userId]);

  const topupEntries = topups.map(t => ({
    id: `topup_${t.id}`,
    type: 'topup',
    amount: parseFloat(t.amount),
    title: 'Wallet Top-up',
    timestamp: t.timestamp
  }));

  const callEntries = calls.map(c => ({
    id: `call_${c.id}`,
    type: 'call',
    amount: -(c.total_cost ? parseFloat(c.total_cost) : 0),
    title: `Call with ${c.creator_name || 'Unknown'}`,
    durationSeconds: c.duration_seconds,
    timestamp: c.timestamp
  }));

  const earningEntries = earnings.map(c => ({
    id: `earning_${c.id}`,
    type: 'earning',
    amount: c.total_cost ? parseFloat(c.total_cost) : 0,
    title: `Earned from ${c.caller_name || 'Unknown'}`,
    durationSeconds: c.duration_seconds,
    timestamp: c.timestamp
  }));

  // Check if user had an initial balance (from seed data)
  const { rows: initialTx } = await pool.query(`
    SELECT id, amount, created_at AS timestamp
    FROM transactions
    WHERE user_id = $1 AND type = 'initial'
    LIMIT 1
  `, [userId]);

  const initialEntry = initialTx.length > 0
    ? {
        id: 'initial_balance',
        type: 'initial',
        amount: parseFloat(initialTx[0].amount),
        title: 'Starting Balance',
        timestamp: initialTx[0].timestamp
      }
    : {
        id: 'initial_balance',
        type: 'initial',
        amount: 0,
        title: 'Starting Balance',
        timestamp: walletRows[0]?.created_at || new Date('2024-01-01').toISOString()
      };

  const combined = [...topupEntries, ...callEntries, ...earningEntries, initialEntry]
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  return combined;
}

async function getUserRecharges(userId) {
  const { rows } = await pool.query(`
    SELECT id, user_id AS "userId", amount, type, status, created_at AS timestamp
    FROM transactions
    WHERE user_id = $1 AND type = 'topup'
    ORDER BY created_at DESC
  `, [userId]);

  return rows.map(r => ({
    ...r,
    amount: parseFloat(r.amount)
  }));
}

// ─── CALLS ──────────────────────────────────────────────

async function createCallRecord(callerId, receiverId, durationSeconds, totalCost) {
  const { rows } = await pool.query(`
    INSERT INTO calls (caller_id, receiver_id, start_time, end_time, duration_seconds, total_cost, status)
    VALUES ($1, $2, NOW() - INTERVAL '1 second' * $3, NOW(), $3, $4, 'completed')
    RETURNING *
  `, [callerId, receiverId, durationSeconds, totalCost]);
  return rows[0];
}

async function getUserCalls(userId) {
  const { rows } = await pool.query(`
    SELECT
      c.id,
      COALESCE(u.name, u.phone, 'Unknown') AS "creatorName",
      cr.image_color AS "creatorColor",
      c.duration_seconds AS "durationSeconds",
      c.total_cost AS cost,
      c.created_at AS timestamp
    FROM calls c
    JOIN users u ON c.receiver_id = u.id
    LEFT JOIN creators cr ON c.receiver_id = cr.user_id
    WHERE c.caller_id = $1
    ORDER BY c.created_at DESC
  `, [userId]);

  return rows.map(r => ({
    ...r,
    cost: r.cost ? parseFloat(r.cost) : 0,
  }));
}

async function getCreatorReceivedCalls(userId) {
  const { rows } = await pool.query(`
    SELECT
      c.id,
      c.caller_id AS "callerId",
      COALESCE(u.name, u.phone, 'Unknown') AS "callerName",
      u.phone AS "callerPhone",
      COALESCE(u.user_rating, 0) AS "callerRating",
      COALESCE(u.user_rating_count, 0)::int AS "callerRatingCount",
      c.caller_rating AS "ratingGiven",
      c.status,
      c.call_type AS "callType",
      c.duration_seconds AS "durationSeconds",
      c.total_cost AS earnings,
      c.created_at AS timestamp
    FROM calls c
    JOIN users u ON c.caller_id = u.id
    WHERE c.receiver_id = $1
    ORDER BY c.created_at DESC
  `, [userId]);

  return rows.map(r => ({
    ...r,
    earnings: r.earnings ? parseFloat(r.earnings) : 0,
    callerRating: r.callerRating ? parseFloat(r.callerRating) : 0,
  }));
}

async function getCreatorReceivedCallDetail(userId, callId) {
  const { rows } = await pool.query(`
    SELECT
      c.id,
      c.caller_id AS "callerId",
      COALESCE(u.name, u.phone, 'Unknown') AS "callerName",
      u.phone AS "callerPhone",
      COALESCE(u.user_rating, 0) AS "callerRating",
      COALESCE(u.user_rating_count, 0)::int AS "callerRatingCount",
      c.caller_rating AS "ratingGiven",
      c.status,
      c.call_type AS "callType",
      c.duration_seconds AS "durationSeconds",
      c.total_cost AS earnings,
      c.created_at AS timestamp,
      EXISTS (
        SELECT 1
        FROM blocks b
        WHERE b.blocker_id = $1 AND b.blocked_id = c.caller_id
      ) AS blocked
    FROM calls c
    JOIN users u ON c.caller_id = u.id
    WHERE c.receiver_id = $1 AND c.id = $2
    LIMIT 1
  `, [userId, callId]);

  if (!rows[0]) return null;

  return {
    ...rows[0],
    earnings: rows[0].earnings ? parseFloat(rows[0].earnings) : 0,
    callerRating: rows[0].callerRating ? parseFloat(rows[0].callerRating) : 0,
  };
}

async function recalculateCreatorAggregateRating(client, creatorId) {
  const { rows: aggregateRows } = await client.query(`
    SELECT
      COUNT(creator_rating)::int AS rating_count,
      COALESCE(ROUND(AVG(creator_rating)::numeric, 2), 0)::numeric AS rating
    FROM calls
    WHERE receiver_id = $1 AND creator_rating IS NOT NULL
  `, [creatorId]);

  const ratingCount = aggregateRows[0]?.rating_count ?? 0;
  const rating = aggregateRows[0]?.rating ? parseFloat(aggregateRows[0].rating) : 0;

  await client.query(
    'UPDATE creators SET rating = $1, rating_count = $2 WHERE user_id = $3',
    [rating, ratingCount, creatorId]
  );

  return { rating, ratingCount };
}

async function recalculateCallerAggregateRating(client, callerId) {
  const { rows: aggregateRows } = await client.query(`
    SELECT
      COUNT(caller_rating)::int AS rating_count,
      COALESCE(ROUND(AVG(caller_rating)::numeric, 2), 0)::numeric AS rating
    FROM calls
    WHERE caller_id = $1 AND caller_rating IS NOT NULL
  `, [callerId]);

  const ratingCount = aggregateRows[0]?.rating_count ?? 0;
  const rating = aggregateRows[0]?.rating ? parseFloat(aggregateRows[0].rating) : 0;

  await client.query(
    'UPDATE users SET user_rating = $1, user_rating_count = $2 WHERE id = $3',
    [rating, ratingCount, callerId]
  );

  return { rating, ratingCount };
}

async function submitCreatorRating(callId, callerId, rating) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: callRows } = await client.query(
      'SELECT * FROM calls WHERE id = $1 FOR UPDATE',
      [callId]
    );
    const call = callRows[0];

    if (!call || call.caller_id !== callerId) {
      await client.query('ROLLBACK');
      return { error: 'Call not found' };
    }

    if (call.status !== 'completed') {
      await client.query('ROLLBACK');
      return { error: 'Only completed calls can be rated' };
    }

    await client.query(
      'UPDATE calls SET creator_rating = $1 WHERE id = $2',
      [rating, callId]
    );

    const previousRating = call.creator_rating != null ? parseInt(call.creator_rating, 10) : null;
    const aggregate = await recalculateCreatorAggregateRating(client, call.receiver_id);

    await client.query('COMMIT');
    return { success: true, rating: aggregate.rating, ratingCount: aggregate.ratingCount, updated: previousRating != null };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function submitCallerRating(callId, creatorId, rating) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: callRows } = await client.query(
      'SELECT * FROM calls WHERE id = $1 FOR UPDATE',
      [callId]
    );
    const call = callRows[0];

    if (!call || call.receiver_id !== creatorId) {
      await client.query('ROLLBACK');
      return { error: 'Call not found' };
    }

    if (call.status !== 'completed') {
      await client.query('ROLLBACK');
      return { error: 'Only completed calls can be rated' };
    }

    await client.query(
      'UPDATE calls SET caller_rating = $1 WHERE id = $2',
      [rating, callId]
    );

    const previousRating = call.caller_rating != null ? parseInt(call.caller_rating, 10) : null;
    const aggregate = await recalculateCallerAggregateRating(client, call.caller_id);

    await client.query('COMMIT');
    return { success: true, rating: aggregate.rating, ratingCount: aggregate.ratingCount, updated: previousRating != null };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── CALL LIFECYCLE (V22) ───────────────────────────────

async function initiateCall(callerId, receiverId, channelName, callType = 'voice') {
  try {
    const { rows } = await pool.query(`
      INSERT INTO calls (caller_id, receiver_id, channel_name, call_type, status)
      VALUES ($1, $2, $3, $4, 'ringing')
      RETURNING *
    `, [callerId, receiverId, channelName, callType]);
    return rows[0];
  } catch (err) {
    if (isPgUniqueViolation(err, 'idx_calls_one_active_per_caller')) {
      return { error: 'caller_busy' };
    }
    if (isPgUniqueViolation(err, 'idx_calls_one_active_per_receiver')) {
      return { error: 'receiver_busy' };
    }
    if (err?.code === '23505') {
      return { error: 'busy' };
    }
    throw err;
  }
}

async function cleanupStaleRingingCalls(timeoutSeconds = RINGING_TIMEOUT_SECONDS) {
  const { rows } = await pool.query(`
    UPDATE calls
    SET status = 'missed',
        end_time = COALESCE(end_time, NOW()),
        end_reason = COALESCE(end_reason, 'no_answer_timeout'),
        ended_by_user_id = NULL
    WHERE status = 'ringing'
      AND created_at < NOW() - make_interval(secs => $1)
    RETURNING id, receiver_id
  `, [timeoutSeconds]);
  return {
    count: rows.length,
    freedCreatorIds: getUniqueInts(rows.map((row) => row.receiver_id)),
  };
}

async function cleanupSupersededConnectedCalls() {
  const { rows } = await pool.query(`
    UPDATE calls c
    SET status = 'missed',
        end_time = COALESCE(c.end_time, NOW()),
        end_reason = COALESCE(c.end_reason, 'system_cleanup'),
        ended_by_user_id = NULL
    WHERE c.status = 'connected'
      AND EXISTS (
        SELECT 1
        FROM calls newer
        WHERE newer.id != c.id
          AND newer.created_at > c.created_at
          AND newer.status IN ('completed', 'missed', 'rejected')
          AND (
            c.caller_id IN (newer.caller_id, newer.receiver_id)
            OR c.receiver_id IN (newer.caller_id, newer.receiver_id)
          )
      )
    RETURNING id, receiver_id
  `);
  return {
    count: rows.length,
    freedCreatorIds: getUniqueInts(rows.map((row) => row.receiver_id)),
  };
}

async function cleanupExpiredCallStates(timeoutSeconds = RINGING_TIMEOUT_SECONDS) {
  const staleRinging = await cleanupStaleRingingCalls(timeoutSeconds);
  const supersededConnected = await cleanupSupersededConnectedCalls();
  return {
    staleRinging: staleRinging.count,
    supersededConnected: supersededConnected.count,
    freedCreatorIds: getUniqueInts([
      ...staleRinging.freedCreatorIds,
      ...supersededConnected.freedCreatorIds,
    ]),
  };
}

async function getOngoingCallForUser(userId, timeoutSeconds = RINGING_TIMEOUT_SECONDS) {
  const { rows } = await pool.query(`
    SELECT *
    FROM calls
    WHERE (caller_id = $1 OR receiver_id = $1)
      AND (
        status = 'connected'
        OR (
          status = 'ringing'
          AND created_at >= NOW() - make_interval(secs => $2)
        )
      )
    ORDER BY created_at DESC
    LIMIT 1
  `, [userId, timeoutSeconds]);
  return rows[0] || null;
}

async function connectCallById(callId, timeoutSeconds = RINGING_TIMEOUT_SECONDS) {
  const { rows } = await pool.query(`
    UPDATE calls SET status = 'connected', start_time = NOW(), end_reason = NULL, ended_by_user_id = NULL
    WHERE id = $1
      AND status = 'ringing'
      AND created_at >= NOW() - make_interval(secs => $2)
    RETURNING *
  `, [callId, timeoutSeconds]);
  return rows[0] || null;
}

async function acceptCallById(callId, receiverId, timeoutSeconds = RINGING_TIMEOUT_SECONDS) {
  const { rows } = await pool.query(`
    UPDATE calls
    SET status = 'connected', start_time = NOW(), end_reason = NULL, ended_by_user_id = NULL
    WHERE id = $1
      AND receiver_id = $2
      AND status = 'ringing'
      AND created_at >= NOW() - make_interval(secs => $3)
      AND end_time IS NULL
    RETURNING *
  `, [callId, receiverId, timeoutSeconds]);
  return rows[0] || null;
}

async function getCallById(callId) {
  const { rows } = await pool.query('SELECT * FROM calls WHERE id = $1', [callId]);
  return rows[0] || null;
}

async function processCallEndById(callId, endedByUserId = null, reasonHint = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: callRows } = await client.query(
      'SELECT * FROM calls WHERE id = $1 FOR UPDATE',
      [callId]
    );
    if (!callRows[0]) throw new Error('Call not found');
    const call = callRows[0];

    if (call.status === 'completed' || call.status === 'missed' || call.status === 'rejected') {
      await client.query('ROLLBACK');
      return {
        success: true,
        alreadyEnded: true,
        status: call.status,
        cost: parseMoney(call.total_cost),
        duration: call.duration_seconds || 0,
        remainingBalance: null,
        missed: call.status === 'missed',
        endReason: call.end_reason || null,
        endedByUserId: call.ended_by_user_id ?? null,
        callType: call.call_type || 'voice',
        creatorUserId: call.receiver_id,
      };
    }

    const callerInitiated = endedByUserId != null && endedByUserId === call.caller_id;
    const receiverInitiated = endedByUserId != null && endedByUserId === call.receiver_id;
    const normalizedReasonHint = TERMINAL_REASON_HINTS.has(reasonHint) ? reasonHint : null;

    // If call never connected, mark as missed — no charge
    if (call.status === 'ringing' || !call.start_time) {
      let nextStatus = 'missed';
      let endReason = 'caller_cancelled_before_answer';
      let terminalEndedByUserId = callerInitiated ? endedByUserId : null;

      if (receiverInitiated) {
        nextStatus = 'rejected';
        endReason = 'creator_declined';
        terminalEndedByUserId = endedByUserId;
      }

      await client.query(
        `UPDATE calls
         SET status = $2,
             end_time = NOW(),
             end_reason = $3,
             ended_by_user_id = $4
         WHERE id = $1`,
        [callId, nextStatus, endReason, terminalEndedByUserId]
      );
      await client.query('COMMIT');
      return {
        success: true,
        status: nextStatus,
        cost: 0,
        duration: 0,
        remainingBalance: null,
        missed: nextStatus === 'missed',
        endReason,
        endedByUserId: terminalEndedByUserId,
        callType: call.call_type || 'voice',
        creatorUserId: call.receiver_id,
      };
    }

    // Server calculates duration from start_time
    const { rows: timeRows } = await client.query(
      `SELECT EXTRACT(EPOCH FROM (NOW() - start_time))::integer AS duration FROM calls WHERE id = $1`,
      [callId]
    );
    const durationSeconds = Math.max(timeRows[0].duration, 0);

    const { rows: creatorRows } = await client.query(
      'SELECT rate, video_rate FROM creators WHERE user_id = $1',
      [call.receiver_id]
    );
    if (!creatorRows[0]) throw new Error('Creator not found');
    // Use video_rate for video calls, voice rate otherwise
    const rate = call.call_type === 'video'
      ? parseFloat(creatorRows[0].video_rate || creatorRows[0].rate)
      : parseFloat(creatorRows[0].rate);

    const minutes = Math.ceil(durationSeconds / 60);
    const totalCost = minutes * rate;

    const { rows: walletRows } = await client.query(
      'SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE',
      [call.caller_id]
    );
    const balance = parseMoney(walletRows[0]?.balance);
    const chargeAmount = Math.min(totalCost, balance);

    const { rows: updatedWallet } = await client.query(
      'UPDATE wallets SET balance = balance - $1, updated_at = NOW() WHERE user_id = $2 RETURNING balance',
      [chargeAmount, call.caller_id]
    );

    await client.query(
      'UPDATE creators SET total_earnings = total_earnings + $1, total_calls = total_calls + 1 WHERE user_id = $2',
      [chargeAmount, call.receiver_id]
    );

    const endReason = normalizedReasonHint
      || (callerInitiated
        ? 'caller_hangup'
        : receiverInitiated
          ? 'creator_hangup'
          : 'system_cleanup');
    const terminalEndedByUserId = normalizedReasonHint ? null : (callerInitiated || receiverInitiated ? endedByUserId : null);

    await client.query(`
      UPDATE calls SET status = 'completed', end_time = NOW(),
        duration_seconds = $1, total_cost = $2, end_reason = $3, ended_by_user_id = $4
      WHERE id = $5
    `, [durationSeconds, chargeAmount, endReason, terminalEndedByUserId, callId]);

    // Record transaction for caller (debit)
    if (chargeAmount > 0) {
      await createTransaction(call.caller_id, -chargeAmount, 'call_debit', 'success', {
        sourceType: 'call',
        sourceId: call.id,
        client,
      });

      await createTransaction(call.receiver_id, chargeAmount, 'call_earning', 'success', {
        sourceType: 'call',
        sourceId: call.id,
        client,
      });
    }

    await client.query('COMMIT');

    return {
      success: true,
      status: 'completed',
      duration: durationSeconds,
      cost: chargeAmount,
      remainingBalance: parseMoney(updatedWallet[0].balance),
      endReason,
      endedByUserId: terminalEndedByUserId,
      callType: call.call_type || 'voice',
      creatorUserId: call.receiver_id,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── CALL END (FULL TRANSACTION — legacy V19) ──────────

async function processCallEnd(callerId, receiverId, durationSeconds) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get creator rate (legacy path doesn't have call_type, default to voice rate)
    const { rows: creatorRows } = await client.query(
      'SELECT rate, video_rate FROM creators WHERE user_id = $1',
      [receiverId]
    );
    if (!creatorRows[0]) throw new Error('Creator not found');
    const rate = parseFloat(creatorRows[0].rate);

    // Calculate cost
    const minutes = Math.ceil(durationSeconds / 60);
    const totalCost = minutes * rate;

    // Check caller balance
    const { rows: walletRows } = await client.query(
      'SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE',
      [callerId]
    );
    if (!walletRows[0]) throw new Error('Caller wallet not found');
    const balance = parseFloat(walletRows[0].balance);

    if (balance < totalCost) {
      await client.query('ROLLBACK');
      return { error: 'Insufficient funds', balance };
    }

    // Deduct from caller
    const { rows: updatedWallet } = await client.query(
      'UPDATE wallets SET balance = balance - $1, updated_at = NOW() WHERE user_id = $2 RETURNING balance',
      [totalCost, callerId]
    );

    // Credit to creator earnings
    await client.query(
      'UPDATE creators SET total_earnings = total_earnings + $1, total_calls = total_calls + 1 WHERE user_id = $2',
      [totalCost, receiverId]
    );

    // Record the call
    await client.query(`
      INSERT INTO calls (caller_id, receiver_id, start_time, end_time, duration_seconds, total_cost, status)
      VALUES ($1, $2, NOW() - INTERVAL '1 second' * $3, NOW(), $3, $4, 'completed')
    `, [callerId, receiverId, durationSeconds, totalCost]);

    await client.query('COMMIT');

    return {
      success: true,
      remainingBalance: parseFloat(updatedWallet[0].balance),
      cost: totalCost
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── PUSH TOKENS ───────────────────────────────────────

async function savePushToken(userId, pushToken) {
  const { rows } = await pool.query(
    'UPDATE users SET push_token = $1 WHERE id = $2 RETURNING id',
    [pushToken, userId]
  );
  return rows[0] || null;
}

// ─── CREATOR REGISTRATION & MANAGEMENT (V32) ──────────

async function registerCreator(userId, { bio, languages, categories }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Update user role to 'creator'
    await client.query(
      "UPDATE users SET role = 'creator', bio = $1 WHERE id = $2",
      [bio || null, userId]
    );

    // Rates are assigned server-side for now. The app no longer asks creators to pick them.
    const voiceRate = 10;
    const vidRate = 15;
    await client.query(`
      INSERT INTO creators (user_id, rate, video_rate, languages, categories, is_online)
      VALUES ($1, $2, $3, $4, $5, false)
      ON CONFLICT (user_id) DO UPDATE SET
        rate = EXCLUDED.rate,
        video_rate = EXCLUDED.video_rate,
        languages = EXCLUDED.languages,
        categories = EXCLUDED.categories
    `, [userId, voiceRate, vidRate, languages || 'Hindi, English', categories || ['General']]);

    // Ensure creator has a wallet (they should already, but just in case)
    await client.query(`
      INSERT INTO wallets (user_id, balance) VALUES ($1, 0)
      ON CONFLICT (user_id) DO NOTHING
    `, [userId]);

    await client.query('COMMIT');
    return { success: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function updateCreatorProfile(userId, updates) {
  const fields = [];
  const values = [];
  let idx = 1;

  if (updates.rate !== undefined) { fields.push(`rate = $${idx++}`); values.push(updates.rate); }
  if (updates.videoRate !== undefined) { fields.push(`video_rate = $${idx++}`); values.push(updates.videoRate); }
  if (updates.languages !== undefined) { fields.push(`languages = $${idx++}`); values.push(updates.languages); }
  if (updates.categories !== undefined) { fields.push(`categories = $${idx++}`); values.push(updates.categories); }
  if (updates.is_online !== undefined) { fields.push(`is_online = $${idx++}`); values.push(updates.is_online); }

  if (fields.length === 0) return null;

  values.push(userId);
  const { rows } = await pool.query(
    `UPDATE creators SET ${fields.join(', ')} WHERE user_id = $${idx} RETURNING *`,
    values
  );

  // Also update bio on users table if provided
  if (updates.bio !== undefined) {
    await pool.query('UPDATE users SET bio = $1 WHERE id = $2', [updates.bio, userId]);
  }

  return rows[0] || null;
}

async function toggleCreatorAvailability(userId) {
  const { rows } = await pool.query(`
    UPDATE creators SET is_online = NOT is_online, last_seen = NOW()
    WHERE user_id = $1
    RETURNING is_online
  `, [userId]);
  return rows[0] || null;
}

async function setCreatorAvailability(userId, isOnline) {
  const { rows } = await pool.query(`
    UPDATE creators SET is_online = $1, last_seen = NOW()
    WHERE user_id = $2
    RETURNING is_online
  `, [isOnline, userId]);
  return rows[0] || null;
}

async function getCreatorDashboard(userId) {
  // Get creator stats
  const { rows: creatorRows } = await pool.query(`
    SELECT c.rate, c.video_rate, c.is_online, c.rating, c.total_calls, c.total_earnings,
           c.languages, c.categories,
           u.name, u.bio, u.phone,
           ${buildCreatorAvailabilityFields({ creatorAlias: 'c', userAlias: 'u', activeAlias: 'active_call' })}
    FROM creators c
    JOIN users u ON c.user_id = u.id
    ${buildCreatorAvailabilityJoin({ userAlias: 'u', activeAlias: 'active_call' })}
    WHERE c.user_id = $1
  `, [userId]);

  if (!creatorRows[0]) return null;

  // Get wallet balance
  const { rows: walletRows } = await pool.query(
    'SELECT balance FROM wallets WHERE user_id = $1',
    [userId]
  );

  // Get recent calls received
  const { rows: recentCalls } = await pool.query(`
    SELECT c.id, c.duration_seconds, c.total_cost, c.status, c.created_at,
           COALESCE(u.name, u.phone, 'Unknown') AS caller_name
    FROM calls c
    JOIN users u ON c.caller_id = u.id
    WHERE c.receiver_id = $1
    ORDER BY c.created_at DESC
    LIMIT 10
  `, [userId]);

  const payoutSummary = await getCreatorPayoutSummary(userId);

  return {
    ...creatorRows[0],
    balance: walletRows[0] ? parseMoney(walletRows[0].balance) : 0,
    total_earnings: parseMoney(creatorRows[0].total_earnings),
    payoutSummary,
    recentCalls: recentCalls.map(c => ({
      ...c,
      total_cost: c.total_cost ? parseMoney(c.total_cost) : 0,
    })),
  };
}

async function getCreatorIncomingCalls(userId) {
  const { rows } = await pool.query(`
    SELECT c.id, c.caller_id, c.channel_name, c.call_type, c.status, c.created_at,
           u.name AS caller_name,
           COALESCE(u.user_rating, 0) AS caller_rating,
           COALESCE(u.user_rating_count, 0)::int AS caller_rating_count
    FROM calls c
    JOIN users u ON c.caller_id = u.id
    WHERE c.receiver_id = $1 AND c.status = 'ringing'
    ORDER BY c.created_at DESC
  `, [userId]);
  return rows.map(r => ({
    ...r,
    caller_rating: r.caller_rating ? parseFloat(r.caller_rating) : 0,
  }));
}

async function rejectCallById(callId, receiverId = null) {
  const { rows } = await pool.query(`
    UPDATE calls
    SET status = 'rejected',
        end_time = NOW(),
        end_reason = 'creator_declined',
        ended_by_user_id = $2
    WHERE id = $1 AND status = 'ringing'
    RETURNING *
  `, [callId, receiverId]);
  return rows[0] || null;
}

async function createOrRefreshCreatorFreeAlert(callerUserId, creatorUserId, sourceCallId = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: creatorRows } = await client.query(`
      SELECT
        u.id,
        u.status AS user_status,
        c.is_online,
        CASE
          WHEN c.is_online IS NOT TRUE THEN 'offline'
          WHEN EXISTS (
            SELECT 1
            FROM calls active_slot
            WHERE active_slot.receiver_id = u.id
              AND (
                active_slot.status = 'connected'
                OR (
                  active_slot.status = 'ringing'
                  AND active_slot.created_at >= NOW() - make_interval(secs => ${RINGING_TIMEOUT_SECONDS})
                )
              )
              AND active_slot.end_time IS NULL
          ) THEN 'busy'
          ELSE 'online'
        END AS availability
      FROM users u
      JOIN creators c ON c.user_id = u.id
      WHERE u.id = $1 AND u.role = 'creator'
      FOR UPDATE OF c
    `, [creatorUserId]);

    if (!creatorRows[0] || creatorRows[0].user_status !== 'active') {
      await client.query('ROLLBACK');
      return { error: 'creator_not_found' };
    }

    if (creatorRows[0].availability !== 'busy') {
      await client.query('ROLLBACK');
      return { error: 'creator_not_busy', availability: creatorRows[0].availability };
    }

    const { rows: existingRows } = await client.query(`
      SELECT id
      FROM creator_free_alerts
      WHERE creator_user_id = $1
        AND caller_user_id = $2
        AND status = 'active'
      FOR UPDATE
    `, [creatorUserId, callerUserId]);

    const expiresSql = `NOW() + make_interval(hours => ${CREATOR_FREE_ALERT_TTL_HOURS})`;

    if (existingRows[0]) {
      const { rows } = await client.query(`
        UPDATE creator_free_alerts
        SET expires_at = ${expiresSql},
            source_call_id = COALESCE($2, source_call_id),
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `, [existingRows[0].id, sourceCallId]);

      await client.query('COMMIT');
      return { alert: rows[0] || null, refreshed: true };
    }

    const { rows } = await client.query(`
      INSERT INTO creator_free_alerts (creator_user_id, caller_user_id, source_call_id, status, expires_at, updated_at)
      VALUES ($1, $2, $3, 'active', ${expiresSql}, NOW())
      RETURNING *
    `, [creatorUserId, callerUserId, sourceCallId]);

    await client.query('COMMIT');
    return { alert: rows[0] || null, refreshed: false };
  } catch (err) {
    await client.query('ROLLBACK');
    if (isPgUniqueViolation(err, 'idx_creator_free_alerts_one_active')) {
      const { rows } = await pool.query(`
        SELECT *
        FROM creator_free_alerts
        WHERE creator_user_id = $1
          AND caller_user_id = $2
          AND status = 'active'
        ORDER BY id DESC
        LIMIT 1
      `, [creatorUserId, callerUserId]);
      return { alert: rows[0] || null, refreshed: true };
    }
    throw err;
  } finally {
    client.release();
  }
}

async function cancelCreatorFreeAlert(callerUserId, creatorUserId) {
  const { rows } = await pool.query(`
    UPDATE creator_free_alerts
    SET status = 'cancelled',
        updated_at = NOW()
    WHERE caller_user_id = $1
      AND creator_user_id = $2
      AND status = 'active'
    RETURNING *
  `, [callerUserId, creatorUserId]);
  return rows[0] || null;
}

async function claimCreatorFreeAlertsForDispatch(creatorUserId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      UPDATE creator_free_alerts
      SET status = 'expired',
          updated_at = NOW()
      WHERE creator_user_id = $1
        AND status = 'active'
        AND expires_at <= NOW()
    `, [creatorUserId]);

    const { rows: creatorRows } = await client.query(`
      SELECT
        u.id,
        COALESCE(u.name, u.phone, 'Creator') AS creator_name,
        c.is_online,
        EXISTS (
          SELECT 1
          FROM calls active_slot
          WHERE active_slot.receiver_id = u.id
            AND (
              active_slot.status = 'connected'
              OR (
                active_slot.status = 'ringing'
                AND active_slot.created_at >= NOW() - make_interval(secs => ${RINGING_TIMEOUT_SECONDS})
              )
            )
            AND active_slot.end_time IS NULL
        ) AS has_active_call
      FROM users u
      JOIN creators c ON c.user_id = u.id
      WHERE u.id = $1 AND u.role = 'creator'
      FOR UPDATE OF c
    `, [creatorUserId]);

    const creator = creatorRows[0];
    if (!creator || !creator.is_online || creator.has_active_call) {
      await client.query('COMMIT');
      return { creator: creator || null, alerts: [] };
    }

    const { rows: claimedRows } = await client.query(`
      UPDATE creator_free_alerts
      SET status = 'notified',
          updated_at = NOW()
      WHERE creator_user_id = $1
        AND status = 'active'
        AND expires_at > NOW()
      RETURNING id, caller_user_id, source_call_id, created_at
    `, [creatorUserId]);

    await client.query('COMMIT');

    return {
      creator,
      alerts: claimedRows,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── CREATOR PAYOUTS (V44) ────────────────────────────

function makePayoutIdempotencyKey(payoutId) {
  return `tiyo_payout_${payoutId}_${crypto.randomUUID()}`;
}

async function getCreatorPayoutById(payoutId, client = pool) {
  const { rows } = await client.query(`
    SELECT *
    FROM creator_payouts
    WHERE id = $1
    LIMIT 1
  `, [payoutId]);
  return rows[0] ? normalizeCreatorPayoutRow(rows[0]) : null;
}

async function syncCreatorPayoutState(
  payoutId,
  {
    providerPayoutId = null,
    providerStatus = null,
    failureReason = null,
    externalReference = null,
  } = {},
  existingClient = null
) {
  const ownClient = !existingClient;
  const client = existingClient || await pool.connect();

  try {
    if (ownClient) {
      await client.query('BEGIN');
    }

    const { rows: payoutRows } = await client.query(`
      SELECT *
      FROM creator_payouts
      WHERE id = $1
      FOR UPDATE
    `, [payoutId]);

    if (!payoutRows[0]) {
      if (ownClient) await client.query('ROLLBACK');
      return null;
    }

    const payout = payoutRows[0];
    const currentStatus = normalizePayoutStatus(
      payout.provider_status || (payout.paid_at ? 'processed' : 'processing')
    );
    const nextStatus = normalizePayoutStatus(
      providerStatus || payout.provider_status || (payout.paid_at ? 'processed' : 'processing')
    );

    if (currentStatus === 'processed' && nextStatus !== 'processed') {
      if (ownClient) await client.query('COMMIT');
      return getCreatorPayoutById(payoutId);
    }

    if (FAILED_PROVIDER_STATUSES.has(currentStatus) && nextStatus === 'processed') {
      if (ownClient) await client.query('COMMIT');
      return getCreatorPayoutById(payoutId);
    }

    const { rows: updatedRows } = await client.query(`
      UPDATE creator_payouts
      SET provider = COALESCE(provider, 'razorpayx'),
          provider_payout_id = COALESCE($2, provider_payout_id),
          provider_status = $3,
          failure_reason = CASE
            WHEN $3 = 'processed' THEN NULL
            ELSE COALESCE($4, failure_reason)
          END,
          external_reference = COALESCE($5, external_reference),
          paid_at = CASE
            WHEN $3 = 'processed' THEN COALESCE(paid_at, NOW())
            WHEN $3 IN ('failed', 'rejected', 'reversed') THEN NULL
            ELSE paid_at
          END
      WHERE id = $1
      RETURNING *
    `, [payoutId, providerPayoutId, nextStatus, failureReason, externalReference]);

    const updated = updatedRows[0];

    if (nextStatus === 'processed') {
      await createTransaction(updated.creator_user_id, parseMoney(updated.amount), 'payout', 'success', {
        sourceType: 'payout',
        sourceId: updated.id,
        client,
      });

      await client.query(`
        UPDATE creator_payout_requests
        SET status = 'paid',
            payout_id = $2,
            reason = NULL,
            resolved_at = NOW()
        WHERE creator_user_id = $1
          AND payout_id = $2
          AND status IN ('open', 'processing', 'failed')
      `, [updated.creator_user_id, updated.id]);
    } else if (FAILED_PROVIDER_STATUSES.has(nextStatus)) {
      await client.query(`
        DELETE FROM creator_payout_items
        WHERE payout_id = $1
      `, [updated.id]);

      await client.query(`
        UPDATE creator_payout_requests
        SET status = 'failed',
            reason = COALESCE($3, reason),
            resolved_at = NOW()
        WHERE creator_user_id = $1
          AND payout_id = $2
          AND status IN ('open', 'processing', 'failed')
      `, [updated.creator_user_id, updated.id, failureReason]);
    } else {
      await client.query(`
        UPDATE creator_payout_requests
        SET status = 'processing',
            payout_id = $2,
            reason = NULL,
            resolved_at = NULL
        WHERE creator_user_id = $1
          AND payout_id = $2
          AND status IN ('open', 'processing', 'failed')
      `, [updated.creator_user_id, updated.id]);
    }

    if (ownClient) {
      await client.query('COMMIT');
    }

    return getCreatorPayoutById(updated.id);
  } catch (err) {
    if (ownClient) {
      await client.query('ROLLBACK');
    }
    throw err;
  } finally {
    if (ownClient) {
      client.release();
    }
  }
}

async function adminGetPayouts() {
  const { rows } = await pool.query(`
    SELECT
      u.id,
      COALESCE(u.name, u.phone, 'Creator') AS name,
      u.phone,
      c.is_online,
      c.rate,
      c.video_rate,
      c.payout_upi_id,
      c.payout_upi_verified_name,
      c.payout_upi_verified_at,
      c.payout_upi_last_error,
      c.payout_upi_verification_status,
      COALESCE(pending.pending_payout, 0) AS pending_payout,
      COALESCE(paid.paid_out_till_date, 0) AS paid_out_till_date,
      paid.last_payout_date,
      current_request.id AS current_request_id,
      current_request.requested_amount AS current_request_amount,
      current_request.created_at AS current_request_created_at,
      current_request.status AS current_request_status,
      current_request.reason AS current_request_reason,
      current_request.resolved_at AS current_request_resolved_at,
      current_request.payout_id AS current_request_payout_id,
      latest_payout.id AS latest_payout_id,
      latest_payout.provider_status AS latest_payout_provider_status,
      latest_payout.failure_reason AS latest_payout_failure_reason,
      latest_payout.provider_payout_id AS latest_payout_provider_payout_id,
      latest_payout.approved_at AS latest_payout_approved_at
    FROM creators c
    JOIN users u ON u.id = c.user_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(t.amount), 0) AS pending_payout
      FROM transactions t
      WHERE t.user_id = c.user_id
        AND t.type = 'call_earning'
        AND t.status = 'success'
        AND t.source_type = 'call'
        AND NOT EXISTS (
          SELECT 1
          FROM creator_payout_items cpi
          JOIN creator_payouts cp ON cp.id = cpi.payout_id
          WHERE cpi.transaction_id = t.id
            AND (
              cp.paid_at IS NOT NULL
              OR COALESCE(cp.provider_status, 'processing') NOT IN ('failed', 'rejected', 'reversed')
            )
        )
    ) pending ON true
    LEFT JOIN LATERAL (
      SELECT
        COALESCE(SUM(amount), 0) AS paid_out_till_date,
        MAX(paid_at) AS last_payout_date
      FROM creator_payouts cp
      WHERE cp.creator_user_id = c.user_id
        AND (
          cp.paid_at IS NOT NULL
          OR COALESCE(cp.provider_status, 'processed') = 'processed'
        )
        AND COALESCE(cp.provider_status, 'processed') NOT IN ('failed', 'rejected', 'reversed')
    ) paid ON true
    LEFT JOIN LATERAL (
      SELECT id, requested_amount, created_at, status, reason, resolved_at, payout_id
      FROM creator_payout_requests cpr
      WHERE cpr.creator_user_id = c.user_id
      ORDER BY
        CASE
          WHEN cpr.status = 'open' THEN 0
          WHEN cpr.status = 'processing' THEN 1
          WHEN cpr.status = 'failed' THEN 2
          ELSE 3
        END,
        cpr.created_at DESC
      LIMIT 1
    ) current_request ON true
    LEFT JOIN LATERAL (
      SELECT id, provider_status, failure_reason, provider_payout_id, approved_at
      FROM creator_payouts cp
      WHERE cp.creator_user_id = c.user_id
      ORDER BY cp.created_at DESC, cp.id DESC
      LIMIT 1
    ) latest_payout ON true
    ORDER BY
      (COALESCE(pending.pending_payout, 0) > 0) DESC,
      COALESCE(pending.pending_payout, 0) DESC,
      current_request.created_at DESC NULLS LAST,
      c.total_earnings DESC
  `);

  return rows.map((row) => ({
    ...row,
    rate: parseMoney(row.rate),
    video_rate: parseMoney(row.video_rate),
    pending_payout: parseMoney(row.pending_payout),
    paid_out_till_date: parseMoney(row.paid_out_till_date),
    current_request_amount: row.current_request_amount == null ? 0 : parseMoney(row.current_request_amount),
  }));
}

async function adminApproveAndSendCreatorPayout(creatorId, note = null, options = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: creatorRows } = await client.query(`
      SELECT
        c.payout_upi_id,
        c.payout_fund_account_id,
        c.payout_upi_verification_status,
        COALESCE(u.name, u.phone, 'Creator') AS payout_name
      FROM creators c
      JOIN users u ON u.id = c.user_id
      WHERE c.user_id = $1
      FOR UPDATE
    `, [creatorId]);
    if (!creatorRows[0]) {
      await client.query('ROLLBACK');
      return { error: 'creator_not_found' };
    }
    const payoutRailConfigured = isRazorpayXPayoutConfigured();
    if (!creatorRows[0].payout_upi_id) {
      await client.query('ROLLBACK');
      return { error: 'payout_upi_not_verified' };
    }
    if (payoutRailConfigured && (creatorRows[0].payout_upi_verification_status !== 'verified' || !creatorRows[0].payout_fund_account_id)) {
      await client.query('ROLLBACK');
      return { error: 'payout_upi_not_verified' };
    }

    const pendingTransactions = await getCreatorPendingEarningTransactions(creatorId, client);
    if (pendingTransactions.length === 0) {
      await client.query('ROLLBACK');
      return { error: 'no_pending_payout' };
    }

    const payoutAmount = pendingTransactions.reduce((sum, row) => sum + parseMoney(row.amount), 0);
    const payoutUpiId = creatorRows[0].payout_upi_id || null;

    const { rows: payoutRows } = await client.query(`
      INSERT INTO creator_payouts (
        creator_user_id,
        amount,
        upi_id,
        note,
        provider,
        provider_status,
        idempotency_key,
        approved_at,
        retry_of_payout_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8)
      RETURNING *
    `, [
      creatorId,
      payoutAmount,
      payoutUpiId,
      note || null,
      payoutRailConfigured ? 'razorpayx' : 'manual',
      payoutRailConfigured ? 'processing' : 'processed',
      payoutRailConfigured ? makePayoutIdempotencyKey(Date.now()) : null,
      options.retryOfPayoutId || null,
    ]);
    const payout = payoutRows[0];

    const pendingTransactionIds = pendingTransactions.map((row) => row.id);
    await client.query(`
      INSERT INTO creator_payout_items (payout_id, transaction_id, amount)
      SELECT $1, t.id, t.amount
      FROM transactions t
      WHERE t.id = ANY($2::int[])
    `, [payout.id, pendingTransactionIds]);

    const { rows: requestRows } = await client.query(`
      SELECT id, status
      FROM creator_payout_requests
      WHERE creator_user_id = $1
        AND status IN ('open', 'failed')
      ORDER BY
        CASE WHEN status = 'open' THEN 0 ELSE 1 END,
        created_at DESC,
        id DESC
      LIMIT 1
      FOR UPDATE
    `, [creatorId]);

    if (requestRows[0]) {
      await client.query(`
        UPDATE creator_payout_requests
        SET status = 'processing',
            payout_id = $2,
            reason = NULL,
            resolved_at = NULL
        WHERE id = $1
      `, [requestRows[0].id, payout.id]);
    }

    await client.query('COMMIT');

    if (!payoutRailConfigured) {
      const finalized = await syncCreatorPayoutState(payout.id, {
        providerStatus: 'processed',
      });

      return {
        payout: finalized,
        summary: await getCreatorPayoutSummary(creatorId),
      };
    }

    try {
      const providerPayout = await createRazorpayXPayout({
        fundAccountId: creatorRows[0].payout_fund_account_id,
        amountPaisa: Math.round(payoutAmount * 100),
        idempotencyKey: payout.idempotency_key,
        referenceId: `tiyo_payout_${payout.id}`,
        narration: `TIYO payout for ${creatorRows[0].payout_name}`,
      });

      const synced = await syncCreatorPayoutState(payout.id, {
        providerPayoutId: providerPayout?.id || null,
        providerStatus: providerPayout?.status || 'processing',
        failureReason: providerPayout?.status_details?.description || null,
        externalReference: providerPayout?.utr || providerPayout?.reference_id || null,
      });

      return {
        payout: synced,
        summary: await getCreatorPayoutSummary(creatorId),
      };
    } catch (err) {
      const failureMessage =
        err?.payload?.error?.description ||
        err?.message ||
        'RazorpayX payout send failed';

      const failedPayout = await syncCreatorPayoutState(payout.id, {
        providerStatus: 'failed',
        failureReason: failureMessage,
      });

      return {
        error: err?.code === 'provider_not_configured' ? 'provider_not_configured' : 'provider_send_failed',
        message: failureMessage,
        payout: failedPayout,
        summary: await getCreatorPayoutSummary(creatorId),
      };
    }
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function adminRejectPayoutRequest(requestId, reason = null) {
  const { rows } = await pool.query(`
    UPDATE creator_payout_requests
    SET status = 'rejected',
        reason = $2,
        resolved_at = NOW()
    WHERE id = $1
      AND status = 'open'
    RETURNING *
  `, [requestId, String(reason || '').trim() || null]);

  return rows[0] || null;
}

async function adminRetryFailedPayout(payoutId, note = null) {
  const { rows } = await pool.query(`
    SELECT creator_user_id
    FROM creator_payouts
    WHERE id = $1
      AND COALESCE(provider_status, '') IN ('failed', 'rejected', 'reversed')
    LIMIT 1
  `, [payoutId]);

  if (!rows[0]) {
    return { error: 'failed_payout_not_found' };
  }

  return adminApproveAndSendCreatorPayout(rows[0].creator_user_id, note || null, {
    retryOfPayoutId: payoutId,
  });
}

async function reconcileRazorpayXPayoutWebhook(providerPayoutId, providerStatus, failureReason = null, externalReference = null) {
  const { rows } = await pool.query(`
    SELECT id
    FROM creator_payouts
    WHERE provider_payout_id = $1
    LIMIT 1
  `, [providerPayoutId]);

  if (!rows[0]) {
    return null;
  }

  return syncCreatorPayoutState(rows[0].id, {
    providerPayoutId,
    providerStatus,
    failureReason,
    externalReference,
  });
}

async function adminUpdateCreatorRates(creatorId, rate, videoRate) {
  const { rows } = await pool.query(`
    UPDATE creators
    SET rate = $1,
        video_rate = $2
    WHERE user_id = $3
    RETURNING user_id, rate, video_rate
  `, [rate, videoRate, creatorId]);

  return rows[0] || null;
}

// ─── ADMIN QUERIES (V34) ─────────────────────────────

async function adminGetStats() {
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM users) AS total_users,
      (SELECT COUNT(*) FROM users WHERE role = 'creator') AS total_creators,
      (SELECT COUNT(*) FROM calls) AS total_calls,
      (SELECT COUNT(*) FROM calls WHERE status = 'completed') AS completed_calls,
      (SELECT COALESCE(SUM(total_cost), 0) FROM calls WHERE status = 'completed') AS total_revenue,
      (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE type = 'topup' AND status = 'success') AS total_recharges,
      (SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '7 days') AS new_users_7d,
      (SELECT COUNT(*) FROM calls WHERE created_at > NOW() - INTERVAL '7 days') AS calls_7d
  `);
  const stats = rows[0];
  return {
    totalUsers: parseInt(stats.total_users),
    totalCreators: parseInt(stats.total_creators),
    totalCalls: parseInt(stats.total_calls),
    completedCalls: parseInt(stats.completed_calls),
    totalRevenue: parseFloat(stats.total_revenue),
    totalRecharges: parseFloat(stats.total_recharges),
    newUsers7d: parseInt(stats.new_users_7d),
    calls7d: parseInt(stats.calls_7d),
  };
}

async function adminGetUsers(limit = 50, offset = 0) {
  const { rows } = await pool.query(`
    SELECT u.id, u.name, u.phone, u.role, u.bio, u.created_at,
           COALESCE(w.balance, 0) AS balance
    FROM users u
    LEFT JOIN wallets w ON u.id = w.user_id
    ORDER BY u.id DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset]);
  return rows.map(r => ({ ...r, balance: parseFloat(r.balance) }));
}

async function adminGetCreators() {
  const { rows } = await pool.query(`
    SELECT u.id, u.name, u.phone, u.created_at,
           c.rate, c.video_rate, c.languages, c.categories, c.is_online, c.payout_upi_id,
           c.rating, c.total_calls, c.total_earnings,
           COALESCE(w.balance, 0) AS balance
    FROM creators c
    JOIN users u ON c.user_id = u.id
    LEFT JOIN wallets w ON u.id = w.user_id
    ORDER BY c.total_earnings DESC
  `);
  return rows.map(r => ({
    ...r,
    rate: parseFloat(r.rate),
    video_rate: parseFloat(r.video_rate),
    total_earnings: parseFloat(r.total_earnings),
    balance: parseFloat(r.balance),
    rating: parseFloat(r.rating),
  }));
}

async function adminGetCalls(limit = 50, offset = 0) {
  const { rows } = await pool.query(`
    SELECT c.id, c.call_type, c.status, c.duration_seconds, c.total_cost, c.created_at,
           c.caller_id, c.receiver_id,
           c.end_reason AS "endReason", c.ended_by_user_id AS "endedByUserId",
           caller.name AS caller_name, caller.phone AS caller_phone,
           receiver.name AS receiver_name, receiver.phone AS receiver_phone
    FROM calls c
    LEFT JOIN users caller ON c.caller_id = caller.id
    LEFT JOIN users receiver ON c.receiver_id = receiver.id
    ORDER BY c.created_at DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset]);
  return rows.map(r => ({
    ...r,
    total_cost: r.total_cost ? parseFloat(r.total_cost) : 0,
  }));
}

async function adminGetTransactions(limit = 50, offset = 0) {
  const { rows } = await pool.query(`
    SELECT t.id, t.amount, t.type, t.status, t.source_type, t.source_id, t.created_at,
           u.name AS user_name, u.phone AS user_phone
    FROM transactions t
    LEFT JOIN users u ON t.user_id = u.id
    ORDER BY t.created_at DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset]);
  return rows.map(r => ({ ...r, amount: parseFloat(r.amount) }));
}

// ─── BLOCKS & SUSPENSION (V38) ─────────────────────────

async function blockUser(blockerId, blockedId) {
  const { rows } = await pool.query(`
    INSERT INTO blocks (blocker_id, blocked_id)
    VALUES ($1, $2)
    ON CONFLICT (blocker_id, blocked_id) DO NOTHING
    RETURNING *
  `, [blockerId, blockedId]);
  return rows[0] || null;
}

async function unblockUser(blockerId, blockedId) {
  const { rows } = await pool.query(
    'DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2 RETURNING *',
    [blockerId, blockedId]
  );
  return rows[0] || null;
}

async function getBlockedUsers(blockerId) {
  const { rows } = await pool.query(`
    SELECT b.blocked_id AS id, b.created_at,
           COALESCE(u.name, u.phone, 'Unknown') AS name, u.phone
    FROM blocks b
    JOIN users u ON b.blocked_id = u.id
    WHERE b.blocker_id = $1
    ORDER BY b.created_at DESC
  `, [blockerId]);
  return rows;
}

async function isBlocked(blockerId, blockedId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2',
    [blockerId, blockedId]
  );
  return rows.length > 0;
}

async function checkAndSuspendUser(userId, threshold = 3) {
  const { rows } = await pool.query(
    'SELECT COUNT(DISTINCT blocker_id)::int AS cnt FROM blocks WHERE blocked_id = $1',
    [userId]
  );
  if (rows[0].cnt >= threshold) {
    await pool.query(
      "UPDATE users SET status = 'suspended' WHERE id = $1 AND status = 'active'",
      [userId]
    );
    return { suspended: true, blockCount: rows[0].cnt };
  }
  return { suspended: false, blockCount: rows[0].cnt };
}

async function unsuspendUser(userId) {
  const { rows } = await pool.query(
    "UPDATE users SET status = 'active' WHERE id = $1 RETURNING *",
    [userId]
  );
  return rows[0] || null;
}

async function getUserStatus(userId) {
  const { rows } = await pool.query('SELECT status FROM users WHERE id = $1', [userId]);
  return rows[0]?.status || 'active';
}

async function adminGetSuspendedUsers() {
  const { rows } = await pool.query(`
    SELECT u.id, u.name, u.phone, u.status, u.created_at,
           COUNT(b.id)::int AS block_count
    FROM users u
    LEFT JOIN blocks b ON u.id = b.blocked_id
    WHERE u.status = 'suspended'
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `);
  return rows;
}

module.exports = {
  RINGING_TIMEOUT_SECONDS,
  findUserByPhone,
  findUserById,
  createNotification,
  getNotificationsForUser,
  markNotificationRead,
  markAllNotificationsRead,
  createUser,
  updateUserName,
  getCreators,
  getCreatorById,
  getWalletBalance,
  updateWalletBalance,
  createTransaction,
  getUserTransactions,
  getUserRecharges,
  createCallRecord,
  getUserCalls,
  getCreatorReceivedCalls,
  getCreatorReceivedCallDetail,
  submitCreatorRating,
  submitCallerRating,
  processCallEnd,
  initiateCall,
  connectCallById,
  acceptCallById,
  getCallById,
  processCallEndById,
  // V32 — Creator Mode
  savePushToken,
  registerCreator,
  updateCreatorProfile,
  toggleCreatorAvailability,
  setCreatorAvailability,
  getCreatorDashboard,
  getCreatorPayoutSummary,
  getCreatorPayoutHistory,
  updateCreatorPayoutDetails,
  createCreatorPayoutRequest,
  createOrRefreshCreatorFreeAlert,
  cancelCreatorFreeAlert,
  claimCreatorFreeAlertsForDispatch,
  getCreatorIncomingCalls,
  rejectCallById,
  adminGetPayouts,
  adminApproveAndSendCreatorPayout,
  adminRejectPayoutRequest,
  adminRetryFailedPayout,
  reconcileRazorpayXPayoutWebhook,
  adminUpdateCreatorRates,
  // V34 — Admin Dashboard
  adminGetStats,
  adminGetUsers,
  adminGetCreators,
  adminGetCalls,
  adminGetTransactions,
  // V38 — Handle, Blocks, Suspension
  updateUserHandle,
  isHandleAvailable,
  blockUser,
  unblockUser,
  getBlockedUsers,
  isBlocked,
  checkAndSuspendUser,
  unsuspendUser,
  getUserStatus,
  adminGetSuspendedUsers,
  cleanupStaleRingingCalls,
  cleanupSupersededConnectedCalls,
  cleanupExpiredCallStates,
  getOngoingCallForUser,
  TERMINAL_REASON_HINTS,
};
