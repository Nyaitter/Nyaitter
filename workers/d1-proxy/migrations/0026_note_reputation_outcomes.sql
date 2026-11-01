CREATE TABLE IF NOT EXISTS reviewer_outcome_candidates (
  note_id INTEGER NOT NULL REFERENCES community_notes(id) ON UPDATE CASCADE ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  day TEXT NOT NULL, rated_at TEXT NOT NULL, amount REAL NOT NULL,
  successes INTEGER NOT NULL, cap REAL NOT NULL, metadata TEXT NOT NULL,
  PRIMARY KEY(note_id,user_id)
);
CREATE INDEX IF NOT EXISTS reviewer_outcome_candidates_group ON reviewer_outcome_candidates(user_id,author_id,day,rated_at,note_id);

INSERT OR IGNORE INTO reviewer_outcome_candidates(note_id,user_id,author_id,day,rated_at,amount,successes,cap,metadata)
SELECT n.id,e.user_id,n.user_id,e.day,strftime('%Y-%m-%dT%H:%M:%fZ',COALESCE(r.created_at,n.created_at)),e.amount,e.successes,e.cap,
  json_set(e.metadata,'$.noteId',n.id,'$.authorId',n.user_id,'$.sourceScope',e.scope,
    '$.ratedAt',strftime('%Y-%m-%dT%H:%M:%fZ',COALESCE(r.created_at,n.created_at)))
FROM reputation_events e JOIN community_notes n ON e.scope='note:'||CAST(n.id AS TEXT)
LEFT JOIN note_ratings r ON r.note_id=n.id AND r.user_id=e.user_id WHERE e.dimension='reviewer';

DELETE FROM reputation_events WHERE dimension='reviewer' AND EXISTS(
  SELECT 1 FROM reviewer_outcome_candidates c WHERE reputation_events.scope='note:'||CAST(c.note_id AS TEXT) AND reputation_events.user_id=c.user_id);
DELETE FROM reviewer_outcome_claims;

INSERT OR IGNORE INTO reviewer_outcome_claims(user_id,author_id,day,note_id)
SELECT user_id,author_id,day,note_id FROM (
  SELECT *,ROW_NUMBER() OVER(PARTITION BY user_id,author_id,day ORDER BY rated_at,note_id) AS position
  FROM reviewer_outcome_candidates
) WHERE position=1;
INSERT OR IGNORE INTO reputation_events(scope,event_key,user_id,dimension,amount,successes,day,cap,metadata)
SELECT 'reviewer-outcome:'||c.user_id||':'||c.author_id||':'||c.day,'outcome',c.user_id,'reviewer',c.amount,c.successes,c.day,c.cap,json_set(c.metadata,'$.authorId',c.author_id,'$.noteId',c.note_id,'$.sourceScope','note:'||c.note_id)
FROM reviewer_outcome_candidates c JOIN reviewer_outcome_claims w
  ON w.user_id=c.user_id AND w.author_id=c.author_id AND w.day=c.day AND w.note_id=c.note_id;

CREATE TRIGGER IF NOT EXISTS reviewer_outcome_candidate_insert AFTER INSERT ON reviewer_outcome_candidates BEGIN
  DELETE FROM reputation_events WHERE scope='reviewer-outcome:'||NEW.user_id||':'||NEW.author_id||':'||NEW.day;
  DELETE FROM reviewer_outcome_claims WHERE user_id=NEW.user_id AND author_id=NEW.author_id AND day=NEW.day;
  INSERT INTO reviewer_outcome_claims(user_id,author_id,day,note_id)
    SELECT user_id,author_id,day,note_id FROM reviewer_outcome_candidates
    WHERE user_id=NEW.user_id AND author_id=NEW.author_id AND day=NEW.day ORDER BY rated_at,note_id LIMIT 1;
  INSERT INTO reputation_events(scope,event_key,user_id,dimension,amount,successes,day,cap,metadata)
    SELECT 'reviewer-outcome:'||c.user_id||':'||c.author_id||':'||c.day,'outcome',c.user_id,'reviewer',c.amount,c.successes,c.day,c.cap,json_set(c.metadata,'$.authorId',c.author_id,'$.noteId',c.note_id,'$.sourceScope','note:'||c.note_id)
    FROM reviewer_outcome_candidates c JOIN reviewer_outcome_claims w ON w.user_id=c.user_id AND w.author_id=c.author_id AND w.day=c.day AND w.note_id=c.note_id
    WHERE c.user_id=NEW.user_id AND c.author_id=NEW.author_id AND c.day=NEW.day;
