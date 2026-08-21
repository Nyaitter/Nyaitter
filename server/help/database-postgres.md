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

`npm run migrate`は空のPostgreSQL DBへ完全な初期スキーマを作成します。

他のDBからPostgreSQLへデータを移す場合は、空のPostgreSQL DBへ初期スキーマを作成した後に`npm run migrate:data`を実行します。接続設定と実行例は[Server README](../README.md#dbデータの移行)を参照してください。
## 確認

```bash
npm run check:config
curl --fail http://127.0.0.1:3000/server/health
curl --fail http://127.0.0.1:3000/server/ready
```

接続エラー時は`DB_ADAPTER`、`DATABASE_URL`、DBのネットワーク設定、SSL要件を確認してください。

関連: [R2](./storage-r2.md) / [本番チェックリスト](./production-checklist.md)
