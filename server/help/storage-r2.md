# Cloudflare R2

`r2`は添付ファイルをCloudflare R2へ保存します。R2のアクセスキーはNyaitter Serverだけが使います。

## 設定

```dotenv
STORAGE_ADAPTER=r2
STORAGE_USER_QUOTA_MB=1024
R2_ACCOUNT_ID=<account-id>
R2_BUCKET=nyaitter-uploads
R2_ACCESS_KEY_ID=<access-key-id>
R2_SECRET_ACCESS_KEY=<secret-access-key>
R2_PUBLIC_DOMAIN=https://media.example.com
```

`R2_PUBLIC_DOMAIN`を設定すると公開URLを使います。設定しない場合はServerが期限付きURLを使います。

公開ドメインから直接配信する場合は、Clientの`userFileEndpoint`にも同じURLを設定します。

```js
// page/config.js
userFileEndpoint: 'https://media.example.com'
```

関連: [ローカルストレージ](./storage-local.md) / [Cloudflare構成](./cloudflare-hybrid.md)
