-- 管理者アナウンス投稿
-- 既存投稿は通常投稿として扱い、明示的にアナウンス指定された投稿だけをお知らせタブへ表示する。

ALTER TABLE posts
    ADD COLUMN IF NOT EXISTS announcement BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_posts_announcements
    ON posts(created_at DESC, id DESC)
    WHERE announcement = true AND reply_to IS NULL;
