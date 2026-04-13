const pool = require('./pool');
const RINGING_TIMEOUT_SECONDS = 35;
const TERMINAL_REASON_HINTS = new Set(['remote_left', 'network_drop_timeout']);
const BASIC_UPI_REGEX = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z0-9.-]{2,64}$/;

const parseMoney = (value) => {
  const amount = parseFloat(value);
  return Number.isFinite(amount) ? amount : 0;
};

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
      c.is_online AS "online", c.rating, c.total_calls AS "totalCalls"
    FROM users u
    JOIN creators c ON u.id = c.user_id
    WHERE u.role = 'creator' AND u.name IS NOT NULL AND u.name != ''
      AND u.status = 'active'
      AND ($1::int IS NULL OR u.id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id = $1))
    ORDER BY c.is_online DESC, c.rating DESC NULLS LAST, u.id
  `, [requestingUserId]);
  return rows;
}

async function getCreatorById(id) {
  const { rows } = await pool.query(`
    SELECT
      u.id, u.name, u.handle, u.role, u.bio,
      c.rate, c.video_rate AS "videoRate", c.languages, c.categories, c.image_color AS "imageColor",
      c.is_online AS "online", c.rating, c.total_calls AS "totalCalls"
    FROM users u
    JOIN creators c ON u.id = c.user_id
    WHERE u.id = $1
  `, [id]);
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
    LEFT JOIN creator_payout_items cpi ON cpi.transaction_id = t.id
    WHERE t.user_id = $1
      AND t.type = 'call_earning'
      AND t.status = 'success'
      AND t.source_type = 'call'
      AND cpi.transaction_id IS NULL
    ORDER BY t.created_at ASC, t.id ASC
  `, [creatorUserId]);

  return rows.map((row) => ({
    ...row,
    amount: parseMoney(row.amount),
  }));
}

async function getCreatorPayoutSummary(userId, client = pool) {
  const { rows: creatorRows } = await client.query(`
    SELECT payout_upi_id, payout_upi_updated_at
    FROM creators
    WHERE user_id = $1
  `, [userId]);

  if (!creatorRows[0]) {
    return null;
  }

  const { rows: pendingRows } = await client.query(`
    SELECT COALESCE(SUM(t.amount), 0) AS pending_payout
    FROM transactions t
    LEFT JOIN creator_payout_items cpi ON cpi.transaction_id = t.id
    WHERE t.user_id = $1
      AND t.type = 'call_earning'
      AND t.status = 'success'
      AND t.source_type = 'call'
      AND cpi.transaction_id IS NULL
  `, [userId]);

  const { rows: paidRows } = await client.query(`
    SELECT
      COALESCE(SUM(amount), 0) AS paid_out_till_date,
      MAX(paid_at) AS last_payout_date
    FROM creator_payouts
    WHERE creator_user_id = $1
  `, [userId]);

  const { rows: requestRows } = await client.query(`
    SELECT
      id,
      requested_amount,
      upi_id,
      status,
      reason,
      payout_id,
      created_at,
      resolved_at
    FROM creator_payout_requests
    WHERE creator_user_id = $1
    ORDER BY
      CASE WHEN status = 'open' THEN 0 ELSE 1 END,
      created_at DESC
    LIMIT 1
  `, [userId]);

  const currentRequest = requestRows[0]
    ? {
        id: requestRows[0].id,
        requestedAmount: parseMoney(requestRows[0].requested_amount),
        upiId: requestRows[0].upi_id || null,
        status: requestRows[0].status,
        reason: requestRows[0].reason || null,
        payoutId: requestRows[0].payout_id || null,
        createdAt: requestRows[0].created_at,
        resolvedAt: requestRows[0].resolved_at,
      }
    : null;

  return {
    payoutUpiId: creatorRows[0].payout_upi_id || null,
    payoutUpiUpdatedAt: creatorRows[0].payout_upi_updated_at || null,
    pendingPayout: parseMoney(pendingRows[0]?.pending_payout),
    paidOutTillDate: parseMoney(paidRows[0]?.paid_out_till_date),
    lastPayoutDate: paidRows[0]?.last_payout_date || null,
    currentRequest,
    hasOpenRequest: currentRequest?.status === 'open',
  };
}

