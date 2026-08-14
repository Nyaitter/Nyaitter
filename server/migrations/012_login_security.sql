-- Unknown-IP login approval and session management.
-- Raw IP addresses are not written by the new code path.  Equality checks use an HMAC hash,
-- while the UI receives only a masked representation.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS session_id TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ip_hash TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ip_masked TEXT;

UPDATE sessions
SET session_id = md5(token || random()::TEXT || clock_timestamp()::TEXT)
WHERE session_id IS NULL;

ALTER TABLE sessions ALTER COLUMN session_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_session_id ON sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user_ip_hash ON sessions(user_id, ip_hash)
WHERE ip_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS trusted_login_ips (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ip_hash TEXT NOT NULL,
    ip_masked TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, ip_hash)
);

CREATE TABLE IF NOT EXISTS login_approvals (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ip_hash TEXT NOT NULL,
    ip_masked TEXT NOT NULL,
    user_agent TEXT NOT NULL,
    poll_token_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'consumed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    decided_at TIMESTAMPTZ,
    consumed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_login_approvals_user_status ON login_approvals(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_approvals_expiry ON login_approvals(status, expires_at);
