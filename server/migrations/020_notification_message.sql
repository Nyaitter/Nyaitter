ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS message TEXT;

COMMENT ON COLUMN notifications.message IS 'システム・管理者通知に任意で添付する表示本文。';
