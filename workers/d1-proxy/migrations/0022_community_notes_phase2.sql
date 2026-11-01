-- Community Notes Phase 2 (D1 / SQLite)
-- SQLite の ALTER TABLE ADD COLUMN には IF NOT EXISTS が無いため、列追加は
-- 適用管理（wrangler の d1_migrations）による一度きりの適用が前提。
ALTER TABLE community_notes ADD COLUMN stage INTEGER NOT NULL DEFAULT 1;
ALTER TABLE community_notes ADD COLUMN published_at TEXT;

CREATE TABLE IF NOT EXISTS note_distribution (
    note_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    tier INTEGER NOT NULL DEFAULT 1,
    notified INTEGER NOT NULL DEFAULT 0,
    relevance REAL NOT NULL DEFAULT 0.0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (note_id, user_id),
    FOREIGN KEY (note_id) REFERENCES community_notes(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_note_distribution_note_id ON note_distribution(note_id);
CREATE INDEX IF NOT EXISTS idx_note_distribution_user_id ON note_distribution(user_id);
