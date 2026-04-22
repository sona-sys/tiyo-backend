const crypto = require('crypto');

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';

const RAZORPAYX_KEY_ID = process.env.RAZORPAYX_KEY_ID || RAZORPAY_KEY_ID || '';
const RAZORPAYX_KEY_SECRET = process.env.RAZORPAYX_KEY_SECRET || RAZORPAY_KEY_SECRET || '';
const RAZORPAYX_SOURCE_ACCOUNT_NUMBER = process.env.RAZORPAYX_SOURCE_ACCOUNT_NUMBER || '';
const RAZORPAYX_WEBHOOK_SECRET = process.env.RAZORPAYX_WEBHOOK_SECRET || process.env.RAZORPAY_WEBHOOK_SECRET || '';
const RAZORPAYX_BASE_URL = process.env.RAZORPAYX_BASE_URL || 'https://api.razorpay.com/v1';
const RAZORPAYX_ALLOW_TEST_UPI_BYPASS = String(process.env.RAZORPAYX_ALLOW_TEST_UPI_BYPASS || '').trim().toLowerCase() === 'true';

let razorpayInstance = null;

function getRazorpay() {
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    return null;
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

function isRazorpayXValidationConfigured() {
  return Boolean(RAZORPAYX_KEY_ID && RAZORPAYX_KEY_SECRET && RAZORPAYX_SOURCE_ACCOUNT_NUMBER);
}

function isRazorpayXPayoutConfigured() {
  return Boolean(isRazorpayXValidationConfigured() && RAZORPAYX_SOURCE_ACCOUNT_NUMBER);
}

function isRazorpayXTestUpiBypassEnabled() {
  return RAZORPAYX_ALLOW_TEST_UPI_BYPASS;
}

async function razorpayXRequest(path, { method = 'GET', body, idempotencyKey } = {}) {
  if (!isRazorpayXValidationConfigured()) {
    const err = new Error('RazorpayX is not configured');
    err.code = 'provider_not_configured';
    throw err;
  }

  const headers = {
    Authorization: `Basic ${Buffer.from(`${RAZORPAYX_KEY_ID}:${RAZORPAYX_KEY_SECRET}`).toString('base64')}`,
    Accept: 'application/json',
  };

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (idempotencyKey) {
    headers['X-Payout-Idempotency'] = idempotencyKey;
  }

  const response = await fetch(`${RAZORPAYX_BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (err) {
      payload = { raw: text };
    }
  }

  if (!response.ok) {
    const message =
      payload?.error?.description ||
      payload?.error?.reason ||
      payload?.description ||
      payload?.message ||
      `RazorpayX request failed (${response.status})`;
    const error = new Error(message);
    error.code = payload?.error?.code || payload?.code || 'provider_request_failed';
    error.httpStatus = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

function verifyPaymentSignature(orderId, paymentId, signature) {
  if (!RAZORPAY_KEY_SECRET) {
    return true;
  }

  const body = orderId + '|' + paymentId;
  const expectedSignature = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(body)
    .digest('hex');

  return expectedSignature === signature;
}

function verifyWebhookSignature(body, signature, webhookSecret) {
  const expectedSignature = crypto
    .createHmac('sha256', webhookSecret)
    .update(body)
    .digest('hex');

  return expectedSignature === signature;
}

async function createOrder(amountINR) {
  const razorpay = getRazorpay();

  if (!razorpay) {
    const mockOrderId = 'order_mock_' + Date.now();
    console.log(`[MOCK] Created order ${mockOrderId} for ₹${amountINR}`);
    return {
      id: mockOrderId,
      amount: amountINR * 100,
      currency: 'INR',
      status: 'created',
    };
  }

  return razorpay.orders.create({
    amount: amountINR * 100,
    currency: 'INR',
    receipt: `tiyo_${Date.now()}`,
  });
}

async function createOrUpdateContact({ existingContactId = null, name, phone, referenceId }) {
  const trimmedName = String(name || '').trim() || 'TIYO Creator';
  const normalizedPhone = String(phone || '').replace(/\D/g, '');
  const payload = {
    name: trimmedName,
    type: 'employee',
    reference_id: referenceId ? String(referenceId) : undefined,
    notes: { product: 'tiyo', purpose: 'creator_payout' },
  };

  if (normalizedPhone) {
    payload.contact = normalizedPhone;
  }

  if (existingContactId) {
    try {
      return await razorpayXRequest(`/contacts/${existingContactId}`, {
        method: 'PATCH',
        body: payload,
      });
    } catch (err) {
      if (err.httpStatus !== 404) {
        throw err;
      }
    }
  }

  return razorpayXRequest('/contacts', {
    method: 'POST',
    body: payload,
  });
}

async function createFundAccount({ contactId, vpa }) {
  return razorpayXRequest('/fund_accounts', {
    method: 'POST',
    body: {
      contact_id: contactId,
      account_type: 'vpa',
      vpa: {
        address: String(vpa || '').trim().toLowerCase(),
      },
    },
  });
}

async function prepareCreatorVpaRecipient({ existingContactId = null, name, phone, referenceId, vpa }) {
  const contact = await createOrUpdateContact({
    existingContactId,
    name,
    phone,
    referenceId,
  });
  const fundAccount = await createFundAccount({
    contactId: contact.id,
    vpa,
  });

  return { contact, fundAccount };
}

async function validateVpaFundAccount({ fundAccountId, referenceId }) {
  return razorpayXRequest('/fund_accounts/validations', {
    method: 'POST',
    body: {
      source_account_number: RAZORPAYX_SOURCE_ACCOUNT_NUMBER,
      reference_id: referenceId ? String(referenceId).slice(0, 40) : undefined,
      notes: {
        product: 'tiyo',
        validation: 'creator_upi',
      },
      fund_account: {
        id: fundAccountId,
      },
    },
  });
}

function extractVerifiedVpaName(validationResponse) {
  return (
    validationResponse?.beneficiary_name ||
    validationResponse?.results?.beneficiary_name ||
    validationResponse?.fund_account?.beneficiary_name ||
    validationResponse?.fund_account?.name ||
    validationResponse?.fund_account?.vpa?.beneficiary_name ||
    null
  );
}

async function validateCreatorVpa({ existingContactId = null, name, phone, referenceId, vpa }) {
  if (!isRazorpayXValidationConfigured()) {
    return { ok: false, errorCode: 'provider_not_configured', message: 'RazorpayX validation is not configured' };
  }

  let contact = null;
  let fundAccount = null;
  try {
    ({ contact, fundAccount } = await prepareCreatorVpaRecipient({
      existingContactId,
      name,
      phone,
      referenceId,
      vpa,
    }));
    const validation = await validateVpaFundAccount({
      fundAccountId: fundAccount?.id,
      referenceId: `tiyo_upi_${referenceId || 'creator'}`,
    });

    const validationStatus = String(validation?.status || '').toLowerCase();
    if (validationStatus && !['completed', 'processed', 'active'].includes(validationStatus)) {
      return {
        ok: false,
        errorCode: 'verification_failed',
        message: validation?.description || validation?.reason || 'The UPI ID could not be verified',
        contactId: contact.id,
        fundAccountId: fundAccount?.id || null,
      };
    }

    return {
      ok: true,
      contactId: contact.id,
      fundAccountId: fundAccount?.id || null,
      verifiedName: extractVerifiedVpaName(validation),
      validationStatus: validationStatus || 'completed',
      contact,
      fundAccount,
      validation,
    };
  } catch (err) {
    if (isRazorpayXTestUpiBypassEnabled() && contact?.id && fundAccount?.id) {
      return {
        ok: true,
        contactId: contact.id,
        fundAccountId: fundAccount.id,
        verifiedName: null,
        validationStatus: 'bypassed',
        verificationBypass: true,
        contact,
        fundAccount,
      };
    }

    const providerMessage =
      err?.payload?.error?.description ||
      err?.message ||
      'RazorpayX verification failed';
    const lowered = providerMessage.toLowerCase();
    const invalid = lowered.includes('vpa') || lowered.includes('upi') || lowered.includes('invalid');
    return {
      ok: false,
      errorCode: invalid ? 'verification_failed' : (err.code === 'provider_not_configured' ? 'provider_not_configured' : 'verification_retryable'),
      message: providerMessage,
      rawError: err,
    };
  }
}

async function createRazorpayXPayout({
  fundAccountId,
  amountPaisa,
  idempotencyKey,
  referenceId,
  narration,
}) {
  if (!isRazorpayXPayoutConfigured()) {
    const err = new Error('RazorpayX payouts are not configured');
    err.code = 'provider_not_configured';
    throw err;
  }

  return razorpayXRequest('/payouts', {
    method: 'POST',
    idempotencyKey,
    body: {
      account_number: RAZORPAYX_SOURCE_ACCOUNT_NUMBER,
      fund_account_id: fundAccountId,
      amount: amountPaisa,
      currency: 'INR',
      mode: 'UPI',
      purpose: 'payout',
      queue_if_low_balance: true,
      narration: narration || 'TIYO payout',
      reference_id: referenceId ? String(referenceId) : undefined,
      notes: {
        product: 'tiyo',
        payout_type: 'creator',
      },
    },
  });
}

function normalizePayoutStatus(status) {
  const value = String(status || '').trim().toLowerCase();
  if (!value) return 'unknown';
  if (['processed', 'completed', 'success', 'paid'].includes(value)) return 'processed';
  if (['queued', 'pending', 'processing', 'scheduled', 'created', 'initiated'].includes(value)) return 'processing';
  if (['failed', 'reversed', 'rejected', 'cancelled', 'canceled'].includes(value)) return value === 'cancelled' ? 'rejected' : value;
  return value;
}

function extractPayoutFailureReason(entity = {}) {
  return (
    entity?.status_details?.description ||
    entity?.failure_reason ||
    entity?.description ||
    entity?.notes?.failure_reason ||
    null
  );
}

function parseRazorpayXPayoutWebhookEvent(payload) {
  const entity = payload?.payload?.payout?.entity || payload?.payout?.entity || payload?.data?.payout || null;
  if (!entity?.id) {
    return null;
  }

  return {
    event: payload?.event || null,
    providerPayoutId: entity.id,
    status: normalizePayoutStatus(entity.status),
    failureReason: extractPayoutFailureReason(entity),
    externalReference: entity.utr || entity.reference_id || null,
    raw: entity,
  };
}

module.exports = {
  RAZORPAY_KEY_ID,
  RAZORPAYX_KEY_ID,
  RAZORPAYX_SOURCE_ACCOUNT_NUMBER,
  RAZORPAYX_WEBHOOK_SECRET,
  isRazorpayXTestUpiBypassEnabled,
  createOrder,
  verifyPaymentSignature,
  verifyWebhookSignature,
  isRazorpayXValidationConfigured,
  isRazorpayXPayoutConfigured,
  validateCreatorVpa,
  createRazorpayXPayout,
  normalizePayoutStatus,
  parseRazorpayXPayoutWebhookEvent,
};
