# ローカルストレージ

`local`は添付ファイルをServerのディスクへ保存します。開発または永続ディスクを持つ単一Serverで使います。

## 設定

```dotenv
STORAGE_ADAPTER=local
STORAGE_USER_QUOTA_MB=1024
```

保存先は`storage.local.uploadDir`で変更できます。既定値は`./uploads`です。

Serverからの配信は、既定で設定済みAPIエンドポイント配下の`/uploads`を使います。Clientの`userFileEndpoint`を`null`のままにすると、同じURLを自動で導出します。

```js
// page/config.js
userFileEndpoint: null
```

別の公開先を使う場合だけ、Clientの`userFileEndpoint`とServerの`NYAITTER_USER_FILES_ENDPOINT`へ同じパスを設定します。`NYAITTER_USER_FILES_PORT`で専用ポートを使う場合、Serverの既定公開パスはAPIエンドポイントを使わない`/uploads`になり、Clientにはその専用ポートの絶対URLを設定します。

```dotenv
NYAITTER_USER_FILES_ENDPOINT=/server/uploads
NYAITTER_USER_FILES_PORT=3001
```

`uploads/`はGitへ追加せず、公開運用では永続ボリュームとバックアップを用意します。

関連: [R2](./storage-r2.md) / [保存先の選び方](./adapters-overview.md)
