# DBスキーマ

`npm run migrate`は、選択中のDBへ**完全な初期スキーマ**を一度に作成します。PostgreSQL、CockroachDB Cloud、Cloudflare D1はいずれも新規の空DBで実行してください。

## 実行

`server/.env`またはデプロイ先のシークレットへDB接続設定を入れ、リポジトリのルートで実行します。

```bash
npm run migrate
```

| DB | 必要な主な設定 |
|---|---|
| PostgreSQL | `DB_ADAPTER=postgres`、`DATABASE_URL` |
| CockroachDB Cloud | `DB_ADAPTER=cockroach`、`COCKROACH_DATABASE_URL` |
| Cloudflare D1 | `DB_ADAPTER=d1`、`D1_WORKER_URL`、`D1_WORKER_TOKEN` |

ローカルD1へ適用する場合は、次を実行します。

```bash
DB_ADAPTER=d1 D1_MIGRATION_TARGET=local npm run migrate
```

## DBデータの移行

既存データを別のDBへ移す場合は、移行先にこの初期スキーマを適用してから`npm run migrate:data`を実行します。接続設定と実行例は[Server README](../README.md#dbデータの移行)を参照してください。

接続文字列やD1トークンはGitへ追加しません。
