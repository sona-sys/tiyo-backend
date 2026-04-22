// Push notification service using direct Firebase Cloud Messaging
const admin = require('firebase-admin');
const pool = require('../db/pool');

let firebaseApp = null;
let loggedMissingConfig = false;
let loggedInitFailure = false;
const FALLBACK_DELAY_MS = 4000;
const pendingIncomingCallFallbacks = new Map();
const deliveredIncomingCallAlerts = new Set();
const CREATOR_ALERTS_CHANNEL_ID = 'creator-alerts-v1';

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

async function storeNotification({ userId, title, body, type, data = {} }) {
  if (!userId || !title || !body || !type) {
    return null;
  }

  try {
    const { rows } = await pool.query(`
      INSERT INTO notifications (user_id, title, body, type, data)
      VALUES ($1, $2, $3, $4, $5::jsonb)
      RETURNING *
    `, [userId, title, body, type, JSON.stringify(data || {})]);
    return rows[0] || null;
  } catch (err) {
    console.error(`Failed to store notification for user ${userId}:`, err.message);
    return null;
  }
}

async function getPushTokenForUser(userId) {
  const { rows } = await pool.query(
    'SELECT push_token FROM users WHERE id = $1',
    [userId]
  );
  return rows[0]?.push_token || null;
}

