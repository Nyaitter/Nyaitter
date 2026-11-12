-- writer/reviewer ランクの TrustRanks 統合（045 の D1 版）。
-- 既存の writer/reviewer イベントを trust ディメンションへ付け替える。
-- reputation_daily / reputation_profiles はトリガー連鎖が維持するため、DELETE → INSERT で集計も追随する。
CREATE TEMP TABLE rep_unify_events AS
  SELECT scope,event_key,user_id,amount,successes,day,cap,metadata FROM reputation_events WHERE dimension IN ('writer','reviewer');
DELETE FROM reputation_events WHERE dimension IN ('writer','reviewer');
INSERT INTO reputation_events(scope,event_key,user_id,dimension,amount,successes,day,cap,metadata)
  SELECT scope,event_key,user_id,'trust',amount,successes,day,cap,metadata FROM rep_unify_events;
DROP TABLE rep_unify_events;

DROP TRIGGER IF EXISTS reviewer_outcome_candidate_insert;
CREATE TRIGGER reviewer_outcome_candidate_insert AFTER INSERT ON reviewer_outcome_candidates BEGIN
  DELETE FROM reputation_events WHERE scope='reviewer-outcome:'||NEW.user_id||':'||NEW.author_id||':'||NEW.day;
  DELETE FROM reviewer_outcome_claims WHERE user_id=NEW.user_id AND author_id=NEW.author_id AND day=NEW.day;
  INSERT INTO reviewer_outcome_claims(user_id,author_id,day,note_id)
    SELECT user_id,author_id,day,note_id FROM reviewer_outcome_candidates
    WHERE user_id=NEW.user_id AND author_id=NEW.author_id AND day=NEW.day ORDER BY rated_at,note_id LIMIT 1;
  INSERT INTO reputation_events(scope,event_key,user_id,dimension,amount,successes,day,cap,metadata)
    SELECT 'reviewer-outcome:'||c.user_id||':'||c.author_id||':'||c.day,'outcome',c.user_id,'trust',c.amount,c.successes,c.day,c.cap,json_set(c.metadata,'$.authorId',c.author_id,'$.noteId',c.note_id,'$.sourceScope','note:'||c.note_id)
    FROM reviewer_outcome_candidates c JOIN reviewer_outcome_claims w ON w.user_id=c.user_id AND w.author_id=c.author_id AND w.day=c.day AND w.note_id=c.note_id
    WHERE c.user_id=NEW.user_id AND c.author_id=NEW.author_id AND c.day=NEW.day;
END;
DROP TRIGGER IF EXISTS reviewer_outcome_candidate_delete;
CREATE TRIGGER reviewer_outcome_candidate_delete AFTER DELETE ON reviewer_outcome_candidates BEGIN
  DELETE FROM reputation_events WHERE scope='reviewer-outcome:'||OLD.user_id||':'||OLD.author_id||':'||OLD.day;
  DELETE FROM reviewer_outcome_claims WHERE user_id=OLD.user_id AND author_id=OLD.author_id AND day=OLD.day;
  INSERT INTO reviewer_outcome_claims(user_id,author_id,day,note_id)
    SELECT user_id,author_id,day,note_id FROM reviewer_outcome_candidates
    WHERE user_id=OLD.user_id AND author_id=OLD.author_id AND day=OLD.day
      AND EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id) AND EXISTS(SELECT 1 FROM users WHERE id=OLD.author_id)
    ORDER BY rated_at,note_id LIMIT 1;
  INSERT INTO reputation_events(scope,event_key,user_id,dimension,amount,successes,day,cap,metadata)
    SELECT 'reviewer-outcome:'||c.user_id||':'||c.author_id||':'||c.day,'outcome',c.user_id,'trust',c.amount,c.successes,c.day,c.cap,json_set(c.metadata,'$.authorId',c.author_id,'$.noteId',c.note_id,'$.sourceScope','note:'||c.note_id)
    FROM reviewer_outcome_candidates c JOIN reviewer_outcome_claims w ON w.user_id=c.user_id AND w.author_id=c.author_id AND w.day=c.day AND w.note_id=c.note_id
    WHERE c.user_id=OLD.user_id AND c.author_id=OLD.author_id AND c.day=OLD.day;
END;
DROP TRIGGER IF EXISTS reviewer_outcome_candidate_update;
CREATE TRIGGER reviewer_outcome_candidate_update AFTER UPDATE ON reviewer_outcome_candidates BEGIN
  DELETE FROM reputation_events WHERE scope IN ('reviewer-outcome:'||OLD.user_id||':'||OLD.author_id||':'||OLD.day,'reviewer-outcome:'||NEW.user_id||':'||NEW.author_id||':'||NEW.day);
  DELETE FROM reviewer_outcome_claims WHERE (user_id=OLD.user_id AND author_id=OLD.author_id AND day=OLD.day) OR (user_id=NEW.user_id AND author_id=NEW.author_id AND day=NEW.day);
  INSERT INTO reviewer_outcome_claims(user_id,author_id,day,note_id)
    SELECT user_id,author_id,day,note_id FROM (
      SELECT *,ROW_NUMBER() OVER(PARTITION BY user_id,author_id,day ORDER BY rated_at,note_id) AS position
      FROM reviewer_outcome_candidates
      WHERE (user_id=OLD.user_id AND author_id=OLD.author_id AND day=OLD.day) OR (user_id=NEW.user_id AND author_id=NEW.author_id AND day=NEW.day)
    ) WHERE position=1;
  INSERT INTO reputation_events(scope,event_key,user_id,dimension,amount,successes,day,cap,metadata)
    SELECT 'reviewer-outcome:'||c.user_id||':'||c.author_id||':'||c.day,'outcome',c.user_id,'trust',c.amount,c.successes,c.day,c.cap,json_set(c.metadata,'$.authorId',c.author_id,'$.noteId',c.note_id,'$.sourceScope','note:'||c.note_id)
    FROM reviewer_outcome_candidates c JOIN reviewer_outcome_claims w ON w.user_id=c.user_id AND w.author_id=c.author_id AND w.day=c.day AND w.note_id=c.note_id
    WHERE (c.user_id=OLD.user_id AND c.author_id=OLD.author_id AND c.day=OLD.day) OR (c.user_id=NEW.user_id AND c.author_id=NEW.author_id AND c.day=NEW.day);
END;

-- Phase1 期の互換列（note_rank 等）は実利用がないため削除する。
ALTER TABLE users DROP COLUMN note_rank;
ALTER TABLE users DROP COLUMN note_affirmative_score;
ALTER TABLE users DROP COLUMN note_max_per_day;
ALTER TABLE users DROP COLUMN note_min_public_threshold;
