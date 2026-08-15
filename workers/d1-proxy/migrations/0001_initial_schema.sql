-- migrations/0001_initial_schema.sql
-- Nyaitter Cloudflare D1 Initial Schema

-- 1. ユーザー (users)
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    scid TEXT,
    name TEXT NOT NULL,
    handle TEXT NOT NULL,
    nyaitter_address TEXT,
    auth_provider TEXT DEFAULT 'local',
    provider_domain TEXT,
    external_id TEXT,
    external_profile TEXT,
    uuid TEXT,
    settings TEXT DEFAULT '{}',
    bio TEXT DEFAULT '',
    header_image TEXT,
    icon_data TEXT,
    verify INTEGER DEFAULT 0,
    admin INTEGER DEFAULT 0,
    freeze TEXT,
    shadow INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_scid ON users(scid);
CREATE INDEX IF NOT EXISTS idx_users_handle ON users(handle);
CREATE INDEX IF NOT EXISTS idx_users_nyaitter_address ON users(nyaitter_address);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at);

-- 2. セッション (sessions)
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    token TEXT UNIQUE NOT NULL,
    user_id INTEGER NOT NULL,
    ip_hash TEXT,
    ip_masked TEXT DEFAULT '不明なIPアドレス',
    user_agent TEXT DEFAULT '不明な端末',
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- 3. 信頼済みログインIP (trusted_login_ips)
CREATE TABLE IF NOT EXISTS trusted_login_ips (
    user_id INTEGER NOT NULL,
    ip_hash TEXT NOT NULL,
    ip_masked TEXT DEFAULT '不明なIPアドレス',
    created_at TEXT DEFAULT (datetime('now')),
    last_used_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY(user_id, ip_hash),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 4. ログイン承認 (login_approvals)
CREATE TABLE IF NOT EXISTS login_approvals (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    ip_hash TEXT,
    ip_masked TEXT DEFAULT '不明なIPアドレス',
    user_agent TEXT DEFAULT '不明な端末',
    poll_token_hash TEXT NOT NULL,
    status TEXT DEFAULT 'pending', -- pending, approved, denied, consumed, expired
    expires_at TEXT NOT NULL,
    decided_at TEXT,
    consumed_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_login_approvals_user ON login_approvals(user_id);
CREATE INDEX IF NOT EXISTS idx_login_approvals_poll ON login_approvals(id, poll_token_hash);

-- 5. Botトークン (bot_tokens)
CREATE TABLE IF NOT EXISTS bot_tokens (
    token_id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    name TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    last_used_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bot_tokens_user ON bot_tokens(user_id);

-- 6. フォロー関係 (follows)
CREATE TABLE IF NOT EXISTS follows (
    follower_id INTEGER NOT NULL,
    following_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY(follower_id, following_id),
    FOREIGN KEY(follower_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(following_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);

-- 7. 投稿 (posts)
CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    content TEXT,
    attachments TEXT,
    mask INTEGER DEFAULT 0,
    lock INTEGER DEFAULT 0,
    reply_to INTEGER,
    repost_to INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id);
CREATE INDEX IF NOT EXISTS idx_posts_reply_to ON posts(reply_to);
CREATE INDEX IF NOT EXISTS idx_posts_repost_to ON posts(repost_to);
CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at);

-- 8. リアクション・ピン・リポスト
CREATE TABLE IF NOT EXISTS likes (
    user_id INTEGER NOT NULL,
    post_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY(user_id, post_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_likes_post ON likes(post_id);

CREATE TABLE IF NOT EXISTS stars (
    user_id INTEGER NOT NULL,
    post_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY(user_id, post_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_stars_post ON stars(post_id);

CREATE TABLE IF NOT EXISTS pinned_posts (
    user_id INTEGER NOT NULL,
    post_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY(user_id, post_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reposts (
    user_id INTEGER NOT NULL,
    post_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY(user_id, post_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_reposts_post ON reposts(post_id);

-- 9. グループDM & 1:1 DM
CREATE TABLE IF NOT EXISTS group_dms (
    id TEXT PRIMARY KEY,
    host_id INTEGER NOT NULL,
    title TEXT DEFAULT '',
    member TEXT NOT NULL, -- JSON array of user IDs
    post TEXT DEFAULT '[]', -- JSON array of messages
    unread TEXT DEFAULT '{}', -- JSON object: userId -> count
    time TEXT DEFAULT (datetime('now')),
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_group_dms_time ON group_dms(time);

-- DM E2E暗号化用の公開鍵
CREATE TABLE IF NOT EXISTS dm_e2e_keys (
    user_id INTEGER PRIMARY KEY,
    public_key TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dm_channels (
    id TEXT PRIMARY KEY,
    participants TEXT NOT NULL, -- JSON array
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dm_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    sender_id INTEGER NOT NULL,
    content TEXT,
    sent_at TEXT DEFAULT (datetime('now')),
    read_at TEXT,
    FOREIGN KEY(channel_id) REFERENCES dm_channels(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_dm_messages_channel ON dm_messages(channel_id);

-- 10. 通知 (notifications)
CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    from_user_id INTEGER,
    post_id INTEGER,
    target TEXT, -- JSON target object
    read INTEGER DEFAULT 0,
    clicked INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at);

-- 11. Web Push 購読 (push_subscriptions)
CREATE TABLE IF NOT EXISTS push_subscriptions (
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL,
    expiration_time INTEGER,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    session_token TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY(user_id, endpoint),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 12. 監査ログ (logs)
CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scratch_id TEXT,
    nyaitter_id INTEGER,
    masked_ip_uuid TEXT,
    log_time TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_logs_time ON logs(log_time);
