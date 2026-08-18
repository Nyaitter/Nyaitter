# Cloudflare D1とWorker

D1を使う場合、Nyaitter ServerはD1 Proxy Workerを通して接続します。

```text
ブラウザ → Nyaitter Server → D1 Proxy Worker → D1
```

## 準備

```bash
cd workers/d1-proxy
npm install
npx wrangler d1 create nyaitter-d1
npx wrangler secret put AUTH_TOKEN
```

作成時に表示された`database_id`を`wrangler.toml`へ設定します。`AUTH_TOKEN`はServer側と同じ値にします。

## 移行とデプロイ

リポジトリのルートで移行します。

```bash
DB_ADAPTER=d1 npm run migrate
```

ローカルD1では次を実行します。

```bash
DB_ADAPTER=d1 D1_MIGRATION_TARGET=local npm run migrate
```

他のDBからD1へデータを移す場合は、空のD1へ初期スキーマを作成した後に`npm run migrate:data`を実行します。接続設定と実行例は[Server README](../README.md#dbデータの移行)を参照してください。

Workerをデプロイします。

```bash
cd workers/d1-proxy
npm run deploy
```

## Server設定

```dotenv
DB_ADAPTER=d1
D1_WORKER_URL=https://nyaitter-d1-proxy.example.workers.dev
D1_WORKER_TOKEN=<AUTH_TOKENと同じ値>
```

`D1_WORKER_TOKEN`とWorkerの`AUTH_TOKEN`は秘密情報です。Git、`wrangler.toml`、Clientへ含めません。

関連: [D1 Proxy Worker](../../workers/d1-proxy/README.md) / [本番チェックリスト](./production-checklist.md)
