PRAGMA foreign_keys = OFF;

CREATE TABLE moderation_reports_rebuild (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_user_id INTEGER NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('user', 'post', 'dm')),
  target_id TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  target_snapshot TEXT NOT NULL DEFAULT '{}',
  assignment_type TEXT NOT NULL DEFAULT 'report'
    CHECK (assignment_type IN ('report', 'freeze_appeal', 'verification_application')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'assigned', 'resolved')),
  assigned_admin_id INTEGER,
  assigned_at TEXT,
  excluded_admin_ids TEXT NOT NULL DEFAULT '[]',
  resolution TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY (reporter_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_admin_id) REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO moderation_reports_rebuild (
  id, reporter_user_id, target_kind, target_id, description, target_snapshot,
  assignment_type, status, assigned_admin_id, assigned_at, excluded_admin_ids,
  resolution, created_at, resolved_at
)
SELECT
  id, reporter_user_id, target_kind, target_id, description, target_snapshot,
  assignment_type, status, assigned_admin_id, assigned_at, excluded_admin_ids,
  resolution, created_at, resolved_at
FROM moderation_reports;

DROP TABLE moderation_reports;
ALTER TABLE moderation_reports_rebuild RENAME TO moderation_reports;

CREATE INDEX IF NOT EXISTS moderation_reports_assignee_status_idx
  ON moderation_reports (assigned_admin_id, status, assigned_at DESC);
CREATE INDEX IF NOT EXISTS moderation_reports_status_assigned_at_idx
  ON moderation_reports (status, assigned_at ASC);
CREATE INDEX IF NOT EXISTS moderation_reports_reporter_created_idx
  ON moderation_reports (reporter_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS moderation_reports_appeal_reporter_status_idx
  ON moderation_reports (reporter_user_id, assignment_type, status, created_at DESC);
CREATE INDEX IF NOT EXISTS moderation_reports_verification_reporter_status_idx
  ON moderation_reports (reporter_user_id, assignment_type, status, created_at DESC);

PRAGMA foreign_keys = ON;
