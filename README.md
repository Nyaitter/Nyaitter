# Nyaitter

Nyaitter は、NyaXがベースのオープンソースScratcher向けSNSです。

- **NyaitterClient** … ブラウザ側の画面（`page/`）
- **NyaitterServer** … API と認証などのサーバー（`server/`）

## ライセンス

NyaitterClient および NyaitterServer は **MIT ライセンス** です。

クレジット（著作権表示）を残していれば、誰でも自由に利用・改変・再配布できます。  
詳細は同梱の `LICENSE` を見てください。

## クライアントについて

クライアントは [nyantorusabu/NyaX](https://github.com/nyantorusabu/NyaX) をベースにしています。

## クイックスタート

必要なもの: Node.js（目安として 18 以上）

```bash
# 1. 依存関係を入れる
npm install

# 2. サーバーを起動する（開発用）
npm run dev:server
```

ブラウザで http://localhost:3000/ を開きます。

開発時の初期設定では、データベースはメモリ上、ファイルはローカルフォルダに保存されます。  
本格運用の手順は `server/README.md` と `server/help/` を参照してください。

## 主な構成

| フォルダ | 内容 |
|----------|------|
| `page/` | フロントエンド（HTML / CSS / JS） |
| `server/` | Node.js サーバー（API・認証・アダプター） |
| `workers/` | Cloudflare D1 用の Worker（任意） |

## もう少し詳しく

- サーバーの起動・API・外部ログイン: `server/README.md`
- データベースやストレージの切り替え: `server/help/`
- 本番向けの確認項目: `server/help/production-checklist.md`
