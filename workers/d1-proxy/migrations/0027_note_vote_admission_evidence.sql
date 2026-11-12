CREATE TABLE IF NOT EXISTS note_vote_admissions (
  note_id INTEGER NOT NULL REFERENCES community_notes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  admitted_at TEXT NOT NULL,
  authorized INTEGER NOT NULL,
  weight REAL NOT NULL CHECK (weight >= 1 AND weight <= 1.5),
  evidence_ref TEXT,
  relation_manifest TEXT,
  legacy INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (note_id, user_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_note_vote_admissions_note ON note_vote_admissions(note_id, user_id);

INSERT OR IGNORE INTO note_vote_admissions(note_id,user_id,revision,admitted_at,authorized,weight,relation_manifest,legacy)
SELECT note_id,user_id,1,created_at,0,weight,NULL,1 FROM note_ratings;
