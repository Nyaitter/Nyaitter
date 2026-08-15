# ローカルストレージの使い方

`LocalStorageAdapter` は添付ファイルをサーバーのローカルディスクへ保存します。開発・テスト・単一サーバーでの小規模運用には便利ですが、複数台構成や長期運用では R2 などのオブジェクトストレージを推奨します。

## 用途と制約

| 用途 | 適性 | 注意点 |
|---|---|---|
| ローカル開発 | 適している | サーバー再作成・コンテナ再作成時のデータ消失に注意 |
| CI・自動テスト | 適している | テスト終了後に一時ファイルを削除する |
| 単一サーバーの小規模運用 | 条件付き | 永続ボリューム、バックアップ、容量監視が必要 |
| 複数アプリサーバー | 適していない | 各サーバーのディスク内容が分離する |

## 設定

`server/config.json` の既定値はローカルストレージです。環境変数で明示する場合は次のように設定します。

```env
STORAGE_ADAPTER=local
```

保存先は `server/config.json` の `storage.local.uploadDir` で設定します。相対パスはサーバープロセスの作業ディレクトリを基準に解決されます。

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

保存先ディレクトリは必要に応じてアダプターが作成します。コンテナやPaaSでは、書き込み可能かつ再起動後も保持されるボリュームを明示的に設定してください。

## 公開URL

ローカルストレージで保存したファイルはサーバーが `/uploads/*` として静的配信します。例えば `attachments/example.png` は通常 `/uploads/attachments/example.png` として参照されます。

アップロードディレクトリは `page/` の外側に置き、ユーザーが任意のアプリケーション資産を上書きできないようにしてください。ファイル名・パスはアダプターの安全なキー生成と検証を通して扱い、任意パスをそのまま公開URLへ連結しないでください。

## コードからの利用

ルート・サービスでは、`req.app.locals.storageAdapter` を通じて操作します。

```js
const storage = req.app.locals.storageAdapter;

const uploaded = await storage.upload({
  file: buffer,
  fileName: 'photo.png',
  contentType: 'image/png',
  folder: 'attachments',
});

await storage.delete(uploaded.id);
await storage.deleteMany(['attachments/unused.png']);
```

アプリケーションコードから特定の保存先の絶対パスに依存しないでください。同じコードを R2 へ切り替えられるよう、保存・削除・公開URL取得はアダプターのメソッドを使います。

## 開発時の整理

`uploads/` は生成物として `.gitignore` に含めることを推奨します。開発データを削除する場合は、運用中のプロセスが参照していないことを確認してから対象ディレクトリだけを消去します。

```bash
rm -rf uploads/attachments/* uploads/icons/* uploads/tmp/*
```

## 実運用で使う場合

ローカルストレージを使い続ける場合は、永続ディスク、ディスク容量監視、定期バックアップ、復旧手順、CDNまたはリバースプロキシのキャッシュ方針を用意してください。複数サーバー構成へ移行する予定がある場合は、早い段階でR2など共有可能なオブジェクトストレージへ移行する方が安全です。

## 関連ドキュメント

- [Cloudflare R2 ストレージ](./storage-r2.md)
- [Cloudflare と組み合わせる構成](./cloudflare-hybrid.md)
- [アダプターの設計と切り替え](./adapters-overview.md)
- [本番デプロイのチェックリスト](./production-checklist.md)
