-- ブロックリストを全PostgreSQL環境で共通のJSONB配列として保持する。
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS block JSONB NOT NULL DEFAULT '[]'::jsonb;

-- 既存・手動投入データを、非負整数・重複なし・自分自身なし・昇順の配列へ正規化する。
-- 数値文字列は10桁以内に限定してbigint変換を安全に行う。
UPDATE users AS owner
SET block = COALESCE(
    (
        SELECT jsonb_agg(normalized.blocked_user_id ORDER BY normalized.blocked_user_id)
        FROM (
            SELECT DISTINCT candidate.blocked_user_id
            FROM (
                SELECT CASE
                    WHEN value ~ '^[0-9]{1,10}$'
                     AND value::bigint <= 2147483647
                    THEN value::bigint::integer
                    ELSE NULL
                END AS blocked_user_id
                FROM jsonb_array_elements_text(
                    CASE
                        WHEN jsonb_typeof(owner.block) = 'array' THEN owner.block
                        ELSE '[]'::jsonb
                    END
                ) AS entry(value)
            ) AS candidate
            WHERE candidate.blocked_user_id IS NOT NULL
              AND candidate.blocked_user_id <> owner.id
        ) AS normalized
    ),
    '[]'::jsonb
);

ALTER TABLE users
    DROP CONSTRAINT IF EXISTS users_block_is_array;
ALTER TABLE users
    ADD CONSTRAINT users_block_is_array
    CHECK (jsonb_typeof(block) = 'array');