async function sendPushNotification({
  userId = null,
  pushToken,
  title,
  body,
  data = {},
  notification = null,
  android = null,
}) {
  if (!pushToken || typeof pushToken !== 'string') {
    return null;
  }

  const messaging = getFirebaseMessaging();
  if (!messaging) {
    return null;
  }

  const message = {
    token: pushToken,
    data: serializeData({
      title,
      message: body,
      channelId: 'incoming-calls-v2',
      sticky: true,
      autoDismiss: false,
      ...data,
    }),
    ...(notification ? { notification } : {}),
    android: {
      priority: 'high',
      ttl: data?.type === 'incoming_call' ? 0 : 35000,
      ...(android || {}),
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

async function isCallStillRinging(callId) {
  if (!callId) {
    return false;
  }

  try {
    const { rows } = await pool.query('SELECT status FROM calls WHERE id = $1', [callId]);
    return rows[0]?.status === 'ringing';
  } catch (err) {
    console.error(`Failed to check call ${callId} for fallback delivery:`, err.message);
    return false;
  }
}

function clearIncomingCallFallback(callId) {
  const normalizedCallId = Number(callId);
  if (!normalizedCallId) {
    return;
  }

  const pendingTimer = pendingIncomingCallFallbacks.get(normalizedCallId);
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingIncomingCallFallbacks.delete(normalizedCallId);
  }
  deliveredIncomingCallAlerts.delete(normalizedCallId);
}

function markIncomingCallAlertDelivered(callId) {
  const normalizedCallId = Number(callId);
  if (!normalizedCallId) {
    return;
  }

  deliveredIncomingCallAlerts.add(normalizedCallId);
  const pendingTimer = pendingIncomingCallFallbacks.get(normalizedCallId);
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingIncomingCallFallbacks.delete(normalizedCallId);
  }
}

function scheduleIncomingCallFallback({
  creatorUserId,
  pushToken,
  callerId = null,
  callerName,
  callerRating = 0,
  callerRatingCount = 0,
  callId,
  channelName,
  callType = 'voice',
}) {
  const normalizedCallId = Number(callId);
  if (!normalizedCallId || !pushToken) {
    return;
  }

  clearIncomingCallFallback(normalizedCallId);

  const timer = setTimeout(async () => {
    pendingIncomingCallFallbacks.delete(normalizedCallId);

    if (deliveredIncomingCallAlerts.has(normalizedCallId)) {
      return;
    }

    const stillRinging = await isCallStillRinging(normalizedCallId);
    if (!stillRinging) {
      clearIncomingCallFallback(normalizedCallId);
      return;
    }

    const displayName = callerName || 'Someone';
    const callLabel = callType === 'video' ? 'Video call' : 'Voice call';

    await sendPushNotification({
      userId: creatorUserId,
      pushToken,
      title: `${callLabel} from ${displayName}`,
      body: 'Tap to answer in TIYO',
      data: {
        type: 'incoming_call',
        callId: normalizedCallId,
        channelName,
        callerId,
        callerName: callerName || 'User',
        callerRating,
        callerRatingCount,
        callType,
        channelId: 'incoming-calls-v2',
        sticky: false,
        autoDismiss: true,
        fallbackMode: 'system_notification',
      },
      android: {
        priority: 'high',
        ttl: 0,
        collapseKey: `incoming-call-${normalizedCallId}`,
        notification: {
          channelId: 'incoming-calls-v2',
          tag: `incoming-call-${normalizedCallId}`,
          clickAction: 'DEFAULT',
          sound: 'default',
          defaultSound: true,
          defaultVibrateTimings: true,
          visibility: 'public',
        },
      },
      notification: {
        title: `${callLabel} from ${displayName}`,
        body: 'Tap to answer in TIYO',
      },
    });
  }, FALLBACK_DELAY_MS);

  pendingIncomingCallFallbacks.set(normalizedCallId, timer);
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
  const pushToken = await getPushTokenForUser(creatorUserId);
  if (!pushToken) {
    console.log(`No push token for creator ${creatorUserId}`);
    return null;
  }

  const displayName = callerName || 'Someone';
  const callLabel = callType === 'video' ? 'Video call' : 'Voice call';

  const result = await sendPushNotification({
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

  scheduleIncomingCallFallback({
    creatorUserId,
    pushToken,
    callerId,
    callerName,
    callerRating,
    callerRatingCount,
    callId,
    channelName,
    callType,
  });

  return result;
}

async function sendCreatorFreeNotification({
  callerUserId,
  creatorUserId,
  creatorName,
}) {
  const displayName = creatorName || 'Your creator';
  const title = `${displayName} is free now`;
  const body = `Tap to view ${displayName} and call if you’re still interested.`;
  const data = {
    type: 'creator_free',
    creatorId: creatorUserId,
    creatorName: displayName,
    channelId: CREATOR_ALERTS_CHANNEL_ID,
    sticky: false,
    autoDismiss: true,
  };

  await storeNotification({
    userId: callerUserId,
    title,
    body,
    type: 'creator_free',
    data,
  });

  const pushToken = await getPushTokenForUser(callerUserId);
  if (!pushToken) {
    return null;
  }

  return sendPushNotification({
    userId: callerUserId,
    pushToken,
    title,
    body,
    data,
    android: {
      priority: 'high',
      ttl: 3600000,
      notification: {
        channelId: CREATOR_ALERTS_CHANNEL_ID,
        tag: `creator-free-${creatorUserId}`,
        clickAction: 'DEFAULT',
        sound: 'default',
        defaultSound: true,
        defaultVibrateTimings: true,
        visibility: 'private',
      },
    },
    notification: {
      title,
      body,
    },
  });
}

async function notifyCreatorFreeCallers({ creatorUserId, creatorName, callerUserIds = [] }) {
  const uniqueCallerIds = [...new Set(
    callerUserIds
      .map((callerUserId) => Number(callerUserId))
      .filter((callerUserId) => Number.isInteger(callerUserId) && callerUserId > 0)
  )];

  if (!uniqueCallerIds.length) {
    return { notifiedCount: 0 };
  }

  await Promise.all(uniqueCallerIds.map((callerUserId) =>
    sendCreatorFreeNotification({
      callerUserId,
      creatorUserId,
      creatorName,
    }).catch((err) => {
      console.error(`Failed to notify caller ${callerUserId} that creator ${creatorUserId} is free:`, err.message);
      return null;
    })
  ));

  return { notifiedCount: uniqueCallerIds.length };
}

module.exports = {
  sendPushNotification,
  sendCallNotificationToCreator,
  notifyCreatorFreeCallers,
  storeNotification,
  clearIncomingCallFallback,
  markIncomingCallAlertDelivered,
};
