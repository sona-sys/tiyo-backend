-- ============================================================
-- V32 Migration — Creator Mode (two-sided platform)
-- Run this in Supabase SQL Editor (one-time migration)
-- ============================================================

-- Users need a push_token for receiving notifications
ALTER TABLE users ADD COLUMN IF NOT EXISTS push_token TEXT;

-- Creators need last_seen for presence tracking
ALTER TABLE creators ADD COLUMN IF NOT EXISTS last_seen TIMESTAMP WITH TIME ZONE;

-- Creators need avatar_url (may already exist from V30)
ALTER TABLE creators ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- Index for looking up calls by receiver + status (creator incoming calls)
CREATE INDEX IF NOT EXISTS idx_calls_receiver_status ON calls(receiver_id, status);
