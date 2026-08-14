# PostgreSQL のセットアップ

Nyaitter サーバーで PostgreSQL を使うときの手順です。Worker を併用する構成にも触れます。

## どんな構成がいいか

| 構成 | おすすめ度 | 向いている場合 |
|------|------------|----------------|
| Node.js + PostgreSQL だけ | とてもおすすめ | 自前サーバーや VPS で完結させたい |
| Node.js + PostgreSQL + Worker（D1/R2） | おすすめ | 将来 Cloudflare も使いたい |
| Node.js + D1（Worker 経由）だけ | やや低い | Cloudflare だけに寄せたいとき |

このガイドでは「PostgreSQL だけ」を中心に説明します。

## PostgreSQL だけ使う場合

### 1. パッケージを入れる

```bash
npm install pg
```

### 2. データベースを作る

```sql
CREATE DATABASE nyaitter;
```

### 3. スキーマを入れる

`server/migrations/` にある SQL を順番に実行します。最初は `001_initial_schema.sql` です。

```bash
psql -U ユーザー名 -d nyaitter -f server/migrations/001_initial_schema.sql
```

本番では、マイグレーション用のツール（node-pg-migrate など）の利用を推奨します。

### 4. 設定する

**環境変数（簡単）**

```env
DB_ADAPTER=postgres
DATABASE_URL="postgres://nyaitter:password@localhost:5432/nyaitter?sslmode=disable"
```

**config.json でも可**

```json
{
  "database": {
    "adapter": "postgres",
    "postgres": {
      "connectionString": "postgres://nyaitter:password@localhost:5432/nyaitter",
      "poolSize": 15,
      "ssl": false
    }
  }
}
```

本番では `DATABASE_URL` を使うのが一般的です。

### 5. SSL（本番向け）

Render、Neon、AWS RDS などでは SSL が必要なことが多いです。

```env
DATABASE_URL="postgres://user:pass@host:5432/db?sslmode=require"
```

または config で `"ssl": true` を指定します。

### 6. 接続確認

サーバーを起動して、次のようなログが出れば成功です。

```
[adapters] Using PostgresAdapter
[PostgresAdapter] Connected to PostgreSQL
```

## Worker を併用する場合

PostgreSQL をメインのデータベースにし、Cloudflare（D1・R2 など）を足す構成です。

```
ブラウザ
  ↓
Node.js サーバー
  ├── PostgreSQL（ユーザー・投稿・DM などの本データ）
  └── Cloudflare Worker
        ├── D1（補助データ）
        ├── R2（ファイル）
        └── その他
```

向いている場合：

- 将来 R2 を本格利用したい
- エッジでの処理やグローバルな制限を試したい
- Cloudflare に少しずつ移したい

ポイント：

1. データベースはこれまでどおり PostgresAdapter
2. ファイルは R2StorageAdapter
3. 必要なら D1Adapter を追加で使う

Worker の詳細は [D1 と Worker のガイド](./database-d1-worker.md) を見てください。

## 本番運用のヒント

- 接続プールのサイズは、CPU コア数の 2〜4 倍程度を目安に
- サーバーは終了信号を受けたとき、プールをきちんと閉じる
- 遅いクエリのログや、接続数の監視を入れると安心
- バックアップは `pg_dump` の定期実行か、マネージドサービスの機能を使う

## 困ったとき

| 症状 | 確認すること |
|------|----------------|
| relation does not exist | スキーマ（テーブル）が入っていない。SQL を実行する |
| SSL 関連のエラー | 接続文字列に `sslmode=require` を付ける、または `ssl: true` |
| 接続が足りなくなる | `poolSize` を増やすか、接続の取りっぱなしがないか調べる |

## 関連

- [アダプターの概要](../adapters/README.md)
- [R2 ストレージ](./storage-r2.md)
- [D1 と Worker](./database-d1-worker.md)
