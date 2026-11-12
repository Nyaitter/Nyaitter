CREATE TABLE IF NOT EXISTS reputation_events (
  scope TEXT NOT NULL, event_key TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  dimension TEXT NOT NULL CHECK (dimension IN ('trust','writer','reviewer','ban')),
  amount REAL NOT NULL, successes INTEGER NOT NULL DEFAULT 0, day TEXT NOT NULL, cap REAL NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(scope,event_key)
);
CREATE INDEX IF NOT EXISTS reputation_events_user_day ON reputation_events(user_id,dimension,day);
CREATE TABLE IF NOT EXISTS reputation_daily (
  user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  dimension TEXT NOT NULL, day TEXT NOT NULL, positive REAL NOT NULL DEFAULT 0, negative REAL NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0, cap REAL NOT NULL, PRIMARY KEY(user_id,dimension,day)
);
CREATE TABLE IF NOT EXISTS reputation_profiles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  dimension TEXT NOT NULL, score REAL NOT NULL DEFAULT 0, successes INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id,dimension)
);
CREATE TABLE IF NOT EXISTS reputation_scopes (scope TEXT PRIMARY KEY, version BIGINT NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS reputation_notice_claims(notice_key TEXT PRIMARY KEY,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS note_selection_identities(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,selection_key TEXT NOT NULL DEFAULT gen_random_uuid()::text);
CREATE TABLE IF NOT EXISTS reviewer_outcome_claims(user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,author_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,day TEXT NOT NULL,note_id INTEGER NOT NULL,PRIMARY KEY(user_id,author_id,day));
CREATE OR REPLACE FUNCTION reputation_event_delta() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE r RECORD; sign INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; sign := -1; ELSE r := NEW; sign := 1; END IF;
  IF NOT EXISTS(SELECT 1 FROM users WHERE id=r.user_id) THEN RETURN NULL; END IF;
  INSERT INTO reputation_daily(user_id,dimension,day,positive,negative,successes,cap)
  VALUES(r.user_id,r.dimension,r.day,sign*GREATEST(r.amount,0),sign*LEAST(r.amount,0),sign*r.successes,r.cap)
  ON CONFLICT(user_id,dimension,day) DO UPDATE SET
    positive=reputation_daily.positive+EXCLUDED.positive, negative=reputation_daily.negative+EXCLUDED.negative,
    successes=reputation_daily.successes+EXCLUDED.successes;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION reputation_daily_delta() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE old_score REAL := 0; old_successes INTEGER := 0;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.user_id<>OLD.user_id THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' THEN old_score := LEAST(OLD.positive,OLD.cap)+OLD.negative; old_successes := LEAST(OLD.successes,FLOOR(OLD.cap)::int); END IF;
  INSERT INTO reputation_profiles(user_id,dimension,score,successes)
  VALUES(NEW.user_id,NEW.dimension,LEAST(NEW.positive,NEW.cap)+NEW.negative-old_score,LEAST(NEW.successes,FLOOR(NEW.cap)::int)-old_successes)
  ON CONFLICT(user_id,dimension) DO UPDATE SET score=reputation_profiles.score+EXCLUDED.score,successes=reputation_profiles.successes+EXCLUDED.successes;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS reputation_event_change ON reputation_events;
CREATE TRIGGER reputation_event_change AFTER INSERT OR DELETE ON reputation_events FOR EACH ROW EXECUTE FUNCTION reputation_event_delta();
DROP TRIGGER IF EXISTS reputation_daily_change ON reputation_daily;
CREATE TRIGGER reputation_daily_change AFTER INSERT OR UPDATE ON reputation_daily FOR EACH ROW EXECUTE FUNCTION reputation_daily_delta();
ALTER TABLE community_notes ADD COLUMN IF NOT EXISTS rating_version BIGINT NOT NULL DEFAULT 0;
ALTER TABLE community_notes ADD COLUMN IF NOT EXISTS distribution_key TEXT;
UPDATE community_notes SET distribution_key=post_id::text||':'||user_id::text;
ALTER TABLE note_ratings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE note_ratings ADD COLUMN IF NOT EXISTS weight REAL NOT NULL DEFAULT 1 CHECK(weight >= 1 AND weight <= 1.5);
CREATE OR REPLACE FUNCTION note_rating_version_delta() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE community_notes SET rating_version=rating_version+1 WHERE id=COALESCE(NEW.note_id,OLD.note_id);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS note_rating_version ON note_ratings;
CREATE TRIGGER note_rating_version AFTER INSERT OR UPDATE OR DELETE ON note_ratings FOR EACH ROW EXECUTE FUNCTION note_rating_version_delta();
CREATE TABLE IF NOT EXISTS note_creation_claims(post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(post_id,user_id));
INSERT INTO note_creation_claims SELECT post_id,user_id,MIN(created_at) FROM community_notes GROUP BY post_id,user_id ON CONFLICT DO NOTHING;
CREATE INDEX IF NOT EXISTS note_creation_claims_daily ON note_creation_claims(user_id,created_at);
CREATE INDEX IF NOT EXISTS community_note_daily_count ON community_notes(user_id,created_at);
CREATE OR REPLACE FUNCTION reputation_deleted_note() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM reputation_events WHERE scope='note:'||OLD.id::text AND (dimension='reviewer' OR amount>0);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS reputation_note_delete ON community_notes;
CREATE TRIGGER reputation_note_delete AFTER DELETE ON community_notes FOR EACH ROW EXECUTE FUNCTION reputation_deleted_note();
CREATE OR REPLACE FUNCTION reputation_deleted_post() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM reputation_events WHERE scope='post-trust:'||OLD.id::text;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS reputation_post_delete ON posts;
CREATE TRIGGER reputation_post_delete AFTER DELETE ON posts FOR EACH ROW EXECUTE FUNCTION reputation_deleted_post();
SELECT setval('community_notes_id_seq',GREATEST(COALESCE((SELECT MAX(id) FROM community_notes),0)+1,1),false);
