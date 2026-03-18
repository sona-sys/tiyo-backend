-- V28: Add avatar column to users table for profile pictures
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT;
