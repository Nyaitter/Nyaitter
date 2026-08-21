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

## クエリ性能と最適化
 
PostgreSQL アダプター (`PostgresAdapter`) は、ホットパスの往復遅延を抑えるための最適化を含んでいます。
 
- **ブートストラップ統合 (`getUserBootstrapData`)**: 認証ユーザーの初期表示 (`/server/auth/me`) に必要なアカウント状態、通知、所属グループバッジを CTE と JSONB 集計により単一クエリで取得します。
- **ポストメトリクス集計 (`getPostMetricsBatch`)**: いいね・スター・リポスト・返信数のカウントおよび閲覧者リアクション判定を、インデックススカラーサブクエリ（Index-Only Scan）で集計し、テーブル直積による負荷を排除します。
- **DM未読判定の短絡評価**: 未読件数がゼロの場合は追加のメンバー検索クエリをスキップし、不要な DB 往復を削減します。
- **ウィンドウ関数によるバッジ絞り込み**: ユーザーごとの参加グループバッジ取得を PostgreSQL 側で最大3件に制限して転送します。

## 確認

```bash
npm run check:config
curl --fail http://127.0.0.1:3000/server/health
curl --fail http://127.0.0.1:3000/server/ready
```

接続エラー時は`DB_ADAPTER`、`DATABASE_URL`、DBのネットワーク設定、SSL要件を確認してください。

関連: [R2](./storage-r2.md) / [本番チェックリスト](./production-checklist.md)
