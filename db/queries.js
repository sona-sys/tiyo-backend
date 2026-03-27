const pool = require('./pool');

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
    ORDER BY u.id
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

async function createTransaction(userId, amount, type, status = 'success') {
  const { rows } = await pool.query(`
    INSERT INTO transactions (user_id, amount, type, status)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `, [userId, amount, type, status]);
  return rows[0];
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
    amount: -parseFloat(c.total_cost),
    title: `Call with ${c.creator_name || 'Unknown'}`,
    durationSeconds: c.duration_seconds,
    timestamp: c.timestamp
  }));

  const earningEntries = earnings.map(c => ({
    id: `earning_${c.id}`,
    type: 'earning',
    amount: parseFloat(c.total_cost),
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
    cost: parseFloat(r.cost)
  }));
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

async function connectCallById(callId) {
  const { rows } = await pool.query(`
    UPDATE calls SET status = 'connected', start_time = NOW()
    WHERE id = $1 AND status = 'ringing'
    RETURNING *
  `, [callId]);
  return rows[0] || null;
}

async function getCallById(callId) {
  const { rows } = await pool.query('SELECT * FROM calls WHERE id = $1', [callId]);
  return rows[0] || null;
}

async function processCallEndById(callId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: callRows } = await client.query(
      'SELECT * FROM calls WHERE id = $1 FOR UPDATE',
      [callId]
    );
    if (!callRows[0]) throw new Error('Call not found');
    const call = callRows[0];

    if (call.status === 'completed') {
      await client.query('ROLLBACK');
      return { error: 'Call already ended' };
    }

    // If call never connected, mark as missed — no charge
    if (call.status === 'ringing' || !call.start_time) {
      await client.query(
        `UPDATE calls SET status = 'missed', end_time = NOW() WHERE id = $1`,
        [callId]
      );
      await client.query('COMMIT');
      return { success: true, cost: 0, duration: 0, remainingBalance: null, missed: true };
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
    const balance = parseFloat(walletRows[0]?.balance || 0);
    const chargeAmount = Math.min(totalCost, balance);

    const { rows: updatedWallet } = await client.query(
      'UPDATE wallets SET balance = balance - $1, updated_at = NOW() WHERE user_id = $2 RETURNING balance',
      [chargeAmount, call.caller_id]
    );

    await client.query(
      'UPDATE creators SET total_earnings = total_earnings + $1, total_calls = total_calls + 1 WHERE user_id = $2',
      [chargeAmount, call.receiver_id]
    );

    await client.query(`
      UPDATE calls SET status = 'completed', end_time = NOW(),
        duration_seconds = $1, total_cost = $2
      WHERE id = $3
    `, [durationSeconds, chargeAmount, callId]);

    // Record transaction for caller (debit)
    await client.query(
      `INSERT INTO transactions (user_id, amount, type, status) VALUES ($1, $2, 'call_debit', 'success')`,
      [call.caller_id, -chargeAmount]
    );

    // Record transaction for creator (credit / earnings)
    await client.query(
      `INSERT INTO transactions (user_id, amount, type, status) VALUES ($1, $2, 'call_earning', 'success')`,
      [call.receiver_id, chargeAmount]
    );

    await client.query('COMMIT');

    return {
      success: true,
      duration: durationSeconds,
      cost: chargeAmount,
      remainingBalance: parseFloat(updatedWallet[0].balance),
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

async function registerCreator(userId, { rate, videoRate, bio, languages, categories }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Update user role to 'creator'
    await client.query(
      "UPDATE users SET role = 'creator', bio = $1 WHERE id = $2",
      [bio || null, userId]
    );

    // Insert into creators table with separate voice and video rates
    const voiceRate = rate || 10;
    const vidRate = videoRate || Math.round(voiceRate * 1.5); // default video rate is 1.5x voice
    await client.query(`
      INSERT INTO creators (user_id, rate, video_rate, languages, categories, is_online)
      VALUES ($1, $2, $3, $4, $5, true)
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

  return {
    ...creatorRows[0],
    balance: walletRows[0] ? parseFloat(walletRows[0].balance) : 0,
    total_earnings: parseFloat(creatorRows[0].total_earnings),
    recentCalls: recentCalls.map(c => ({
      ...c,
      total_cost: c.total_cost ? parseFloat(c.total_cost) : 0,
    })),
  };
}

async function getCreatorIncomingCalls(userId) {
  const { rows } = await pool.query(`
    SELECT c.id, c.caller_id, c.channel_name, c.call_type, c.status, c.created_at,
           u.name AS caller_name
    FROM calls c
    JOIN users u ON c.caller_id = u.id
    WHERE c.receiver_id = $1 AND c.status = 'ringing'
    ORDER BY c.created_at DESC
  `, [userId]);
  return rows;
}

async function rejectCallById(callId) {
  const { rows } = await pool.query(`
    UPDATE calls SET status = 'rejected', end_time = NOW()
    WHERE id = $1 AND status = 'ringing'
    RETURNING *
  `, [callId]);
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
           c.rate, c.video_rate, c.languages, c.categories, c.is_online,
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
    SELECT t.id, t.amount, t.type, t.status, t.created_at,
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
  processCallEnd,
  initiateCall,
  connectCallById,
  getCallById,
  processCallEndById,
  // V32 — Creator Mode
  savePushToken,
  registerCreator,
  updateCreatorProfile,
  toggleCreatorAvailability,
  getCreatorDashboard,
  getCreatorIncomingCalls,
  rejectCallById,
  // V34 — Admin Dashboard
  adminGetStats,
  adminGetUsers,
  adminGetCreators,
  adminGetCalls,
  adminGetTransactions,
  // V38 — Handle, Blocks, Suspension
  updateUserHandle,
  blockUser,
  unblockUser,
  getBlockedUsers,
  isBlocked,
  checkAndSuspendUser,
  unsuspendUser,
  getUserStatus,
  adminGetSuspendedUsers,
};
