# Cloudflare D1 と Worker のセットアップ

Nyaitter の Node.js サーバーから Cloudflare D1 を使う場合は、認証済みの D1 Proxy Worker を経由します。ブラウザが D1 やプロキシWorkerへ直接接続する構成ではありません。

```text
ブラウザ → Nyaitter Node.js サーバー → D1 Proxy Worker → Cloudflare D1
```

Node.js サーバーには Worker 認証用トークンを置き、Worker はアプリケーションに必要な固定操作だけを受け付けます。自由なSQLを受け取るAPIを公開してはいけません。

## 事前に決めること

- D1 をこの環境の主データベースとして使うか、PostgreSQLと役割を分けるか
- D1の正本となるデータと、スキーマ変更の適用手順
- WorkerのURL、`AUTH_TOKEN`、Node側の `D1_WORKER_TOKEN` の管理方法
- 障害時のバックアップ・ロールバック方法

## 1. D1 データベースを作成する

Workerディレクトリで、用途ごとにD1データベースを作成します。

```bash
cd workers/d1-proxy
npx wrangler d1 create nyaitter-d1
```

出力された `database_id` を `workers/d1-proxy/wrangler.toml` の `[[d1_databases]]` に設定します。既定の `database_name` は `nyaitter-d1` です。

開発・ステージング・本番で別名のDBを使う場合、`wrangler.toml` の `database_name` と、次節のマイグレーションコマンドの対象名を同じ値に更新してください。

## 2. Worker の認証シークレットを設定する

`AUTH_TOKEN` は Worker が必須とする共有シークレットです。未設定の場合、Worker はすべてのリクエストを拒否します。

```bash
cd workers/d1-proxy
npx wrangler secret put AUTH_TOKEN
```

十分に長いランダム値を入力し、Node.js サーバー側の `D1_WORKER_TOKEN` に同じ値を設定します。トークンを Git、`wrangler.toml`、フロントエンド、ログに含めないでください。

## 3. マイグレーションを適用する

Workerの `package.json` は既定で `nyaitter-d1` に対してマイグレーションを実行します。

```bash
cd workers/d1-proxy
npm install
npm run migrate:local   # WranglerのローカルD1
npm run migrate:remote  # wrangler.tomlで設定したリモートD1
npm run deploy
```

D1のスキーマは `workers/d1-proxy/migrations/` で管理します。現在は初期スキーマとPush購読トークン用の追加マイグレーションが含まれます。既存環境へ適用する前に、バックアップとステージング検証を行ってください。

## 4. Node.js サーバーを設定する

`server/.env` またはデプロイ先のシークレット管理に設定します。

```env
DB_ADAPTER=d1
D1_WORKER_URL=https://nyaitter-d1-proxy.<あなたのサブドメイン>.workers.dev
D1_WORKER_TOKEN=<AUTH_TOKENと同じ値>

# 任意: タイムアウト、読み取り再試行、短時間キャッシュ
D1_REQUEST_TIMEOUT_MS=10000
D1_RETRY_ATTEMPTS=1
D1_RETRY_BASE_DELAY_MS=120
D1_READ_CACHE_SECONDS=0
D1_BATCH_MAX_ITEMS=100
```

`D1_READ_CACHE_SECONDS` は 0 で無効です。読み取りキャッシュを使う場合も、投稿・通知・DMなど閲覧者ごとに可視性が変わるAPIでは、キャッシュキーと無効化を慎重に設計してください。

## D1スキーマの注意

PostgreSQLの型・機能はD1（SQLite系）へそのまま移植できません。

| PostgreSQL | D1 での一般的な代替 |
|---|---|
| `JSONB` | JSON文字列を保存する `TEXT` |
| `TIMESTAMPTZ` | ISO 8601 文字列または整数時刻 |
| `SERIAL` | `INTEGER PRIMARY KEY` |
| 配列型 | JSON文字列または中間テーブル |
| PostgreSQL拡張 | SQLite・アプリケーション側の実装 |

DBアダプターの返却値は PostgreSQL・InMemory の契約と揃える必要があります。特に投稿ページング、通知、DMメンバー、未読数、日時形式を確認してください。

## デプロイ後の確認

1. Workerへ認証なしのリクエストが拒否されることを確認します。
2. Node.js サーバーを `DB_ADAPTER=d1` で起動し、`/server/health` と `/server/ready` を確認します。
3. ログイン、投稿、検索、フォロー、通知、DM、Push購読をステージングで確認します。
4. ブロック・検索除外・非公開投稿が保存先にかかわらず同じ可視性になることを確認します。

## 関連ドキュメント

- [D1 Proxy Worker README](../../workers/d1-proxy/README.md)
- [PostgreSQL のセットアップ](./database-postgres.md)
- [Cloudflare と組み合わせる構成](./cloudflare-hybrid.md)
- [本番デプロイのチェックリスト](./production-checklist.md)
