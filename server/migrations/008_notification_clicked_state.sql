-- 通知の既読状態とクリック済み状態を独立して保持する。
-- `read` は未読バッジの集計専用、`clicked` は通知を開いた履歴専用とする。
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS clicked BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN notifications.clicked IS
  '通知をクリックして遷移したか。未読数・read状態には影響しない。';

CREATE INDEX IF NOT EXISTS idx_notifications_user_clicked
  ON notifications(user_id, clicked, created_at DESC);
