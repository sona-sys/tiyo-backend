const crypto = require('crypto');

// ─── Agora Configuration ───────────────────────────────
const AGORA_APP_ID = process.env.AGORA_APP_ID || '';
const AGORA_APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE || '';

const isMockMode = !AGORA_APP_ID || !AGORA_APP_CERTIFICATE;

if (isMockMode) {
  console.log('Agora not configured — running in mock calling mode');
} else {
  console.log('Agora configured — real calling enabled');
}

// ─── Token Generation ──────────────────────────────────
// Generates an RTC token that lets a user join a specific Agora channel.
// Token expires after 1 hour.

function generateRtcToken(channelName, uid) {
  if (isMockMode) {
    // Mock token — still returns a valid-looking structure
    return {
      token: `mock_token_${channelName}_${uid}_${Date.now()}`,
      appId: 'mock_app_id',
      channelName,
      uid,
    };
  }

  try {
    const { RtcTokenBuilder, RtcRole } = require('agora-token');

    const role = RtcRole.PUBLISHER; // both caller and creator publish audio/video
    const expirationTimeInSeconds = 3600; // 1 hour
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

    const token = RtcTokenBuilder.buildTokenWithUid(
      AGORA_APP_ID,
      AGORA_APP_CERTIFICATE,
      channelName,
      uid,
      role,
      privilegeExpiredTs,
      privilegeExpiredTs
    );

    return {
      token,
      appId: AGORA_APP_ID,
      channelName,
      uid,
    };
  } catch (err) {
    console.error('Agora token generation failed:', err.message);
    throw new Error('Failed to generate call token');
  }
}

// ─── Channel Name Generator ────────────────────────────
// Creates a unique channel name for each call.

function generateChannelName(callerId, receiverId) {
  const timestamp = Date.now();
  const random = crypto.randomBytes(4).toString('hex');
  return `tiyo_${callerId}_${receiverId}_${timestamp}_${random}`;
}

module.exports = {
  AGORA_APP_ID,
  isMockMode,
  generateRtcToken,
  generateChannelName,
};
