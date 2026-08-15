# データベースとストレージのアダプター

Nyaitter サーバーは、データベースとファイル保存の実装をアダプターとして分離しています。アプリケーション層は `DatabaseAdapter` と `StorageAdapter` の契約を通して操作するため、開発・本番・Cloudflare 構成を切り替えられます。

## 利用可能なアダプター

| 分類 | 実装 | 設定値 | 主な用途 |
|---|---|---|---|
| データベース | `InMemoryAdapter` | `DB_ADAPTER=memory` | 開発・自動テスト。再起動でデータが消える |
| データベース | `PostgresAdapter` | `DB_ADAPTER=postgres` | PostgreSQL を使う通常の本番構成 |
| データベース | `D1Adapter` | `DB_ADAPTER=d1` | 認証済み Worker プロキシ経由の Cloudflare D1 |
| ストレージ | `LocalStorageAdapter` | `STORAGE_ADAPTER=local` | 開発・単一サーバーでの簡易保存 |
| ストレージ | `R2StorageAdapter` | `STORAGE_ADAPTER=r2` または `cloudflare-r2` | Cloudflare R2 を使う実運用向け保存 |

## 基本的な切り替え

環境変数は `server/config.json` の既定値を上書きします。秘密情報は `server/.env` またはデプロイ先のシークレット管理機能に置き、リポジトリへ追加しないでください。

```bash
# 開発: メモリDBとローカルファイル保存
DB_ADAPTER=memory STORAGE_ADAPTER=local npm run dev:server

# PostgreSQL と R2 を使う例
DB_ADAPTER=postgres DATABASE_URL='postgres://...' STORAGE_ADAPTER=r2 npm start

# Cloudflare D1 Worker を使う例
DB_ADAPTER=d1 D1_WORKER_URL='https://d1-proxy.example.workers.dev' \
D1_WORKER_TOKEN='...' npm start
```

## 実装上の責務

アダプターは永続化・取得・原子的な更新を担います。一方、投稿の非公開状態、検索除外、双方向ブロック関係、通知・DMの閲覧制御のような**利用者間の共通ルールはアプリケーション層で判定**します。

> 新しいアダプターを追加する場合も、可視性ルールを各アダプターのクエリへ複製しないでください。共通サービス・ユーティリティを経由し、すべての保存先で同じ結果になるようにします。

## 新しいアダプターを作るとき

1. `DatabaseAdapter` または `StorageAdapter` の必要なメソッドを実装します。
2. 返却値の型・フィールド名を既存アダプターと揃えます。特にページング結果、DM 未読数、添付ファイルURLは互換性を確認します。
3. いいね、スター、未読数など同時更新が必要な操作は、保存先側で原子的に扱います。
4. 失敗時は原因を追跡できるエラーを返し、秘密情報をログへ出さないようにします。
5. InMemory・PostgreSQL・D1 を横断するスモークテストを追加または実行します。

## 関連ドキュメント

- [PostgreSQL のセットアップ](../help/database-postgres.md)
- [Cloudflare D1 と Worker](../help/database-d1-worker.md)
- [Cloudflare R2 ストレージ](../help/storage-r2.md)
- [ローカルストレージ](../help/storage-local.md)
- [アダプターの設計と切り替え](../help/adapters-overview.md)
