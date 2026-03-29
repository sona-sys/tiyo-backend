-- ============================================================
-- TIYO Pay-to-Call App — V39 Ratings Migration
-- Adds creator<->caller ratings with aggregate reputation fields.
-- Safe to run multiple times.
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS user_rating DECIMAL(3, 2) DEFAULT 0.00;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS user_rating_count INTEGER DEFAULT 0;

ALTER TABLE creators
  ADD COLUMN IF NOT EXISTS rating_count INTEGER DEFAULT 0;

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS creator_rating SMALLINT;

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS caller_rating SMALLINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'calls_creator_rating_range_check'
  ) THEN
    ALTER TABLE calls
      ADD CONSTRAINT calls_creator_rating_range_check
      CHECK (creator_rating IS NULL OR creator_rating BETWEEN 1 AND 5);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'calls_caller_rating_range_check'
  ) THEN
    ALTER TABLE calls
      ADD CONSTRAINT calls_caller_rating_range_check
      CHECK (caller_rating IS NULL OR caller_rating BETWEEN 1 AND 5);
  END IF;
END $$;

UPDATE users
SET user_rating = COALESCE(user_rating, 0.00),
    user_rating_count = COALESCE(user_rating_count, 0);

UPDATE creators
SET rating_count = CASE
  WHEN rating_count IS NULL OR rating_count = 0 THEN COALESCE(total_calls, 0)
  ELSE rating_count
END;
