-- Community Notes Phase 2 (limited distribution / voting quorum / public promotion / penalty)
ALTER TABLE community_notes
  ADD COLUMN IF NOT EXISTS stage INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS note_distribution (
  note_id INTEGER NOT NULL REFERENCES community_notes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  tier INTEGER NOT NULL DEFAULT 1,
  notified BOOLEAN NOT NULL DEFAULT FALSE,
  relevance REAL NOT NULL DEFAULT 0.0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (note_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_note_distribution_note_id ON note_distribution(note_id);
CREATE INDEX IF NOT EXISTS idx_note_distribution_user_id ON note_distribution(user_id);
