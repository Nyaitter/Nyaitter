ALTER TABLE moderation_reports
  ADD COLUMN IF NOT EXISTS assignment_type VARCHAR(24) NOT NULL DEFAULT 'report'
  CHECK (assignment_type IN ('report', 'freeze_appeal'));

CREATE INDEX IF NOT EXISTS moderation_reports_appeal_reporter_status_idx
  ON moderation_reports (reporter_user_id, assignment_type, status, created_at DESC);

COMMENT ON COLUMN moderation_reports.assignment_type IS '管理者割当の種別。report は通常報告、freeze_appeal は凍結異議申し立て。';
