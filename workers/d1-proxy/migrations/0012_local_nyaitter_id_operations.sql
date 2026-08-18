ALTER TABLE users ADD COLUMN local_nyaitter_id INTEGER;
ALTER TABLE users ADD COLUMN account_operation TEXT;

UPDATE users
SET local_nyaitter_id = id
WHERE auth_provider <> 'nyaitter'
  AND local_nyaitter_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_local_nyaitter_id
  ON users (local_nyaitter_id)
  WHERE local_nyaitter_id IS NOT NULL;
