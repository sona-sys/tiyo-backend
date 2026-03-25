-- V33: Add video_rate column for differential pricing (voice vs video)
-- Run this in Supabase SQL Editor

-- Add video_rate column, default to same as voice rate
ALTER TABLE creators ADD COLUMN IF NOT EXISTS video_rate NUMERIC(10,2);

-- Set existing creators' video_rate to their current rate (so nothing breaks)
UPDATE creators SET video_rate = rate WHERE video_rate IS NULL;

-- Make video_rate NOT NULL with a default going forward
ALTER TABLE creators ALTER COLUMN video_rate SET DEFAULT 10;
ALTER TABLE creators ALTER COLUMN video_rate SET NOT NULL;
