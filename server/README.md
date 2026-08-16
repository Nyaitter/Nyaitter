# Nyaitter Server

このフォルダには、Nyaitter のサーバーがあります。投稿、認証、通知、DM、ファイル保存、リアルタイム配信を担当します。ブラウザはデータベースやR2へ直接接続せず、必ずこのサーバーを通して操作します。

## 起動方法

リポジトリのルートで次を実行します。

```bash
npm install
cp server/.env.example server/.env
npm start
```

初期設定では <http://localhost:3000/> で動きます。

| URL | 内容 |
|---|---|
| `/server/health` | サーバーが応答しているか確認する |
| `/server/ready` | DBなどの起動準備が完了したか確認する |
| `/server/status` または `/server/api/status` | サーバーと認証の状態を確認する |
| `/server/apidocs` | API仕様を確認する |

> 初期設定のDBはメモリ上だけで動きます。再起動するとデータが消えます。公開運用ではPostgreSQLまたはD1を使ってください。

## Clientの配置

`page/` がある場合、サーバーはその中の静的ファイルを配信します。`page/` がない場合、APIだけを提供し、静的ファイルは配信しません。

NyaitterClientを `page/` へ取得・更新するには、次を実行します。

```bash
npm run sync:client
```

Clientリポジトリは `NYAITTER_CLIENT_REPOSITORY` または `server/config.json` の `client.repository` で指定します。既定値は `Nyaitter/Client` です。

> `page/` を作成または入れ替えた後は、静的配信を有効にするためServerを再起動してください。

## ユーザーファイルの配信

Clientの `page/config.js` には `userFileEndpoint` があります。添付ファイル、ヘッダー画像、保存済みユーザーアイコンなどのユーザーファイルを配信するURLを指定します。

```js
userFileEndpoint: 'https://media.example.com'
```

Cloudflare R2の公開ドメインから直接配信する場合は、この設定にR2の公開ドメインを指定します。この場合、Server側のユーザーファイルエンドポイントは未設定にします。保存済みアイコンも、添付ファイルと同じ公開ドメインから直接取得されます。

ローカル保存をServerから配信する場合は、ClientとServerで同じパスを指定します。

```js
// page/config.js
userFileEndpoint: '/uploads'
```

```dotenv
# server/.env
NYAITTER_USER_FILES_ENDPOINT=/uploads
```

Serverの `NYAITTER_USER_FILES_PORT` を設定すると、ユーザーファイルだけを専用ポートから配信します。未設定の場合は通常のServerポートから配信します。

> `userFileEndpoint` または `NYAITTER_USER_FILES_ENDPOINT` が未設定の場合、Nyaitter Serverはユーザーファイルを配信しません。

## APIのパス

APIの基準パスは `NYAITTER_API_ENDPOINT` または `server.apiEndpoint` で設定します。既定値は `/server` です。

各REST APIは、`/api` あり・なしの両方で利用できます。たとえば既定値では、投稿APIは `/server/posts` と `/server/api/posts` のどちらでも利用できます。

| 機能 | APIパスの例 |
|---|---|
| 投稿、検索、リアクション | `/server/api/posts` |
| ファイルのアップロード、削除 | `/server/api/uploads` |
| 保存済みファイルと使用量 | `/server/api/uploads/storage` |
| プロフィール、フォロー、設定 | `/server/api/users` |
| グループDM、未読数 | `/server/api/dm` |
| 通知 | `/server/api/notifications` |
| Push通知 | `/server/api/push` |
| Scratch認証、セッション、外部ログイン | `/server/auth/*` |
| ローカル保存時のファイル配信 | `/uploads/*` |

`NYAITTER_API_ENDPOINT=/` と設定した場合は、`/posts` と `/api/posts` のように公開されます。`/api` は互換用の別名であり、どちらも同じ処理を実行します。

## 設定

通常の設定は `server/config.json`、パスワードやトークンなどの秘密情報は `server/.env` に置きます。`server/.env` はGitへ追加しないでください。

