# PostgreSQL マイグレーション

このディレクトリには PostgreSQL 用のスキーマ変更SQLを置いています。`001_initial_schema.sql` が新規環境向けの初期スキーマで、その後のファイルが機能追加・インデックス・運用上の変更を適用します。

## 新規データベースへの適用

リポジトリのルートから、ファイル名の昇順で適用します。`ON_ERROR_STOP=1` を指定し、途中の失敗を見逃さないようにします。

```bash
for migration in server/migrations/*.sql; do
  echo "Applying $migration"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"
done
```

`DATABASE_URL` には対象環境の接続文字列を設定してください。新規DB・ステージングDBへ先に適用し、その後に本番へ反映します。

## 既存データベースへの適用

既存環境では、すでに実行した**ファイル名**をデプロイ記録や専用のマイグレーション管理表で管理し、未適用のファイルだけを順番に実行します。

> 現在のファイル名には `007_` と `008_` で始まるものが複数あります。番号だけでは一意に判別できないため、適用済みかどうかは必ず完全なファイル名で記録してください。

本番へ適用する前に、次を実施してください。

1. DBバックアップまたは復旧可能なスナップショットを作成する。
2. 同じデータ規模に近いステージング環境でSQLを実行する。
3. ロック時間、実行時間、エラー、ロールバック手順を確認する。
4. アプリケーションの互換リリースを先にデプロイする必要があるか確認する。

## 主な変更領域

| 領域 | 関連するファイル例 |
|---|---|
| 基本スキーマ | `001_initial_schema.sql` |
| プロフィール・検索・索引 | `002_add_user_profile_fields.sql`、`003_add_indexes_and_evolution.sql` |
| 通知・Push | `004_notification_open.sql`、`007_structured_notifications.sql`、`008_notification_clicked_state.sql`、Push購読関連 |
| Nyaitterアドレス・モデレーション | `005_nyaitter_address_v2.sql`、`009_user_moderation_state.sql` |
| 投稿公開範囲・検索性能 | `010_post_lock.sql`、`008_optimize_high_volume_post_reads.sql` |
| ログイン保護・DM・監査 | `012_login_security.sql`、`013_group_dms.sql`、`014_dm_e2e_keys.sql`、`015_audit_logs.sql` |
| ブロックリスト永続化 | `016_user_block_lists.sql`（`users.block` をJSONB配列として追加・既存値を正規化） |
| お知らせ・おすすめ・通報 | `017_post_announcements.sql`、`018_recommendation_candidate_index.sql`、`019_moderation_reports.sql` |
| 通知・審査・DM通報 | `020_notification_message.sql`、`021_moderation_appeals.sql`、`022_verification_applications.sql`、`023_dm_message_reports.sql` |

現在は `023_dm_message_reports.sql` が最新です。SQLファイルは変更履歴として扱います。すでに本番へ適用したファイルを直接書き換えず、追加の変更は新しいファイルとして作成してください。

## 新しいマイグレーションを追加する場合

- 既存ファイルと衝突しない、昇順で分かりやすいファイル名を付ける。
- 可能な限り後方互換な変更を段階的に行う。
- 大きいテーブルへのインデックス追加や列更新ではロック・実行時間を検証する。
- アプリケーションコード、D1スキーマ、運用ドキュメントへの影響を確認する。
- 適用手順と復旧手順をプルリクエストまたはデプロイ記録に残す。

D1を使う場合のマイグレーションは別管理です。`workers/d1-proxy/migrations/` と [`../../workers/d1-proxy/README.md`](../../workers/d1-proxy/README.md) を参照してください。
