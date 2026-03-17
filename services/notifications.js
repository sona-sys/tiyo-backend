const { Expo } = require('expo-server-sdk');
const pool = require('../db/pool');

const expo = new Expo();

// ─── Send Push Notification ──────────────────────────────
async function sendPushNotification(pushToken, title, body, data = {}) {
  if (!pushToken || !Expo.isExpoPushToken(pushToken)) {
    console.log('Invalid or missing push token, skipping notification');
    return null;
  }

  const message = {
    to: pushToken,
    sound: 'default',
    title,
    body,
    data,
  };

  try {
    const chunks = expo.chunkPushNotifications([message]);
    for (const chunk of chunks) {
      const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
      console.log('Push notification sent:', ticketChunk);
    }
    return true;
  } catch (err) {
    console.error('Failed to send push notification:', err);
    return null;
  }
}

// ─── Store Notification in DB ────────────────────────────
async function storeNotification(userId, title, body, type, data = {}) {
  try {
    const { rows } = await pool.query(`
      INSERT INTO notifications (user_id, title, body, type, data)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [userId, title, body, type, JSON.stringify(data)]);
    return rows[0];
  } catch (err) {
    console.error('Failed to store notification:', err);
    return null;
  }
}

// ─── Specific Notification Types ─────────────────────────

async function sendCallNotification(creatorUserId, callerName) {
  const title = 'Incoming Call';
  const body = `${callerName || 'Someone'} is calling you`;

  // Get creator's push token
  const { rows } = await pool.query('SELECT push_token FROM users WHERE id = $1', [creatorUserId]);
  const pushToken = rows[0]?.push_token;

  await storeNotification(creatorUserId, title, body, 'call_incoming', { callerName });
  await sendPushNotification(pushToken, title, body, { type: 'call_incoming', callerName });
}

async function sendPaymentConfirmation(userId, amount) {
  const title = 'Payment Successful';
  const body = `₹${amount} added to your wallet`;

  const { rows } = await pool.query('SELECT push_token FROM users WHERE id = $1', [userId]);
  const pushToken = rows[0]?.push_token;

  await storeNotification(userId, title, body, 'payment_success', { amount });
  await sendPushNotification(pushToken, title, body, { type: 'payment_success', amount });
}

async function sendCallEndSummary(userId, creatorName, durationSeconds, cost) {
  const minutes = Math.floor(durationSeconds / 60);
  const seconds = durationSeconds % 60;
  const durationStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

  const title = 'Call Ended';
  const body = `Call with ${creatorName}: ${durationStr}, ₹${cost} charged`;

  const { rows } = await pool.query('SELECT push_token FROM users WHERE id = $1', [userId]);
  const pushToken = rows[0]?.push_token;

  await storeNotification(userId, title, body, 'call_summary', {
    creatorName, durationSeconds, cost
  });
  await sendPushNotification(pushToken, title, body, {
    type: 'call_summary', creatorName, durationSeconds, cost
  });
}

// ─── Notification Queries ────────────────────────────────

async function getUserNotifications(userId, limit = 50) {
  const { rows } = await pool.query(`
    SELECT id, title, body, type, data, read, created_at
    FROM notifications
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT $2
  `, [userId, limit]);
  return rows;
}

async function markNotificationRead(notificationId, userId) {
  const { rows } = await pool.query(`
    UPDATE notifications SET read = TRUE
    WHERE id = $1 AND user_id = $2
    RETURNING *
  `, [notificationId, userId]);
  return rows[0] || null;
}

async function markAllNotificationsRead(userId) {
  await pool.query(
    'UPDATE notifications SET read = TRUE WHERE user_id = $1 AND read = FALSE',
    [userId]
  );
}

async function getUnreadCount(userId) {
  const { rows } = await pool.query(
    'SELECT COUNT(*) AS count FROM notifications WHERE user_id = $1 AND read = FALSE',
    [userId]
  );
  return parseInt(rows[0].count);
}

module.exports = {
  sendPushNotification,
  storeNotification,
  sendCallNotification,
  sendPaymentConfirmation,
  sendCallEndSummary,
  getUserNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  getUnreadCount,
};
