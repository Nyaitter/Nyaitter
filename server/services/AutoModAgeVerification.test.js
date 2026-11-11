'use strict';

// AutoMod 年齢確認システム（AUTOMOD_MODE v2）の検証。
// (a) off で評価が走らない (b) legacy で年齢系が不変 (c) v2 の年齢ラベル処理
// (d) 投稿者年齢の集約（最小サンプル・非対称） (e) serialize の閲覧者差。

const assert = require('node:assert/strict');
const { test } = require('node:test');
const InMemoryAdapter = require('../adapters/database/InMemoryAdapter');
const { AutoModerationService, parseClassification } = require('./AutoModerationService');
const { aggregateAuthorAge, nextAgeEstimate } = require('./AgeEstimateService');
const { serializePostsBatch, serializePost, serializeReply } = require('../utils/serialize');

function makeService(db, { mode = 'v2', respond = '<safe>', authorAge = true } = {}) {
  const calls = { count: 0 };
  const aiService = {
    generate: async () => {
      calls.count += 1;
      return typeof respond === 'function' ? respond() : respond;
    },
  };
  const service = new AutoModerationService({
    dbAdapter: db,
    storageAdapter: undefined,
    moderationConfig: { enabled: true, prompt: '基準', provider: 'mock', model: 'mock', mode, authorAge },
    ageVerifyConfig: { margin: 5, unknown: 'warn', postMinSamples: 5 },
    aiService,
  });
  return { service, calls };
}

async function moderate(service, db, postId) {
  const post = await db.getPostById(postId);
  service.enqueue(post);
  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (!service.processing && service.queue.length <= service.queueHead) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('moderation did not settle');
}

async function setup() {
  const db = new InMemoryAdapter();
  const author = await db.createUser({ name: 'author' });
  return { db, author };
}

test('(c) parseClassification は3出力を取り、欠落ラベルは null', () => {
  assert.deepEqual(parseClassification('<safe> <age:18> <author:13-15>'), { level: 1, ageRating: 18, authorAgeBand: '13-15' });
  assert.deepEqual(parseClassification('<low>'), { level: 2, ageRating: null, authorAgeBand: null });
  assert.deepEqual(parseClassification('<middle> <age:all> <author:unknown>'), { level: 3, ageRating: 0, authorAgeBand: null });
  // 違反ラベル欠落時は従来どおり safe 扱い。年齢系だけが null（＝変更なし）になる。
  assert.deepEqual(parseClassification('ラベルなし'), { level: 1, ageRating: null, authorAgeBand: null });
});

test('(a) off では評価が一切走らず投稿も変わらない', async () => {
  const { db, author } = await setup();
  const post = await db.createPost({ userId: author.id, content: 'post' });
  const { service, calls } = makeService(db, { mode: 'off', respond: '<high> <age:18> <author:13-15>' });
  assert.equal(service.enabled, false);
  assert.equal(service.enqueue(post), false);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls.count, 0);
  const after = await db.getPostById(post.id);
  assert.equal(after.mask, false);
  assert.equal(after.lock, false);
  assert.equal(after.age_rating, 0);
});

test('(b) legacy では違反側だけが動き、年齢系の列は変わらない', async () => {
  const { db, author } = await setup();
  const { service, calls } = makeService(db, { mode: 'legacy', respond: '<low> <age:18> <author:13-15>' });
  for (let i = 0; i < 3; i += 1) {
    const post = await db.createPost({ userId: author.id, content: `post ${i}` });
    await moderate(service, db, post.id);
    const after = await db.getPostById(post.id);
    assert.equal(after.mask, true, 'V1 の mask は従来どおり付く');
    assert.equal(after.age_rating, 0, 'legacy では age_rating は変わらない');
  }
  assert.equal(calls.count, 3);
  const user = await db.getUserById(author.id);
  assert.equal(user.age_estimate, null, 'legacy では推定年齢は付かない');
  assert.equal(user.age_samples, 0);
});

