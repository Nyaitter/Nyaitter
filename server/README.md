# Nyaitter サーバー

Nyaitter のバックエンドです。ブラウザはデータベースやストレージへ直接接続せず、この Express サーバーの API を介して認証、投稿、通知、DM、アップロード、リアルタイム配信を利用します。

## 起動

リポジトリのルートで依存関係を導入し、必要に応じて環境変数ファイルを用意します。

```bash
npm install
cp server/.env.example server/.env
npm run dev:server
```

既定では <http://localhost:3000/> で起動します。監視・疎通確認には次のエンドポイントを使用できます。

| パス | 用途 |
|---|---|
| `GET /server/health` | プロセスが応答できるかを確認するヘルスチェック |
| `GET /server/ready` | 起動準備が完了しているかを確認するレディネスチェック |
| `GET /server/api/status` | サーバー識別情報と認証関連の状態を取得する |

> 開発時の `InMemoryAdapter` は再起動で全データを失います。実運用には PostgreSQL または D1 を設定してください。

## ルーティング

| パス | 内容 |
|---|---|
| `/server/api/posts` | 投稿、タイムライン、検索、リアクション |
| `/server/api/users` | プロフィール、検索、フォロー、設定 |
| `/server/api/dm` | グループ DM、未読数、E2E 公開鍵 |
| `/server/api/notifications` | 通知の一覧、既読・クリック・削除 |
| `/server/api/ui/summary` | ナビゲーション向け未読数の要約 |
| `/server/api/push` | Web Push の設定と購読 |
| `/server/api/ranking` | ランキング |
| `/server/auth/*` | Scratch 認証、セッション、外部ログイン |
| `/uploads/*` | ローカルストレージ使用時のアップロードファイル |
| それ以外 | `page/` 配下の静的クライアント資産 |

静的クライアント資産は ETag/Last-Modified を利用して毎回再検証されます。サービスワーカーもネットワーク優先で更新を確認するため、ファイル内容の変更時にクエリ文字列で手動バージョンを付け替える必要はありません。

## 設定

基本設定は `server/config.json`、環境ごとの秘密情報や上書き値は `server/.env` に置きます。`server/.env` は Git の追跡対象外です。

| 分類 | 主な値 |
|---|---|
| 実行環境 | `PORT`、`NODE_ENV`、`TRUST_PROXY`、`LOG_LEVEL` |
| データベース | `DB_ADAPTER`、`DATABASE_URL`、`D1_WORKER_URL`、`D1_WORKER_TOKEN` |
| ストレージ | `STORAGE_ADAPTER`、`R2_*` |
| 認証・ログイン保護 | `MULTI_ACCOUNT_COOKIE_SECRET`、`LOGIN_SECURITY_HMAC_SECRET`、`TURNSTILE_*` |
| Push | `VAPID_SUBJECT`、`VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY` |

`server/.env.example` は利用可能な環境変数と安全上の注意の一覧です。

### 開発用認証バイパス

`DEV_BYPASS_AUTH=true` は Scratch コメント認証を省略する**ローカル開発専用**の設定です。本番環境では有効化してはいけません。`NODE_ENV=production` で有効化された構成は起動時に拒否されます。

リバースプロキシの背後で運用する場合は、実際のプロキシ構成を確認した上で `TRUST_PROXY=true` を設定してください。

## アダプター

データベースとストレージはアダプターで切り替えます。

| 種類 | 開発用 | 実運用向け |
|---|---|---|
| データベース | `memory`（InMemoryAdapter） | `postgres`、`d1` |
| ストレージ | `local`（LocalStorageAdapter） | `r2`（R2StorageAdapter） |

詳細は [`server/adapters/README.md`](./adapters/README.md) と [`server/help/README.md`](./help/README.md) を参照してください。

## 主要 API

### 投稿

| エンドポイント | 内容 |
|---|---|
| `GET /server/api/posts/page` | タイムライン、検索、おすすめ、プロフィールのページ取得 |
| `GET /server/api/posts/search` | 投稿検索 |
| `GET /server/api/posts/recommended` | おすすめ投稿 |
| `GET /server/api/posts/:id` | 投稿詳細 |
| `POST /server/api/posts` | 投稿、返信、引用の作成（認証必須） |
| `POST /server/api/posts/:id/like` | いいねの切り替え（認証必須） |
| `POST /server/api/posts/:id/star` | スターの切り替え（認証必須） |
| `POST /server/api/posts/:id/repost` | リポストの切り替え（認証必須） |

タイムライン、検索、おすすめなどの発見経路では、非公開投稿、検索除外、ブロック関係を共通の可視性層で判定します。検索除外中の投稿は、投稿者自身と投稿者をフォローしている利用者だけが発見できます。プロフィールでは検索除外のみを理由に投稿を隠しません。

