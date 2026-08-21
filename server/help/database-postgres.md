# PostgreSQL 設定ガイド

PostgreSQL を Nyaitter のデータベースとして使用する手順です。

## 1. 接続先の設定

`server/.env` に PostgreSQL の接続URLを設定します。

```dotenv
DB_ADAPTER=postgres
DATABASE_URL=postgres://ユーザー名:パスワード@ホスト名:5432/データベース名?sslmode=require
```

## 2. データベースの初期化

次のコマンドを実行して、データベースに必要なテーブルを作成します。

```bash
npm run migrate
```

## 3. サーバーの起動と確認

```bash
npm start
```

ブラウザで <http://localhost:3000/> を開いて動作を確認します。

---

- 関連: [Cloudflare R2 設定ガイド](./storage-r2.md) / [本番公開前チェックリスト](./production-checklist.md)

