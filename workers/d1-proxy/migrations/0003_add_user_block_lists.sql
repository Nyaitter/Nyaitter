-- ブロックリストをJSON配列文字列として保存する。
-- 既存ユーザーは安全な空配列から開始し、Workerの更新経路で常に正規化される。
ALTER TABLE users ADD COLUMN block TEXT NOT NULL DEFAULT '[]';
