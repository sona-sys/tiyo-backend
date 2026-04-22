-- ============================================================
-- V44.1 Migration — RazorpayX verified UPI + provider-backed payouts
-- Safe to rerun.
-- ============================================================

ALTER TABLE creators
  ADD COLUMN IF NOT EXISTS payout_contact_id TEXT;

ALTER TABLE creators
  ADD COLUMN IF NOT EXISTS payout_fund_account_id TEXT;

ALTER TABLE creators
  ADD COLUMN IF NOT EXISTS payout_upi_verified_name TEXT;

ALTER TABLE creators
  ADD COLUMN IF NOT EXISTS payout_upi_verified_at TIMESTAMPTZ;

ALTER TABLE creators
  ADD COLUMN IF NOT EXISTS payout_upi_last_error TEXT;

ALTER TABLE creators
  ADD COLUMN IF NOT EXISTS payout_upi_verification_status TEXT DEFAULT 'unverified';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'creators_payout_upi_verification_status_check'
  ) THEN
    ALTER TABLE creators
      ADD CONSTRAINT creators_payout_upi_verification_status_check
      CHECK (payout_upi_verification_status IN ('unverified', 'verified', 'failed'));
  END IF;
END $$;

ALTER TABLE creator_payouts
  ADD COLUMN IF NOT EXISTS provider TEXT;

ALTER TABLE creator_payouts
  ADD COLUMN IF NOT EXISTS provider_payout_id TEXT;

ALTER TABLE creator_payouts
  ADD COLUMN IF NOT EXISTS provider_status TEXT DEFAULT 'created';

ALTER TABLE creator_payouts
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

ALTER TABLE creator_payouts
  ADD COLUMN IF NOT EXISTS failure_reason TEXT;

ALTER TABLE creator_payouts
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

ALTER TABLE creator_payouts
  ADD COLUMN IF NOT EXISTS retry_of_payout_id INTEGER REFERENCES creator_payouts(id) ON DELETE SET NULL;

ALTER TABLE creator_payouts
  ALTER COLUMN paid_at DROP NOT NULL;

ALTER TABLE creator_payouts
  ALTER COLUMN paid_at DROP DEFAULT;

UPDATE creators
SET payout_upi_verification_status = 'unverified'
WHERE payout_upi_verification_status IS NULL;

UPDATE creator_payouts
SET provider = COALESCE(provider, 'manual'),
    provider_status = 'processed',
    approved_at = COALESCE(approved_at, paid_at)
WHERE paid_at IS NOT NULL
  AND (provider IS NULL OR provider_status IS NULL OR provider_status = 'created');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'creator_payouts_provider_status_check'
  ) THEN
    ALTER TABLE creator_payouts
      ADD CONSTRAINT creator_payouts_provider_status_check
      CHECK (
        provider_status IN (
          'created',
          'pending',
          'queued',
          'processing',
          'processed',
          'rejected',
          'failed',
          'reversed'
        )
      );
  END IF;
END $$;

ALTER TABLE creator_payout_requests
  DROP CONSTRAINT IF EXISTS creator_payout_requests_status_check;

ALTER TABLE creator_payout_requests
  ADD CONSTRAINT creator_payout_requests_status_check
  CHECK (status IN ('open', 'processing', 'rejected', 'paid', 'failed'));

DROP INDEX IF EXISTS idx_creator_payout_requests_one_open;

CREATE UNIQUE INDEX IF NOT EXISTS idx_creator_payout_requests_one_active
ON creator_payout_requests(creator_user_id)
WHERE status IN ('open', 'processing');

CREATE UNIQUE INDEX IF NOT EXISTS idx_creator_payouts_provider_payout_id
ON creator_payouts(provider_payout_id)
WHERE provider_payout_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_creator_payouts_idempotency_key
ON creator_payouts(idempotency_key)
WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_creator_payouts_provider_status
ON creator_payouts(provider_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_creator_payout_requests_status
ON creator_payout_requests(status, created_at DESC);
