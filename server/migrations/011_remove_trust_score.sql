-- TrustScore廃止: users テーブルからスコア列を撤去する。
ALTER TABLE users DROP COLUMN IF EXISTS trust;
