# Nyaitter サーバーについて

Nyaitter のバックエンドです。ブラウザは直接データベースに触れず、このサーバー経由でだけやり取りします。

## 起動方法

プロジェクトのルートで次を実行します。

```bash
npm install
npm run dev:server
```

ブラウザで http://localhost:3000/ を開きます。

## URL の振り分け

| パス | 内容 |
|------|------|
| `/server/health` | サーバーが動いているか確認する |
| `/server/api/posts` | 投稿の取得・作成・いいねなど |
| `/server/api/dm` | ダイレクトメッセージ |
| `/server/api/users` | ユーザー検索・プロフィール |
| `/server/auth/*` | ログイン関連 |
| `/server/apidocs` | 各APIに関する情報を取得する(β) |
| それ以外 | `page/` フォルダの静的ファイル（フロント画面） |

例：

- `http://localhost:3000/` → `page/index.html`
- `http://localhost:3000/js/main.js` → `page/js/main.js`
- `http://localhost:3000/server/health` → ヘルスチェックの JSON

## 環境変数

`server/.env.example` をコピーして `server/.env` を作り、必要な値を入れてください。

開発時の初期設定：

- `DB_ADAPTER=memory`（メモリ上のデータベース）
- `STORAGE_ADAPTER=local`（ローカルフォルダにファイル保存）

## 設定ファイル

細かい設定は `server/config.json` にまとまっています。

主な項目：

- `server` … ポート番号など
- `cors` … 許可するオリジン
- `limits` … 投稿文字数やアップロードサイズの上限
- `auth` … セッションの有効期間など
- `database` / `storage` … 使うデータベース・ストレージの種類
- `rateLimit` … アクセス制限
- `security` … セキュリティヘッダ

重要な値の一部は環境変数の方が優先されます（`PORT` など）。

## 全体の仕組み

このサーバーは「フロント用の窓口（BFF）」です。

- ブラウザは `/server/...` だけを呼び出す
- データベースやファイル保存の実装はアダプターで切り替え可能
  - 開発用：メモリ（InMemory）
  - 本番向け：PostgreSQL、Cloudflare D1、R2 など

詳細は `server/adapters/README.md` と `server/help/` を見てください。

## 主な API

### 投稿

- `GET /server/api/posts` … タイムライン
- `POST /server/api/posts` … 投稿する（ログイン必要）
- `GET /server/api/posts/:id` … 投稿の詳細
- `POST /server/api/posts/:id/like` … いいねの切り替え
- `POST /server/api/posts/:id/star` … スターの切り替え
- `GET /server/api/posts/:id/replies` … 返信一覧

### ダイレクトメッセージ

- `GET /server/api/dm` … 会話一覧（ログイン必要）
- `GET /server/api/dm/unread` … 未読数（ログイン必要）
- `POST /server/api/dm/:targetUserId` … 会話を開始／取得（ログイン必要）
- `GET /server/api/dm/:channelId/messages` … メッセージ一覧（ログイン必要）
- `POST /server/api/dm/:channelId/messages` … 送信（ログイン必要）
- `PUT /server/api/dm/:channelId/read` … 既読にする（ログイン必要）

### ユーザー

- `GET /server/api/users/search?q=...` … 検索
- `GET /server/api/users/:userId` … プロフィール
- `GET /server/api/users?ids=1,2,3` … 複数ユーザー取得

### 認証

- `POST /server/auth/scratch/generate` … 確認コード発行
- `POST /server/auth/scratch/verify` … Scratch アカウント確認
- `GET /server/auth/me` … 今ログインしているユーザー（ログイン必要）
- `GET /server/auth/external/confirm-context` … 外部ログイン確認画面用の情報
- `POST /server/auth/external/confirm` … 外部ログインを許可して proof を発行（ログイン必要）
- `POST /server/auth/external/verify` … 他サーバーからの proof 検証
- `POST /server/auth/external/init` … 外部サーバーへのログイン開始
- `POST /server/auth/external/complete` … 外部ログイン完了処理


## 新しい API を足すとき

1. `server/routes/` にファイルを作る（例：`posts.js`）
2. `server/index.js` で登録する

```js
app.use('/server/api/posts', require('./routes/posts'));
```

3. データベースは `req.app.locals.dbAdapter` 経由で使う
4. API Docsの更新を`npm run swagger`で行う

## セキュリティの注意

- セッション用のトークンは短めの有効期限にし、定期的に入れ替える
- 権限が必要な処理は必ずこのサーバーを通す
- 秘密のキーをブラウザに渡さない

## 外部 Nyaitter アドレスでのログイン

デフォルトでは `federation.allow_external_login` は有効です（`trusted_servers` が空のときはオープンモード）。このサーバーが確認側になる場合は `/auth/external` で許可画面を表示します。


ログイン画面では、Scratch のユーザー名のほかに `#1234@example.com` 形式の Nyaitter アドレスも使えます。

この形式が入力されると、サーバーは `POST /server/auth/external/init` を呼び出し、登録済みの外部サーバーの確認ページへ進みます。Scratch ユーザー名の場合は、これまでどおりコメント認証になります。

外部ログインを使うには `server/config.json` の `federation` で次のようにします。

- `allow_external_login` を有効にする
- `trusted_servers` にサーバーを1件以上書くと、その一覧だけを受け付ける（ホワイトリスト）
- `trusted_servers` を空にすると、任意の Nyaitter サーバーを受け付ける（オープン）

どちらの場合も、証明（proof）は HTTPS でサーバー同士が確認します。

```json
{
  "federation": {
    "allow_external_login": true,
    "trusted_servers": [
      {
        "domain": "remote.nyaitter.example",
        "auth_endpoint": "https://remote.nyaitter.example/login/confirm",
        "verify_endpoint": "https://remote.nyaitter.example/api/verify-login"
      }
    ]
  }
}
```

開始時に短い寿命の `state` と、コールバック先の URL を外部サーバーに渡します。外部サーバーは成功時に、同じ `state` と `proof` を付けて戻します。ログイン画面は `/server/auth/external/complete` を呼び、検証が成功したときだけセッションを作ります。

`state` は約10分で無効になり、一度使うと消費されます。
