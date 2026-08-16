# Cloudflare D1 と Worker

NyaitterでD1を使う場合、Node.jsサーバーは **D1 Proxy Worker** を通してD1へ接続します。ブラウザがD1やWorkerへ直接つながることはありません。

```text
ブラウザ → Nyaitterサーバー → D1 Proxy Worker → D1
```

## 準備するもの

- Cloudflareアカウント
- D1データベース
- D1 Proxy Worker
- WorkerとNode.jsサーバーで共有する長いランダムトークン

## 手順

### 1. D1を作る

```bash
cd workers/d1-proxy
npx wrangler d1 create nyaitter-d1
```

表示された `database_id` を `wrangler.toml` に設定します。

### 2. Workerのトークンを設定する

```bash
npx wrangler secret put AUTH_TOKEN
```

入力した値は、Node.jsサーバー側の `D1_WORKER_TOKEN` と同じにします。トークンをGit、`wrangler.toml`、ブラウザ、ログへ書かないでください。

### 3. マイグレーションとデプロイ

```bash
npm install
npm run migrate:remote
npm run deploy
```

マイグレーションは `workers/d1-proxy/migrations/` にあります。現在は高頻度の投稿、通知、DM読み取りを助ける `0011_optimize_high_volume_reads.sql` まで含まれています。既存DBへ適用する前に、必ずバックアップとステージング確認を行ってください。

### 4. Nyaitterサーバーを設定する

`server/.env` に次を設定します。

```env
DB_ADAPTER=d1
D1_WORKER_URL=https://nyaitter-d1-proxy.example.workers.dev
D1_WORKER_TOKEN=<AUTH_TOKENと同じ値>
```

必要ならタイムアウトや再試行回数も `.env.example` を参考に追加できます。

## 公開前の確認

1. Workerがトークンなしのリクエストを拒否することを確認します。
2. `/server/health` と `/server/ready` が成功することを確認します。
3. 投稿、検索、通知、DM、ファイル保存をステージングで確認します。
4. ブロック、非公開投稿、検索除外が期待どおりに動くことを確認します。

## 注意

D1はSQLite系のDBです。PostgreSQLの型や拡張機能をそのまま使えない場合があります。D1を使う場合も、認可や投稿の表示ルールはNode.jsサーバー側で処理します。

- [D1 Proxy Workerの説明](../../workers/d1-proxy/README.md)
- [本番デプロイのチェックリスト](./production-checklist.md)