test('(c) v2 は対象年齢を保存し、欠落時は不変、再評価で下降もできる', async () => {
  const { db, author } = await setup();
  const post = await db.createPost({ userId: author.id, content: 'post' });

  const first = makeService(db, { respond: '<safe> <age:18>' });
  await moderate(first.service, db, post.id);
  assert.equal((await db.getPostById(post.id)).age_rating, 18);

  const notifications = await db.getNotifications(author.id, 50, 0);
  assert.ok(
    notifications.some((n) => n.type === 'auto_moderation' && String(n.message || '').includes('対象年齢18歳以上')),
    '対象年齢が付いたことが投稿者へ通知される',
  );

  const missing = makeService(db, { respond: '<safe>' });
  await moderate(missing.service, db, post.id);
  assert.equal((await db.getPostById(post.id)).age_rating, 18, '年齢ラベル欠落時は age_rating 不変');

  const lower = makeService(db, { respond: '<safe> <age:12>' });
  await moderate(lower.service, db, post.id);
  assert.equal((await db.getPostById(post.id)).age_rating, 12, '編集再評価では下がる方向の更新も可');
});

test('(d) 集約は最小サンプル未満で反映せず、非対称に動く', async () => {
  const { db, author } = await setup();
  const postIds = [];
  for (let i = 0; i < 12; i += 1) {
    const post = await db.createPost({ userId: author.id, content: `p${i}` });
    postIds.push(post.id);
  }
  for (let i = 0; i < 4; i += 1) {
    await aggregateAuthorAge(db, author.id, postIds[i], '13-15', { minSamples: 5 });
  }
  let user = await db.getUserById(author.id);
  assert.equal(user.age_estimate, null, '5サンプル未満では反映しない');
  assert.equal(user.age_samples, 4);

  await aggregateAuthorAge(db, author.id, postIds[4], '13-15', { minSamples: 5 });
  user = await db.getUserById(author.id);
  assert.equal(user.age_estimate, 14, '帯の代表値（中央値）が反映される');
  assert.equal(user.age_source, 'post');

  // 高い帯へは遅く動く: 14 → 29 方向は差の2割（3）まで。
  await db.updateUserAgeEstimate(author.id, { ageEstimate: 14, ageSource: 'post', ageSamples: 5 });
  for (let i = 5; i < 10; i += 1) {
    await aggregateAuthorAge(db, author.id, postIds[i], '25-34', { minSamples: 5 });
  }
  user = await db.getUserById(author.id);
  assert.ok(user.age_estimate > 14 && user.age_estimate <= 17, `高い帯へは小さく動く (actual: ${user.age_estimate})`);

  // 若い帯へは速く動く: 29 → 11 方向は差の半分（9）まで。
  await db.updateUserAgeEstimate(author.id, { ageEstimate: 29, ageSource: 'post', ageSamples: 5 });
  await aggregateAuthorAge(db, author.id, postIds[10], 'under13', { minSamples: 5 });
  await aggregateAuthorAge(db, author.id, postIds[11], 'under13', { minSamples: 5 });
  user = await db.getUserById(author.id);
  assert.ok(user.age_estimate <= 24, `若い帯へは大きく動く (actual: ${user.age_estimate})`);
});

test('(d) 推定は投稿内容のみから集約され、旧経路の推定値も投稿推定の規則で上書きされる', async () => {
  const { db, author } = await setup();
  await db.updateUserAgeEstimate(author.id, { ageEstimate: 30, ageSource: 'ondevice', ageSamples: 0 });
  for (let i = 0; i < 5; i += 1) {
    const post = await db.createPost({ userId: author.id, content: `p${i}` });
    await aggregateAuthorAge(db, author.id, post.id, 'under13', { minSamples: 5 });
  }
  const user = await db.getUserById(author.id);
  // 若い方向は差の半分: 30 -> 11 方向へ 10 動く。
  assert.equal(user.age_estimate, 20);
  assert.equal(user.age_source, 'post', '推定の経路は投稿内容に一本化される');
});

