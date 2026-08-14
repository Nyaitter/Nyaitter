-- 007_structured_notifications.sql
-- 通知を message/open 中心の表示用レコードから、target JSON を持つ構造化レコードへ移行する。
-- 旧message/open列は既存データの読取互換性のため残すが、新規通知は使用しない。

ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS target JSONB;

-- 既存のpost_idを最優先し、残る旧openハッシュはroute targetとして一度だけ変換する。
UPDATE notifications
SET target = jsonb_build_object('kind', 'post', 'id', post_id)
WHERE target IS NULL AND post_id IS NOT NULL;

UPDATE notifications
SET target = jsonb_build_object('kind', 'route', 'value', open)
WHERE target IS NULL
  AND open IS NOT NULL
  AND open LIKE '#%';

CREATE INDEX IF NOT EXISTS idx_notifications_target_kind
    ON notifications ((target->>'kind'));