### グループ DM

| エンドポイント | 内容 |
|---|---|
| `GET /server/api/dm` | 会話一覧と未読合計 |
| `GET /server/api/dm/unread` | 表示可能な会話の未読合計 |
| `GET /server/api/dm/unread-counts` | 会話ごとの未読数 |
| `GET /server/api/dm/:dmId` | 会話詳細 |
| `POST /server/api/dm` | 会話を作成または既存会話を取得 |
| `PUT /server/api/dm/:dmId` | タイトル・メンバー・ホストを更新 |
| `POST /server/api/dm/:dmId/messages` | メッセージを送信 |
| `POST /server/api/dm/:dmId/read` | 会話を既読にする |
| `POST /server/api/dm/:dmId/leave` | 会話から退出する |
| `GET` / `POST /server/api/dm/keys` | E2E 暗号化用公開鍵の取得・登録 |

ブロック関係にある利用者は同じ DM に新規招待できません。既存会話では相手のメッセージ、最新メッセージ要約、未読数、リアルタイム配信を閲覧者ごとに除外します。

### ユーザー・通知

- `GET /server/api/users/search?q=...` はユーザーを検索します。
- `GET /server/api/users/:userId` は公開プロフィールと閲覧者との関係を返します。
- `POST /server/api/users/:userId/follow` はフォロー状態を切り替えます。
- `PUT /server/api/users/me` はプロフィール・設定・ブロックリストを更新します。
- `GET /server/api/notifications` は通知一覧を返し、既読・クリック・削除用のエンドポイントを提供します。

ブロック関係がある利用者由来の投稿通知・フォロー通知・クライアント作成通知は作成・Push・リアルタイム配信されません。

## リアルタイム配信

接続中の利用者には WebSocket で、通知、DM、新規のフォロー中投稿、DM 未読数などを配信します。投稿の配信対象は、投稿者をフォローしており、かつ投稿者とのブロック関係がない接続中の利用者に限定されます。

リアルタイム配信の失敗は、すでに保存済みの投稿やメッセージの API 成功を取り消しません。画面は必要に応じて通常の API 取得で整合します。

## 新しい API・アダプターを追加する場合

1. `server/routes/` にルートを追加し、`server/index.js` で `/server/api/...` に登録します。
2. DB は `req.app.locals.dbAdapter`、ストレージは `req.app.locals.storageAdapter` 経由で利用します。
3. 投稿・通知・DMの閲覧制御は、アダプター固有の処理ではなく共通サービス・ユーティリティを通してください。
4. 認証が必要な操作には `requireAuth`、閲覧者によって結果が変わる公開取得には `optionalAuth` を適切に使います。

## 外部 Nyaitter アドレスでのログイン

`federation.allow_external_login` を有効にすると、`#1234@example.com` 形式の Nyaitter アドレスによる外部ログインを受け付けます。`trusted_servers` が空ならオープンモード、指定されていればその一覧だけを受け付けます。

外部ログインでは短時間で失効し一度だけ使える `state` と、相手サーバーが発行した `proof` を用います。proof は HTTPS 経由で相手サーバーに検証し、成功時だけローカルセッションを発行します。

## 本番運用

デプロイ前後の確認項目は [`help/production-checklist.md`](./help/production-checklist.md) を使用してください。秘密鍵、トークン、DB 接続文字列をクライアント・`config.json`・リポジトリへ含めてはいけません。

## ローカル運用 CLI

実行中のNyaitterサーバーは、同一OS利用者だけがアクセスできるUnixドメインソケットを作成します。CLIはこのローカルソケット経由で**現在接続されているアダプター**を操作するため、HTTP認証やブラウザ操作は必要ありません。

```bash
# サーバー状態
npm run cli -- server status

# サーバーの起動・停止・再起動
npm run cli -- server start
npm run cli -- server stop
npm run cli -- server restart

# 管理者権限の付与・解除（`#` は省略可能）
npm run cli -- admin grant '#3480'
npm run cli -- admin revoke 3480
```

管理者付与・解除は、実行中の `InMemoryAdapter`、PostgreSQL、D1のいずれでも、同じ`updateUserProfile`契約を通じて反映されます。`InMemoryAdapter`のデータはサーバー再起動時に失われるため、開発環境での付与も再起動後には必要に応じて再実行してください。

> このCLIはネットワーク公開されません。制御ソケットは既定で`/tmp/nyaitter-operator.sock`に作成され、所有者のみ読み書き可能な`0600`権限です。必要な場合は`NYAITTER_OPERATOR_SOCKET`で別のローカルパスを指定できます。
