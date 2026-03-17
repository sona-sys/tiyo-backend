-- ============================================================
-- V22 Migration — Add channel_name and call_type to calls table
-- Run this in Supabase SQL Editor (one-time migration)
-- ============================================================

ALTER TABLE calls ADD COLUMN IF NOT EXISTS channel_name VARCHAR(255);
ALTER TABLE calls ADD COLUMN IF NOT EXISTS call_type VARCHAR(20) DEFAULT 'voice';  -- 'voice' or 'video'
