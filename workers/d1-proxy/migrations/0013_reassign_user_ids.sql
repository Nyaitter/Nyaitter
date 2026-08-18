DROP INDEX IF EXISTS idx_users_local_nyaitter_id;
ALTER TABLE users DROP COLUMN local_nyaitter_id;

UPDATE users
SET handle = printf('#%04d', id)
WHERE auth_provider <> 'nyaitter';
