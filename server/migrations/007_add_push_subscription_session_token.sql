-- 007_add_push_subscription_session_token.sql
-- 購読作成時のブラウザセッショントークンを保存し、送信前にセッションの
-- 有効性を確認できるようにする。

ALTER TABLE push_subscriptions
    ADD COLUMN IF NOT EXISTS session_token TEXT;
