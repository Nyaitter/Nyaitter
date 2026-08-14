# セットアップ・運用ガイド一覧

このフォルダには、サーバーの各部品のセットアップ手順と運用の注意をまとめています。

コード内のコメントは短くしてあるので、実際の手順はここに書いてあります。

## ドキュメント一覧

### データベース

- [PostgreSQL のセットアップ](./database-postgres.md)  
  純粋な PostgreSQL 構成と、Worker を併用する場合の説明

- [Cloudflare D1 と Worker](./database-d1-worker.md)  
  D1 を使うときの設計、Worker の設定、スキーマ、キャッシュや再試行など

### ストレージ

- [Cloudflare R2](./storage-r2.md)  
  トークン、公開ドメイン、署名付き URL、運用とセキュリティ

- [ローカルストレージ](./storage-local.md)  
  開発での使い方と、本番で使う場合の注意

### Cloudflare 全体

- [ハイブリッド構成の考え方](./cloudflare-hybrid.md)  
  Postgres・R2・D1 をどう組み合わせるか、段階的な進め方

### その他

- [本番デプロイのチェックリスト](./production-checklist.md)
- [アダプターの設計と切り替え方](./adapters-overview.md)

アダプターの概要は [server/adapters/README.md](../adapters/README.md) も参照してください。
