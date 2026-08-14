-- 投稿単位のフォロワー限定公開フラグ
ALTER TABLE posts
	ADD COLUMN IF NOT EXISTS lock BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_posts_lock_created_at
	ON posts (lock, created_at DESC);
