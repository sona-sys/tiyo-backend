// Supabase Auth integration for real OTP.
// When SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set,
// falls back to mock OTP mode (code: 1234).

let supabase = null;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (supabaseUrl && supabaseServiceKey) {
  try {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
    console.log('Supabase Auth initialized (real OTP mode)');
  } catch (err) {
    console.error('Failed to initialize Supabase Auth:', err.message);
    console.log('Falling back to mock OTP mode (code: 1234)');
  }
} else {
  console.log('Supabase Auth not configured — running in mock OTP mode (code: 1234)');
}

async function sendOTP(phone) {
  if (!supabase) {
    console.log(`[MOCK] OTP sent to ${phone}`);
    return { success: true, mock: true };
  }

  const { error } = await supabase.auth.signInWithOtp({ phone });
  if (error) {
    console.error('Supabase OTP send error:', error.message);
    throw new Error(error.message);
  }
  return { success: true };
}

async function verifyOTP(phone, code) {
  if (!supabase) {
    if (code !== '1234') {
      throw new Error('Invalid OTP code');
    }
    return { success: true, mock: true };
  }

  const { error } = await supabase.auth.verifyOtp({
    phone,
    token: code,
    type: 'sms',
  });
  if (error) {
    console.error('Supabase OTP verify error:', error.message);
    throw new Error(error.message);
  }
  return { success: true };
}

module.exports = { sendOTP, verifyOTP };
