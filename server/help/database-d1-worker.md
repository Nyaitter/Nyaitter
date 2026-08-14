# Cloudflare D1 と Worker のセットアップ

Nyaitter の Node.js サーバーから、Worker 経由で Cloudflare D1 を使う手順です。

## 全体のイメージ

```
ブラウザ → Nyaitter サーバー → Cloudflare Worker（D1 プロキシ） → D1
```

ブラウザが D1 や Worker に直接つなぐ設計ではありません。Node 側だけが、秘密のトークン付きで Worker を呼びます。

Worker に公開するのは「アプリが必要な操作だけ」にしてください。自由な SQL を受け付けると危険です。固定の SQL とパラメータバインドを使います。

| 使い方 | おすすめ | 向いている場合 |
|--------|----------|----------------|
| PostgreSQL が主、D1 が補助 | 最初はこちら | キャッシュや実験的な機能 |
| D1 を主のデータベースにする | 上級者向け | Cloudflare 中心で運用する |

PostgreSQL 用の SQL をそのまま D1 に流すことはできません。D1（SQLite 系）用に別のスキーマを用意します。

## 導入前に決めること

- どのデータの「正」が D1 か、PostgreSQL か（機能ごとに1つに決める）
- Worker は Node サーバーだけが呼ぶこと
- 認証方法（最低でも長いランダムな Bearer トークン）
- D1 用のスキーマとマイグレーションの管理方法
- 障害時にどう戻すか

## D1 データベースを作る

```bash
npx wrangler d1 create nyaitter-d1-prod
npx wrangler d1 create nyaitter-d1-stg
```

出力された `database_id` を控えます。環境ごとに名前を分けてください。

## Worker の用意

プロジェクト内の `workers/d1-proxy/` を使うか、同様の Worker を用意します。

`wrangler.toml` の例：

```toml
name = "nyaitter-d1-proxy-prod"
main = "src/index.js"
compatibility_date = "2026-08-14"

[[d1_databases]]
binding = "DB"
database_name = "nyaitter-d1-prod"
database_id = "<取得したdatabase_id>"
migrations_dir = "migrations"
```

認証用のシークレット：

```bash
npx wrangler secret put AUTH_TOKEN
```

マイグレーションとデプロイ：

```bash
npm run migrate:local    # ローカル
npm run migrate:remote   # 本番向け
npm run deploy
```

## Node 側の設定

```env
DB_ADAPTER=d1
D1_WORKER_URL=https://nyaitter-d1-proxy.あなたのサブドメイン.workers.dev
D1_WORKER_TOKEN=<AUTH_TOKENと同じ値>
```

`AUTH_TOKEN` が未設定のとき、Worker はすべて拒否する設計です（安全側に倒す）。

## スキーマの注意

PostgreSQL の次のようなものは、そのままでは使えません。

| PostgreSQL | D1 での例 |
|------------|-----------|
| JSONB | TEXT に JSON 文字列 |
| TIMESTAMPTZ | ISO 文字列や UNIX 時刻の整数 |
| SERIAL | INTEGER PRIMARY KEY など |
| 配列型 | 中間テーブル |
| 一部の拡張機能 | SQLite の機能やアプリ側で代替 |

D1 用の SQL は `workers/d1-proxy/migrations/` 側で管理します。

## 運用のポイント

- Worker と Node のリリースは別々に検証する
- 破壊的なスキーマ変更は避け、段階的に進める
- ログとエラー率を見て、必要なら PostgreSQL に戻せるようにしておく

詳細な API 一覧や実装の中身は、`workers/d1-proxy/README.md` も参照してください。

## 関連

- [Worker の README](../../workers/d1-proxy/README.md)
- [PostgreSQL のセットアップ](./database-postgres.md)
- [ハイブリッド構成](./cloudflare-hybrid.md)
