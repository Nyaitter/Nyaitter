-- Evolution script example (003)
-- Adds useful indexes and any columns that were introduced after initial schema.
-- Safe to run multiple times (IF NOT EXISTS / IF EXISTS patterns).

-- Performance indexes for common queries
CREATE INDEX IF NOT EXISTS idx_posts_user_created ON posts(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reposts_post ON reposts(post_id);

-- Example: ensure a future column (safe no-op if already exists)
-- ALTER TABLE posts ADD COLUMN IF NOT EXISTS visibility TEXT DEFAULT 'public';

-- Add any other light migrations here as the schema evolves.
-- After applying, consider updating the main 001 or documenting the state.

COMMENT ON TABLE notifications IS 'User notifications (likes, stars, follows, replies, etc.)';
COMMENT ON TABLE reposts IS 'Tracks who reposted which posts (separate from legacy repost_to field)';