| 分類 | 主な設定 |
|---|---|
| 起動 | `PORT`、`NODE_ENV`、`LOG_LEVEL`、`TRUST_PROXY` |
| APIパス | `NYAITTER_API_ENDPOINT`、`server.apiEndpoint` |
| ユーザーファイル | `NYAITTER_USER_FILES_ENDPOINT`、`NYAITTER_USER_FILES_PORT`、`userFiles.endpoint`、`userFiles.port` |
| Client同期 | `NYAITTER_CLIENT_REPOSITORY`、`client.repository` |
| DB | `DB_ADAPTER`、`DATABASE_URL`、`D1_WORKER_URL`、`D1_WORKER_TOKEN` |
| ストレージ | `STORAGE_ADAPTER`、`STORAGE_USER_QUOTA_MB`、`R2_*` |
| Push通知 | `VAPID_SUBJECT`、`VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY` |

設定例は [`.env.example`](./.env.example) を確認してください。

設定に不備がないかを確認するには、次を実行します。

```bash
npm run check:config
```

このコマンドは設定を変更せず、設定不備が見つかった場合は対応方法を表示します。外部サービスへの接続やサーバー起動は行いません。

## DBとファイル保存

| 種類 | 開発向け | 公開運用向け |
|---|---|---|
| データベース | `memory` | `postgres` または `d1` |
| ファイル保存 | `local` | `r2` |

D1を使う場合は、D1プロキシWorkerのURLと共有トークンを設定します。

```dotenv
DB_ADAPTER=d1
D1_WORKER_URL=https://example.workers.dev
D1_WORKER_TOKEN=秘密のトークン
```

R2を使う場合は、R2のS3 API用アクセスキーと対象バケットを設定します。

```dotenv
STORAGE_ADAPTER=r2
R2_ACCOUNT_ID=CloudflareのアカウントID
R2_BUCKET=nyaitter-uploads
R2_ACCESS_KEY_ID=S3_API_Access_Key_ID
R2_SECRET_ACCESS_KEY=S3_API_Secret_Access_Key
R2_PUBLIC_DOMAIN=https://media.example.com
```

## ファイルのアップロード

アップロードしたファイルは `attachments/{ユーザーID}` の形でユーザーごとに保存されます。

- 初期設定で入力ファイルの上限は **5 MB** です。
- 初期設定で1ユーザーの保存上限は **1 GB** です。
- 保存上限は `storage.userQuotaMB` または `STORAGE_USER_QUOTA_MB` でMB単位に変更できます。
- 画像は保存前にEXIFや位置情報を削除します。大きい画像は縮小してWebPへ圧縮します。
- ユーザーは **設定 → ストレージ** で使用量、保存ファイル、削除操作を確認できます。

## 開発用の注意

`DEV_BYPASS_AUTH=true` はScratch認証を省略する開発専用設定です。公開サーバーでは絶対に使わないでください。`NODE_ENV=production` で有効にすると、サーバーは起動を拒否します。

`TRUST_PROXY=true` は、信頼できるリバースプロキシの背後で動かす場合だけ設定します。直接公開するサーバーでは安易に有効化しないでください。

API仕様を更新した場合は、次を実行してSwagger文書を更新します。

```bash
npm run swagger
```

## DM暗号化の一時停止

複数デバイスでのDM利用を優先するため、現在はDMのE2E暗号化を既定で無効にしています。新規DMと編集後のDMは平文で保存され、暗号化済みのDMペイロードはサーバーで受け付けません。以前に保存された暗号化DMは削除せず、当時の秘密鍵が残る端末では引き続き閲覧できます。

> `DM_E2E_ENABLED=true` の指定だけでは再有効化されません。再有効化する際は、鍵管理・送信処理を含むClient実装もあわせて戻してください。

## ローカル操作CLI

起動中のサーバーは、同じOS利用者だけが使えるローカルソケットで操作できます。

```bash
npm run cli -- server status
npm run cli -- server restart
npm run cli -- admin grant '#3480'
```

メモリDBの内容は再起動で消えるため、開発環境で付与した管理者権限も必要に応じて再設定してください。
