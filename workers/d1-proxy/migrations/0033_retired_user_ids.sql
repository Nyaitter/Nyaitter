-- 削除されたアカウントの NyaitterID を再利用しないための退役 ID 記録（046 の D1 版）。
-- アカウント削除時に ID を記録し、新規採番ではこの ID を候補から除外する。
CREATE TABLE IF NOT EXISTS retired_user_ids (
  id INTEGER PRIMARY KEY,
  retired_at TEXT
);
