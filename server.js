const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

dotenv.config();

const pool = require('./db/pool');
const db = require('./db/queries');
const { generateToken, requireAuth } = require('./middleware/auth');
const { sendOTP, verifyOTP } = require('./auth/supabase');
const { RAZORPAY_KEY_ID, createOrder, verifyPaymentSignature } = require('./payments/razorpay');
const { AGORA_APP_ID, isMockMode: agoraMockMode, generateRtcToken, generateChannelName } = require('./calling/agora');
const notifications = require('./services/notifications');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── SECURITY HEADERS (Helmet) ──────────────────────────
app.use(helmet());

// ─── GZIP COMPRESSION ───────────────────────────────────
app.use(compression());

// ─── CORS ────────────────────────────────────────────────
// React Native doesn't enforce browser CORS, but this prevents
// random websites from calling the API. Mobile requests still work.
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:8081', 'http://localhost:19006'];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, curl, server-to-server)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(null, false);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400, // Cache preflight for 24h
}));

app.use(express.json({ limit: '1mb' }));

// ─── RATE LIMITING ───────────────────────────────────────

// Global: 100 req/min per IP
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});
app.use('/api/', globalLimiter);

// Auth: 10 req/min per IP (brute-force protection)
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts, please try again later' },
});
app.use('/api/auth/', authLimiter);

// Payment: 5 req/min per IP
const paymentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many payment requests, please try again later' },
});
app.use('/api/payments/', paymentLimiter);

// ─── REQUEST LOGGING ─────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (req.path !== '/api/health') {
      console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    }
  });
  next();
});

// ─── HEALTH CHECK ───────────────────────────────────────

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', error: 'Database unreachable' });
  }
});

app.get('/', (req, res) => {
  res.json({ name: 'TIYO API', version: '1.1.0', status: 'running' });
});

// ─── AUTH ROUTES (public — no token required) ───────────

app.post('/api/auth/login', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number is required' });

    // Validate phone: strip non-digits, check length (10-15 digits)
    const cleanPhone = String(phone).replace(/\D/g, '');
    if (cleanPhone.length < 10 || cleanPhone.length > 15) {
      return res.status(400).json({ error: 'Phone number must be 10-15 digits' });
    }

    await sendOTP(cleanPhone);
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

    // Validate phone: strip non-digits, check length (10-15 digits)
    const cleanPhone = String(phone).replace(/\D/g, '');
    if (cleanPhone.length < 10 || cleanPhone.length > 15) {
      return res.status(400).json({ error: 'Phone number must be 10-15 digits' });
    }

    // Validate OTP: must be 4-6 digits
    const cleanOtp = String(otp).replace(/\D/g, '');
    if (cleanOtp.length < 4 || cleanOtp.length > 6) {
      return res.status(400).json({ error: 'OTP must be 4-6 digits' });
    }

    // Verify OTP (real Supabase or mock depending on config)
    await verifyOTP(cleanPhone, cleanOtp);

    // Find or create user in our database
    let user = await db.findUserByPhone(cleanPhone);
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

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const transactions = await db.getUserTransactions(userId, page, limit);
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

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const recharges = await db.getUserRecharges(userId, page, limit);
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

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const calls = await db.getUserCalls(userId, page, limit);
    res.json(calls);
  } catch (err) {
    console.error('Get calls error:', err);
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

// ─── WALLET ROUTES (protected) ──────────────────────────

app.post('/api/wallet/topup', requireAuth, async (req, res) => {
  try {
    const { amount } = req.body;
    const userId = req.userId; // from JWT — tamper-proof

    // Validate amount: positive number, max 50000
    const numAmount = parseFloat(amount);
    if (!Number.isFinite(numAmount) || numAmount <= 0) {
      return res.status(400).json({ error: 'Amount must be a positive number' });
    }
    if (numAmount > 50000) {
      return res.status(400).json({ error: 'Amount cannot exceed 50000' });
    }

    const user = await db.findUserById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const newBalance = await db.updateWalletBalance(userId, numAmount);
    await db.createTransaction(userId, numAmount, 'topup', 'success');

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

    // Validate amount: positive number, max 50000
    const numAmount = parseFloat(amount);
    if (!Number.isFinite(numAmount) || numAmount <= 0) {
      return res.status(400).json({ error: 'Amount must be a positive number' });
    }
    if (numAmount > 50000) {
      return res.status(400).json({ error: 'Amount cannot exceed 50000' });
    }

    const order = await createOrder(numAmount);

    // Log a pending transaction so we can track abandoned payments
    await db.createTransaction(userId, numAmount, 'topup', 'pending');

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

    // V23: Send payment confirmation push notification
    notifications.sendPaymentConfirmation(userId, amount).catch(err =>
      console.error('Payment notification failed:', err)
    );

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

    // V23: Notify creator of incoming call
    const caller = await db.findUserById(callerId);
    notifications.sendCallNotification(receiverId, caller?.name || 'Someone').catch(err =>
      console.error('Call notification failed:', err)
    );

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

      // V23: Send call summary notification
      if (result.success && !result.missed) {
        const call = await db.getCallById(callId);
        if (call) {
          const creator = await db.findUserById(call.receiver_id);
          notifications.sendCallEndSummary(
            call.caller_id, creator?.name || 'Creator',
            result.duration || 0, result.cost || 0
          ).catch(err => console.error('Call summary notification failed:', err));
        }
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

// ─── PUSH TOKEN ROUTE (V23) ─────────────────────────────

app.post('/api/users/push-token', requireAuth, async (req, res) => {
  try {
    const { pushToken } = req.body;
    const userId = req.userId;

    if (!pushToken) {
      return res.status(400).json({ error: 'pushToken is required' });
    }

    await pool.query('UPDATE users SET push_token = $1 WHERE id = $2', [pushToken, userId]);
    console.log(`Push token registered for user ${userId}`);

    res.json({ success: true });
  } catch (err) {
    console.error('Push token error:', err);
    res.status(500).json({ error: 'Failed to register push token' });
  }
});

// ─── NOTIFICATION ROUTES (V23) ──────────────────────────

app.get('/api/notifications', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const notifs = await notifications.getUserNotifications(userId, page, limit);
    const unreadCount = await notifications.getUnreadCount(userId);
    res.json({ notifications: notifs, unreadCount });
  } catch (err) {
    console.error('Get notifications error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/notifications/:id/read', requireAuth, async (req, res) => {
  try {
    const notifId = parseInt(req.params.id);
    await notifications.markNotificationRead(notifId, req.userId);
    res.json({ success: true });
  } catch (err) {
    console.error('Mark read error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/notifications/read-all', requireAuth, async (req, res) => {
  try {
    await notifications.markAllNotificationsRead(req.userId);
    res.json({ success: true });
  } catch (err) {
    console.error('Mark all read error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── CREATOR PRESENCE ROUTE (V23) ───────────────────────

app.post('/api/creators/heartbeat', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    await pool.query(
      'UPDATE creators SET last_seen = NOW(), is_online = TRUE WHERE user_id = $1',
      [userId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Heartbeat error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── HELPERS ────────────────────────────────────────────

function formatUserForClient(user) {
  return {
    id: user.id,
    name: user.name || null,
    phone: user.phone,
    role: user.role,
    balance: user.balance != null ? parseFloat(user.balance) : 0,
  };
}

// ─── MIDDLEWARE: 404 & ERROR HANDLING ───────────────────

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

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
