-- ============================================================
-- V45 Migration — creator concurrency guardrails + notify-when-free
-- Safe to rerun.
-- ============================================================

-- Clean up duplicate active calls so the unique partial indexes can be created.
WITH active_calls AS (
  SELECT
    id,
    status,
    start_time,
    ROW_NUMBER() OVER (PARTITION BY caller_id ORDER BY created_at DESC, id DESC) AS caller_rank,
    ROW_NUMBER() OVER (PARTITION BY receiver_id ORDER BY created_at DESC, id DESC) AS receiver_rank
  FROM calls
  WHERE status IN ('ringing', 'connected')
    AND end_time IS NULL
),
duplicate_calls AS (
  SELECT DISTINCT id
  FROM active_calls
  WHERE caller_rank > 1 OR receiver_rank > 1
)
UPDATE calls c
SET status = 'missed',
    end_time = COALESCE(c.end_time, NOW()),
    end_reason = COALESCE(c.end_reason, 'system_cleanup'),
    ended_by_user_id = NULL
FROM duplicate_calls d
WHERE c.id = d.id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_one_active_per_caller
ON calls(caller_id)
WHERE status IN ('ringing', 'connected') AND end_time IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_one_active_per_receiver
ON calls(receiver_id)
WHERE status IN ('ringing', 'connected') AND end_time IS NULL;

CREATE TABLE IF NOT EXISTS creator_free_alerts (
  id SERIAL PRIMARY KEY,
  creator_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  caller_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_call_id INTEGER NULL REFERENCES calls(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT creator_free_alerts_status_check
    CHECK (status IN ('active', 'notified', 'expired', 'cancelled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_creator_free_alerts_one_active
ON creator_free_alerts(creator_user_id, caller_user_id)
WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_creator_free_alerts_creator_status_expires
ON creator_free_alerts(creator_user_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_creator_free_alerts_caller_status
ON creator_free_alerts(caller_user_id, status, created_at DESC);

ALTER TABLE IF EXISTS public.creator_free_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.creator_free_alerts FROM anon, authenticated;
