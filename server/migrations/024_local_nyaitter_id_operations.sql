ALTER TABLE users
    ADD COLUMN IF NOT EXISTS local_nyaitter_id INTEGER,
    ADD COLUMN IF NOT EXISTS account_operation TEXT;

UPDATE users
SET local_nyaitter_id = id
WHERE auth_provider <> 'nyaitter'
  AND local_nyaitter_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_local_nyaitter_id
    ON users (local_nyaitter_id)
    WHERE local_nyaitter_id IS NOT NULL;

ALTER TABLE users
    DROP CONSTRAINT IF EXISTS users_account_operation_check;

ALTER TABLE users
    ADD CONSTRAINT users_account_operation_check
    CHECK (account_operation IS NULL OR account_operation IN ('reassigning', 'deleting'));
