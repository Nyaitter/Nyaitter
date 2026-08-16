# データベースとストレージの選び方

Nyaitter は、データベースとファイル保存先をアダプターとして切り替えられます。アプリ本体は同じ操作方法を使うため、開発用の保存先から公開運用向けの保存先へ変更できます。

## 使えるアダプター

| 種類 | 設定値 | 使いどころ |
|---|---|---|
| メモリDB | `DB_ADAPTER=memory` | ローカル開発。再起動でデータが消えます。 |
| PostgreSQL | `DB_ADAPTER=postgres` | 一般的な公開運用。 |
| Cloudflare D1 | `DB_ADAPTER=d1` | D1 Proxy Workerを使う公開運用。 |
| ローカル保存 | `STORAGE_ADAPTER=local` | 開発、または単一サーバー。 |
| Cloudflare R2 | `STORAGE_ADAPTER=r2` | 複数サーバーや公開運用向け。 |

## おすすめの組み合わせ

| 場面 | DB | ファイル保存 |
|---|---|---|
| 手元で試す | `memory` | `local` |
| 一般的な公開運用 | `postgres` | `r2` |
| Cloudflare中心の運用 | `d1` | `r2` |

## ファイル保存の共通仕様

ローカル保存とR2では、次の動きが共通です。

- ファイルは `attachments/{ユーザーID}` のユーザー別領域へ保存します。
- すべてのファイル形式を保存できます。
- 画像はEXIFや位置情報を削除し、大きい場合は縮小・WebP圧縮します。
- 保存量は圧縮後のサイズで数えます。
- 1ユーザーの上限は初期設定で1 GBです。`STORAGE_USER_QUOTA_MB` または `storage.userQuotaMB` で変更できます。
- 設定画面から使用量、ファイル一覧、削除操作を確認できます。

> アダプターを増やす場合は、保存・削除・公開URL取得に加えて、使用量取得とファイル一覧取得も実装してください。

## 設定例

```bash
# 開発
DB_ADAPTER=memory
STORAGE_ADAPTER=local

# PostgreSQL + R2
DB_ADAPTER=postgres
DATABASE_URL='postgres://user:password@host:5432/nyaitter'
STORAGE_ADAPTER=r2
STORAGE_USER_QUOTA_MB=1024
```

秘密情報は `server/.env` またはデプロイ先のシークレット管理へ置きます。`config.json` やGitへ書き込まないでください。

## 関連文書

- [PostgreSQL のセットアップ](../help/database-postgres.md)
- [Cloudflare D1 と Worker](../help/database-d1-worker.md)
- [ローカルストレージ](../help/storage-local.md)
- [Cloudflare R2](../help/storage-r2.md)
