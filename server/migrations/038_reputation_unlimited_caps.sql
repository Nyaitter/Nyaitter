ALTER TABLE reputation_daily ADD COLUMN IF NOT EXISTS uncapped_positive REAL NOT NULL DEFAULT 0;
ALTER TABLE reputation_daily ADD COLUMN IF NOT EXISTS uncapped_successes INTEGER NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION reputation_event_delta() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE r RECORD; sign INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; sign := -1; ELSE r := NEW; sign := 1; END IF;
  IF NOT EXISTS(SELECT 1 FROM users WHERE id=r.user_id) THEN RETURN NULL; END IF;
  INSERT INTO reputation_daily(user_id,dimension,day,positive,negative,successes,cap,uncapped_positive,uncapped_successes)
  VALUES(r.user_id,r.dimension,r.day,sign*GREATEST(r.amount,0),sign*LEAST(r.amount,0),sign*r.successes,r.cap,
    CASE WHEN r.cap=-1 THEN sign*GREATEST(r.amount,0) ELSE 0 END,CASE WHEN r.cap=-1 THEN sign*r.successes ELSE 0 END)
  ON CONFLICT(user_id,dimension,day) DO UPDATE SET
    positive=reputation_daily.positive+EXCLUDED.positive,negative=reputation_daily.negative+EXCLUDED.negative,
    successes=reputation_daily.successes+EXCLUDED.successes,
    uncapped_positive=reputation_daily.uncapped_positive+EXCLUDED.uncapped_positive,
    uncapped_successes=reputation_daily.uncapped_successes+EXCLUDED.uncapped_successes,
    cap=CASE WHEN reputation_daily.cap=-1 AND EXCLUDED.cap>=0 THEN EXCLUDED.cap ELSE reputation_daily.cap END;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION reputation_daily_delta() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE old_score REAL := 0; old_successes INTEGER := 0;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.user_id<>OLD.user_id THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' THEN
    old_score := (CASE WHEN OLD.cap=-1 THEN OLD.positive ELSE LEAST(OLD.positive-OLD.uncapped_positive,OLD.cap)+OLD.uncapped_positive END)+OLD.negative;
    old_successes := CASE WHEN OLD.cap=-1 THEN OLD.successes ELSE LEAST(OLD.successes-OLD.uncapped_successes,FLOOR(OLD.cap)::int)+OLD.uncapped_successes END;
  END IF;
  INSERT INTO reputation_profiles(user_id,dimension,score,successes)
  VALUES(NEW.user_id,NEW.dimension,
    (CASE WHEN NEW.cap=-1 THEN NEW.positive ELSE LEAST(NEW.positive-NEW.uncapped_positive,NEW.cap)+NEW.uncapped_positive END)+NEW.negative-old_score,
    (CASE WHEN NEW.cap=-1 THEN NEW.successes ELSE LEAST(NEW.successes-NEW.uncapped_successes,FLOOR(NEW.cap)::int)+NEW.uncapped_successes END)-old_successes)
  ON CONFLICT(user_id,dimension) DO UPDATE SET score=reputation_profiles.score+EXCLUDED.score,successes=reputation_profiles.successes+EXCLUDED.successes;
  RETURN NULL;
END $$;
