ALTER TABLE moderation_reports
  ADD COLUMN assignment_type TEXT NOT NULL DEFAULT 'report'
  CHECK (assignment_type IN ('report', 'freeze_appeal'));

CREATE INDEX IF NOT EXISTS moderation_reports_appeal_reporter_status_idx
  ON moderation_reports (reporter_user_id, assignment_type, status, created_at DESC);
