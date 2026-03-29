-- V38 schema migration
-- Safe to rerun.

-- Handle support
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS handle VARCHAR(30);

-- Suspension status
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active';

UPDATE users
SET status = 'active'
WHERE status IS NULL;

-- Blocks
CREATE TABLE IF NOT EXISTS blocks (
    id SERIAL PRIMARY KEY,
    blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (blocker_id, blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_blocks_blocker ON blocks(blocker_id);
CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked_id);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- Enforce lowercase handle format and 3-30 char length at the DB layer.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'users_handle_format_check'
    ) THEN
        ALTER TABLE users
        ADD CONSTRAINT users_handle_format_check
        CHECK (
            handle IS NULL
            OR handle ~ '^[a-z0-9_]{3,30}$'
        );
    END IF;
END $$;

-- Keep handle uniqueness in the database while allowing NULLs.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_handle_unique
ON users(handle)
WHERE handle IS NOT NULL;
