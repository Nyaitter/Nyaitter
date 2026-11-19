-- ワンクッションの理由。ポストにワンクッションが付いている間だけ表示する（048 の D1 版）。
ALTER TABLE posts ADD COLUMN mask_reason TEXT;
