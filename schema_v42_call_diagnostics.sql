-- V42 Migration — Call diagnostics

ALTER TABLE calls
ADD COLUMN IF NOT EXISTS end_reason TEXT;

ALTER TABLE calls
ADD COLUMN IF NOT EXISTS ended_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_calls_status_end_reason_created_at
ON calls(status, end_reason, created_at DESC);
