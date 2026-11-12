-- Add denormalized counter columns to posts for instantaneous timeline reads
ALTER TABLE posts ADD COLUMN IF NOT EXISTS like_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS star_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS repost_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS reply_count INTEGER NOT NULL DEFAULT 0;

-- Backfill like counts
UPDATE posts
SET like_count = COALESCE(counts.cnt, 0)
FROM (
    SELECT post_id, COUNT(*)::int AS cnt
    FROM likes
    GROUP BY post_id
) AS counts
WHERE posts.id = counts.post_id;

-- Backfill star counts
UPDATE posts
SET star_count = COALESCE(counts.cnt, 0)
FROM (
    SELECT post_id, COUNT(*)::int AS cnt
    FROM stars
    GROUP BY post_id
) AS counts
WHERE posts.id = counts.post_id;

-- Backfill repost counts
UPDATE posts
SET repost_count = COALESCE(counts.cnt, 0)
FROM (
    SELECT post_id, COUNT(*)::int AS cnt
    FROM reposts
    GROUP BY post_id
) AS counts
WHERE posts.id = counts.post_id;

-- Backfill reply counts
UPDATE posts
SET reply_count = COALESCE(counts.cnt, 0)
FROM (
    SELECT reply_to AS post_id, COUNT(*)::int AS cnt
    FROM posts
    WHERE reply_to IS NOT NULL
    GROUP BY reply_to
) AS counts
WHERE posts.id = counts.post_id;
