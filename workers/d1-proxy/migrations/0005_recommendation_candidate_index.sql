-- おすすめ候補は返信を除く新着投稿から選ぶため、候補集合の抽出を索引で支援する。
CREATE INDEX IF NOT EXISTS idx_posts_root_created_id_desc
    ON posts (created_at DESC, id DESC)
    WHERE reply_to IS NULL;
