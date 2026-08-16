-- 高頻度のページングと未読集計を、既存クエリの条件・並び順に合わせて支援する。
CREATE INDEX IF NOT EXISTS idx_posts_user_created_id_desc
    ON posts (user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_posts_reply_created_id_desc
    ON posts (reply_to, created_at DESC, id DESC)
    WHERE reply_to IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
    ON notifications (user_id)
    WHERE read = 0;

CREATE INDEX IF NOT EXISTS idx_dm_messages_channel_sent_id_desc
    ON dm_messages (channel_id, sent_at DESC, id DESC);
