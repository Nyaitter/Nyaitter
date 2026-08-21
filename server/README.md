# Nyaitter Server

NyaitterのAPI、認証、投稿、通知、DM、ファイル保存、リアルタイム配信を提供するNode.jsサーバーです。ブラウザはDB、R2、D1へ直接接続しません。

## 起動

リポジトリのルートで実行します。

```bash
npm install
cp server/.env.example server/.env
npm start
```

既定のURLは <http://localhost:3000/> です。既定の`memory` DBは再起動で消えます。

| URL | 用途 |
|---|---|
| `/server/health` | 応答確認 |
| `/server/ready` | DBなどの準備完了確認 |
| `/server/status` | Server・認証・Client向け制限情報 |
| `/server/apidocs` | API仕様 |

## Client

起動時に`page/`があれば静的Clientを配信します。Clientを取得または更新するには、次を実行します。

```bash
npm run sync:client
```

取得先は`NYAITTER_CLIENT_REPOSITORY`または`client.repository`で指定します。起動時に`page/`がなかった場合は、同期後にServerを再起動してください。

## APIとユーザーファイル

APIの基準パスは`NYAITTER_API_ENDPOINT`または`server.apiEndpoint`です。既定値は`/server`です。`/api`の有無はどちらも利用できます。

```text
/server/posts       /server/api/posts
/server/uploads     /server/api/uploads
/server/users       /server/api/users
```

Serverからユーザーファイルを配信する場合は、ClientとServerへ同じ公開パスを設定します。

```js
// page/config.js
userFileEndpoint: '/uploads'
```

```dotenv
NYAITTER_USER_FILES_ENDPOINT=/uploads
```

R2などの公開ドメインを直接使う場合は、Clientの`userFileEndpoint`にそのURLを設定し、`NYAITTER_USER_FILES_ENDPOINT`は設定しません。

## 設定

通常設定は`server/config.json`、秘密情報は`server/.env`またはデプロイ先のシークレット管理に置きます。

| 分類 | 主な設定 |
|---|---|
| 起動 | `PORT`、`NODE_ENV`、`TRUST_PROXY` |
| 認証 | `AUTH_METHOD_SCRATCH_ENABLED`、`AUTH_METHOD_EMAIL_ENABLED`、`AUTH_METHOD_PASSKEY_ENABLED`（詳細は [認証ガイド](./help/auth-providers.md)） |
| API・Client | `NYAITTER_API_ENDPOINT`、`NYAITTER_CLIENT_REPOSITORY` |
| CORS | `NYAITTER_CORS_ALLOWED_ORIGINS`、`NYAITTER_CORS_CREDENTIALS` |
| DB | `DB_ADAPTER`、`DATABASE_URL`、`COCKROACH_DATABASE_URL`、`D1_WORKER_URL`、`D1_WORKER_TOKEN` |
| ファイル | `STORAGE_ADAPTER`、`STORAGE_USER_QUOTA_MB`、`R2_*` |
| Push | `VAPID_SUBJECT`、`VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY` |
| 自動モデレーション | `GEMINI_API_KEY`、`GEMINI_MODEL`、`GEMINI_MOD_PROMPT` |
| Turnstile | `TURNSTILE_SECRET_KEY`（クライアントのサイトキーは `page/config.js` の `turnstileSiteKey`） |

別オリジンのClientでCookieを使う場合は、ClientのオリジンとCookie利用を設定します。

```dotenv
NYAITTER_CORS_ALLOWED_ORIGINS=https://client.example.com
NYAITTER_CORS_CREDENTIALS=true
```

設定を確認するには、次を実行します。

```bash
npm run check:config
```

## DBと移行

DBを変更または更新した後は、リポジトリのルートで移行を実行します。

```bash
npm run migrate
```

| `DB_ADAPTER` | 用途 | 移行 |
|---|---|---|
| `memory` | 開発 | 不要 |
| `postgres` | PostgreSQL | `server/migrations/`を適用 |
| `d1` | Cloudflare D1 | Worker側のD1移行を適用 |

### PostgreSQL

PostgreSQL互換DBも`postgres`を使います。`DATABASE_URL`にはホスト名だけではなく、完全な`postgres://`または`postgresql://`接続文字列を設定します。

```dotenv
DB_ADAPTER=postgres
DATABASE_URL=postgres://user:password@db.example.com:5432/nyaitter?sslmode=require
```