test('(e) serialize は閲覧者の実効年齢で制限が変わり保存値は不変', async () => {
  const { db, author } = await setup();
  const post = await db.createPost({ userId: author.id, content: 'rated post' });
  await db.updatePost(post.id, { age_rating: 18 });

  const mkViewer = async (name, ageEstimate) => {
    const viewer = await db.createUser({ name });
    if (ageEstimate != null) {
      await db.updateUserAgeEstimate(viewer.id, { ageEstimate, ageSource: 'post' });
    }
    return viewer;
  };
  const adult = await mkViewer('adult', 30); // 実効22（30-5-3）→ 制限なし
  const borderline = await mkViewer('borderline', 23); // 実効15 → 差3 → mask
  const young = await mkViewer('young', 16); // 実効8 → 差10 → hide

  const serializedFor = async (viewerId) => {
    const [serialized] = await serializePostsBatch(db, [await db.getPostById(post.id)], viewerId);
    return serialized || null;
  };

  const forAdult = await serializedFor(adult.id);
  assert.equal(forAdult.age_rating, 18);
  assert.equal(forAdult.mask, false, '年齢が足りていれば制限なし');
  assert.ok(!('age_penalty' in forAdult), '制限の段階は外に出さない');
  assert.ok(!('author_age_band' in forAdult) && !('age_estimate' in forAdult), '投稿者の推定は露出しない');

  const forBorderline = await serializedFor(borderline.id);
  assert.equal(forBorderline.mask, true, 'mask は通常のクッションとして mask に畳まれる');

  assert.equal(await serializedFor(young.id), null, 'hide はバッチから除外される');
  assert.equal(await serializePost(db, await db.getPostById(post.id), young.id), null, 'hide は単体取得でも除外される');

  const forAuthor = await serializedFor(author.id);
  assert.equal(forAuthor.mask, false, '投稿者本人には制限なし');

  const forAnonymous = await serializedFor(null);
  assert.equal(forAnonymous.mask, true, '未ログインは年齢不明としてクッションがかかる');

  const stored = await db.getPostById(post.id);
  assert.equal(stored.age_rating, 18, '保存値は serialize で変わらない');
});

test('(f) lock+mask 投稿も v2 では年齢分類の対象になり、mask/lock は変わらない', async () => {
  const { db, author } = await setup();
  const post = await db.createPost({ userId: author.id, content: 'private post', mask: true, lock: true });

  const v2 = makeService(db, { respond: '<safe> <age:18> <author:25-34>' });
  await moderate(v2.service, db, post.id);
  const afterV2 = await db.getPostById(post.id);
  assert.equal(afterV2.age_rating, 18, 'v2 では lock+mask でも対象年齢が付く');
  assert.equal(afterV2.mask, true, 'mask は分類で変わらない');
  assert.equal(afterV2.lock, true, 'lock は分類で変わらない');

  const post2 = await db.createPost({ userId: author.id, content: 'private post 2', mask: true, lock: true });
  const legacy = makeService(db, { mode: 'legacy', respond: '<safe> <age:18> <author:25-34>' });
  await moderate(legacy.service, db, post2.id);
  assert.equal((await db.getPostById(post2.id)).age_rating, 0, 'legacy では lock+mask は分類対象外');
});

test('(g) serializeReply も mask を畳み、hide を返さない', async () => {
  const { db, author } = await setup();
  const post = await db.createPost({ userId: author.id, content: 'rated reply target' });
  await db.updatePost(post.id, { age_rating: 18 });

  const mkViewer = async (name, ageEstimate) => {
    const viewer = await db.createUser({ name });
    await db.updateUserAgeEstimate(viewer.id, { ageEstimate, ageSource: 'post' });
    return viewer;
  };
  const borderline = await mkViewer('reply-borderline', 23);
  const young = await mkViewer('reply-young', 16);

  const masked = await serializeReply(db, await db.getPostById(post.id), borderline.id);
  assert.equal(masked.mask, true, 'mask は通常のクッションとして畳まれる');
  assert.ok(!('age_penalty' in masked));

  assert.equal(await serializeReply(db, await db.getPostById(post.id), young.id), null, 'hide は返信でも返さない');
});

test('nextAgeEstimate: 高い方向も差が小さければ最低1は進む（デッドゾーンなし）', () => {
  assert.equal(nextAgeEstimate(14, 16), 15, '差2でも1進む');
  assert.equal(nextAgeEstimate(21, 29), 22, '差8は2割で1進む');
  assert.equal(nextAgeEstimate(29, 21), 25, '若い方向は差の半分');
  assert.equal(nextAgeEstimate(20, 20), 20);
  assert.equal(nextAgeEstimate(null, 16), 16);
  assert.equal(nextAgeEstimate(20, null), 20);
});
