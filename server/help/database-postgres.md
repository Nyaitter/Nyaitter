# PostgreSQL のセットアップ

Nyaitter を永続的に運用する場合の標準的な選択肢は PostgreSQL です。Node.js サーバーは `PostgresAdapter` を通して接続し、投稿、通知、グループDM、ログイン保護、Push購読などのデータを保存します。

## 推奨構成

| 構成 | 向いている場合 |
|---|---|
| Node.js + PostgreSQL | VPSやマネージドPostgreSQLで完結させたい場合 |
| Node.js + PostgreSQL + R2 | DBをPostgreSQL、添付ファイルをR2に分ける一般的な実運用 |
| Node.js + PostgreSQL + R2 + D1 Worker | Cloudflare機能を必要な領域に限定して段階導入する場合 |

## 1. PostgreSQL と依存関係を用意する

`pg` はプロジェクトの依存関係に含まれます。依存関係全体はリポジトリのルートで導入します。

```bash
npm install
```

PostgreSQL側で専用のDBと、必要最小限の権限を持つ接続ユーザーを作成します。

```sql
CREATE DATABASE nyaitter;
```

## 2. マイグレーションを適用する

PostgreSQL用SQLは `server/migrations/` にあります。新規DBでは番号順にすべて適用します。

```bash
cd /path/to/Nyaitter
for migration in server/migrations/*.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"
done
```

既存DBへ反映する場合は、すでに適用済みのファイルを記録し、未適用分だけを番号順に実行してください。現在は `023_dm_message_reports.sql` まであります。投稿候補の読み取りを速くする `018_recommendation_candidate_index.sql` なども含まれるため、番号を飛ばさずに適用してください。

> 本番DBに対しては、事前バックアップ、ステージング適用、復旧手順の確認なしにSQLを実行しないでください。

詳しくは [`../migrations/README.md`](../migrations/README.md) を参照してください。

## 3. サーバーを設定する

`server/.env` またはデプロイ先のシークレットに設定します。

```env
NODE_ENV=production
DB_ADAPTER=postgres
DATABASE_URL=postgres://nyaitter:password@db.example.com:5432/nyaitter?sslmode=require
```

`server/config.json` でも `database.postgres.connectionString`、`poolSize`、`ssl` を指定できますが、接続文字列やパスワードを追跡対象の設定ファイルへ保存しないでください。実運用では環境変数またはホスティングサービスのシークレットを推奨します。

## SSL と接続プール

マネージドPostgreSQLではSSLが必要なことが多いため、接続先の指示に従って `sslmode=require` などを設定します。自己署名証明書や独自CAを使う場合は、接続ライブラリとホスティング事業者の手順を確認してください。

接続プールはDBの最大接続数、アプリプロセス数、同時リクエスト数を合算して決めます。単純に大きくするのではなく、DB監視で接続待ち・遅いクエリ・CPU使用率を確認してください。

## 4. 起動と確認

```bash
npm start
```

起動後に、少なくとも次を確認します。

```bash
curl --fail http://127.0.0.1:3000/server/health
curl --fail http://127.0.0.1:3000/server/ready
```

ステージングではログイン、投稿、検索、添付アップロード、ユーザー別ストレージ上限、通知、DM、Push購読を確認します。非公開投稿、検索除外、ブロック関係についても、取得経路にかかわらず同じ可視性ルールになることを確認してください。

## バックアップと復旧

- `pg_dump` またはマネージドサービスのバックアップを定期実行します。
- DBスキーマの変更前に復旧可能なスナップショットを作成します。
- R2など外部ストレージを使う場合、DBバックアップとオブジェクトの保持方針を別途決めます。
- 実際に別環境へ復元する訓練を行い、復旧時間と手順を記録します。

## トラブルシューティング

| 症状 | 確認項目 |
|---|---|
| `relation does not exist` | 未適用のマイグレーション、接続先DB、スキーマ検索パス |
| SSL接続エラー | `DATABASE_URL`、CA設定、ホスティング事業者のSSL要件 |
| 接続上限・待ち時間 | プール数、アプリプロセス数、DBの最大接続数、遅いクエリ |
| アダプター初期化エラー | `DB_ADAPTER=postgres`、接続文字列、ネットワーク到達性、起動ログ |

## 関連ドキュメント

- [PostgreSQL マイグレーション](../migrations/README.md)
- [Cloudflare R2 ストレージ](./storage-r2.md)
- [Cloudflare D1 と Worker](./database-d1-worker.md)
- [本番デプロイのチェックリスト](./production-checklist.md)
