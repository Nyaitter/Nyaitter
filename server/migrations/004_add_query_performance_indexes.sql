-- PostgreSQL query performance indexes.
-- Reaction lists and the pinned-post lookup filter by user_id and sort by created_at.
-- The primary keys cover membership checks, but not this chronological ordering.

CREATE INDEX IF NOT EXISTS idx_likes_user_created_desc
    ON likes (user_id, created_at DESC, post_id);

CREATE INDEX IF NOT EXISTS idx_stars_user_created_desc
    ON stars (user_id, created_at DESC, post_id);

CREATE INDEX IF NOT EXISTS idx_pinned_posts_user_created_desc
    ON pinned_posts (user_id, created_at DESC, post_id);
