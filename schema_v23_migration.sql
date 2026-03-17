-- V23: Push Notifications + Creator Presence
-- Run this in Supabase SQL Editor

-- Add push token column to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS push_token TEXT;

-- Add last_seen column to creators for presence tracking
ALTER TABLE creators ADD COLUMN IF NOT EXISTS last_seen TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- Create notifications table to store notification history
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  title VARCHAR(255) NOT NULL,
  body TEXT NOT NULL,
  type VARCHAR(50) NOT NULL, -- 'call_incoming', 'payment_success', 'call_summary', 'promo'
  data JSONB DEFAULT '{}',
  read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for fast notification queries
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);
