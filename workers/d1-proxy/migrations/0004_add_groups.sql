-- Nyaitter groups: UUID public IDs, permissioned memberships, and group-scoped posts.

CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    owner_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    icon_data TEXT,
    header_image TEXT,
    visibility TEXT NOT NULL DEFAULT 'open',
    deleted_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (length(name) BETWEEN 1 AND 100),
    CHECK (length(description) <= 2000),
    CHECK (visibility IN ('open', 'private', 'invite', 'open_invite')),
    FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS group_roles (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    name TEXT NOT NULL,
    permissions TEXT NOT NULL DEFAULT '[]',
    is_system INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(group_id, name),
    FOREIGN KEY(group_id) REFERENCES groups(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS group_memberships (
    group_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    role_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    joined_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(group_id, user_id),
    CHECK (status IN ('active', 'pending', 'invited', 'banned')),
    FOREIGN KEY(group_id) REFERENCES groups(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(role_id) REFERENCES group_roles(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS group_invites (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    inviter_id INTEGER NOT NULL,
    invitee_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    responded_at TEXT,
    UNIQUE(group_id, invitee_id, status),
    CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
    FOREIGN KEY(group_id) REFERENCES groups(id) ON DELETE CASCADE,
    FOREIGN KEY(inviter_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(invitee_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS group_join_requests (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    reviewed_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at TEXT,
    UNIQUE(group_id, user_id, status),
    CHECK (status IN ('pending', 'approved', 'declined', 'cancelled')),
    FOREIGN KEY(group_id) REFERENCES groups(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(reviewed_by) REFERENCES users(id) ON DELETE SET NULL
);

ALTER TABLE posts ADD COLUMN group_id TEXT;
ALTER TABLE posts ADD COLUMN group_announcement INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_groups_visibility_created ON groups(visibility, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_groups_owner ON groups(owner_id);
CREATE INDEX IF NOT EXISTS idx_group_roles_group ON group_roles(group_id, sort_order, name);
CREATE INDEX IF NOT EXISTS idx_group_memberships_user_status ON group_memberships(user_id, status, group_id);
CREATE INDEX IF NOT EXISTS idx_group_memberships_group_status ON group_memberships(group_id, status, user_id);
CREATE INDEX IF NOT EXISTS idx_group_invites_invitee_status ON group_invites(invitee_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_group_join_requests_group_status ON group_join_requests(group_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_group_created ON posts(group_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_posts_group_announcement_created ON posts(group_id, created_at DESC, id DESC);
