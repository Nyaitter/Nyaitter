# データの保存先の選び方

Nyaitter では、投稿などの「データ保存先（データベース）」と、画像などの「ファイル保存先（ストレージ）」を用途に合わせて選べます。

## おすすめの組み合わせ

| やりたいこと | データベース (`DB_ADAPTER`) | ファイル保存 (`STORAGE_ADAPTER`) |
|---|---|---|
| まず手元で試す | `memory`（一時保存） | `local`（パソコン内） |
| 本格的に運用する（標準） | `postgres`（PostgreSQL） | `r2` または `local` |
| Cloudflare で運用する | `d1`（Cloudflare D1） | `r2`（Cloudflare R2） |

## 設定例 (`server/.env`)

### 1. 手元でテスト・開発する場合
```dotenv
DB_ADAPTER=memory
STORAGE_ADAPTER=local
```

### 2. 本番運用（PostgreSQL + R2）
```dotenv
DB_ADAPTER=postgres
DATABASE_URL=postgres://ユーザー名:パスワード@ホスト名:5432/データベース名?sslmode=require
STORAGE_ADAPTER=r2
STORAGE_USER_QUOTA_MB=1024
```

## 関連ドキュメント

- [PostgreSQL 設定ガイド](../help/database-postgres.md)
- [Cloudflare D1 設定ガイド](../help/database-d1-worker.md)
- [ローカル保存 設定ガイド](../help/storage-local.md)
- [Cloudflare R2 設定ガイド](../help/storage-r2.md)

