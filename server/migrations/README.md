# データベースのマイグレーション

最初のスキーマは `001_initial_schema.sql` にあります。

## 使い方（いまは手動）

1. PostgreSQL に接続する
2. SQL を実行する

```bash
psql -U ユーザー名 -d nyaitter -f 001_initial_schema.sql
```

自動マイグレーションは将来入れる想定です（例：node-pg-migrate）。

このスキーマには、Nyaitter の識別子（handle、nyaitter_address、外部ログイン）や通知のテーブルも含まれます。

## 追加のスクリプト

- `002_add_user_profile_fields.sql` … プロフィール用カラムやインデックスの追加例
- `003_add_indexes_and_evolution.sql` … 性能用インデックスや安全なカラム追加の例

既存のデータベースを更新するときは、番号順に実行してください。可能な限り、何度実行しても安全な書き方にしてあります。
