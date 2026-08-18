# ローカルストレージ

`local`は添付ファイルをServerのディスクへ保存します。開発または永続ディスクを持つ単一Serverで使います。

## 設定

```dotenv
STORAGE_ADAPTER=local
STORAGE_USER_QUOTA_MB=1024
```

保存先は`storage.local.uploadDir`で変更できます。既定値は`./uploads`です。

Serverからファイルを配信する場合は、Clientの`userFileEndpoint`とServerの`NYAITTER_USER_FILES_ENDPOINT`へ同じパスを設定します。

```js
// page/config.js
userFileEndpoint: '/uploads'
```

```dotenv
NYAITTER_USER_FILES_ENDPOINT=/uploads
```

`uploads/`はGitへ追加せず、公開運用では永続ボリュームとバックアップを用意します。

関連: [R2](./storage-r2.md) / [保存先の選び方](./adapters-overview.md)
