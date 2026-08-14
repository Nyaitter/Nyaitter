-- DM E2E暗号化用の公開鍵
-- 各ユーザーが登録した公開鍵を保管する。秘密鍵はクライアント端末にのみ存在する。
-- public_key は ECDH(P-256) の未圧縮公開鍵（65バイト）を base64url 化した文字列。
CREATE TABLE IF NOT EXISTS dm_e2e_keys (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    public_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);