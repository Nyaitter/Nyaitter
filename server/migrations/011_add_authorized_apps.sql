-- 連携アプリケーション (NyaitterAuth / OAuth) 管理テーブル
CREATE TABLE IF NOT EXISTS authorized_apps (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    app_id TEXT NOT NULL,
    app_token_hash TEXT NOT NULL,
    app_name TEXT NOT NULL,
    app_icon_url TEXT,
    scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
    access_token_id TEXT,
    access_token_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,
    CONSTRAINT authorized_apps_user_app_unique UNIQUE (user_id, app_id, app_token_hash)
);

CREATE INDEX IF NOT EXISTS idx_authorized_apps_user_id ON authorized_apps(user_id);
CREATE INDEX IF NOT EXISTS idx_authorized_apps_access_token_id ON authorized_apps(access_token_id) WHERE access_token_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_authorized_apps_lookup ON authorized_apps(user_id, app_id, app_token_hash);