async function getCreatorPayoutHistory(userId, client = pool) {
  const summary = await getCreatorPayoutSummary(userId, client);
  if (!summary) {
    return null;
  }

  const { rows: payoutRows } = await client.query(`
    SELECT id, amount, upi_id, external_reference, note, paid_at, created_at
    FROM creator_payouts
    WHERE creator_user_id = $1
    ORDER BY paid_at DESC, id DESC
  `, [userId]);

  const { rows: requestRows } = await client.query(`
    SELECT id, requested_amount, upi_id, status, reason, payout_id, created_at, resolved_at
    FROM creator_payout_requests
    WHERE creator_user_id = $1
    ORDER BY created_at DESC, id DESC
  `, [userId]);

  return {
    summary,
    payouts: payoutRows.map((row) => ({
      id: row.id,
      amount: parseMoney(row.amount),
      upiId: row.upi_id || null,
      externalReference: row.external_reference || null,
      note: row.note || null,
      paidAt: row.paid_at,
      createdAt: row.created_at,
    })),
    requests: requestRows.map((row) => ({
      id: row.id,
      requestedAmount: parseMoney(row.requested_amount),
      upiId: row.upi_id || null,
      status: row.status,
      reason: row.reason || null,
      payoutId: row.payout_id || null,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
    })),
  };
}

async function updateCreatorPayoutDetails(userId, upiId) {
  const normalizedUpi = String(upiId || '').trim().toLowerCase();
  if (normalizedUpi && !BASIC_UPI_REGEX.test(normalizedUpi)) {
    return { error: 'invalid_upi' };
  }

  const { rows } = await pool.query(`
    UPDATE creators
    SET payout_upi_id = $1,
        payout_upi_updated_at = CASE WHEN $1 IS NULL THEN NULL ELSE NOW() END
    WHERE user_id = $2
    RETURNING payout_upi_id, payout_upi_updated_at
  `, [normalizedUpi || null, userId]);

  return rows[0] || null;
}

async function createCreatorPayoutRequest(userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: creatorRows } = await client.query(`
      SELECT payout_upi_id
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

    const { rows: openRequestRows } = await client.query(`
      SELECT id
      FROM creator_payout_requests
      WHERE creator_user_id = $1 AND status = 'open'
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
  const { rows } = await pool.query(`
    INSERT INTO calls (caller_id, receiver_id, channel_name, call_type, status)
    VALUES ($1, $2, $3, $4, 'ringing')
    RETURNING *
  `, [callerId, receiverId, channelName, callType]);
  return rows[0];
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
    RETURNING id
  `, [timeoutSeconds]);
  return rows.length;
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
    RETURNING id
  `);
  return rows.length;
}

