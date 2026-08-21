# Nyaitter Server 設定・運用ガイド

Nyaitter のデータ保存、アカウント管理、通知、投稿配信を行うサーバーです。

## 起動手順

1. 必要なパッケージをインストールし、設定ファイルを用意します。
```bash
npm install
cp server/.env.example server/.env
```

2. サーバーを起動します。
```bash
npm start
```

ブラウザで <http://localhost:3000/> を開きます。
初期状態ではデータが一時保存（メモリ）のため、サーバーを再起動すると消えます。

## データの保存先（データベース）の設定

本番運用ではデータを保存するために PostgreSQL または Cloudflare D1 を使用します。
`server/.env` に保存先を設定し、データベースの初期化を実行してください。

```bash
# データベースの初期化・更新
npm run migrate
```

### PostgreSQL を使う場合（おすすめ）

```dotenv
DB_ADAPTER=postgres
DATABASE_URL=postgres://ユーザー名:パスワード@ホスト名:5432/データベース名?sslmode=require
```

### Cloudflare D1 を使う場合

```dotenv
DB_ADAPTER=d1
D1_WORKER_URL=https://あなたのWorker名.workers.dev
D1_WORKER_TOKEN=安全なランダム文字列
```

## 画像・ファイルの保存先

添付画像やアイコンの保存先を設定します。

| 設定値 | 保存先 | 用途 |
|---|---|---|
| `STORAGE_ADAPTER=local` | サーバー本体のディスク | 1台のサーバーでシンプルに動かす場合（既定値: `./uploads`） |
| `STORAGE_ADAPTER=r2` | Cloudflare R2 | 複数サーバー構成や大量の画像を扱う場合 |

### 画像保存の上限設定
ユーザー1人あたりの最大保存容量（メガバイト単位）を指定できます。
```dotenv
STORAGE_USER_QUOTA_MB=1024 # 1GB
```

## 主な機能と環境設定

設定は `server/.env` に記述します。

### 1. ログイン方法の有効化
```dotenv
AUTH_METHOD_SCRATCH_ENABLED=true  # Scratch認証
AUTH_METHOD_EMAIL_ENABLED=true    # メールアドレス認証
AUTH_METHOD_PASSKEY_ENABLED=true  # パスキー（生体認証）
```
※詳細は [認証設定ガイド](./help/auth-providers.md) をご覧ください。

### 2. プッシュ通知 (Web Push)
```dotenv
VAPID_SUBJECT=mailto:admin@example.com
VAPID_PUBLIC_KEY=公開キー
VAPID_PRIVATE_KEY=秘密キー
```

### 3. AI自動モデレーション (Google Gemini)
投稿内容をAIで自動判定して不適切な投稿を防ぎます。
```dotenv
GEMINI_API_KEY=あなたのAPIキー
GEMINI_MODEL=gemini-2.0-flash
GEMINI_MOD_PROMPT=投稿をコミュニティルールに基づいて判定してください。
```

### 4. 設定の自己診断
設定に誤りがないか自動で検査できます。
```bash
npm run check:config
```

## データのバックアップと移行

別のデータベースへデータを移す場合は次のコマンドを使います。

```bash
# バックアップの書き出し
npm run migrate:data -- --from postgres --output backup.json

# バックアップからの復元
npm run migrate:data -- --to postgres --input backup.json --replace
```

## ドキュメント一覧

- [保存先の選び方](./help/adapters-overview.md)
- [PostgreSQL 設定ガイド](./help/database-postgres.md)
- [Cloudflare D1 設定ガイド](./help/database-d1-worker.md)
- [Cloudflare R2 設定ガイド](./help/storage-r2.md)
- [ローカル保存 設定ガイド](./help/storage-local.md)
- [認証プロバイダー設定](./help/auth-providers.md)
- [NyaitterAuth 外部連携ガイド](./help/nyaitter-auth.md)
- [本番公開前チェックリスト](./help/production-checklist.md)
