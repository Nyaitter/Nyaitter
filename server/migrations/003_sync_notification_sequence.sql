-- 明示IDを含むデータ移行後も、notifications.id の採番が既存行と衝突しないよう同期する。
WITH table_state AS (
  SELECT COALESCE(MAX(id), 0)::bigint AS max_id FROM notifications
), sequence_state AS (
  SELECT last_value::bigint AS last_value FROM nyaitter_notifications_id_seq
)
SELECT setval(
  'nyaitter_notifications_id_seq',
  GREATEST(table_state.max_id, sequence_state.last_value),
  true
)
FROM table_state CROSS JOIN sequence_state;
