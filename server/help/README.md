# セットアップ・運用ガイド

まずは[Server README](../README.md)で起動と共通設定を確認してください。ここでは保存先ごとの設定を説明します。

| やりたいこと | 文書 |
|---|---|
| DB・保存先を選ぶ | [保存先の選び方](./adapters-overview.md) |
| DBデータを移す | [Server README](../README.md#dbデータの移行) |
| PostgreSQLを使う | [PostgreSQL](./database-postgres.md) |
| Cloudflare D1を使う | [D1とWorker](./database-d1-worker.md) |
| ローカルへ保存する | [ローカルストレージ](./storage-local.md) |
| R2へ保存する | [Cloudflare R2](./storage-r2.md) |
| Cloudflareを併用する | [Cloudflare構成](./cloudflare-hybrid.md) |
| 認証方法を設定する | [認証プロバイダー設定](./auth-providers.md) |
| 公開前に確認する | [本番チェックリスト](./production-checklist.md) |

公開運用では永続DB（`postgres`または`d1`）を使います。秘密情報は`server/.env`またはデプロイ先のシークレット管理に置き、Gitへ追加しません。
