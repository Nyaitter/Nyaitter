# アダプターの考え方と切り替え方

Nyaitter は、保存先ごとの違いをアダプターへ閉じ込め、投稿・通知・DMなどのアプリケーション機能を同じ API 契約で動かします。

## 役割の分離

| 層 | 担当すること |
|---|---|
| ルート・サービス | 認証、入力検証、投稿公開範囲、検索除外、ブロック、通知配信、DM可視性 |
| DB アダプター | 保存、検索、ページング、トランザクション、未読数などの永続化 |
| ストレージアダプター | 添付ファイルの保存、削除、公開URLまたは署名URLの発行 |

> 非公開投稿、検索除外、ブロック関係のような利用者間ルールはアダプターより上位の共通層で処理します。保存先の違いで可視性が変わらないことが重要です。

## 現在の実装

| 種別 | 実装 | 状態 | 用途 |
|---|---|---|---|
| DB | `InMemoryAdapter` | 利用可能 | 開発・テスト。再起動で消去 |
| DB | `PostgresAdapter` | 利用可能 | PostgreSQL を使う実運用 |
| DB | `D1Adapter` | 利用可能 | 認証済み D1 Proxy Worker 経由 |
| ストレージ | `LocalStorageAdapter` | 利用可能 | 開発・単一サーバー |
| ストレージ | `R2StorageAdapter` | 利用可能 | R2 の公開・署名URL配信 |

## 設定方法

`server/config.json` の `database.adapter` と `storage.adapter` が既定値です。環境変数を設定すると、環境別に上書きできます。

```bash
# 開発
DB_ADAPTER=memory
STORAGE_ADAPTER=local

# PostgreSQL
DB_ADAPTER=postgres
DATABASE_URL='postgres://user:password@host:5432/nyaitter'

# D1 Proxy Worker
DB_ADAPTER=d1
D1_WORKER_URL='https://d1-proxy.example.workers.dev'
D1_WORKER_TOKEN='shared-secret'

# Cloudflare R2
STORAGE_ADAPTER=r2
R2_ACCOUNT_ID='...'
R2_BUCKET='nyaitter-uploads'
R2_ACCESS_KEY_ID='...'
R2_SECRET_ACCESS_KEY='...'
```

## アダプター契約の注意点

アダプター間の互換性は、メソッドの有無だけでなく返却値も対象です。たとえばDM一覧では保存先によって未読情報が `unread` マップまたは `unread_count` として返る場合があるため、共通サービスで正規化します。

新しいアダプターを追加する場合は、次を確認してください。

1. `DatabaseAdapter` または `StorageAdapter` の必要な操作を実装する。
2. ID、日時、ページング結果、未読数、添付URLを既存の契約に揃える。
3. 複数レコードを同時更新する操作は、保存先で原子的に実行する。
4. 例外に秘密情報を含めず、接続・認可・一時障害を区別できるようにする。
5. InMemory、PostgreSQL、D1 の差分を意識した回帰確認を行う。

## 構成の選び方

| 構成 | 向いている場合 |
|---|---|
| InMemory + Local | UIやAPIを素早く試すローカル開発 |
| PostgreSQL + R2 | 一般的な実運用。保存性と運用の分かりやすさを優先 |
| D1 Worker + R2 | Cloudflare中心で運用し、Worker プロキシを管理できる場合 |
| PostgreSQL + R2 + D1 | PostgreSQLを主データ、D1を必要な領域に限定して導入する場合 |

## 関連ドキュメント

- [PostgreSQL のセットアップ](./database-postgres.md)
- [Cloudflare D1 と Worker](./database-d1-worker.md)
- [Cloudflare R2 ストレージ](./storage-r2.md)
- [ローカルストレージ](./storage-local.md)
- [本番デプロイのチェックリスト](./production-checklist.md)
