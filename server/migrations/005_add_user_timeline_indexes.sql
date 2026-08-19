-- PostgreSQL user-scoped chronological query indexes.
-- The primary keys support membership checks, while these indexes satisfy the
-- ORDER BY clauses used by repost history and authenticated session lists.

CREATE INDEX IF NOT EXISTS idx_reposts_user_created_desc
    ON reposts (user_id, created_at DESC, post_id);

CREATE INDEX IF NOT EXISTS idx_sessions_user_created_desc
    ON sessions (user_id, created_at DESC);
