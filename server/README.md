# Nyaitter サーバー

このフォルダには、Nyaitter のAPI、認証、投稿、通知、DM、ファイル保存、リアルタイム配信を行うNode.jsサーバーがあります。ブラウザはデータベースやストレージへ直接つながず、必ずこのサーバーを通して操作します。

## 起動方法

リポジトリのルートで次を実行します。

```bash
npm install
cp server/.env.example server/.env
npm run dev:server
```

初期設定では <http://localhost:3000/> で動きます。

| URL | 用途 |
|---|---|
| `/server/health` | サーバーが応答しているか確認する |
| `/server/ready` | 起動準備が完了したか確認する |
| `/server/api/status` | サーバーと認証の状態を確認する |

> 初期設定のメモリDBは、再起動するとデータが消えます。公開運用ではPostgreSQLまたはD1を使ってください。

## 主なURL

| パス | 内容 |
|---|---|
| `/server/api/posts` | 投稿、検索、リアクション、添付ファイル |
| `/server/api/users` | プロフィール、フォロー、設定 |
| `/server/api/dm` | グループDM、未読数、暗号化用公開鍵 |
| `/server/api/notifications` | 通知の取得、既読、削除 |
| `/server/api/push` | Push通知の設定 |
| `/server/auth/*` | Scratch認証、セッション、外部ログイン |
| `/uploads/*` | ローカル保存時のアップロードファイル |

## 設定の置き場所

通常の設定は `server/config.json`、パスワードやトークンなどの秘密情報は `server/.env` に置きます。`server/.env` はGitへ追加しないでください。

| 分類 | よく使う設定 |
|---|---|
| 起動 | `PORT`、`NODE_ENV`、`LOG_LEVEL` |
| DB | `DB_ADAPTER`、`DATABASE_URL`、`D1_WORKER_URL`、`D1_WORKER_TOKEN` |
| ストレージ | `STORAGE_ADAPTER`、`STORAGE_USER_QUOTA_MB`、`R2_*` |
| 認証 | `MULTI_ACCOUNT_COOKIE_SECRET`、`LOGIN_SECURITY_HMAC_SECRET`、`TURNSTILE_*` |
| Push通知 | `VAPID_SUBJECT`、`VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY` |

環境変数の一覧と説明は [`.env.example`](./.env.example) を確認してください。

## ファイルのアップロード

すべてのファイル形式を保存できます。アップロードしたファイルは `attachments/{ユーザーID}` の形でユーザー別に管理されます。

- 入力ファイルの上限は初期設定で **5 MB** です。
- 1ユーザーの保存上限は初期設定で **1 GB** です。
- 上限は `storage.userQuotaMB` または `STORAGE_USER_QUOTA_MB` でMB単位に変更できます。
- 画像は保存前にEXIF・位置情報などを削除します。大きい画像は縦横比を保ったまま縮小し、WebPへ圧縮します。
- ユーザーは **設定 → ストレージ** で使用率、保存ファイル、削除操作を確認できます。

## 開発用の注意

`DEV_BYPASS_AUTH=true` はScratch認証を省略する開発専用設定です。公開サーバーでは絶対に使わないでください。`NODE_ENV=production` で有効にすると、サーバーは起動を拒否します。

`TRUST_PROXY=true` は、信頼できるリバースプロキシの背後で動かす場合だけ設定します。直接公開するサーバーで安易に有効化しないでください。

## 保存先の選び方

| 種類 | 開発向け | 公開運用向け |
|---|---|---|
| データベース | `memory` | `postgres` または `d1` |
| ファイル保存 | `local` | `r2` |

詳しい説明は [アダプターの文書](./adapters/README.md) と [セットアップ・運用ガイド](./help/README.md) にあります。

## 運用前の確認

公開前は [本番デプロイのチェックリスト](./help/production-checklist.md) を確認してください。秘密鍵、DB接続文字列、D1/R2トークンをクライアント側や `config.json`、Gitへ書き込んではいけません。

## ローカル操作CLI

起動中のサーバーは、同じOS利用者だけが使えるローカルソケットでCLI操作できます。

```bash
npm run cli -- server status
npm run cli -- server restart
npm run cli -- admin grant '#3480'
```

メモリDBの内容は再起動で消えるため、開発環境で付与した管理者権限も必要に応じて再設定してください。
