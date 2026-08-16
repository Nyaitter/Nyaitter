ALTER TABLE moderation_reports
  DROP CONSTRAINT IF EXISTS moderation_reports_assignment_type_check;

ALTER TABLE moderation_reports
  ADD CONSTRAINT moderation_reports_assignment_type_check
  CHECK (assignment_type IN ('report', 'freeze_appeal', 'verification_application'));

CREATE INDEX IF NOT EXISTS moderation_reports_verification_reporter_status_idx
  ON moderation_reports (reporter_user_id, assignment_type, status, created_at DESC);
