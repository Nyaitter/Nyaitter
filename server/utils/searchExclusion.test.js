'use strict';

// 検索除外（users.shadow）の検証。
// ・発見可能リストでは、除外した著者の投稿が「フォローしていない閲覧者」に
//   出ないこと（リポスト・引用経由でも同様）。
// ・PG の著者プロジェクションに shadow が含まれること。
// ・setUserStatus で shadow 未指定のときに既存の除外を上書きしないこと。

const assert = require('node:assert/strict');
const { test } = require('node:test');
const InMemoryAdapter = require('../adapters/database/InMemoryAdapter');
const PostgresAdapter = require('../adapters/database/postgres/PostgresAdapter');
const { filterDiscoverablePosts } = require('./postVisibility');

async function setup() {
  const db = new InMemoryAdapter();
  const author = await db.createUser({ name: 'shadowed' });
  const follower = await db.createUser({ name: 'follower' });
  const stranger = await db.createUser({ name: 'stranger' });
  const reposter = await db.createUser({ name: 'reposter' });
  await db.toggleFollow(follower.id, author.id);
  const post = await db.createPost({ userId: author.id, content: 'shadowed post' });
  const repost = await db.createPost({ userId: reposter.id, content: '', repostTo: post.id });
  const quote = await db.createPost({ userId: reposter.id, content: 'quote', repostTo: post.id });
  await db.setUserStatus(author.id, { shadow: true });
  return { db, author, follower, stranger, reposter, post, repost, quote };
}

test('検索除外した著者の投稿は未フォローの閲覧者の発見可能リストに出ない（リポスト・引用経由も）', async () => {
  const { db, follower, stranger, post, repost, quote } = await setup();
  const all = [post, repost, quote];

  const forStranger = await filterDiscoverablePosts(db, all, stranger.id);
  assert.deepEqual(forStranger.map((p) => p.id), [], '未フォローでは本人投稿・リポスト・引用すべて除外');

  const forAnonymous = await filterDiscoverablePosts(db, all, null);
  assert.deepEqual(forAnonymous.map((p) => p.id), [], '未ログインでも除外');

  const forFollower = await filterDiscoverablePosts(db, all, follower.id);
  assert.deepEqual(
    forFollower.map((p) => Number(p.id)).sort(),
    [post.id, repost.id, quote.id].map(Number).sort(),
    'フォロワーには従来どおり表示される',
  );
});

test('元投稿の取得自体が失敗した場合はリポストを通す（取得できて存在しない場合とは区別する）', async () => {
  const { db, stranger, repost } = await setup();
  const original = db.getPostsByIds.bind(db);
  db.getPostsByIds = async () => { throw new Error('transient failure'); };
  try {
    const result = await filterDiscoverablePosts(db, [repost], stranger.id);
    assert.deepEqual(result.map((p) => p.id), [repost.id], '取得失敗時は従来どおり通す');
  } finally {
    db.getPostsByIds = original;
  }
});

test('元投稿を確認できないリポストは発見可能リストに出ない', async () => {
  const { db, stranger, reposter } = await setup();
  const orphan = await db.createPost({ userId: reposter.id, content: '', repostTo: 999999 });
  const visible = await filterDiscoverablePosts(db, [orphan], stranger.id);
  assert.deepEqual(visible.map((p) => p.id), [], '元投稿が無いリポストは著者を確認できないため載せない');
});

test('検索除外を解除すると未フォローでも再び表示される', async () => {
  const { db, author, stranger, post, repost, quote } = await setup();
  await db.setUserStatus(author.id, { shadow: false });
  const visible = await filterDiscoverablePosts(db, [post, repost, quote], stranger.id);
  assert.equal(visible.length, 3);
});

function makePgStub() {
  const calls = [];
  const fullRow = {
    id: 7,
    auth_provider: 'local',
    external_id: null,
    name: 'pguser',
    scid: null,
    icon_data: null,
    bio: '',
    header_image: null,
    verify: false,
    admin: false,
    settings: {},
    block: [],
    shadow: true,
    created_at: new Date(),
  };
  const pool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/^\s*UPDATE users SET shadow/.test(sql)) return { rows: [{ shadow: params[1] }] };
      if (/SELECT shadow FROM users/.test(sql)) return { rows: [{ shadow: true }] };
      if (/FROM users/.test(sql)) return { rows: [fullRow] };
      return { rows: [] };
    },
  };
  const adapter = new PostgresAdapter({});
  adapter.pool = pool;
  return { adapter, calls };
}

test('PG の著者プロジェクションは shadow を含み、値が伝わる', async () => {
  const { adapter, calls } = makePgStub();
  const authors = await adapter.getPostAuthorsByIds([7]);
  assert.equal(authors.length, 1);
  assert.equal(authors[0].shadow, true);
  assert.ok(/shadow/.test(calls[0].sql), 'SELECT に shadow 列が含まれる');
});

test('PG の setUserStatus は shadow 未指定で既存の除外を上書きしない', async () => {
  const { adapter, calls } = makePgStub();
  const status = await adapter.setUserStatus(7, {});
  assert.deepEqual(status, { shadow: true }, '未指定では現状を返す');
  assert.equal(calls.filter((c) => /UPDATE/.test(c.sql)).length, 0, 'UPDATE は発行されない');

  const updated = await adapter.setUserStatus(7, { shadow: false });
  assert.deepEqual(updated, { shadow: false });
  assert.equal(calls.filter((c) => /UPDATE/.test(c.sql)).length, 1, '明示指定では UPDATE される');
});

test('PG の JOIN 取得ポストでも埋め込み著者に shadow が伝わり、除外が効く', async () => {
  const joinedRow = {
    id: 42,
    user_id: 7,
    content: 'joined post',
    created_at: new Date(),
    author_id: 7,
    author_name: 'pguser',
    author_scid: null,
    author_handle: null,
    author_icon_data: null,
    author_bio: '',
    author_header_image: null,
    author_verify: false,
    author_admin: false,
    author_settings: {},
    author_block: [],
    author_shadow: true,
    author_created_at: new Date(),
  };
  const pg = new PostgresAdapter({});
  pg.pool = {
    query: async (sql) => {
      assert.ok(/author_shadow/.test(sql), 'ポスト取得の SELECT に author_shadow が含まれる');
      return { rows: [joinedRow] };
    },
  };
  const post = await pg.getPostById(42);
  assert.equal(post.author.shadow, true, '埋め込み著者に shadow が伝わる');

  const db = new InMemoryAdapter();
  const stranger = await db.createUser({ name: 'joinstranger' });
  const visible = await filterDiscoverablePosts(db, [post], stranger.id);
  assert.deepEqual(visible, [], '埋め込み著者を優先する経路でも除外される');
});
