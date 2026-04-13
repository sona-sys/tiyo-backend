-- ============================================================
-- V44 Migration — Money Ops, Monthly Payouts, Admin Reconciliation
-- Safe to rerun.
-- ============================================================

-- Transaction source linkage for idempotent money events
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS source_type TEXT;

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS source_id TEXT;

-- Creator payout destination
ALTER TABLE creators
  ADD COLUMN IF NOT EXISTS payout_upi_id TEXT;

ALTER TABLE creators
  ADD COLUMN IF NOT EXISTS payout_upi_updated_at TIMESTAMPTZ;

-- Paid payout batches
CREATE TABLE IF NOT EXISTS creator_payouts (
    id SERIAL PRIMARY KEY,
    creator_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount DECIMAL(10, 2) NOT NULL CHECK (amount >= 0),
    upi_id TEXT,
    external_reference TEXT,
    note TEXT,
    paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Creator payout requests (open, rejected, or resolved by a payout)
CREATE TABLE IF NOT EXISTS creator_payout_requests (
    id SERIAL PRIMARY KEY,
    creator_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    requested_amount DECIMAL(10, 2) NOT NULL CHECK (requested_amount >= 0),
    upi_id TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    reason TEXT,
    payout_id INTEGER REFERENCES creator_payouts(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    CONSTRAINT creator_payout_requests_status_check
      CHECK (status IN ('open', 'rejected', 'paid'))
);

-- Links each paid payout to the earning transactions it settled
CREATE TABLE IF NOT EXISTS creator_payout_items (
    id SERIAL PRIMARY KEY,
    payout_id INTEGER NOT NULL REFERENCES creator_payouts(id) ON DELETE CASCADE,
    transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
    amount DECIMAL(10, 2) NOT NULL CHECK (amount >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_transactions_source
ON transactions(source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_creator_payouts_creator
ON creator_payouts(creator_user_id, paid_at DESC);

CREATE INDEX IF NOT EXISTS idx_creator_payout_requests_creator
ON creator_payout_requests(creator_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_creator_payout_items_payout
ON creator_payout_items(payout_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_creator_payout_requests_one_open
ON creator_payout_requests(creator_user_id)
WHERE status = 'open';

-- Remove any accidental duplicate source-linked success rows before enforcing uniqueness.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, type, source_type, source_id
      ORDER BY id
    ) AS rn
  FROM transactions
  WHERE status = 'success'
    AND source_type IS NOT NULL
    AND source_id IS NOT NULL
)
DELETE FROM transactions t
USING ranked r
WHERE t.id = r.id
  AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_success_source_unique
ON transactions(user_id, type, source_type, source_id)
WHERE status = 'success'
  AND source_type IS NOT NULL
  AND source_id IS NOT NULL;

-- Lock payout tables away from Supabase public API access.
ALTER TABLE IF EXISTS public.creator_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.creator_payout_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.creator_payout_items ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.creator_payouts FROM anon, authenticated;
REVOKE ALL ON TABLE public.creator_payout_requests FROM anon, authenticated;
REVOKE ALL ON TABLE public.creator_payout_items FROM anon, authenticated;

-- Backfill source-linked call debit rows for completed calls that do not have one yet.
INSERT INTO transactions (user_id, amount, type, status, source_type, source_id, created_at)
SELECT
  c.caller_id,
  -c.total_cost,
  'call_debit',
  'success',
  'call',
  c.id::TEXT,
  COALESCE(c.end_time, c.created_at, NOW())
FROM calls c
WHERE c.status = 'completed'
  AND COALESCE(c.total_cost, 0) > 0
  AND NOT EXISTS (
    SELECT 1
    FROM transactions t
    WHERE t.user_id = c.caller_id
      AND t.type = 'call_debit'
      AND t.status = 'success'
      AND t.source_type = 'call'
      AND t.source_id = c.id::TEXT
  );

-- Backfill source-linked creator earning rows for completed calls that do not have one yet.
INSERT INTO transactions (user_id, amount, type, status, source_type, source_id, created_at)
SELECT
  c.receiver_id,
  c.total_cost,
  'call_earning',
  'success',
  'call',
  c.id::TEXT,
  COALESCE(c.end_time, c.created_at, NOW())
FROM calls c
WHERE c.status = 'completed'
  AND COALESCE(c.total_cost, 0) > 0
  AND NOT EXISTS (
    SELECT 1
    FROM transactions t
    WHERE t.user_id = c.receiver_id
      AND t.type = 'call_earning'
      AND t.status = 'success'
      AND t.source_type = 'call'
      AND t.source_id = c.id::TEXT
  );
