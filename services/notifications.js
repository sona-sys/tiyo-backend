// Push notification service using Expo Push Notifications
const { Expo } = require('expo-server-sdk');
const pool = require('../db/pool');

const expo = new Expo();

async function sendPushNotification(pushToken, title, body, data = {}) {
  if (!Expo.isExpoPushToken(pushToken)) {
    console.log(`Invalid Expo push token: ${pushToken}`);
    return null;
  }

  try {
    const [ticket] = await expo.sendPushNotificationsAsync([
      {
        to: pushToken,
        sound: 'default',
        title,
        body,
        data,
        priority: 'high',
      },
    ]);
    console.log(`Push sent to ${pushToken}: ${title}`, ticket);
    return ticket;
  } catch (err) {
    console.error('Push notification error:', err.message);
    return null;
  }
}

async function sendCallNotificationToCreator(creatorUserId, callerName, callId, channelName) {
  const { rows } = await pool.query(
    'SELECT push_token FROM users WHERE id = $1',
    [creatorUserId]
  );
  const pushToken = rows[0]?.push_token;
  if (!pushToken) {
    console.log(`No push token for creator ${creatorUserId}`);
    return null;
  }

  return sendPushNotification(
    pushToken,
    'Incoming Call',
    `${callerName || 'Someone'} is calling you`,
    {
      type: 'incoming_call',
      callId,
      channelName,
      callerName: callerName || 'User',
    }
  );
}

module.exports = { sendPushNotification, sendCallNotificationToCreator };