END;
CREATE TRIGGER IF NOT EXISTS reviewer_outcome_candidate_delete AFTER DELETE ON reviewer_outcome_candidates BEGIN
  DELETE FROM reputation_events WHERE scope='reviewer-outcome:'||OLD.user_id||':'||OLD.author_id||':'||OLD.day;
  DELETE FROM reviewer_outcome_claims WHERE user_id=OLD.user_id AND author_id=OLD.author_id AND day=OLD.day;
  INSERT INTO reviewer_outcome_claims(user_id,author_id,day,note_id)
    SELECT user_id,author_id,day,note_id FROM reviewer_outcome_candidates
    WHERE user_id=OLD.user_id AND author_id=OLD.author_id AND day=OLD.day
      AND EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id) AND EXISTS(SELECT 1 FROM users WHERE id=OLD.author_id)
    ORDER BY rated_at,note_id LIMIT 1;
  INSERT INTO reputation_events(scope,event_key,user_id,dimension,amount,successes,day,cap,metadata)
    SELECT 'reviewer-outcome:'||c.user_id||':'||c.author_id||':'||c.day,'outcome',c.user_id,'reviewer',c.amount,c.successes,c.day,c.cap,json_set(c.metadata,'$.authorId',c.author_id,'$.noteId',c.note_id,'$.sourceScope','note:'||c.note_id)
    FROM reviewer_outcome_candidates c JOIN reviewer_outcome_claims w ON w.user_id=c.user_id AND w.author_id=c.author_id AND w.day=c.day AND w.note_id=c.note_id
    WHERE c.user_id=OLD.user_id AND c.author_id=OLD.author_id AND c.day=OLD.day;
END;
CREATE TRIGGER IF NOT EXISTS reviewer_outcome_candidate_update AFTER UPDATE ON reviewer_outcome_candidates BEGIN
  DELETE FROM reputation_events WHERE scope IN ('reviewer-outcome:'||OLD.user_id||':'||OLD.author_id||':'||OLD.day,'reviewer-outcome:'||NEW.user_id||':'||NEW.author_id||':'||NEW.day);
  DELETE FROM reviewer_outcome_claims WHERE (user_id=OLD.user_id AND author_id=OLD.author_id AND day=OLD.day) OR (user_id=NEW.user_id AND author_id=NEW.author_id AND day=NEW.day);
  INSERT INTO reviewer_outcome_claims(user_id,author_id,day,note_id)
    SELECT user_id,author_id,day,note_id FROM (
      SELECT *,ROW_NUMBER() OVER(PARTITION BY user_id,author_id,day ORDER BY rated_at,note_id) AS position
      FROM reviewer_outcome_candidates
      WHERE (user_id=OLD.user_id AND author_id=OLD.author_id AND day=OLD.day) OR (user_id=NEW.user_id AND author_id=NEW.author_id AND day=NEW.day)
    ) WHERE position=1;
  INSERT INTO reputation_events(scope,event_key,user_id,dimension,amount,successes,day,cap,metadata)
    SELECT 'reviewer-outcome:'||c.user_id||':'||c.author_id||':'||c.day,'outcome',c.user_id,'reviewer',c.amount,c.successes,c.day,c.cap,json_set(c.metadata,'$.authorId',c.author_id,'$.noteId',c.note_id,'$.sourceScope','note:'||c.note_id)
    FROM reviewer_outcome_candidates c JOIN reviewer_outcome_claims w ON w.user_id=c.user_id AND w.author_id=c.author_id AND w.day=c.day AND w.note_id=c.note_id
    WHERE (c.user_id=OLD.user_id AND c.author_id=OLD.author_id AND c.day=OLD.day) OR (c.user_id=NEW.user_id AND c.author_id=NEW.author_id AND c.day=NEW.day);
END;
