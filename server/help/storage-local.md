# ローカルストレージの使い方

ファイルをサーバーのディスクに保存する `LocalStorageAdapter` の説明です。

## 向いている用途

- 開発・テストでのアップロード確認
- 小さな単一サーバーでの簡易保存
- CI での一時ファイル

本番で長く使う場合は、Cloudflare R2 などオブジェクトストレージへの移行を強くおすすめします。

## 基本設定

### config.json

```json
{
  "storage": {
    "adapter": "local",
    "local": {
      "uploadDir": "./uploads"
    }
  }
}
```

### 環境変数

```env
STORAGE_ADAPTER=local
```

細かいパスは `config.json` の `local` で管理する方が分かりやすいです。

### フォルダを用意する

起動時に自動作成されますが、先に作っておくと安心です。

```bash
mkdir -p uploads/attachments uploads/icons uploads/tmp
```

## ブラウザから見られるようにする

アップロードしたファイルは、Express で静的配信する必要があります。`server/index.js` では次のような設定がされています。

- `/uploads` で `uploadDir` の中身を公開
- キャッシュや etag を有効にする

これで `/uploads/attachments/xxxx.png` のような URL でアクセスできます。

### セキュリティの注意

- アップロード用フォルダは `page/` の外に置く
- 実行できる種類のファイル（.php など）を配信しないよう、必要なら拡張子を制限する
- 本番では可能なら R2 などに移す

## コードからの使い方

```js
const storage = req.app.locals.storageAdapter;

const result = await storage.upload({
  file: buffer,
  fileName: 'photo.png',
  contentType: 'image/png',
  folder: 'attachments',
});

// result.id  … "attachments/abc123.png" のような識別子
// result.url … "/uploads/attachments/abc123.png"

await storage.delete(result.id);

await storage.deleteMany([
  'attachments/abc123.png',
  'icons/user-456.jpg',
]);
```

## おすすめのフォルダ分け

```
uploads/
├── attachments/   # 投稿の添付
├── icons/         # アイコン
├── tmp/           # 一時ファイル（定期削除対象）
└── exports/       # エクスポートなど
```

`folder` を指定すると、その下に自動でサブフォルダが作られます。

## 開発時のヒント

`.gitignore` に次を入れておくと便利です。

```gitignore
uploads/
!uploads/.gitkeep
```

中身を消したいとき：

```bash
rm -rf uploads/attachments/* uploads/icons/* uploads/tmp/*
```

## 本番で使う場合の注意（おすすめはしない）

どうしても使う場合：

- `/uploads` を定期バックアップする
- ディスク容量を監視する
- 複数サーバーにするなら共有ディスクが必要
- できれば CDN を前に置く

長期的には次への移行を検討してください。

- Cloudflare R2（おすすめ）
- AWS S3
- Google Cloud Storage
- MinIO など社内の S3 互換

## 困ったとき

| 症状 | 確認すること |
|------|----------------|
| ファイルが保存されない | `uploadDir` の書き込み権限、コンテナならボリューム設定 |
| ブラウザで 404 | `/uploads` の静的配信設定、パスが正しいか |
| ディスクがいっぱい | `tmp/` の定期削除、または最初からオブジェクトストレージを使う |

## 関連

- [R2 ストレージ](./storage-r2.md)（本番向け）
- [ハイブリッド構成](./cloudflare-hybrid.md)
- [アダプター概要](../adapters/README.md)
