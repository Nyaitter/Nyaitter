# Cloudflare R2

`R2StorageAdapter` は、添付ファイルをCloudflare R2へ保存します。ブラウザへR2のアクセスキーは渡さず、NyaitterサーバーがR2と通信します。

```text
ブラウザ → Nyaitterサーバー → R2
```

## 用意するもの

1. R2バケット
2. そのバケットだけを操作できるS3 APIトークン
3. Access Key ID と Secret Access Key

鍵は `server/.env` またはデプロイ先のシークレット管理へ保存します。Git、クライアントコード、`config.json` へ書き込みません。

## 設定例

```env
STORAGE_ADAPTER=r2
STORAGE_USER_QUOTA_MB=1024

R2_ACCOUNT_ID=<CloudflareのアカウントID>
R2_BUCKET=nyaitter-uploads
R2_ACCESS_KEY_ID=<S3 API Access Key ID>
R2_SECRET_ACCESS_KEY=<S3 API Secret Access Key>

# 公開ドメインを使う場合だけ設定
R2_PUBLIC_DOMAIN=https://media.example.com
```

`R2_PUBLIC_DOMAIN` を設定すると公開URLで配信します。設定しない場合は、サーバーが期限付きの署名URLを使います。

## ファイルの扱い

- ファイルはユーザー別に保存されます。
- すべてのファイル形式を保存できます。
- 画像はEXIFや位置情報を削除し、必要に応じて縮小・WebP圧縮します。
- 初期設定では1ユーザー当たり1 GBまでです。`STORAGE_USER_QUOTA_MB` で変更できます。
- 設定画面から使用量、保存ファイル、削除操作を確認できます。

## 切り替える前の確認

ステージング環境で、アップロード、表示、削除、ファイル一覧、容量上限、公開URLまたは署名URLを確認してから本番へ切り替えてください。

公開URLを使う場合、そのURLを知る人がファイルへアクセスできる構成になることがあります。公開してよいファイルだけを置くか、署名URLの構成を選んでください。

- [ローカルストレージ](./storage-local.md)
- [Cloudflare構成](./cloudflare-hybrid.md)
- [本番デプロイのチェックリスト](./production-checklist.md)
