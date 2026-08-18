# PostgreSQL

## 設定

`server/.env`またはデプロイ先のシークレットに接続文字列を設定します。

```dotenv
DB_ADAPTER=postgres
DATABASE_URL=postgres://user:password@db.example.com:5432/nyaitter?sslmode=require
```

接続先がSSLを要求する場合は、接続先の案内に従ったURLを使います。接続文字列はGitへ追加しません。

## 初期化と移行

依存関係を導入した後、リポジトリのルートで実行します。

```bash
npm install
npm run migrate
npm start
```

`npm run migrate`は`server/migrations/`の未適用分を適用します。移行前にDBのバックアップを取ってください。

## 確認

```bash
npm run check:config
curl --fail http://127.0.0.1:3000/server/health
curl --fail http://127.0.0.1:3000/server/ready
```

接続エラー時は`DB_ADAPTER`、`DATABASE_URL`、DBのネットワーク設定、SSL要件を確認してください。

関連: [R2](./storage-r2.md) / [本番チェックリスト](./production-checklist.md)
