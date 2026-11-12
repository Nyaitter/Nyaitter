ALTER TABLE reputation_daily ADD COLUMN uncapped_positive REAL NOT NULL DEFAULT 0;
ALTER TABLE reputation_daily ADD COLUMN uncapped_successes INTEGER NOT NULL DEFAULT 0;

DROP TRIGGER IF EXISTS reputation_event_insert;
DROP TRIGGER IF EXISTS reputation_event_delete;
DROP TRIGGER IF EXISTS reputation_daily_insert;
DROP TRIGGER IF EXISTS reputation_daily_update;

CREATE TRIGGER reputation_event_insert AFTER INSERT ON reputation_events BEGIN
  INSERT INTO reputation_daily(user_id,dimension,day,positive,negative,successes,cap,uncapped_positive,uncapped_successes)
  VALUES(NEW.user_id,NEW.dimension,NEW.day,MAX(NEW.amount,0),MIN(NEW.amount,0),NEW.successes,NEW.cap,
    CASE WHEN NEW.cap=-1 THEN MAX(NEW.amount,0) ELSE 0 END,CASE WHEN NEW.cap=-1 THEN NEW.successes ELSE 0 END)
  ON CONFLICT(user_id,dimension,day) DO UPDATE SET positive=positive+excluded.positive,
    negative=negative+excluded.negative,successes=successes+excluded.successes,
    uncapped_positive=uncapped_positive+excluded.uncapped_positive,uncapped_successes=uncapped_successes+excluded.uncapped_successes,
    cap=CASE WHEN cap=-1 AND excluded.cap>=0 THEN excluded.cap ELSE cap END;
END;
CREATE TRIGGER reputation_event_delete AFTER DELETE ON reputation_events BEGIN
  UPDATE reputation_daily SET positive=positive-MAX(OLD.amount,0),negative=negative-MIN(OLD.amount,0),successes=successes-OLD.successes,
    uncapped_positive=uncapped_positive-CASE WHEN OLD.cap=-1 THEN MAX(OLD.amount,0) ELSE 0 END,
    uncapped_successes=uncapped_successes-CASE WHEN OLD.cap=-1 THEN OLD.successes ELSE 0 END
  WHERE user_id=OLD.user_id AND dimension=OLD.dimension AND day=OLD.day;
END;
CREATE TRIGGER reputation_daily_insert AFTER INSERT ON reputation_daily BEGIN
  INSERT INTO reputation_profiles(user_id,dimension,score,successes)
  VALUES(NEW.user_id,NEW.dimension,
    (CASE WHEN NEW.cap=-1 THEN NEW.positive ELSE MIN(NEW.positive-NEW.uncapped_positive,NEW.cap)+NEW.uncapped_positive END)+NEW.negative,
    CASE WHEN NEW.cap=-1 THEN NEW.successes ELSE MIN(NEW.successes-NEW.uncapped_successes,CAST(NEW.cap AS INTEGER))+NEW.uncapped_successes END)
  ON CONFLICT(user_id,dimension) DO UPDATE SET score=score+excluded.score,successes=successes+excluded.successes;
END;
CREATE TRIGGER reputation_daily_update AFTER UPDATE ON reputation_daily BEGIN
  UPDATE reputation_profiles SET score=score+
    (CASE WHEN NEW.cap=-1 THEN NEW.positive ELSE MIN(NEW.positive-NEW.uncapped_positive,NEW.cap)+NEW.uncapped_positive END)+NEW.negative-
    (CASE WHEN OLD.cap=-1 THEN OLD.positive ELSE MIN(OLD.positive-OLD.uncapped_positive,OLD.cap)+OLD.uncapped_positive END)-OLD.negative,
    successes=successes+
    (CASE WHEN NEW.cap=-1 THEN NEW.successes ELSE MIN(NEW.successes-NEW.uncapped_successes,CAST(NEW.cap AS INTEGER))+NEW.uncapped_successes END)-
    (CASE WHEN OLD.cap=-1 THEN OLD.successes ELSE MIN(OLD.successes-OLD.uncapped_successes,CAST(OLD.cap AS INTEGER))+OLD.uncapped_successes END)
  WHERE user_id=NEW.user_id AND dimension=NEW.dimension;
END;
