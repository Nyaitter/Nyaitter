# Cloudflare R2 のセットアップと運用

`R2StorageAdapter` は投稿添付などのファイルを Cloudflare R2 へ保存します。Node.js サーバーがS3互換APIを利用し、ブラウザへR2のアクセスキーを渡しません。

```text
ブラウザ → Nyaitter Node.js サーバー → Cloudflare R2
                         └→ 公開URL または 期限付き署名URL
```

## 配信方式

| 方式 | 設定 | 用途 |
|---|---|---|
| 公開ドメイン | `R2_PUBLIC_DOMAIN` を設定 | 公開添付をCDN経由で配信する |
| 署名URL | `R2_PUBLIC_DOMAIN` を設定しない | 非公開バケットのオブジェクトを期限付きで配信する |
| 直接アップロード | Worker等を別途構成 | 大容量・高頻度アップロードをサーバー帯域から切り離す |

公開ドメインを使う場合は、R2のカスタムドメインまたは公開ドメインを設定し、末尾のスラッシュを付けないベースURLを `R2_PUBLIC_DOMAIN` に指定します。オブジェクトキーはランダムかつ不変にし、同じキーの内容を後から差し替えない運用にしてください。

## 事前準備

1. CloudflareのR2で環境ごとのバケットを作成します。
2. 対象バケットだけに限定した S3 API トークンを作成します。
3. Access Key ID と Secret Access Key を、サーバーのシークレット管理または `server/.env` に保存します。

Secret Access Key は再表示できない場合があります。Git、チャット、クライアントコード、`server/config.json` に保存しないでください。

## サーバー設定

```env
STORAGE_ADAPTER=r2

R2_ACCOUNT_ID=<Cloudflare Account ID>
R2_BUCKET=nyaitter-uploads-prod
R2_ACCESS_KEY_ID=<S3 API Access Key ID>
R2_SECRET_ACCESS_KEY=<S3 API Secret Access Key>

# 公開配信する場合だけ指定
R2_PUBLIC_DOMAIN=https://media.example.com

# 任意の調整
R2_CACHE_CONTROL=public, max-age=31536000, immutable
R2_SIGNED_URL_CACHE_SECONDS=300
R2_RETRY_ATTEMPTS=2
R2_RETRY_BASE_DELAY_MS=120
R2_DELETE_CONCURRENCY=8
```

`STORAGE_ADAPTER` は `r2` または `cloudflare-r2` を受け付けます。未設定のR2認証情報や公開ドメインの誤りは、起動ログとステージング環境で確認してください。

## 移行と確認

ステージングバケットで先に確認し、アップロード、表示、削除、署名URL、有効期限切れ、添付付き投稿を一通り試してから本番へ切り替えます。既存のローカルファイルを移行する場合は、DBに保存されたファイルID・公開URLとの対応を計画し、ロールバック可能な状態で段階的に行ってください。

デプロイ後は次を確認します。

- 添付が意図した公開URLまたは署名URLで取得できる。
- 削除した添付がアプリ上から参照されない。
- 不正なMIMEタイプ・パス・所有者のファイルを操作できない。
- R2一時障害時に再試行・エラー記録が機能する。
- ブラウザ・CDNのキャッシュが更新不能な添付を誤って保持しない。

## 運用

R2の保存量、操作回数、エラー率を監視し、ライフサイクルルールとバックアップ方針を設定してください。署名URLを使う構成では、URLの有効期限とキャッシュ時間を利用者の期待とアクセス制御に合わせます。

R2はファイル保存先であり、投稿・DM・通知の可視性はサーバーAPIの共通ルールで制御します。公開URLを知っているだけでアクセスできる構成にする場合は、アップロード対象を公開前提のファイルに限定してください。

## 関連ドキュメント

- [ローカルストレージ](./storage-local.md)
- [Cloudflare と組み合わせる構成](./cloudflare-hybrid.md)
- [アダプターの設計と切り替え](./adapters-overview.md)
- [本番デプロイのチェックリスト](./production-checklist.md)
