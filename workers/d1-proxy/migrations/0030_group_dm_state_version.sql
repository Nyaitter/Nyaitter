ALTER TABLE group_dms ADD COLUMN state_version INTEGER NOT NULL DEFAULT 0;

DROP TRIGGER IF EXISTS group_dm_state_version;
CREATE TRIGGER group_dm_state_version AFTER UPDATE OF host_id, title, member, post, unread, time ON group_dms
WHEN NEW.state_version = OLD.state_version
  AND (NEW.host_id IS NOT OLD.host_id
       OR NEW.title IS NOT OLD.title
       OR NEW.member IS NOT OLD.member
       OR NEW.post IS NOT OLD.post
       OR NEW.time IS NOT OLD.time
       OR COALESCE(json_extract(NEW.unread, '$._accepted'), '') IS NOT COALESCE(json_extract(OLD.unread, '$._accepted'), ''))
BEGIN
  UPDATE group_dms SET state_version = OLD.state_version + 1 WHERE id = NEW.id;
END;
