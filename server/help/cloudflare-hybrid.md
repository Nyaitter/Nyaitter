# Cloudflare と組み合わせる構成

Nyaitter では、Node.jsサーバーがAPIと認証を担当します。Cloudflareを使う場合も、ブラウザはNode.jsサーバーへ接続し、D1やR2の鍵をブラウザへ渡しません。

## 構成のイメージ

```text
ブラウザ
  ↓ HTTPS / WebSocket
Nyaitter Node.js サーバー
  ├─ PostgreSQL または D1 Proxy Worker
  └─ R2（添付ファイル）
```

## 段階的に導入する

| 段階 | 設定 | 内容 |
|---|---|---|
| 1 | `memory` + `local` | 手元で機能を試します。データは再起動で消えます。 |
| 2 | `postgres` + `r2` | DBとファイル保存を分ける、分かりやすい公開構成です。 |
| 3 | `d1` + `r2` | D1 Proxy Workerを通してCloudflare D1を使います。 |

## R2を使う

添付ファイルをR2へ保存する場合は、Node.jsサーバーへR2の接続情報を設定します。

```bash
STORAGE_ADAPTER=r2
STORAGE_USER_QUOTA_MB=1024
```

ファイルはユーザーごとに管理されます。画像はEXIFを削除してから保存され、初期設定では1ユーザー当たり1 GBまでです。

## D1を使う

D1はNode.jsサーバーから直接ではなく、D1 Proxy Workerを通して使います。

```text
Node.js サーバー → Bearerトークン → D1 Proxy Worker → Cloudflare D1
```

Workerの `AUTH_TOKEN` とNode.js側の `D1_WORKER_TOKEN` は同じ値にします。ブラウザからWorkerへDBトークンやSQLを送る構成にはしません。

## 運用時の注意

- DBとストレージを切り替える前にバックアップを取ります。
- Worker、D1マイグレーション、Node.jsの更新は順番に確認します。
- R2/D1の鍵は `.env` またはデプロイ先のシークレット管理に置き、Gitへ追加しません。
- 投稿・DM・通知は利用者ごとに見える内容が変わるため、キャッシュ設定は慎重に行います。

## 関連文書

- [D1 と Worker](./database-d1-worker.md)
- [D1 Proxy Worker](../../workers/d1-proxy/README.md)
- [Cloudflare R2](./storage-r2.md)
- [PostgreSQL](./database-postgres.md)
- [本番デプロイのチェックリスト](./production-checklist.md)
