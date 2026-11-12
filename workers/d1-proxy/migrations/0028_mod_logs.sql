CREATE TABLE IF NOT EXISTS mod_logs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  result TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mod_logs_created_idx ON mod_logs (created_at DESC, id DESC);
