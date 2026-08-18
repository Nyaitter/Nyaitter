-- 外部データ移行や明示ID投入後に、postsの採番シーケンスを既存IDより遅れない位置へ同期する。
-- 投稿がない新規DBでは is_called を維持し、初回採番のID 1 を消費しない。
WITH table_state AS (
    SELECT MAX(id)::bigint AS max_id FROM posts
), sequence_state AS (
    SELECT last_value::bigint AS last_value, is_called
    FROM nyaitter_posts_id_seq
)
SELECT setval(
    'nyaitter_posts_id_seq',
    CASE
        WHEN table_state.max_id IS NULL THEN sequence_state.last_value
        ELSE GREATEST(table_state.max_id, sequence_state.last_value)
    END,
    CASE
        WHEN table_state.max_id IS NULL THEN sequence_state.is_called
        ELSE true
    END
)
FROM table_state CROSS JOIN sequence_state;
