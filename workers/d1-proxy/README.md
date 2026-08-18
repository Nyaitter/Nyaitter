# Nyaitter D1 Proxy Worker

Nyaitter ServerからCloudflare D1へ接続するためのWorkerです。ブラウザはWorkerやD1へ直接接続しません。

```text
Nyaitter Server → D1 Proxy Worker → D1
```

## 作成

```bash
cd workers/d1-proxy
npm install
npx wrangler d1 create nyaitter-d1
```

作成時に表示された`database_id`を`wrangler.toml`の`[[d1_databases]]`へ設定します。

## 認証

```bash
npx wrangler secret put AUTH_TOKEN
```

`AUTH_TOKEN`は十分に長いランダム値にします。Server側の`D1_WORKER_TOKEN`へ同じ値を設定し、Git、`wrangler.toml`、Clientへは含めません。

## 移行とデプロイ

リポジトリのルートでD1移行を実行します。

```bash
DB_ADAPTER=d1 npm run migrate
```

ローカルD1では次を実行します。

```bash
DB_ADAPTER=d1 D1_MIGRATION_TARGET=local npm run migrate
```

他のDBとのデータ移行は、空のD1へ初期スキーマを作成した後にServer側で`npm run migrate:data`を実行します。詳細は[Server設定](../../server/README.md#dbデータの移行)を参照してください。

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

関連: [D1とWorker](../../server/help/database-d1-worker.md) / [Server設定](../../server/README.md)
