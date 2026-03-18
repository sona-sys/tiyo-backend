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

// ─── CREATORS ───────────────────────────────────────────

async function getCreators() {
  const { rows } = await pool.query(`
    SELECT
      u.id, u.name, u.role, u.bio,
      c.rate, c.languages, c.categories, c.image_color AS "imageColor",
      c.avatar_url, c.is_online AS "online", c.rating, c.total_calls AS "totalCalls"
    FROM users u
    JOIN creators c ON u.id = c.user_id
    WHERE u.role = 'creator'
    ORDER BY u.id
  `);
  return rows;
}

async function getCreatorById(id) {
  const { rows } = await pool.query(`
    SELECT
      u.id, u.name, u.role, u.bio,
      c.rate, c.languages, c.categories, c.image_color AS "imageColor",
      c.avatar_url, c.is_online AS "online", c.rating, c.total_calls AS "totalCalls"
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

async function getUserTransactions(userId, page = 1, limit = 20) {
  const offset = (page - 1) * limit;

  // Get top-up transactions
  const { rows: topups } = await pool.query(`
    SELECT id, amount, type, status, created_at AS timestamp
    FROM transactions
    WHERE user_id = $1 AND type = 'topup' AND status = 'success'
    ORDER BY created_at DESC
  `, [userId]);

  // Get call deductions
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

  const combined = [...topupEntries, ...callEntries, initialEntry]
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  // Paginate the combined result
  const total = combined.length;
  const paginated = combined.slice(offset, offset + limit);

  return { data: paginated, page, limit, total, hasMore: offset + limit < total };
}

async function getUserRecharges(userId, page = 1, limit = 20) {
  const offset = (page - 1) * limit;

  const { rows: countRows } = await pool.query(
    'SELECT COUNT(*) AS total FROM transactions WHERE user_id = $1 AND type = $2',
    [userId, 'topup']
  );
  const total = parseInt(countRows[0].total);

  const { rows } = await pool.query(`
    SELECT id, user_id AS "userId", amount, type, status, created_at AS timestamp
    FROM transactions
    WHERE user_id = $1 AND type = 'topup'
    ORDER BY created_at DESC
    LIMIT $2 OFFSET $3
  `, [userId, limit, offset]);

  const data = rows.map(r => ({ ...r, amount: parseFloat(r.amount) }));

  return { data, page, limit, total, hasMore: offset + limit < total };
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

async function getUserCalls(userId, page = 1, limit = 20) {
  const offset = (page - 1) * limit;

  const { rows: countRows } = await pool.query(
    'SELECT COUNT(*) AS total FROM calls WHERE caller_id = $1',
    [userId]
  );
  const total = parseInt(countRows[0].total);

  const { rows } = await pool.query(`
    SELECT
      c.id,
      u.name AS "creatorName",
      cr.image_color AS "creatorColor",
      cr.avatar_url AS "creatorAvatarUrl",
      c.duration_seconds AS "durationSeconds",
      c.total_cost AS cost,
      c.created_at AS timestamp
    FROM calls c
    JOIN users u ON c.receiver_id = u.id
    LEFT JOIN creators cr ON c.receiver_id = cr.user_id
    WHERE c.caller_id = $1
    ORDER BY c.created_at DESC
    LIMIT $2 OFFSET $3
  `, [userId, limit, offset]);

  const data = rows.map(r => ({ ...r, cost: parseFloat(r.cost) }));

  return { data, page, limit, total, hasMore: offset + limit < total };
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
      'SELECT rate FROM creators WHERE user_id = $1',
      [call.receiver_id]
    );
    if (!creatorRows[0]) throw new Error('Creator not found');
    const rate = parseFloat(creatorRows[0].rate);

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

    // Get creator rate
    const { rows: creatorRows } = await client.query(
      'SELECT rate FROM creators WHERE user_id = $1',
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
};
