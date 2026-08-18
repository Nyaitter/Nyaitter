# Cloudflare構成

Cloudflareを使う場合も、ブラウザはNyaitter Serverへ接続します。D1、R2の資格情報はブラウザへ渡しません。

```text
ブラウザ → Nyaitter Server → D1 Proxy Worker → D1
                         └→ R2
```

| DB | ファイル保存 | 設定例 |
|---|---|---|
| PostgreSQL | R2 | `DB_ADAPTER=postgres`、`STORAGE_ADAPTER=r2` |
| CockroachDB Cloud | R2 | `DB_ADAPTER=cockroach`、`STORAGE_ADAPTER=r2` |
| D1 | R2 | `DB_ADAPTER=d1`、`STORAGE_ADAPTER=r2` |

D1ではWorkerの`AUTH_TOKEN`とServerの`D1_WORKER_TOKEN`を同じ値にします。R2のアクセスキー、D1トークン、DB接続文字列は`server/.env`またはデプロイ先のシークレット管理に置きます。

設定後は移行します。

```bash
npm run migrate
```

関連: [D1とWorker](./database-d1-worker.md) / [R2](./storage-r2.md) / [本番チェックリスト](./production-checklist.md)
