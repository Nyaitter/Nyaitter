# Cloudflare と組み合わせる構成

Nyaitter は Node.js サーバーを API の窓口とし、データベース・ファイル保存をアダプター経由で接続します。Cloudflare を導入する場合も、ブラウザは Node.js サーバーの API を利用し、秘密情報を持つ接続はサーバー側へ閉じます。

## 基本構成

```text
ブラウザ
  │ HTTPS / WebSocket
  ▼
Nyaitter Node.js サーバー
  ├── PostgreSQL または D1 Proxy Worker
  ├── R2（添付ファイル）
  └── Web Push / 外部認証先
```

| 領域 | 推奨する役割 |
|---|---|
| ユーザー、投稿、DM、通知 | PostgreSQL を主DBにするか、D1 Proxy Worker経由のD1に統一する |
| 添付ファイル | R2 |
| エッジ処理 | Cloudflare Worker。D1アクセスや将来の直接アップロードを必要な範囲で担当 |
| 静的クライアント資産 | Node.js 配信の前段CDN、またはデプロイ構成に応じた静的配信 |

## 段階的な導入

### 1. PostgreSQL とローカルストレージで開発する

`DB_ADAPTER=postgres` と `STORAGE_ADAPTER=local` を使い、機能・マイグレーション・バックアップを安定させます。ローカルストレージは単一サーバーの開発用途に限定し、実運用の永続ファイル保存には使わないことを推奨します。

### 2. 添付ファイルを R2 へ移す

`STORAGE_ADAPTER=r2` と R2 の接続情報を設定します。R2 の公開ドメインを使う場合、オブジェクトキーは変更しない前提で長期キャッシュを設定できます。非公開バケットではサーバーが署名URLを発行します。

### 3. D1 Proxy Worker を導入する

D1 を利用する場合、Node.js サーバーは `D1Adapter` を通じて認証済み Worker だけを呼びます。

```text
Node.js サーバー -- Bearer トークン --> D1 Proxy Worker --> Cloudflare D1
```

`AUTH_TOKEN` は Worker のシークレットと Node 側の `D1_WORKER_TOKEN` で一致させます。ブラウザから Worker に自由なSQLや認証トークンを送る構成にはしません。

### 4. 必要に応じてエッジ処理を拡張する

Worker の役割は段階的に増やします。たとえばD1プロキシ、R2の直接アップロード用署名、エッジ側のレート制限などです。Node.js の主API、認証、可視性ルールを一度に移行する必要はありません。

## 運用上の判断

| 判断 | 指針 |
|---|---|
| 主データの正本 | 機能ごとに PostgreSQL または D1 のどちらか一方を正本として決める |
| リリース順 | Worker・DBマイグレーション・Node.js の互換性を段階的に確認する |
| 秘密情報 | D1/R2 のトークンはWorkerシークレット、サーバー環境変数、デプロイ先のシークレット管理にのみ置く |
| キャッシュ | クライアント資産は再検証可能なキャッシュ、投稿・DM・通知はAPIの可視性規則を優先する |
| 障害対応 | R2/D1接続失敗時のログ、再試行、バックアップ、ロールバック手順を事前に用意する |

## 関連ドキュメント

- [Cloudflare D1 と Worker](./database-d1-worker.md)
- [Cloudflare D1 Proxy Worker](../../workers/d1-proxy/README.md)
- [Cloudflare R2 ストレージ](./storage-r2.md)
- [PostgreSQL のセットアップ](./database-postgres.md)
- [本番デプロイのチェックリスト](./production-checklist.md)
