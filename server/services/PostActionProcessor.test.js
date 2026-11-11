'use strict';

// 引用・リポストの通知仕様の回帰テスト。
// 仕様: 引用（repost_to + 本文あり）には通知自体が存在しない。
// 純粋なリポスト（repost_to + 本文なし）では、従来どおり元投稿の作者へ
// repost 通知が1件作られる。

const assert = require('node:assert/strict');
const { test } = require('node:test');
const InMemoryAdapter = require('../adapters/database/InMemoryAdapter');
const { processCreatePostAction } = require('./PostActionProcessor');

function makeContext(db, userId) {
  return {
    db,
    storage: undefined,
    realtime: undefined,
    autoModerationService: undefined,
    authRequest: { user: { id: userId }, headers: { cookie: '' } },
  };
}

// 通知は投稿処理の末尾で非同期に発火するため、着弾を待ってから一覧を返す。
async function settleNotifications(db, userId, expectedCount, timeoutMs = 3000) {
  const start = Date.now();
  for (;;) {
    const list = await db.getNotifications(userId, 50, 0);
    if (list.length >= expectedCount) return list;
    if (Date.now() - start > timeoutMs) return list;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function setup() {
  const db = new InMemoryAdapter();
  const author = await db.createUser({ name: 'author' });
  const actor = await db.createUser({ name: 'actor' });
  const original = await db.createPost({ userId: author.id, content: 'original post' });
  return { db, author, actor, original };
}

test('引用ポストでは元投稿の作者へ通知が作られない', async () => {
  const { db, author, actor, original } = await setup();
  const quote = await processCreatePostAction(makeContext(db, actor.id), {
    content: 'quote comment',
    repostTo: original.id,
  });
  assert.equal(Number(quote.repostTo ?? quote.repost_to), Number(original.id));
  assert.ok(quote.content, '引用ポストの本文が保存されていること');
  await settleNotifications(db, author.id, 1, 500);
  const notifications = await db.getNotifications(author.id, 50, 0);
  assert.equal(notifications.length, 0, '引用では通知が作られないこと');
});

test('純粋なリポストでは元投稿の作者へ repost 通知が1件作られる', async () => {
  const { db, author, actor, original } = await setup();
  const repost = await processCreatePostAction(makeContext(db, actor.id), {
    content: '',
    repostTo: original.id,
  });
  assert.equal(Number(repost.repostTo ?? repost.repost_to), Number(original.id));
  const notifications = await settleNotifications(db, author.id, 1);
  assert.equal(notifications.length, 1, 'リポスト通知が1件作られること');
  assert.equal(notifications[0].type, 'repost');
  assert.equal(Number(notifications[0].fromUserId), Number(actor.id));
});
