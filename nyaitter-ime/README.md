# NyaitterIME（パッチ済みビルド）

`nyaitter-ime.min.js` は [NyaitterIME](https://github.com/nyaitter/NyaitterIME) の
`5578455f5acb6d0a580d0dfc56e1346671e8f698`（v0.1.2）に
`UPSTREAM.patch` を適用してビルドしたものです。

このディレクトリはサーバーが `/nyaitter-ime/` で配信する独立アセットです。
クライアントには同梱されず、クライアントは manifest の `nyaitter_ime`
（既定 `/nyaitter-ime/nyaitter-ime.min.js`）で参照します。

## 上流との差分

- ハイフンで区切った長音ローマ字（`ki-bo-do`）を 1 つの読みとして扱い、
  短い英語単語（`bo` / `do` / `me`）との誤判定を防ぎます。
- 英語のハイフン語（`e-mail`, `keyboard-shortcut`）は従来どおり保持します。
- 母音の重ね打ち（`kiiboodo`, `suupaa`）を辞書の長音表記（`きーぼーど`）へ
  フォールバックします。Mozc に完全一致がある語（`おおきい`）は変えません。
- 濁点・半濁点なしの読み（`てんふら`）を、完全一致が無い場合と、完全一致
  が人名など稀な語しかない場合（`あめた` → `雨だ`）に限り、濁点・半濁点
  を付け替えた読み（`てんぷら`）へフォールバックします。通常の語として
  完全一致がある語（`かんし`）は変えません。
- 英単語判定をローマ字列の内部一致に適用しないようにし、`kiiboodo` の
  `boo` のような部分一致が日本語変換を妨げないようにしました。
- `src/dictionary/supplements.js` に Mozc 由来辞書の補完データを追加しました
  （`うんち` が `運痴` になる問題を修正）。
- ローマ字として解釈できない英単語（子音クラスタで ASCII が残る `github` /
  `push` 等）は、文中の位置でも英単語として素通しします。従来は文の先頭・
  末尾でしか英単語と認めず、文中の語が断片化して化けていました。
- 変換ラティス内のラテン文字列・数字列に、外来語名詞（サ変）／数詞として
  の接続コストを持たせ、ラテン文字列の前後で文節を分断しないようにしま
  した。直前がラテン語でも文末の「した」が動詞として選ばれ、名詞の「下」
  へ化けません（空白・記号列は中立のままです）。
- ホスト側が `globalThis.NYAITTER_IME_DICTIONARY_URL` を設定すると、
  大きな辞書データを別 URL から読み込めます。ページ側は既存の固定 CDN URL を
  指定しています。

## 再ビルド

```bash
git clone https://github.com/nyaitter/NyaitterIME
cd NyaitterIME
git checkout 5578455f5acb6d0a580d0dfc56e1346671e8f698
git apply /path/to/UPSTREAM.patch
npm install
npm run build
```

生成物 `dist/nyaitter-ime.min.js` をこのディレクトリへコピーしてください。
`data/nyaitter-ime-core.bin.gz` は変更していないため同梱していません。

## ライセンス

NyaitterIME 本体は MIT License です。辞書などの第三者由来データについては
`THIRD_PARTY_NOTICES.md`、`LICENSE-MOZC`、`LICENSE-ESDB` を参照してください。
