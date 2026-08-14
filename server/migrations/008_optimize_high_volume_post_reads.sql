-- 大量投稿向けの読取り最適化。
-- 実行中の本番環境では、必要に応じて運用手順に従い低負荷時間帯に適用してください。

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 時系列ページング、プロフィール、返信ツリー
CREATE INDEX IF NOT EXISTS idx_posts_created_id_desc
    ON posts (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_posts_user_created_id_desc
    ON posts (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_posts_reply_created_id_desc
    ON posts (reply_to, created_at DESC, id DESC)
    WHERE reply_to IS NOT NULL;

-- 投稿単位メトリクスと推薦スコア計算
CREATE INDEX IF NOT EXISTS idx_likes_post_id ON likes (post_id);
CREATE INDEX IF NOT EXISTS idx_stars_post_id ON stars (post_id);
CREATE INDEX IF NOT EXISTS idx_reposts_post_created_desc ON reposts (post_id, created_at DESC);

-- ILIKE '%query%' をトライグラムGIN索引で支援
CREATE INDEX IF NOT EXISTS idx_posts_content_trgm
    ON posts USING GIN (content gin_trgm_ops);

-- フォロー中タイムラインとフォロー一覧
CREATE INDEX IF NOT EXISTS idx_follows_follower_created_desc
    ON follows (follower_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_follows_following_created_desc
    ON follows (following_id, created_at DESC);

-- 通知とDMの既存ページングを時刻・IDで安定化
CREATE INDEX IF NOT EXISTS idx_notifications_user_created_id_desc
    ON notifications (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_dm_messages_channel_sent_id_desc
    ON dm_messages (channel_id, sent_at DESC, id DESC);
