const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const db = require('./db/queries');
const { generateToken, requireAuth } = require('./middleware/auth');
const { sendOTP, verifyOTP } = require('./auth/supabase');
const { RAZORPAY_KEY_ID, createOrder, verifyPaymentSignature } = require('./payments/razorpay');
const { AGORA_APP_ID, isMockMode: agoraMockMode, generateRtcToken, generateChannelName } = require('./calling/agora');
const { sendCallNotificationToCreator } = require('./services/notifications');
const { requireAdmin } = require('./middleware/adminAuth');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve static files (admin dashboard)
app.use(express.static(path.join(__dirname, 'public')));

// ─── AUTH ROUTES (public — no token required) ───────────

app.post('/api/auth/login', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number is required' });

    await sendOTP(phone);
    res.json({ success: true, message: 'OTP sent successfully' });
  } catch (err) {
    console.error('OTP send error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to send OTP' });
  }
});

app.post('/api/auth/verify', async (req, res) => {
  try {
    const { phone, otp } = req.body;
    if (!phone || !otp) {
      return res.status(400).json({ error: 'Phone and OTP are required' });
    }

    // Verify OTP (real Supabase or mock depending on config)
    await verifyOTP(phone, otp);

    // Find or create user in our database
    let user = await db.findUserByPhone(phone);
    if (!user) {
      user = await db.createUser(phone);
    } else {
      const fullUser = await db.findUserById(user.id);
      user = fullUser;
    }

    // Issue JWT token
    const token = generateToken(user);

    res.json({
      success: true,
      user: formatUserForClient(user),
      token,
    });
  } catch (err) {
    console.error('Auth verify error:', err.message);
    // Return specific error for invalid OTP vs server errors
    if (err.message.includes('Invalid') || err.message.includes('expired') || err.message.includes('OTP')) {
      return res.status(400).json({ success: false, error: err.message });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── USER ROUTES (protected) ────────────────────────────

app.get('/api/users/:id', requireAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);

    // Users can only access their own data
    if (userId !== req.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const user = await db.findUserById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(formatUserForClient(user));
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/users/:id/transactions', requireAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    if (userId !== req.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const transactions = await db.getUserTransactions(userId);
    res.json(transactions);
  } catch (err) {
    console.error('Get transactions error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/users/:id/recharges', requireAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    if (userId !== req.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const recharges = await db.getUserRecharges(userId);
    res.json(recharges);
  } catch (err) {
    console.error('Get recharges error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/users/:id/calls', requireAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    if (userId !== req.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const calls = await db.getUserCalls(userId);
    res.json(calls);
  } catch (err) {
    console.error('Get calls error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── PUSH TOKEN ROUTE ──────────────────────────────────

app.post('/api/users/push-token', requireAuth, async (req, res) => {
  try {
    const { pushToken } = req.body;
    if (!pushToken) return res.status(400).json({ error: 'pushToken is required' });

    await db.savePushToken(req.userId, pushToken);
    res.json({ success: true });
  } catch (err) {
    console.error('Save push token error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── NOTIFICATIONS ROUTE ─────────────────────────────

app.get('/api/notifications', requireAuth, async (req, res) => {
  try {
    // V35: stub — returns empty list + unread count for now
    // Full notification system (DB-backed) can be added later
    res.json({ notifications: [], unreadCount: 0 });
  } catch (err) {
    console.error('Notifications error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── USER PROFILE UPDATE ───────────────────────────────

app.put('/api/users/profile', requireAuth, async (req, res) => {
  try {
    const { name, avatar } = req.body;
    const userId = req.userId;

    if (name !== undefined) {
      await db.updateUserName(userId, name);
    }

    const user = await db.findUserById(userId);
    res.json({ success: true, user: formatUserForClient(user) });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── CREATORS ROUTE (public — browsing doesn't need auth) ──

app.get('/api/creators', async (req, res) => {
  try {
    const creators = await db.getCreators();
    res.json(creators);
  } catch (err) {
    console.error('Get creators error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── CREATOR MANAGEMENT ROUTES (V32 — protected) ───────

app.post('/api/creators/register', requireAuth, async (req, res) => {
  try {
    const { rate, videoRate, bio, languages, categories } = req.body;
    await db.registerCreator(req.userId, { rate, videoRate, bio, languages, categories });

    // Re-fetch user to get updated role
    const user = await db.findUserById(req.userId);
    res.json({ success: true, user: formatUserForClient(user) });
  } catch (err) {
    console.error('Creator register error:', err);
    res.status(500).json({ error: 'Failed to register as creator' });
  }
});

app.put('/api/creators/profile', requireAuth, async (req, res) => {
  try {
    const result = await db.updateCreatorProfile(req.userId, req.body);
    if (!result) return res.status(404).json({ error: 'Creator not found' });
    res.json({ success: true, creator: result });
  } catch (err) {
    console.error('Creator profile update error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/creators/toggle-availability', requireAuth, async (req, res) => {
  try {
    const result = await db.toggleCreatorAvailability(req.userId);
    if (!result) return res.status(404).json({ error: 'Creator not found' });
    res.json({ success: true, isOnline: result.is_online });
  } catch (err) {
    console.error('Toggle availability error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/creators/dashboard', requireAuth, async (req, res) => {
  try {
    const dashboard = await db.getCreatorDashboard(req.userId);
    if (!dashboard) return res.status(404).json({ error: 'Creator profile not found' });
    res.json(dashboard);
  } catch (err) {
    console.error('Creator dashboard error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/creators/incoming-calls', requireAuth, async (req, res) => {
  try {
    const calls = await db.getCreatorIncomingCalls(req.userId);
    res.json(calls);
  } catch (err) {
    console.error('Creator incoming calls error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/calls/accept', requireAuth, async (req, res) => {
  try {
    const { callId } = req.body;
    if (!callId) return res.status(400).json({ error: 'callId is required' });

    // Connect the call (same as /calls/connect but from creator side)
    const call = await db.connectCallById(callId);
    if (!call) return res.status(404).json({ error: 'Call not found or already connected' });

    // Generate Agora token for the creator
    const tokenData = generateRtcToken(call.channel_name, req.userId);

    console.log(`Call accepted by creator: ${callId}`);

    res.json({
      success: true,
      callId: call.id,
      channelName: call.channel_name,
      agoraAppId: tokenData.appId,
      agoraToken: tokenData.token,
      agoraUid: req.userId,
      startTime: call.start_time,
    });
  } catch (err) {
    console.error('Accept call error:', err);
    res.status(500).json({ error: 'Failed to accept call' });
  }
});

app.post('/api/calls/reject', requireAuth, async (req, res) => {
  try {
    const { callId } = req.body;
    if (!callId) return res.status(400).json({ error: 'callId is required' });

    const call = await db.rejectCallById(callId);
    if (!call) return res.status(404).json({ error: 'Call not found or already handled' });

    console.log(`Call rejected by creator: ${callId}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Reject call error:', err);
    res.status(500).json({ error: 'Failed to reject call' });
  }
});

// ─── WALLET ROUTES (protected) ──────────────────────────

app.post('/api/wallet/topup', requireAuth, async (req, res) => {
  try {
    const { amount } = req.body;
    const userId = req.userId; // from JWT — tamper-proof

    const user = await db.findUserById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const newBalance = await db.updateWalletBalance(userId, amount);
    await db.createTransaction(userId, amount, 'topup', 'success');

    res.json({ success: true, newBalance });
  } catch (err) {
    console.error('Topup error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/wallet/log', requireAuth, async (req, res) => {
  try {
    const { amount, status } = req.body;
    const userId = req.userId;

    const user = await db.findUserById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    await db.createTransaction(userId, amount, 'topup', status);

    res.json({ success: true });
  } catch (err) {
    console.error('Wallet log error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── PAYMENT ROUTES (Razorpay) ─────────────────────────

// Step 1: Create a Razorpay order (frontend calls this before opening checkout)
app.post('/api/payments/create-order', requireAuth, async (req, res) => {
  try {
    const { amount } = req.body;
    const userId = req.userId;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Valid amount is required' });
    }

    const order = await createOrder(amount);

    // Log a pending transaction so we can track abandoned payments
    await db.createTransaction(userId, amount, 'topup', 'pending');

    res.json({
      success: true,
      orderId: order.id,
      amount: order.amount, // in paise
      currency: order.currency || 'INR',
      keyId: RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error('Create order error:', err);
    res.status(500).json({ error: 'Failed to create payment order' });
  }
});

// Step 2: Verify payment after Razorpay checkout completes
app.post('/api/payments/verify', requireAuth, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, amount } = req.body;
    const userId = req.userId;

    if (!razorpay_order_id || !razorpay_payment_id || !amount) {
      return res.status(400).json({ error: 'Missing payment details' });
    }

    // Verify the payment signature (prevents client-side tampering)
    const isValid = verifyPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);

    if (!isValid) {
      await db.createTransaction(userId, amount, 'topup', 'failed');
      return res.status(400).json({ error: 'Payment verification failed — signature mismatch' });
    }

    // Credit wallet
    const newBalance = await db.updateWalletBalance(userId, amount);
    await db.createTransaction(userId, amount, 'topup', 'success');

    console.log(`Payment verified: user ${userId}, ₹${amount}, balance now ₹${newBalance}`);

    res.json({
      success: true,
      newBalance,
      paymentId: razorpay_payment_id,
    });
  } catch (err) {
    console.error('Verify payment error:', err);
    res.status(500).json({ error: 'Payment verification failed' });
  }
});

// ─── CALL ROUTES (V22 — Agora integration) ─────────────

// Step 1: Start a call — creates DB record + Agora channel
app.post('/api/calls/start', requireAuth, async (req, res) => {
  try {
    const { receiverId, callType } = req.body; // callType: 'voice' or 'video'
    const callerId = req.userId;

    if (!receiverId) {
      return res.status(400).json({ error: 'receiverId is required' });
    }

    // Generate unique channel name
    const channelName = generateChannelName(callerId, receiverId);

    // Create call record in DB
    const call = await db.initiateCall(callerId, receiverId, channelName, callType || 'voice');

    // Generate Agora token for the caller
    const tokenData = generateRtcToken(channelName, callerId);

    console.log(`Call started: ${call.id} (${callType || 'voice'}) channel=${channelName}`);

    // Send push notification to the creator (non-blocking)
    const caller = await db.findUserById(callerId);
    sendCallNotificationToCreator(receiverId, caller?.name, call.id, channelName, callType || 'voice')
      .catch(err => console.error('Failed to notify creator:', err.message));

    res.json({
      success: true,
      callId: call.id,
      channelName,
      agoraAppId: tokenData.appId,
      agoraToken: tokenData.token,
      agoraUid: callerId,
      mockMode: agoraMockMode,
    });
  } catch (err) {
    console.error('Start call error:', err);
    res.status(500).json({ error: 'Failed to start call' });
  }
});

// Step 2: Get Agora token (for reconnection or creator joining)
app.post('/api/calls/token', requireAuth, async (req, res) => {
  try {
    const { channelName } = req.body;
    const userId = req.userId;

    if (!channelName) {
      return res.status(400).json({ error: 'channelName is required' });
    }

    const tokenData = generateRtcToken(channelName, userId);

    res.json({
      success: true,
      ...tokenData,
    });
  } catch (err) {
    console.error('Token generation error:', err);
    res.status(500).json({ error: 'Failed to generate token' });
  }
});

// Step 3: Mark call as connected (billing starts)
app.post('/api/calls/connect', requireAuth, async (req, res) => {
  try {
    const { callId } = req.body;

    if (!callId) {
      return res.status(400).json({ error: 'callId is required' });
    }

    const call = await db.connectCallById(callId);
    if (!call) {
      return res.status(404).json({ error: 'Call not found or already connected' });
    }

    console.log(`Call connected: ${callId} at ${call.start_time}`);

    res.json({ success: true, startTime: call.start_time });
  } catch (err) {
    console.error('Connect call error:', err);
    res.status(500).json({ error: 'Failed to connect call' });
  }
});

// Step 4: End call — server calculates duration + cost
app.post('/api/calls/end', requireAuth, async (req, res) => {
  try {
    const { callId, receiverId, durationSeconds } = req.body;

    // V22 path: end by callId (server calculates duration)
    if (callId) {
      const result = await db.processCallEndById(callId);
      if (result.error) {
        return res.status(400).json({ error: result.error });
      }
      return res.json(result);
    }

    // Legacy V19 path: end by receiverId + client-reported duration
    if (receiverId && durationSeconds !== undefined) {
      const callerId = req.userId;
      const result = await db.processCallEnd(callerId, receiverId, durationSeconds);
      if (result.error) {
        return res.status(400).json({ error: result.error });
      }
      return res.json(result);
    }

    res.status(400).json({ error: 'callId or (receiverId + durationSeconds) required' });
  } catch (err) {
    console.error('End call error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── ADMIN ROUTES (V34 — protected by admin key) ────────

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const stats = await db.adminGetStats();
    res.json(stats);
  } catch (err) {
    console.error('Admin stats error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const users = await db.adminGetUsers(limit, offset);
    res.json(users);
  } catch (err) {
    console.error('Admin users error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/creators', requireAdmin, async (req, res) => {
  try {
    const creators = await db.adminGetCreators();
    res.json(creators);
  } catch (err) {
    console.error('Admin creators error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/calls', requireAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const calls = await db.adminGetCalls(limit, offset);
    res.json(calls);
  } catch (err) {
    console.error('Admin calls error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/transactions', requireAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const txns = await db.adminGetTransactions(limit, offset);
    res.json(txns);
  } catch (err) {
    console.error('Admin transactions error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── HEALTH CHECK ───────────────────────────────────────

app.get('/', (req, res) => {
  res.send('Pay-to-Call API is running');
});

// ─── HELPERS ────────────────────────────────────────────

function formatUserForClient(user) {
  return {
    id: user.id,
    name: user.name || null,
    phone: user.phone,
    role: user.role || 'user',
    balance: user.balance != null ? parseFloat(user.balance) : 0,
    bio: user.bio || null,
  };
}

// ─── ERROR HANDLING ─────────────────────────────────────

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
});

// ─── START SERVER ───────────────────────────────────────

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT} across all interfaces.`);
});

server.on('error', (err) => {
  console.error('Server error:', err.message);
});
