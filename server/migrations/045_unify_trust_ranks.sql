-- writer/reviewer ランクの TrustRanks 統合。
-- 既存の writer/reviewer イベントを trust ディメンションへ付け替える。
-- reputation_daily / reputation_profiles は reputation_events のトリガーが維持するため、
-- DELETE → INSERT で付け替えると日次集計とプロフィールも自動で追随する。
CREATE TEMP TABLE rep_unify_events ON COMMIT DROP AS
  SELECT scope,event_key,user_id,amount,successes,day,cap,metadata FROM reputation_events WHERE dimension IN ('writer','reviewer');
DELETE FROM reputation_events WHERE dimension IN ('writer','reviewer');
INSERT INTO reputation_events(scope,event_key,user_id,dimension,amount,successes,day,cap,metadata)
  SELECT scope,event_key,user_id,'trust',amount,successes,day,cap,metadata FROM rep_unify_events;
DROP TABLE rep_unify_events;

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
      VALUES(outcome_scope,'outcome',uid,'trust',winner.amount,winner.successes,outcome_day,winner.cap,
        (winner.metadata::jsonb || jsonb_build_object('authorId',aid,'noteId',winner.note_id,'sourceScope','note:'||winner.note_id::text))::text);
  END IF;
END $$;

-- Phase1 期の互換列（note_rank 等）は実利用がないため削除する。
ALTER TABLE users
  DROP COLUMN IF EXISTS note_rank,
  DROP COLUMN IF EXISTS note_affirmative_score,
  DROP COLUMN IF EXISTS note_max_per_day,
  DROP COLUMN IF EXISTS note_min_public_threshold;
