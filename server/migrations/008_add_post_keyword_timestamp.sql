ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS tags_generated_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_posts_tags_generated_at
  ON posts(tags_generated_at)
  WHERE tags_generated_at IS NULL;
