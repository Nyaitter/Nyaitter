CREATE INDEX IF NOT EXISTS idx_users_created_id_desc
  ON users(created_at DESC, id ASC);
