-- Group DMs
-- Backs the /server/api/dm routes (routes/dm.js), which model DMs as a single
-- "group" record with an arbitrary member list rather than a 1:1 channel.
-- Each row corresponds to InMemoryAdapter's `groupDms` entry:
--   { id, title, member: [userId...], host_id, time, post: [message...], unread: {userId: count} }

CREATE TABLE IF NOT EXISTS group_dms (
    id SERIAL PRIMARY KEY,
    host_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT DEFAULT '',
    member INTEGER[] NOT NULL DEFAULT '{}',
    post JSONB NOT NULL DEFAULT '[]',
    unread JSONB NOT NULL DEFAULT '{}',      -- { "<userId>": count }
    -- Timestamp of the most recent message (or creation time if empty).
    -- Named "time" to mirror the in-memory model's `dm.time`, used for list ordering.
    time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Membership lookups ("DMs this user is part of") are the hottest read path.
CREATE INDEX IF NOT EXISTS idx_group_dms_member ON group_dms USING GIN (member);

-- List ordering (time降順) per user relies on this composite-ish access pattern;
-- a plain index on time keeps the sort cheap once filtered by membership.
CREATE INDEX IF NOT EXISTS idx_group_dms_time ON group_dms (time DESC);
