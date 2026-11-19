-- ワンクッションの理由。ポストにワンクッションが付いている間だけ表示する。
ALTER TABLE posts ADD COLUMN IF NOT EXISTS mask_reason TEXT;
