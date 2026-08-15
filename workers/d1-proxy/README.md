# Nyaitter 用 Cloudflare D1 プロキシ Worker

この Worker は Nyaitter の Node.js サーバーに代わって D1 へ接続する認証済みプロキシです。Node.js 側の `D1Adapter` が Worker を呼び出し、ブラウザは Worker やD1へ直接アクセスしません。

```text
Nyaitter Node.js サーバー -- Bearer AUTH_TOKEN --> D1 Proxy Worker --> D1
```

## ディレクトリ構成

```text
workers/d1-proxy/
├── package.json
├── wrangler.toml
├── migrations/
│   ├── 0001_initial_schema.sql
│   └── 0002_add_push_subscription_session_token.sql
├── src/
│   └── index.js
└── README.md
```

`wrangler.toml` の既定Worker名・D1名は `nyaitter-d1-proxy`・`nyaitter-d1` です。別の環境名を使う場合は、設定とマイグレーションスクリプトの対象DB名を一致させてください。

## デプロイ手順

### 1. D1データベースを作成する

```bash
cd workers/d1-proxy
npx wrangler d1 create nyaitter-d1
```

出力された `database_id` を `wrangler.toml` の `[[d1_databases]]` に設定します。開発、ステージング、本番では別のD1データベースを使うことを推奨します。

### 2. 依存関係と認証シークレットを設定する

```bash
npm install
npx wrangler secret put AUTH_TOKEN
```

`AUTH_TOKEN` は十分に長いランダム値にしてください。未設定のWorkerはすべてのリクエストを拒否します。値を `wrangler.toml`、コード、Git、ブラウザ、ログに書き込まないでください。

### 3. マイグレーションとデプロイを実行する

```bash
npm run migrate:local
npm run migrate:remote
npm run deploy
```

これらのスクリプトは既定で `nyaitter-d1` を対象にします。`wrangler.toml` の `database_name` を変更した場合は、`package.json` の `migrate:local` と `migrate:remote` の対象名も変更してから実行してください。

本番マイグレーション前には、ステージング検証、バックアップ・エクスポート、未適用ファイルの確認、ロールバック手順の確認を行ってください。

## Node.js サーバー側の設定

Node.js サーバーの `server/.env` またはデプロイ先のシークレットへ設定します。

```env
DB_ADAPTER=d1
D1_WORKER_URL=https://nyaitter-d1-proxy.<your-subdomain>.workers.dev
D1_WORKER_TOKEN=<AUTH_TOKENと同じ値>
```

必要に応じて、`D1_REQUEST_TIMEOUT_MS`、`D1_RETRY_ATTEMPTS`、`D1_RETRY_BASE_DELAY_MS`、`D1_READ_CACHE_SECONDS`、`D1_BATCH_MAX_ITEMS` を設定できます。詳細は [`../../server/.env.example`](../../server/.env.example) を確認してください。

## 対応範囲

Workerはアプリケーションで必要な固定操作を提供します。主な対象は次のとおりです。

| 領域 | 対象 |
|---|---|
| ユーザー・認証 | ユーザー、プロフィール、セッション、信頼IP、ログイン承認、Botトークン |
| 投稿 | 作成、タイムライン、ページング、検索、返信、集計、いいね、スター、ピン、リポスト |
| コミュニケーション | グループDM、DM公開鍵、通知、Web Push購読 |
| 運用 | ランキング、監査ログ |

Workerは永続化を担います。非公開投稿、検索除外、ブロック関係、通知・DMの表示可否はNode.js側の共通サービスで判定されるため、Worker固有の実装で閲覧ルールを複製しないでください。

## セキュリティと確認

- 認証ヘッダーがない、または誤ったトークンのリクエストが拒否されることを確認します。
- Workerに自由なSQL実行機能を追加しません。操作ごとに固定SQLとパラメータバインドを使います。
- Node.jsサーバー経由で、ログイン、投稿、検索、通知、DM、Push購読をステージング確認します。
- D1の一時障害、タイムアウト、再試行、キャッシュの挙動を監視します。
- WorkerのデプロイとNode.jsのデプロイは互換性を保ち、段階的に実施します。

## 関連ドキュメント

- [D1 と Worker のセットアップ](../../server/help/database-d1-worker.md)
- [アダプターの設計と切り替え](../../server/help/adapters-overview.md)
- [本番デプロイのチェックリスト](../../server/help/production-checklist.md)
