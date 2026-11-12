ALTER TABLE posts ADD COLUMN tags_generated_at TEXT;

CREATE INDEX IF NOT EXISTS idx_posts_tags_generated_at
  ON posts(tags_generated_at)
  WHERE tags_generated_at IS NULL;
