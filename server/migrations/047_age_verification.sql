-- 年齢確認システム（AutoMod V2）の保存先。
-- posts.age_rating は投稿の対象年齢（0=全年齢または未評価、12/15/18）。
-- users の年齢列は推定年齢と、その集約に使う内部情報（経路・サンプル数。利用者には表示しない）。
-- post_age_estimates は投稿ごとの投稿者年齢帯の推定を内部用に保持する。
ALTER TABLE posts ADD COLUMN IF NOT EXISTS age_rating SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS age_estimate INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS age_source TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS age_estimated_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS age_samples INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS post_age_estimates (
  post_id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  band TEXT NOT NULL CHECK (band IN ('under13', '13-15', '16-17', '18-24', '25-34', '35over')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS post_age_estimates_user_idx ON post_age_estimates (user_id, created_at DESC);
