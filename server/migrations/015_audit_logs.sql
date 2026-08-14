-- 015_audit_logs.sql
-- ログイン監査ログ（マスク済みIP）。D1プロキシの logs テーブルと同形状。

CREATE TABLE IF NOT EXISTS logs (
    id SERIAL PRIMARY KEY,
    scratch_id TEXT,
    nyaitter_id INTEGER,
    masked_ip_uuid TEXT,
    log_time TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_logs_time ON logs(log_time DESC);
