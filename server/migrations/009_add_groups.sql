-- Nyaitter groups: UUID public IDs, permissioned memberships, and group-scoped posts.

CREATE TABLE IF NOT EXISTS groups (
    id UUID PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    icon_data TEXT,
    header_image TEXT,
    visibility TEXT NOT NULL DEFAULT 'open',
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT groups_name_length CHECK (char_length(name) BETWEEN 1 AND 100),
    CONSTRAINT groups_description_length CHECK (char_length(description) <= 2000),
    CONSTRAINT groups_visibility_check CHECK (visibility IN ('open', 'private', 'invite', 'open_invite'))
);

CREATE TABLE IF NOT EXISTS group_roles (
    id UUID PRIMARY KEY,
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_system BOOLEAN NOT NULL DEFAULT false,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT group_roles_permissions_array CHECK (jsonb_typeof(permissions) = 'array'),
    CONSTRAINT group_roles_name_length CHECK (char_length(name) BETWEEN 1 AND 50),
    UNIQUE (group_id, name)
);

CREATE TABLE IF NOT EXISTS group_memberships (
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    role_id UUID REFERENCES group_roles(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'active',
    joined_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (group_id, user_id),
    CONSTRAINT group_memberships_status_check CHECK (status IN ('active', 'pending', 'invited', 'banned'))
);

CREATE TABLE IF NOT EXISTS group_invites (
    id UUID PRIMARY KEY,
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    inviter_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    invitee_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    responded_at TIMESTAMPTZ,
    CONSTRAINT group_invites_status_check CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
    UNIQUE (group_id, invitee_id, status)
);

CREATE TABLE IF NOT EXISTS group_join_requests (
    id UUID PRIMARY KEY,
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    reviewed_by INTEGER REFERENCES users(id) ON UPDATE CASCADE ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_at TIMESTAMPTZ,
    CONSTRAINT group_join_requests_status_check CHECK (status IN ('pending', 'approved', 'declined', 'cancelled')),
    UNIQUE (group_id, user_id, status)
);

ALTER TABLE posts ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES groups(id) ON DELETE RESTRICT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS group_announcement BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_groups_visibility_created ON groups(visibility, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_groups_owner ON groups(owner_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_group_roles_group ON group_roles(group_id, sort_order, name);
CREATE INDEX IF NOT EXISTS idx_group_memberships_user_status ON group_memberships(user_id, status, group_id);
CREATE INDEX IF NOT EXISTS idx_group_memberships_group_status ON group_memberships(group_id, status, user_id);
CREATE INDEX IF NOT EXISTS idx_group_invites_invitee_status ON group_invites(invitee_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_group_join_requests_group_status ON group_join_requests(group_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_group_created ON posts(group_id, created_at DESC, id DESC) WHERE group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_group_announcement_created ON posts(group_id, created_at DESC, id DESC) WHERE group_id IS NOT NULL AND group_announcement = true;
