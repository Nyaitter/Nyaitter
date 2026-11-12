-- ユーザーごとの複数認証プロバイダー紐づけ用テーブル
CREATE TABLE IF NOT EXISTS user_auth_providers (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    provider TEXT NOT NULL,
    provider_user_id TEXT NOT NULL,
    provider_profile JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT user_auth_providers_unique_provider_user UNIQUE (provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_auth_providers_user_id ON user_auth_providers(user_id);
CREATE INDEX IF NOT EXISTS idx_user_auth_providers_lookup ON user_auth_providers(provider, provider_user_id);
