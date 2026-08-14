# Cloudflare R2 のセットアップと運用

投稿の添付ファイルなどを Cloudflare R2 に保存するための手順です。

## 全体の流れ

標準の構成では、Node.js サーバーが R2 に直接つなぎます。ブラウザに R2 の秘密鍵は渡しません。

```
ブラウザ → Nyaitter サーバー → Cloudflare R2
                ↓
         公開 URL または 署名付き URL → ブラウザ
```

| やり方 | おすすめ | 向いている場合 |
|--------|----------|----------------|
| サーバーから R2 に直接接続 | 標準・おすすめ | まずは安全に R2 へ移したい |
| 公開ドメインで配信 | おすすめ | 添付を公開し、CDN キャッシュを使いたい |
| 非公開 + 署名付き URL | 対応済み | 期限付き・限定公開にしたい |
| Worker で署名してブラウザから直接アップロード | 発展形 | 大容量・多いアップロード |

## 事前準備

- Cloudflare で R2 が使えること
- Node.js 18 以上
- 本番の秘密情報を安全に渡せる仕組みがあること

依存関係の例：

```bash
npm ci
# 必要なら
npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

## Cloudflare 側の準備

### 1. バケットを作る

ダッシュボードの R2 で、用途が分かる名前のバケットを作ります（例：`nyaitter-uploads-prod`）。

開発・ステージング・本番は別バケットにすると安全です。

### 2. API トークンを作る

R2 用の S3 互換 API トークンを作ります。

| 項目 | おすすめ |
|------|----------|
| 権限 | Object Read & Write |
| 対象 | Nyaitter 用バケットだけ |
| 名前 | `nyaitter-r2-prod` など |

表示された Access Key ID と Secret Access Key は、すぐに安全な場所へ移してください。Secret は再表示できません。Git やチャットに書かないでください。

## 公開配信か、署名付き URL か

| 方式 | 設定 | 意味 |
|------|------|------|
| 公開 | `R2_PUBLIC_DOMAIN=https://media.example.com` | URL を知っている人が見られる前提 |
| 非公開 | `R2_PUBLIC_DOMAIN` を設定しない | 期限付きの署名 URL を使う |

公開する場合は、ダッシュボードで公開ドメイン（またはカスタムドメイン）を設定し、`R2_PUBLIC_DOMAIN` には末尾スラッシュのないベース URL を書きます。

オブジェクトのキーはランダムで、キャッシュは長く設定されることが多いです。同じ URL の中身を後から差し替える運用には向きません。

## 環境変数の例

```env
STORAGE_ADAPTER=r2

R2_ACCOUNT_ID=あなたのアカウントID
R2_BUCKET=nyaitter-uploads-prod
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...

# 公開する場合だけ
R2_PUBLIC_DOMAIN=https://media.example.com

# 任意の調整
R2_CACHE_CONTROL=public, max-age=31536000, immutable
R2_SIGNED_URL_CACHE_SECONDS=300
R2_RETRY_ATTEMPTS=2
R2_RETRY_BASE_DELAY_MS=120
R2_DELETE_CONCURRENCY=8
```

`STORAGE_ADAPTER` は `r2` または `cloudflare-r2` で指定できます。

## 切り替えの進め方

1. ステージング用のバケットとトークンを用意する  
2. 環境変数を入れて起動し、ログに `Using R2StorageAdapter` が出ることを確認する  
3. アップロード・表示・削除を一通り試す  
4. 問題なければ本番用に同じ手順で切り替える  

本番で `DEV_BYPASS_AUTH=true` は絶対に使わないでください。

## 運用の注意

- 秘密鍵はコードやリポジトリに入れない
- 削除はオブジェクト単位で行われる（一括削除 API は使っていない）
- 障害時は一時的にローカルストレージに戻す、または前の設定に戻せるようにしておく

## 関連

- [ローカルストレージ](./storage-local.md)
- [ハイブリッド構成](./cloudflare-hybrid.md)
- [アダプター概要](../adapters/README.md)
