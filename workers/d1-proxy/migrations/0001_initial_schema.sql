-- Nyaitter Cloudflare D1 の新規DB用スキーマ

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
    block TEXT NOT NULL DEFAULT '[]',
    account_operation TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

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

CREATE TABLE IF NOT EXISTS trusted_login_ips (
    user_id INTEGER NOT NULL,
    ip_hash TEXT NOT NULL,
    ip_masked TEXT DEFAULT '不明なIPアドレス',
    created_at TEXT DEFAULT (datetime('now')),
    last_used_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY(user_id, ip_hash),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS login_approvals (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    ip_hash TEXT,
    ip_masked TEXT DEFAULT '不明なIPアドレス',
    user_agent TEXT DEFAULT '不明な端末',
    poll_token_hash TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    expires_at TEXT NOT NULL,
    decided_at TEXT,
    consumed_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bot_tokens (
    token_id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    name TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    last_used_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS follows (
    follower_id INTEGER NOT NULL,
    following_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY(follower_id, following_id),
    FOREIGN KEY(follower_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(following_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    content TEXT,
    attachments TEXT,
    mask INTEGER DEFAULT 0,
    lock INTEGER DEFAULT 0,
    announcement INTEGER NOT NULL DEFAULT 0,
    reply_to INTEGER,
    repost_to INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS likes (
    user_id INTEGER NOT NULL,
    post_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY(user_id, post_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS stars (
    user_id INTEGER NOT NULL,
    post_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY(user_id, post_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE
);

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

CREATE TABLE IF NOT EXISTS group_dms (
    id TEXT PRIMARY KEY,
    host_id INTEGER NOT NULL,
    title TEXT DEFAULT '',
    member TEXT NOT NULL,
    post TEXT DEFAULT '[]',
    unread TEXT DEFAULT '{}',
    time TEXT DEFAULT (datetime('now')),
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dm_e2e_keys (
    user_id INTEGER PRIMARY KEY,
    public_key TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dm_channels (
    id TEXT PRIMARY KEY,
    participants TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    from_user_id INTEGER,
    post_id INTEGER,
    target TEXT,
    message TEXT,
    read INTEGER DEFAULT 0,
    clicked INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

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

CREATE TABLE IF NOT EXISTS moderation_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_user_id INTEGER NOT NULL,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('user', 'post', 'dm', 'dm_message')),
    target_id TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    target_snapshot TEXT NOT NULL DEFAULT '{}',
    assignment_type TEXT NOT NULL DEFAULT 'report' CHECK (assignment_type IN ('report', 'freeze_appeal', 'verification_application')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'assigned', 'resolved')),
    assigned_admin_id INTEGER,
    assigned_at TEXT,
    excluded_admin_ids TEXT NOT NULL DEFAULT '[]',
    resolution TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    FOREIGN KEY(reporter_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(assigned_admin_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scratch_id TEXT,
    nyaitter_id INTEGER,
    masked_ip_uuid TEXT,
    log_time TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_scid ON users(scid);
CREATE INDEX IF NOT EXISTS idx_users_handle ON users(handle);
CREATE INDEX IF NOT EXISTS idx_users_nyaitter_address ON users(nyaitter_address);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_login_approvals_user ON login_approvals(user_id);
CREATE INDEX IF NOT EXISTS idx_login_approvals_poll ON login_approvals(id, poll_token_hash);
CREATE INDEX IF NOT EXISTS idx_bot_tokens_user ON bot_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);
CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id);
CREATE INDEX IF NOT EXISTS idx_posts_reply_to ON posts(reply_to);
CREATE INDEX IF NOT EXISTS idx_posts_repost_to ON posts(repost_to);
CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at);
CREATE INDEX IF NOT EXISTS idx_posts_announcements ON posts(created_at DESC, id DESC) WHERE announcement = 1 AND reply_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_posts_root_created_id_desc ON posts(created_at DESC, id DESC) WHERE reply_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_posts_user_created_id_desc ON posts(user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_posts_reply_created_id_desc ON posts(reply_to, created_at DESC, id DESC) WHERE reply_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_likes_post ON likes(post_id);
CREATE INDEX IF NOT EXISTS idx_stars_post ON stars(post_id);
CREATE INDEX IF NOT EXISTS idx_reposts_post ON reposts(post_id);
CREATE INDEX IF NOT EXISTS idx_group_dms_time ON group_dms(time);
CREATE INDEX IF NOT EXISTS idx_dm_messages_channel ON dm_messages(channel_id);
CREATE INDEX IF NOT EXISTS idx_dm_messages_channel_sent_id_desc ON dm_messages(channel_id, sent_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id) WHERE read = 0;
CREATE INDEX IF NOT EXISTS idx_logs_time ON logs(log_time);
CREATE INDEX IF NOT EXISTS moderation_reports_assignee_status_idx ON moderation_reports(assigned_admin_id, status, assigned_at DESC);
CREATE INDEX IF NOT EXISTS moderation_reports_status_assigned_at_idx ON moderation_reports(status, assigned_at ASC);
CREATE INDEX IF NOT EXISTS moderation_reports_reporter_created_idx ON moderation_reports(reporter_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS moderation_reports_appeal_reporter_status_idx ON moderation_reports(reporter_user_id, assignment_type, status, created_at DESC);
CREATE INDEX IF NOT EXISTS moderation_reports_verification_reporter_status_idx ON moderation_reports(reporter_user_id, assignment_type, status, created_at DESC);
