CREATE TABLE IF NOT EXISTS reputation_events (
  scope TEXT NOT NULL, event_key TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  dimension TEXT NOT NULL CHECK(dimension IN ('trust','writer','reviewer','ban')),
  amount REAL NOT NULL, successes INTEGER NOT NULL DEFAULT 0, day TEXT NOT NULL, cap REAL NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(scope,event_key)
);
CREATE INDEX IF NOT EXISTS reputation_events_user_day ON reputation_events(user_id,dimension,day);
CREATE TABLE IF NOT EXISTS reputation_daily (
  user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE, dimension TEXT NOT NULL, day TEXT NOT NULL,
  positive REAL NOT NULL DEFAULT 0, negative REAL NOT NULL DEFAULT 0, successes INTEGER NOT NULL DEFAULT 0,
  cap REAL NOT NULL, PRIMARY KEY(user_id,dimension,day)
);
CREATE TABLE IF NOT EXISTS reputation_profiles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE, dimension TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0, successes INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id,dimension)
);
CREATE TABLE IF NOT EXISTS reputation_scopes(scope TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS reputation_notice_claims(notice_key TEXT PRIMARY KEY,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS note_selection_identities(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,selection_key TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reviewer_outcome_claims(user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,author_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,day TEXT NOT NULL,note_id INTEGER NOT NULL,PRIMARY KEY(user_id,author_id,day));
CREATE TRIGGER IF NOT EXISTS reputation_event_insert AFTER INSERT ON reputation_events BEGIN
  INSERT INTO reputation_daily(user_id,dimension,day,positive,negative,successes,cap)
  VALUES(NEW.user_id,NEW.dimension,NEW.day,MAX(NEW.amount,0),MIN(NEW.amount,0),NEW.successes,NEW.cap)
  ON CONFLICT(user_id,dimension,day) DO UPDATE SET positive=positive+excluded.positive,negative=negative+excluded.negative,successes=successes+excluded.successes;
END;
CREATE TRIGGER IF NOT EXISTS reputation_event_delete AFTER DELETE ON reputation_events BEGIN
  UPDATE reputation_daily SET positive=positive-MAX(OLD.amount,0),negative=negative-MIN(OLD.amount,0),successes=successes-OLD.successes
  WHERE user_id=OLD.user_id AND dimension=OLD.dimension AND day=OLD.day;
END;
CREATE TRIGGER IF NOT EXISTS reputation_daily_insert AFTER INSERT ON reputation_daily BEGIN
  INSERT INTO reputation_profiles(user_id,dimension,score,successes)
  VALUES(NEW.user_id,NEW.dimension,MIN(NEW.positive,NEW.cap)+NEW.negative,MIN(NEW.successes,CAST(NEW.cap AS INTEGER)))
  ON CONFLICT(user_id,dimension) DO UPDATE SET score=score+excluded.score,successes=successes+excluded.successes;
END;
CREATE TRIGGER IF NOT EXISTS reputation_daily_update AFTER UPDATE ON reputation_daily BEGIN
  UPDATE reputation_profiles SET score=score+MIN(NEW.positive,NEW.cap)+NEW.negative-MIN(OLD.positive,OLD.cap)-OLD.negative,
    successes=successes+MIN(NEW.successes,CAST(NEW.cap AS INTEGER))-MIN(OLD.successes,CAST(OLD.cap AS INTEGER))
  WHERE user_id=NEW.user_id AND dimension=NEW.dimension;
END;
ALTER TABLE community_notes ADD COLUMN rating_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE community_notes ADD COLUMN distribution_key TEXT;
UPDATE community_notes SET distribution_key=CAST(post_id AS TEXT)||':'||CAST(user_id AS TEXT);
ALTER TABLE note_ratings ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
UPDATE note_ratings SET updated_at=created_at WHERE updated_at='';
ALTER TABLE note_ratings ADD COLUMN weight REAL NOT NULL DEFAULT 1 CHECK(weight >= 1 AND weight <= 1.5);
CREATE TRIGGER IF NOT EXISTS note_rating_insert AFTER INSERT ON note_ratings BEGIN
  UPDATE community_notes SET rating_version=rating_version+1 WHERE id=NEW.note_id;
END;
CREATE TRIGGER IF NOT EXISTS note_rating_update AFTER UPDATE ON note_ratings BEGIN
  UPDATE community_notes SET rating_version=rating_version+1 WHERE id=NEW.note_id;
END;
CREATE TRIGGER IF NOT EXISTS note_rating_delete AFTER DELETE ON note_ratings BEGIN
  UPDATE community_notes SET rating_version=rating_version+1 WHERE id=OLD.note_id;
END;
CREATE TABLE IF NOT EXISTS note_creation_claims(post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,created_at TEXT NOT NULL,PRIMARY KEY(post_id,user_id));
INSERT OR IGNORE INTO note_creation_claims SELECT post_id,user_id,MIN(created_at) FROM community_notes GROUP BY post_id,user_id;
CREATE INDEX IF NOT EXISTS note_creation_claims_daily ON note_creation_claims(user_id,created_at);
CREATE INDEX IF NOT EXISTS community_note_daily_count ON community_notes(user_id,created_at);
CREATE TRIGGER IF NOT EXISTS reputation_note_delete AFTER DELETE ON community_notes BEGIN
  DELETE FROM reputation_events WHERE scope='note:'||CAST(OLD.id AS TEXT) AND (dimension='reviewer' OR amount>0);
END;
CREATE TRIGGER IF NOT EXISTS reputation_post_delete AFTER DELETE ON posts BEGIN
  DELETE FROM reputation_events WHERE scope='post-trust:'||CAST(OLD.id AS TEXT);
END;
