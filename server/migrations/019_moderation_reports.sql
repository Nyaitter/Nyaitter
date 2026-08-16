CREATE TABLE IF NOT EXISTS moderation_reports (
  id BIGSERIAL PRIMARY KEY,
  reporter_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_kind VARCHAR(16) NOT NULL CHECK (target_kind IN ('user', 'post', 'dm')),
  target_id TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  target_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'assigned', 'resolved')),
  assigned_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ,
  excluded_admin_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  resolution JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS moderation_reports_assignee_status_idx
  ON moderation_reports (assigned_admin_id, status, assigned_at DESC);
CREATE INDEX IF NOT EXISTS moderation_reports_status_assigned_at_idx
  ON moderation_reports (status, assigned_at ASC);
CREATE INDEX IF NOT EXISTS moderation_reports_reporter_created_idx
  ON moderation_reports (reporter_user_id, created_at DESC);

COMMENT ON TABLE moderation_reports IS '匿名化された利用者報告と管理者割当。対象の証跡は作成時点のスナップショットとして保存する。';
COMMENT ON COLUMN moderation_reports.target_snapshot IS '管理レビュー用の対象証跡。DMの場合はサーバーに保存された直近10メッセージを含む。';
COMMENT ON COLUMN moderation_reports.excluded_admin_ids IS '期限切れ再割当で除外する管理者ID一覧。';
COMMENT ON COLUMN moderation_reports.resolution IS '対応した制裁と管理者通知の監査用記録。';
