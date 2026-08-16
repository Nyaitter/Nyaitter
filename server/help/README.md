# セットアップ・運用ガイド

このフォルダには、公開運用で必要になるデータベース、ファイル保存、Cloudflare、本番確認の説明があります。まずは [`../README.md`](../README.md) の起動方法と設定一覧を確認してください。

## 目的別の文書

| やりたいこと | 読む文書 |
|---|---|
| DBと保存先を選びたい | [アダプターの概要](./adapters-overview.md) |
| PostgreSQLを使いたい | [PostgreSQL のセットアップ](./database-postgres.md) |
| Cloudflare D1を使いたい | [D1 と Worker](./database-d1-worker.md) |
| ローカルへファイルを保存したい | [ローカルストレージ](./storage-local.md) |
| R2へファイルを保存したい | [Cloudflare R2](./storage-r2.md) |
| Cloudflareを段階的に使いたい | [ハイブリッド構成](./cloudflare-hybrid.md) |
| 公開前後の確認をしたい | [本番デプロイのチェックリスト](./production-checklist.md) |

## まず知っておくこと

- 開発では `memory` と `local` が使えますが、サーバー再起動でメモリDBの内容は消えます。
- 公開運用では、DBにPostgreSQLまたはD1、ファイル保存にR2を使う構成をおすすめします。
- ファイルはユーザー別に保存され、初期設定では1ユーザー当たり1 GBまでです。
- `.env`、DB接続文字列、R2/D1の鍵、VAPID秘密鍵はGitへ追加しないでください。

D1 Proxy Workerの詳しいデプロイ手順は [`../../workers/d1-proxy/README.md`](../../workers/d1-proxy/README.md) にあります。
