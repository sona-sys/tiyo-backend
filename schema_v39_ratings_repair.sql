-- ============================================================
-- TIYO Pay-to-Call App — V39 Ratings Repair
-- Rebuilds aggregate creator/caller ratings from actual submitted ratings.
-- Safe to run multiple times.
-- ============================================================

UPDATE creators c
SET
  rating = COALESCE(r.avg_rating, 0),
  rating_count = COALESCE(r.rating_count, 0)
FROM (
  SELECT
    receiver_id,
    ROUND(AVG(creator_rating)::numeric, 2) AS avg_rating,
    COUNT(creator_rating)::int AS rating_count
  FROM calls
  WHERE creator_rating IS NOT NULL
  GROUP BY receiver_id
) r
WHERE c.user_id = r.receiver_id;

UPDATE creators c
SET
  rating = 0,
  rating_count = 0
WHERE NOT EXISTS (
  SELECT 1
  FROM calls call_rows
  WHERE call_rows.receiver_id = c.user_id
    AND call_rows.creator_rating IS NOT NULL
);

UPDATE users u
SET
  user_rating = COALESCE(r.avg_rating, 0),
  user_rating_count = COALESCE(r.rating_count, 0)
FROM (
  SELECT
    caller_id,
    ROUND(AVG(caller_rating)::numeric, 2) AS avg_rating,
    COUNT(caller_rating)::int AS rating_count
  FROM calls
  WHERE caller_rating IS NOT NULL
  GROUP BY caller_id
) r
WHERE u.id = r.caller_id;

UPDATE users u
SET
  user_rating = 0,
  user_rating_count = 0
WHERE NOT EXISTS (
  SELECT 1
  FROM calls call_rows
  WHERE call_rows.caller_id = u.id
    AND call_rows.caller_rating IS NOT NULL
);
