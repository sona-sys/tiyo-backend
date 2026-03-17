const crypto = require('crypto');

// ─── Razorpay Configuration ────────────────────────────
// Uses test mode keys by default. Replace with live keys for production.

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';

let razorpayInstance = null;

function getRazorpay() {
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    return null; // Keys not configured — mock mode
  }

  if (!razorpayInstance) {
    const Razorpay = require('razorpay');
    razorpayInstance = new Razorpay({
      key_id: RAZORPAY_KEY_ID,
      key_secret: RAZORPAY_KEY_SECRET,
    });
  }

  return razorpayInstance;
}

// ─── Create Order ──────────────────────────────────────
// Creates a Razorpay order. In mock mode, returns a fake order.

async function createOrder(amountINR) {
  const razorpay = getRazorpay();

  if (!razorpay) {
    // Mock mode — return a fake order for testing without keys
    const mockOrderId = 'order_mock_' + Date.now();
    console.log(`[MOCK] Created order ${mockOrderId} for ₹${amountINR}`);
    return {
      id: mockOrderId,
      amount: amountINR * 100, // paise
      currency: 'INR',
      status: 'created',
    };
  }

  // Real Razorpay order
  const order = await razorpay.orders.create({
    amount: amountINR * 100, // Razorpay expects paise
    currency: 'INR',
    receipt: `tiyo_${Date.now()}`,
  });

  return order;
}

// ─── Verify Payment Signature ──────────────────────────
// Verifies that the payment wasn't tampered with using HMAC SHA256.
// Returns true if valid, false if tampered.

function verifyPaymentSignature(orderId, paymentId, signature) {
  if (!RAZORPAY_KEY_SECRET) {
    // Mock mode — accept any signature
    console.log('[MOCK] Skipping signature verification (no key_secret)');
    return true;
  }

  const body = orderId + '|' + paymentId;
  const expectedSignature = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(body)
    .digest('hex');

  return expectedSignature === signature;
}

// ─── Verify Webhook Signature ──────────────────────────
// Verifies Razorpay webhook payload authenticity.

function verifyWebhookSignature(body, signature, webhookSecret) {
  const expectedSignature = crypto
    .createHmac('sha256', webhookSecret)
    .update(body)
    .digest('hex');

  return expectedSignature === signature;
}

module.exports = {
  RAZORPAY_KEY_ID,
  createOrder,
  verifyPaymentSignature,
  verifyWebhookSignature,
};
