# Nyaitter

Nyaitter は、投稿・通知・メッセージを使えるSNSです。画面を表示するクライアント、Node.js サーバー、必要に応じて使うデータベースとファイル保存先で構成されています。

## できること

投稿、返信、引用、リポスト、いいね、スター、検索、フォロー、通知、グループDM、Push通知を使えます。画像を含むファイルを添付でき、画像はサーバー側でメタデータを削除してから保存します。

## フォルダの役割

| 場所 | 役割 |
|---|---|
| `page/` | ブラウザで表示する画面、PWA、サービスワーカー |
| `server/` | API、認証、投稿、DM、通知、リアルタイム配信 |
| `server/help/` | PostgreSQL、D1、R2、本番運用の説明 |
| `workers/d1-proxy/` | Cloudflare D1 を使う場合の Worker |

## ローカルで試す

Node.js **20.9.0 以上**を用意し、次を実行します。

```bash
npm install
cp server/.env.example server/.env
npm run dev:server
```

ブラウザで <http://localhost:3000/> を開きます。サーバーが起動しているかは <http://localhost:3000/server/health> で確認できます。

> 初期設定では、データはメモリに保存されます。サーバーを再起動すると投稿やユーザー情報は消えます。これはローカル開発用の動作です。

## ファイル保存

アップロードしたファイルはユーザーごとの保存領域に入ります。1ユーザー当たりの上限は初期設定で **1 GB** です。`server/config.json` の `storage.userQuotaMB`、または `STORAGE_USER_QUOTA_MB` でMB単位に変更できます。

1ファイルの入力上限は初期設定で **5 MB** です。画像はEXIFなどのメタデータを削除し、必要なら縮小・WebP圧縮してから保存します。画像以外のファイル形式も保存できます。

## 本番環境へ出す前に

本番では `InMemoryAdapter` を使わず、PostgreSQLまたはD1を設定してください。ファイル保存にはR2を推奨します。`DEV_BYPASS_AUTH=true` は認証を無効にする開発専用設定なので、公開環境では使わないでください。

詳しい手順は次の文書を参照してください。

- [サーバーの説明](./server/README.md)
- [保存先の選び方](./server/adapters/README.md)
- [セットアップ・運用ガイド](./server/help/README.md)
- [PostgreSQL マイグレーション](./server/migrations/README.md)
- [D1 Proxy Worker](./workers/d1-proxy/README.md)

## ライセンス

NyaitterClient と NyaitterServer は MIT ライセンスです。詳しくは `LICENSE` を確認してください。
