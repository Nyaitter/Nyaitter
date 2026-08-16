-- 管理者アナウンス投稿
-- 既存投稿は通常投稿として扱う。

ALTER TABLE posts ADD COLUMN announcement INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_posts_announcements
    ON posts(created_at DESC, id DESC)
    WHERE announcement = 1 AND reply_to IS NULL;
