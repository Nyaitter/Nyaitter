# データベースとストレージのアダプター

Nyaitter サーバーは、データベースやファイル保存の実装を切り替えられるようになっています（アダプターパターン）。

詳しい手順は `server/help/` にまとめてあります。

## いま使えるアダプター

| 名前 | 状態 | 主な用途 |
|------|------|----------|
| InMemoryAdapter | 完成 | 開発・テスト |
| PostgresAdapter | 完成 | 自前サーバーや VPS（本番向け） |
| D1Adapter | 完成 | Cloudflare Workers / D1 |
| LocalStorageAdapter | 完成 | 開発時のファイル保存 |
| R2StorageAdapter | 完成 | 本番のファイル保存 |

## 詳しいガイド

- [PostgreSQL のセットアップ](../help/database-postgres.md)
- [Cloudflare D1 と Worker](../help/database-d1-worker.md)
- [Cloudflare R2 ストレージ](../help/storage-r2.md)

純粋な構成と、Worker を混ぜた構成の両方を書いてあります。

## 切り替え方（基本）

```bash
# PostgreSQL を使う
DB_ADAPTER=postgres DATABASE_URL="postgres://..." npm run dev:server

# R2 を使う
STORAGE_ADAPTER=r2 npm run dev:server
```

細かい設定は `server/config.json` と `server/help/` を見てください。
