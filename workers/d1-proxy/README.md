# Nyaitter 用 Cloudflare D1 プロキシ Worker

Nyaitter の Node.js サーバー（`D1Adapter`）と Cloudflare D1 の間を中継する Worker です。

## フォルダ構成

```
workers/d1-proxy/
├── package.json
├── wrangler.toml          # Worker の設定
├── migrations/
│   └── 0001_initial_schema.sql
├── src/
│   └── index.js
└── README.md
```

## デプロイの手順

### 1. D1 データベースを作る

```bash
npx wrangler d1 create nyaitter-d1
```

表示された `database_id` を `wrangler.toml` に書きます。

### 2. マイグレーションを適用する

```bash
# ローカル
npm run migrate:local

# リモート（本番向け）
npm run migrate:remote
```

### 3. 認証用トークンを設定する

Node サーバーと Worker で共有する秘密の文字列です。

```bash
npx wrangler secret put AUTH_TOKEN
```

プロンプトでランダムな文字列を入力します。

### 4. Worker をデプロイする

```bash
npm run deploy
```

## Node 側の設定

デプロイ後、Node サーバーの `.env` に次を書きます。

```env
DB_ADAPTER=d1
D1_WORKER_URL=https://nyaitter-d1-proxy.あなたのサブドメイン.workers.dev
D1_WORKER_TOKEN=<AUTH_TOKENと同じ値>
```

## 対応している主な機能

- ユーザーとプロフィール（登録、検索、一括取得、更新）
- 認証とセッション（作成・確認・無効化、信頼 IP、端末間のログイン承認）
- Bot トークン
- 投稿とタイムライン（作成、ページング、検索、返信、各種数値）
- いいね・スター・ピン・リポスト
- DM とグループ DM
- 通知と Web Push の購読
- ランキングと監査ログ

`AUTH_TOKEN` が設定されていない場合、Worker はすべてのリクエストを拒否します。
