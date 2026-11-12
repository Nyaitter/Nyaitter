'use strict';

// リポストの再発防止テスト。
// 純粋なリポストは posts 行の content が空・attachments が NULL でなければならず、
// 元投稿の本文・添付をコピーしてはならない（コピーするとクライアントが
// content の有無で判定するため引用ポストとして表示されてしまう）。
// 既存の壊れた行を戻す復旧 migration は、区別できない行を無理に戻すと
// 正当な引用を壊しうるため 2026-11-01 のユーザー判断で撤回された。
// その代わりに、前方修正（repostPost がコピーしないこと）をこのテストで固定する。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const InMemoryAdapter = require('./InMemoryAdapter');
const PostgresAdapter = require('./postgres/PostgresAdapter');

test('PostgresAdapter.repostPost は元本文・添付をコピーしない', async () => {
  const original = {
    id: 1,
    user_id: 10,
    content: 'original text',
    attachments: [{ file: 'a.png' }],
    mask: false,
    lock: false,
    repost_to: null,
  };
  const recorded = [];
  const client = {
    async query(sql, params) {
      recorded.push({ sql, params });
      const s = sql.trim().toUpperCase();
      if (s.startsWith('SELECT * FROM POSTS')) return { rows: [original] };
      if (s.startsWith('SELECT 1 FROM REPOSTS')) return { rows: [] };
      if (s.startsWith('INSERT INTO POSTS')) {
        const [userId, content, attachments, mask, lock, repostTo, now] = params;
        return {
          rows: [{
            id: 99,
            user_id: userId,
            content,
            attachments,
            mask,
            lock,
            repost_to: repostTo,
            created_at: now,
          }],
        };
      }
      return { rows: [] };
    },
    release() {},
  };
  const adapter = new PostgresAdapter({});
  adapter.pool = { async connect() { return client; } };

  const post = await adapter.repostPost(20, 1);

  const insert = recorded.find((r) => r.sql.trim().toUpperCase().startsWith('INSERT INTO POSTS'));
  assert.ok(insert, 'posts への INSERT が実行されること');
  const [, content, attachments, , , repostTo] = insert.params;
  assert.equal(content, '', 'リポスト行の content は空文字でなければならない');
  assert.equal(attachments, null, 'リポスト行の attachments は NULL でなければならない');
  assert.equal(repostTo, 1, 'repost_to には元投稿の id が入ること');
  assert.ok(
    recorded.some((r) => r.sql.trim().toUpperCase().startsWith('INSERT INTO REPOSTS')),
    'reposts テーブルにも記録されること',
  );
  assert.equal(post.content, '', '返却行の content も空であること');
  assert.equal(Number(post.repost_to ?? post.repostTo), 1);
});

test('InMemoryAdapter.repostPost は元本文・添付をコピーしない', async () => {
  const adapter = new InMemoryAdapter();
  const author = await adapter.createUser({ name: 'author' });
  const reposter = await adapter.createUser({ name: 'reposter' });
  const original = await adapter.createPost({
    userId: author.id,
    content: 'original text',
    attachments: [{ url: 'https://example.invalid/a.png' }],
  });

  const repost = await adapter.repostPost(reposter.id, original.id);

  assert.equal(repost.content, null, 'リポスト行の content は null（空）でなければならない');
  assert.equal(repost.attachments, null, 'リポスト行の attachments は NULL でなければならない');
  assert.equal(Number(repost.repostTo ?? repost.repost_to), Number(original.id));
  const stored = adapter.posts.get(repost.id);
  assert.equal(stored.content, null, '保存された行の content も空であること');
  assert.equal(stored.attachments, null, '保存された行の attachments も NULL であること');
});

test('D1 Proxy の repost ハンドラは元本文・添付をコピーしない', () => {
  // D1 Worker は Worker ランタイムと D1 バインディングがなければ実行できないため、
  // repost ハンドラの INSERT バインド値をソース契約として固定する。
  const source = fs.readFileSync(
    path.join(__dirname, '../../../workers/d1-proxy/src/index.js'),
    'utf8',
  );
  const repostHandler = source.slice(source.indexOf('/posts\\/(\\d+)\\/repost'));
  assert.ok(repostHandler.length > 0, 'repost ハンドラが存在すること');
  const insert = repostHandler.slice(
    repostHandler.indexOf('INSERT INTO posts'),
    repostHandler.indexOf('INSERT INTO posts') + 600,
  );
  assert.match(
    insert,
    /\.bind\(userId, '', null,/,
    "リポスト行の content は ''・attachments は null でバインドされること",
  );
  assert.doesNotMatch(
    insert,
    /original\.content|original\.attachments/,
    '元投稿の content / attachments をバインドしてはならない',
  );
});
