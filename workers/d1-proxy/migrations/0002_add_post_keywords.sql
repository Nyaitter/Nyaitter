ALTER TABLE posts ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS user_keyword_affinities (
  user_id INTEGER NOT NULL,
  keyword TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, keyword),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_keyword_affinities_user_score
  ON user_keyword_affinities(user_id, score DESC, keyword);
