-- SQLite の ALTER TABLE ADD COLUMN には IF NOT EXISTS が無いため、この列追加は
-- 適用管理（wrangler の d1_migrations）による一度きりの適用が前提。
ALTER TABLE users ADD COLUMN admin_request_excluded INTEGER NOT NULL DEFAULT 0;
