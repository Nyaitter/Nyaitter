ALTER TABLE moderation_reports
  DROP CONSTRAINT IF EXISTS moderation_reports_target_kind_check;

ALTER TABLE moderation_reports
  ADD CONSTRAINT moderation_reports_target_kind_check
  CHECK (target_kind IN ('user', 'post', 'dm', 'dm_message'));

COMMENT ON COLUMN moderation_reports.target_snapshot IS
  '管理レビュー用の対象証跡。DMメッセージ報告では対象メッセージとサーバー保存済みの直近10メッセージを含む。';
