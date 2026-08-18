# DBスキーマ移行

`npm run migrate`は、選択中のDBアダプターに必要なスキーマ変更を適用します。新規DBと既存DBのどちらでも、Serverを起動する前に実行します。

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

`npm run migrate`はスキーマだけを変更します。既存データを別のDBへ移す場合は、移行先のスキーマを最新化してから`npm run migrate:data`を実行します。接続設定と実行例は[Server README](../README.md#dbデータの移行)を参照してください。

## 公開前の確認

公開DBへ適用する前に、復元できるバックアップを用意し、同じ設定の検証環境で実行結果を確認してください。接続文字列やD1トークンはGitへ追加しません。

D1のスキーマはWorker側で管理します。詳細は[Cloudflare D1とWorker](../help/database-d1-worker.md)を参照してください。
