CREATE TABLE IF NOT EXISTS note_vote_admissions (
  note_id INTEGER NOT NULL REFERENCES community_notes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  admitted_at TIMESTAMPTZ NOT NULL,
  authorized BOOLEAN NOT NULL,
  weight REAL NOT NULL CHECK (weight >= 1 AND weight <= 1.5),
  evidence_ref TEXT,
  relation_manifest JSONB,
  legacy BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (note_id, user_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_note_vote_admissions_note ON note_vote_admissions(note_id, user_id);

INSERT INTO note_vote_admissions(note_id,user_id,revision,admitted_at,authorized,weight,relation_manifest,legacy)
SELECT r.note_id,r.user_id,1,r.created_at,FALSE,r.weight,NULL,TRUE
FROM note_ratings r
ON CONFLICT DO NOTHING;
