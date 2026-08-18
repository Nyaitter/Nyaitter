# 本番チェックリスト

## 公開前

- [ ] `NODE_ENV=production`を設定した。
- [ ] `DEV_BYPASS_AUTH`を有効にしていない。
- [ ] 信頼できるリバースプロキシの背後でだけ`TRUST_PROXY=true`を設定した。
- [ ] ClientのオリジンをCORS許可設定へ追加した。
- [ ] 永続DBとして`postgres`または`d1`を設定した。
- [ ] DB・R2・D1・VAPID・外部APIの秘密情報をシークレット管理へ置いた。
- [ ] DBのバックアップを取り、`npm run migrate`を実行した。
- [ ] ファイル保存先と`STORAGE_USER_QUOTA_MB`を設定した。
- [ ] Push通知を使う場合はVAPID設定を保存した。

## 公開後

- [ ] `/server/health`と`/server/ready`が成功する。
- [ ] ログイン、投稿、検索、添付、通知、DM、リアルタイム接続が動作する。
- [ ] 非公開投稿、検索除外、ブロック関係が期待どおりに制限される。
- [ ] レート制限が有効である。
- [ ] DB・ストレージ・Workerのエラーと容量を監視する。

## 継続運用

- [ ] 移行前にバックアップを取り、ステージングで確認する。
- [ ] DBとファイル保存の復旧手順を定期的に確認する。
- [ ] 秘密情報を定期的に更新し、漏えい時に失効できるようにする。

関連: [PostgreSQL](./database-postgres.md) / [D1とWorker](./database-d1-worker.md) / [R2](./storage-r2.md)