### Cloudflare D1

```dotenv
DB_ADAPTER=d1
D1_WORKER_URL=https://nyaitter-d1-proxy.example.workers.dev
D1_WORKER_TOKEN=<WorkerのAUTH_TOKENと同じ値>
```

既定ではリモートD1へ移行します。ローカルD1では次を実行します。

```bash
D1_MIGRATION_TARGET=local npm run migrate
```

### DBデータの移行

空の移行先DBへ先に`npm run migrate`で初期スキーマを作成します。`npm run migrate:data`は`memory`、`postgres`、`d1`間のデータ移行に使います。

```bash
# バックアップ
npm run migrate:data -- --from d1 --output nyaitter-backup.json

# 復元
npm run migrate:data -- --to postgres --input nyaitter-backup.json --replace
```

`--replace`は移行先のデータを置き換えます。移行元は`NYAITTER_DATA_SOURCE_`、移行先は`NYAITTER_DATA_DESTINATION_`を接頭辞にして接続情報を設定します。

| DB | 接続設定 |
|---|---|
| PostgreSQL | `DATABASE_URL` |
| Cloudflare D1 | `D1_WORKER_URL`、`D1_WORKER_TOKEN` |
| memory | `OPERATOR_SOCKET`（対象Serverの起動が必要） |

D1からPostgreSQLへ直接移す例です。

```bash
NYAITTER_DATA_SOURCE_D1_WORKER_URL=https://d1-proxy.example.workers.dev \
NYAITTER_DATA_SOURCE_D1_WORKER_TOKEN=<D1のWorkerトークン> \
NYAITTER_DATA_DESTINATION_DATABASE_URL='postgresql://user:password@db.example.com:5432/nyaitter?sslmode=require' \
npm run migrate:data -- --from d1 --to postgres --replace --output nyaitter-backup.json
```

## ファイル保存

| `STORAGE_ADAPTER` | 用途 |
|---|---|
| `local` | 開発または永続ディスクを持つ単一Server |
| `r2` | Cloudflare R2 |

画像はEXIFを削除し、必要に応じて縮小・WebP変換します。ユーザーごとの保存上限は`STORAGE_USER_QUOTA_MB`で設定します。

## 主な機能設定

文字数の範囲は`10`、`10..`、`..10`、`10..15`の形式で設定します。時間は`10min`、`15m10s`、`1000ms`の形式で設定します。

```dotenv
NYAITTER_LIMIT_POST_CONTENT_LENGTH=..1000
NYAITTER_LIMIT_PROFILE_BIO_LENGTH=..500
NYAITTER_RATE_LIMIT_POST_WRITE_WINDOW=15m10s
NYAITTER_RATE_LIMIT_POST_WRITE_MAX=30
```

`GET /server/status`はClient向けに文字数、ファイル容量、レート制限を返します。

標準Clientの「プライバシーとセキュリティ」ではNyaitterIDの再割り当てとアカウント削除を行えます。再割り当て後もアカウントデータとセッションは新しいIDへ引き継がれます。削除は2回確認後に実行され、元に戻せません。

投稿中の先頭のHTTPS URLにはカードを表示できます。URLを`<`と`>`で囲むとカードを表示しません。

Push通知を使う場合は、次を設定します。

```dotenv
VAPID_SUBJECT=mailto:admin@example.com
VAPID_PUBLIC_KEY=<public-key>
VAPID_PRIVATE_KEY=<private-key>
```

Gemini自動モデレーションは、次の3項目をすべて設定すると有効です。

```dotenv
GEMINI_API_KEY=<api-key>
GEMINI_MODEL=gemini-2.0-flash
GEMINI_MOD_PROMPT=投稿をコミュニティルールに基づいて判定してください。
```

`GEMINI_MOD_MAX_IMAGES`は判定に送る添付画像数です。`0`では本文だけを送ります。

## 公開前の確認

`NODE_ENV=production`を設定し、`DEV_BYPASS_AUTH`は有効にしません。DB、ストレージ、Push、外部サービスの秘密情報をGitやClientへ含めず、移行前にはバックアップを取ります。`TRUST_PROXY=true`は信頼できるリバースプロキシの背後でだけ設定します。

詳しい構成は[ヘルプ文書](./help/README.md)を参照してください。
