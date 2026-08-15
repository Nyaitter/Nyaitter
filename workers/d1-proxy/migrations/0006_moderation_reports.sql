CREATE TABLE IF NOT EXISTS moderation_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_user_id INTEGER NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('user', 'post', 'dm')),
  target_id TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  target_snapshot TEXT NOT NULL DEFAULT '{}',
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

CREATE INDEX IF NOT EXISTS moderation_reports_assignee_status_idx
  ON moderation_reports (assigned_admin_id, status, assigned_at DESC);
CREATE INDEX IF NOT EXISTS moderation_reports_status_assigned_at_idx
  ON moderation_reports (status, assigned_at ASC);
CREATE INDEX IF NOT EXISTS moderation_reports_reporter_created_idx
  ON moderation_reports (reporter_user_id, created_at DESC);
