-- ============================================================
-- V30 Migration: Add avatar_url to creators
-- ============================================================
-- Run in Supabase SQL Editor

-- Add column
ALTER TABLE creators ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- Seed with AI-style illustrated portrait URLs (DiceBear notionists style)
-- These are deterministic — same seed always gives the same face
UPDATE creators SET avatar_url = 'https://api.dicebear.com/9.x/notionists/png?seed=Nida&size=512&backgroundColor=b6e3f4' WHERE user_id = 1;
UPDATE creators SET avatar_url = 'https://api.dicebear.com/9.x/notionists/png?seed=Riya&size=512&backgroundColor=ffd5dc' WHERE user_id = 2;
UPDATE creators SET avatar_url = 'https://api.dicebear.com/9.x/notionists/png?seed=Kabir&size=512&backgroundColor=d1d4f9' WHERE user_id = 3;
UPDATE creators SET avatar_url = 'https://api.dicebear.com/9.x/notionists/png?seed=Simran&size=512&backgroundColor=c0aede' WHERE user_id = 4;
UPDATE creators SET avatar_url = 'https://api.dicebear.com/9.x/notionists/png?seed=DrZoya&size=512&backgroundColor=ffdfbf' WHERE user_id = 5;
UPDATE creators SET avatar_url = 'https://api.dicebear.com/9.x/notionists/png?seed=Vikram&size=512&backgroundColor=b6e3f4' WHERE user_id = 6;
