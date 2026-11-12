ALTER TABLE group_dms ADD COLUMN IF NOT EXISTS state_version bigint NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION advance_group_dm_state_version() RETURNS trigger AS $$
BEGIN
  -- state_version 自体を明示的に書き換える更新（移行・復元）では世代を進めない。
  IF NEW.state_version IS DISTINCT FROM OLD.state_version THEN
    RETURN NEW;
  END IF;
  -- 世代が進むのは会話の内容・構成が変わる更新だけ。unread の件数だけの変更
  -- （既読マーク・未読加算）や集約列（message_count / latest_message）の
  -- 再計算では進めない。accepted は unread._accepted に格納されるため、
  -- unread 全体ではなく _accepted の変化だけを見る。
  IF NEW.host_id IS DISTINCT FROM OLD.host_id
     OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.member IS DISTINCT FROM OLD.member
     OR NEW.post IS DISTINCT FROM OLD.post
     OR NEW.time IS DISTINCT FROM OLD.time
     OR (NEW.unread -> '_accepted') IS DISTINCT FROM (OLD.unread -> '_accepted') THEN
    NEW.state_version := OLD.state_version + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS group_dm_state_version ON group_dms;
CREATE TRIGGER group_dm_state_version BEFORE UPDATE ON group_dms
FOR EACH ROW EXECUTE FUNCTION advance_group_dm_state_version();
