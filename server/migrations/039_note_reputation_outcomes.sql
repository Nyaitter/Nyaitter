CREATE TABLE IF NOT EXISTS reviewer_outcome_candidates (
  note_id INTEGER NOT NULL REFERENCES community_notes(id) ON UPDATE CASCADE ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  day TEXT NOT NULL, rated_at TIMESTAMPTZ NOT NULL, amount REAL NOT NULL,
  successes INTEGER NOT NULL, cap REAL NOT NULL, metadata TEXT NOT NULL,
  PRIMARY KEY(note_id,user_id)
);
CREATE INDEX IF NOT EXISTS reviewer_outcome_candidates_group ON reviewer_outcome_candidates(user_id,author_id,day,rated_at,note_id);

INSERT INTO reviewer_outcome_candidates(note_id,user_id,author_id,day,rated_at,amount,successes,cap,metadata)
SELECT n.id,e.user_id,n.user_id,e.day,date_trunc('milliseconds',COALESCE(r.created_at,n.created_at)),e.amount,e.successes,e.cap,
  (e.metadata::jsonb || jsonb_build_object('noteId',n.id,'authorId',n.user_id,'sourceScope',e.scope,
    'ratedAt',to_char(COALESCE(r.created_at,n.created_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))::text
FROM reputation_events e JOIN community_notes n ON e.scope='note:'||n.id::text
LEFT JOIN note_ratings r ON r.note_id=n.id AND r.user_id=e.user_id WHERE e.dimension='reviewer' ON CONFLICT DO NOTHING;

DELETE FROM reputation_events e USING reviewer_outcome_candidates c
WHERE e.dimension='reviewer' AND e.scope='note:'||c.note_id::text AND e.user_id=c.user_id;
DELETE FROM reviewer_outcome_claims;

CREATE OR REPLACE FUNCTION refresh_reviewer_outcome(uid INTEGER,aid INTEGER,outcome_day TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE winner reviewer_outcome_candidates%ROWTYPE; outcome_scope TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(19710,uid);
  outcome_scope := 'reviewer-outcome:'||uid::text||':'||aid::text||':'||outcome_day;
  DELETE FROM reputation_events WHERE scope=outcome_scope;
  DELETE FROM reviewer_outcome_claims WHERE user_id=uid AND author_id=aid AND day=outcome_day;
  SELECT * INTO winner FROM reviewer_outcome_candidates
    WHERE user_id=uid AND author_id=aid AND day=outcome_day ORDER BY rated_at,note_id LIMIT 1;
  IF FOUND AND EXISTS(SELECT 1 FROM users WHERE id=uid) AND EXISTS(SELECT 1 FROM users WHERE id=aid) THEN
    INSERT INTO reviewer_outcome_claims(user_id,author_id,day,note_id) VALUES(uid,aid,outcome_day,winner.note_id);
    INSERT INTO reputation_events(scope,event_key,user_id,dimension,amount,successes,day,cap,metadata)
      VALUES(outcome_scope,'outcome',uid,'reviewer',winner.amount,winner.successes,outcome_day,winner.cap,
        (winner.metadata::jsonb || jsonb_build_object('authorId',aid,'noteId',winner.note_id,'sourceScope','note:'||winner.note_id::text))::text);
  END IF;
END $$;
CREATE OR REPLACE FUNCTION reviewer_outcome_candidate_delta() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN PERFORM refresh_reviewer_outcome(OLD.user_id,OLD.author_id,OLD.day); END IF;
  IF TG_OP<>'DELETE' THEN PERFORM refresh_reviewer_outcome(NEW.user_id,NEW.author_id,NEW.day); END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS reviewer_outcome_candidate_change ON reviewer_outcome_candidates;
CREATE TRIGGER reviewer_outcome_candidate_change AFTER INSERT OR UPDATE OR DELETE ON reviewer_outcome_candidates
  FOR EACH ROW EXECUTE FUNCTION reviewer_outcome_candidate_delta();

SELECT refresh_reviewer_outcome(user_id,author_id,day) FROM reviewer_outcome_candidates GROUP BY user_id,author_id,day;
