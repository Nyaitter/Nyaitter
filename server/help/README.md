# セットアップ・運用ガイド

このフォルダには、Nyaitter サーバーの保存先、Cloudflare 連携、本番運用を構成するための手順をまとめています。最初に [`../README.md`](../README.md) でサーバーの起動・API・環境変数の全体像を確認してください。

## 保存先とアダプター

| ガイド | 内容 | 主な対象 |
|---|---|---|
| [アダプターの設計と切り替え](./adapters-overview.md) | DB・ストレージアダプターの責務と選び方 | すべての構成 |
| [PostgreSQL のセットアップ](./database-postgres.md) | PostgreSQL の作成、マイグレーション、接続設定 | Node.js + PostgreSQL |
| [Cloudflare D1 と Worker](./database-d1-worker.md) | D1 Proxy Worker、トークン、D1 マイグレーション | Node.js + D1 |
| [ローカルストレージ](./storage-local.md) | 開発用ローカルファイル保存 | ローカル開発 |
| [Cloudflare R2](./storage-r2.md) | R2 の認証、公開配信、署名URL | 実運用のファイル保存 |
| [ハイブリッド構成](./cloudflare-hybrid.md) | PostgreSQL・R2・D1 の組み合わせ方 | 段階的な Cloudflare 導入 |

D1 Proxy Worker 自体のデプロイ手順は [`../../workers/d1-proxy/README.md`](../../workers/d1-proxy/README.md) も参照してください。

## 運用

- [本番デプロイのチェックリスト](./production-checklist.md) には、認証バイパス、リバースプロキシ、ヘルスチェック、キャッシュ、WebSocket、バックアップの確認項目があります。
- PostgreSQL のスキーマ更新は [`../migrations/README.md`](../migrations/README.md) に従い、既存環境では番号順に適用します。

> `server/.env`、DB 接続文字列、R2/D1 の認証情報、VAPID 秘密鍵は Git に登録しないでください。`server/.env.example` は値を含まない設定一覧です。
