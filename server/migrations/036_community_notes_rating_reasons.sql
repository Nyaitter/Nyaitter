-- Community Notes: 評価理由 (helpful / not helpful の理由コード)
CREATE TABLE IF NOT EXISTS note_rating_reasons (
  note_id INTEGER NOT NULL REFERENCES community_notes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  code TEXT NOT NULL REFERENCES note_reason_tag_defs(code) ON UPDATE CASCADE ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (note_id, user_id, code)
);

CREATE INDEX IF NOT EXISTS idx_note_rating_reasons_note_id ON note_rating_reasons(note_id);
CREATE INDEX IF NOT EXISTS idx_note_rating_reasons_user_id ON note_rating_reasons(user_id);
