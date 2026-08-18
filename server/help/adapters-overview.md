# 保存先の選び方

NyaitterはDBとファイル保存先を別々に設定できます。APIとClientの使い方は変わりません。

## DB

| `DB_ADAPTER` | 用途 |
|---|---|
| `memory` | 開発用。再起動で消えます。 |
| `postgres` | PostgreSQL。 |
| `cockroach` | CockroachDB Cloud。 |
| `d1` | Cloudflare D1。D1 Proxy Workerが必要です。 |

永続DBを設定または更新した後は、リポジトリのルートで移行します。

```bash
npm run migrate
```

## DBデータの移行

移行先のスキーマを`npm run migrate`で最新化してから、`npm run migrate:data`を実行します。バックアップ、復元、接続設定は[Server README](../README.md#dbデータの移行)を参照してください。

## ファイル保存

| `STORAGE_ADAPTER` | 用途 |
|---|---|
| `local` | 開発または永続ディスクを持つ単一Server。 |
| `r2` | Cloudflare R2。 |

ユーザーごとの保存上限は`STORAGE_USER_QUOTA_MB`で設定します。

関連: [PostgreSQL](./database-postgres.md) / [D1とWorker](./database-d1-worker.md) / [ローカルストレージ](./storage-local.md) / [Cloudflare R2](./storage-r2.md)
