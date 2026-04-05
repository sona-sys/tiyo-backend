// Push notification service using direct Firebase Cloud Messaging
const admin = require('firebase-admin');
const pool = require('../db/pool');

let firebaseApp = null;
let loggedMissingConfig = false;
let loggedInitFailure = false;

function normalizePrivateKey(value) {
  return typeof value === 'string' ? value.replace(/\\n/g, '\n') : value;
}

function getFirebaseServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      const parsed = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      if (parsed.private_key) {
        parsed.private_key = normalizePrivateKey(parsed.private_key);
      }
      return parsed;
    } catch (err) {
      if (!loggedInitFailure) {
        loggedInitFailure = true;
        console.error('Invalid FIREBASE_SERVICE_ACCOUNT_JSON:', err.message);
      }
      return null;
    }
  }

  if (
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY
  ) {
    return {
      project_id: process.env.FIREBASE_PROJECT_ID,
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      private_key: normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY),
    };
  }

  return null;
}

function getFirebaseMessaging() {
  if (firebaseApp) {
    return admin.messaging(firebaseApp);
  }

  const serviceAccount = getFirebaseServiceAccount();
  if (!serviceAccount) {
    if (!loggedMissingConfig) {
      loggedMissingConfig = true;
      console.warn('Firebase Admin is not configured. Incoming-call push will fall back to polling.');
    }
    return null;
  }

  try {
    firebaseApp = admin.apps.length
      ? admin.app()
      : admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
          projectId: serviceAccount.project_id || process.env.FIREBASE_PROJECT_ID,
        });
    return admin.messaging(firebaseApp);
  } catch (err) {
    if (!loggedInitFailure) {
      loggedInitFailure = true;
      console.error('Firebase Admin init error:', err.message);
    }
    return null;
  }
}

function serializeData(data = {}) {
  return Object.entries(data).reduce((acc, [key, value]) => {
    if (value == null) {
      return acc;
    }
    acc[key] = typeof value === 'string' ? value : String(value);
    return acc;
  }, {});
}

async function clearStoredPushToken(userId) {
  try {
    await pool.query('UPDATE users SET push_token = NULL WHERE id = $1', [userId]);
  } catch (err) {
    console.error(`Failed to clear push token for user ${userId}:`, err.message);
  }
}

async function sendPushNotification({ userId = null, pushToken, title, body, data = {} }) {
  if (!pushToken || typeof pushToken !== 'string') {
    return null;
  }

  const messaging = getFirebaseMessaging();
  if (!messaging) {
    return null;
  }

  const message = {
    token: pushToken,
    notification: {
      title,
      body,
    },
    data: serializeData(data),
    android: {
      priority: 'high',
      ttl: 35000,
      notification: {
        channelId: 'incoming-calls',
        priority: 'max',
        sound: 'default',
        visibility: 'public',
        tag: data.callId ? `incoming-call-${data.callId}` : 'incoming-call',
        sticky: true,
        localOnly: true,
        defaultVibrateTimings: true,
        eventTimestamp: new Date(),
      },
    },
  };

  try {
    const messageId = await messaging.send(message);
    console.log(`FCM push sent to ${userId || 'unknown'}: ${messageId}`);
    return messageId;
  } catch (err) {
    const errorCode = err?.errorInfo?.code || err?.code || 'unknown';
    console.error('FCM push error:', errorCode, err.message);

    if (
      userId &&
      (errorCode === 'messaging/registration-token-not-registered' ||
        errorCode === 'messaging/invalid-registration-token')
    ) {
      await clearStoredPushToken(userId);
    }

    return null;
  }
}

async function sendCallNotificationToCreator({
  creatorUserId,
  callerId = null,
  callerName,
  callerRating = 0,
  callerRatingCount = 0,
  callId,
  channelName,
  callType = 'voice',
}) {
  const { rows } = await pool.query(
    'SELECT push_token FROM users WHERE id = $1',
    [creatorUserId]
  );
  const pushToken = rows[0]?.push_token;
  if (!pushToken) {
    console.log(`No push token for creator ${creatorUserId}`);
    return null;
  }

  const displayName = callerName || 'Someone';
  const callLabel = callType === 'video' ? 'Video call' : 'Voice call';

  return sendPushNotification({
    userId: creatorUserId,
    pushToken,
    title: `${callLabel} from ${displayName}`,
    body: 'Tap to answer in TIYO',
    data: {
      type: 'incoming_call',
      categoryId: 'incomingCall',
      callId,
      channelName,
      callerId,
      callerName: callerName || 'User',
      callerRating,
      callerRatingCount,
      callType,
    },
  });
}

module.exports = { sendPushNotification, sendCallNotificationToCreator };
