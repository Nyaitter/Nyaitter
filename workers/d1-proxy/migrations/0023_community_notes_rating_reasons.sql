-- Community Notes: 評価理由 (D1 / SQLite)
CREATE TABLE IF NOT EXISTS note_rating_reasons (
    note_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (note_id, user_id, code),
    FOREIGN KEY (note_id) REFERENCES community_notes(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (code) REFERENCES note_reason_tag_defs(code) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_note_rating_reasons_note_id ON note_rating_reasons(note_id);
CREATE INDEX IF NOT EXISTS idx_note_rating_reasons_user_id ON note_rating_reasons(user_id);