async function cleanupExpiredCallStates(timeoutSeconds = RINGING_TIMEOUT_SECONDS) {
  const staleRinging = await cleanupStaleRingingCalls(timeoutSeconds);
  const supersededConnected = await cleanupSupersededConnectedCalls();
  return { staleRinging, supersededConnected };
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
           u.name, u.bio, u.phone
    FROM creators c
    JOIN users u ON c.user_id = u.id
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
  await cleanupExpiredCallStates();
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

// ─── CREATOR PAYOUTS (V44) ────────────────────────────

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
      COALESCE(pending.pending_payout, 0) AS pending_payout,
      COALESCE(paid.paid_out_till_date, 0) AS paid_out_till_date,
      paid.last_payout_date,
      open_request.id AS open_request_id,
      open_request.requested_amount AS open_request_amount,
      open_request.created_at AS open_request_created_at
    FROM creators c
    JOIN users u ON u.id = c.user_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(t.amount), 0) AS pending_payout
      FROM transactions t
      LEFT JOIN creator_payout_items cpi ON cpi.transaction_id = t.id
      WHERE t.user_id = c.user_id
        AND t.type = 'call_earning'
        AND t.status = 'success'
        AND t.source_type = 'call'
        AND cpi.transaction_id IS NULL
    ) pending ON true
    LEFT JOIN LATERAL (
      SELECT
        COALESCE(SUM(amount), 0) AS paid_out_till_date,
        MAX(paid_at) AS last_payout_date
      FROM creator_payouts cp
      WHERE cp.creator_user_id = c.user_id
    ) paid ON true
    LEFT JOIN LATERAL (
      SELECT id, requested_amount, created_at
      FROM creator_payout_requests cpr
      WHERE cpr.creator_user_id = c.user_id
        AND cpr.status = 'open'
      ORDER BY cpr.created_at DESC
      LIMIT 1
    ) open_request ON true
    ORDER BY
      (COALESCE(pending.pending_payout, 0) > 0) DESC,
      COALESCE(pending.pending_payout, 0) DESC,
      open_request.created_at DESC NULLS LAST,
      c.total_earnings DESC
  `);

  return rows.map((row) => ({
    ...row,
    rate: parseMoney(row.rate),
    video_rate: parseMoney(row.video_rate),
    pending_payout: parseMoney(row.pending_payout),
    paid_out_till_date: parseMoney(row.paid_out_till_date),
    open_request_amount: row.open_request_amount == null ? 0 : parseMoney(row.open_request_amount),
  }));
}

async function adminMarkCreatorPendingPaid(creatorId, externalReference, note = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: creatorRows } = await client.query(`
      SELECT payout_upi_id
      FROM creators
      WHERE user_id = $1
      FOR UPDATE
    `, [creatorId]);
    if (!creatorRows[0]) {
      await client.query('ROLLBACK');
      return { error: 'creator_not_found' };
    }

    const pendingTransactions = await getCreatorPendingEarningTransactions(creatorId, client);
    if (pendingTransactions.length === 0) {
      await client.query('ROLLBACK');
      return { error: 'no_pending_payout' };
    }

    const payoutAmount = pendingTransactions.reduce((sum, row) => sum + parseMoney(row.amount), 0);
    const payoutUpiId = creatorRows[0].payout_upi_id || null;

    const { rows: payoutRows } = await client.query(`
      INSERT INTO creator_payouts (creator_user_id, amount, upi_id, external_reference, note, paid_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING *
    `, [creatorId, payoutAmount, payoutUpiId, externalReference, note || null]);
    const payout = payoutRows[0];

    const pendingTransactionIds = pendingTransactions.map((row) => row.id);
    await client.query(`
      INSERT INTO creator_payout_items (payout_id, transaction_id, amount)
      SELECT $1, t.id, t.amount
      FROM transactions t
      WHERE t.id = ANY($2::int[])
    `, [payout.id, pendingTransactionIds]);

    await createTransaction(creatorId, payoutAmount, 'payout', 'success', {
      sourceType: 'payout',
      sourceId: payout.id,
      client,
    });

    await client.query(`
      UPDATE creator_payout_requests
      SET status = 'paid',
          payout_id = $2,
          reason = NULL,
          resolved_at = NOW()
      WHERE creator_user_id = $1
        AND status = 'open'
    `, [creatorId, payout.id]);

    await client.query('COMMIT');

    return {
      payout: {
        id: payout.id,
        amount: parseMoney(payout.amount),
        upiId: payout.upi_id || null,
        externalReference: payout.external_reference || null,
        note: payout.note || null,
        paidAt: payout.paid_at,
      },
      summary: await getCreatorPayoutSummary(creatorId),
    };
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
  getCreatorIncomingCalls,
  rejectCallById,
  adminGetPayouts,
  adminMarkCreatorPendingPaid,
  adminRejectPayoutRequest,
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
