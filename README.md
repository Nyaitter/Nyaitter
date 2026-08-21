# Nyaitter

Nyaitter は、NyaX をベースにした Scratcher 向けのオープンソース SNS です。ブラウザ用のシングルページアプリケーションと、認証・API・WebSocket を提供する Node.js サーバーで構成されています。

| 区分 | 配置 | 内容 |
|---|---|---|
| NyaitterClient | `page/` | バニラ JavaScript による画面、PWA、サービスワーカー |
| NyaitterServer | `server/` | Express API、認証、リアルタイム配信、DB・ストレージアダプター |
| D1 Proxy Worker | `workers/d1-proxy/` | Cloudflare D1 を利用する場合の認証済みプロキシ |

## 主な機能

投稿、返信、引用、リポスト、いいね、スター、検索、フォロー、通知、グループ DM、Web Push、マルチプロバイダー認証（Scratch、メールアドレス、パスキー）を提供します。投稿の公開範囲、検索除外、双方向のブロック関係はサーバー側の共通可視性ルールで判定されます。

> ブロック関係にある利用者同士では、相互の投稿・投稿通知・DMメッセージを表示しません。DMへの新規招待やメンバー追加も拒否されます。

## クイックスタート

Node.js 18 以上を用意し、リポジトリのルートで実行します。

```bash
npm install
npm start
```

ブラウザで <http://localhost:3000/> を開きます。稼働確認には <http://localhost:3000/server/health> を利用できます。

開発時の既定値は `InMemoryAdapter` と `LocalStorageAdapter` です。**メモリ上のデータはサーバー再起動時に失われます。** 実運用の手順は `server/README.md` と `server/help/` を参照してください。

## ライセンス

NyaitterClient と NyaitterServer は **MIT ライセンス**です。著作権表示を保持する限り、利用・改変・再配布できます。詳細は同梱の `LICENSE` を確認してください。

## ドキュメント

- サーバーの起動、API、認証、リアルタイム配信: [`server/README.md`](./server/README.md)
- 認証プロバイダー設定（Scratch、メール、パスキー）: [`server/help/auth-providers.md`](./server/help/auth-providers.md)
- DB・ストレージアダプター: [`server/adapters/README.md`](./server/adapters/README.md)
- PostgreSQL、D1、R2、ローカルストレージ、本番運用: [`server/help/README.md`](./server/help/README.md)
- DBスキーマ・データ移行: [`server/migrations/README.md`](./server/migrations/README.md)
- Cloudflare D1 Proxy Worker: [`workers/d1-proxy/README.md`](./workers/d1-proxy/README.md)
