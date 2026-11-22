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

function makeService(db, { mode = 'v2', respond = '<safe>', authorAge = true, toolCall = false } = {}) {
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
    moderationConfig: { enabled: true, prompt: '基準', provider: 'mock', model: 'mock', mode, authorAge, toolCall },
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
  assert.deepEqual(parseClassification('<safe> <age:18> <author:13-15>'), { level: 1, ageRating: 18, authorAgeBand: '13-15', reason: null });
  assert.deepEqual(parseClassification('<low>'), { level: 2, ageRating: null, authorAgeBand: null, reason: null });
  assert.deepEqual(parseClassification('<middle> <age:all> <author:unknown>'), { level: 3, ageRating: 0, authorAgeBand: null, reason: null });
  // 違反ラベル欠落時は従来どおり safe 扱い。年齢系だけが null（＝変更なし）になる。
  assert.deepEqual(parseClassification('ラベルなし'), { level: 1, ageRating: null, authorAgeBand: null, reason: null });
  assert.deepEqual(parseClassification('<low> <reason>Graphic violence</reason>'), { level: 2, ageRating: null, authorAgeBand: null, reason: 'Graphic violence' });
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
  const { service, calls } = makeService(db, { mode: 'legacy', respond: '<low> <age:18> <author:13-15> <reason>Graphic violence</reason>' });
  for (let i = 0; i < 3; i += 1) {
    const post = await db.createPost({ userId: author.id, content: `post ${i}` });
    await moderate(service, db, post.id);
    const after = await db.getPostById(post.id);
    assert.equal(after.mask, true, 'V1 の mask は従来どおり付く');
    assert.equal(after.mask_reason, 'Graphic violence', 'ペナルティの理由が保存される');
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

  const first = makeService(db, { respond: '<safe> <age:18> <reason>Graphic violence</reason>' });
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

  const v2 = makeService(db, { respond: '<safe> <age:18> <author:25-34> <reason>Graphic violence</reason>' });
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

test('(h) 理由が無いペナルティは適用されない', async () => {
  const { db, author } = await setup();

  const noReason = makeService(db, { mode: 'legacy', respond: '<low>' });
  const post = await db.createPost({ userId: author.id, content: 'post' });
  await moderate(noReason.service, db, post.id);
  const after = await db.getPostById(post.id);
  assert.equal(after.mask, false, '理由が無い mask は付かない');
  assert.equal(after.mask_reason, null);

  const noReasonAge = makeService(db, { respond: '<safe> <age:18>' });
  const post2 = await db.createPost({ userId: author.id, content: 'post 2' });
  await moderate(noReasonAge.service, db, post2.id);
  assert.equal((await db.getPostById(post2.id)).age_rating, 0, '理由が無い対象年齢の引き上げは適用されない');
});

test('(i) 処理に失敗した投稿はキューの最後へ移り、他の投稿を先に処理し、落とされない', async () => {
  const { db, author } = await setup();
  const order = [];
  const aiService = {
    generate: async ({ text }) => {
      if (text.includes('FAILME')) {
        order.push('A');
        throw new Error('mock failure');
      }
      const marker = /POST_B\d/.exec(text)?.[0];
      if (marker) order.push(marker);
      return '<safe>';
    },
  };
  const service = new AutoModerationService({
    dbAdapter: db,
    storageAdapter: undefined,
    moderationConfig: { enabled: true, prompt: '基準', provider: 'mock', model: 'mock', mode: 'v2', authorAge: true, toolCall: false },
    ageVerifyConfig: { margin: 5, unknown: 'warn', postMinSamples: 5 },
    aiService,
  });
  const failPost = await db.createPost({ userId: author.id, content: 'FAILME' });
  try {
    service.enqueue(failPost);
    for (const label of ['POST_B1', 'POST_B2', 'POST_B3', 'POST_B4']) {
      const post = await db.createPost({ userId: author.id, content: label });
      service.enqueue(post);
    }
    const start = Date.now();
    while (Date.now() - start < 30000) {
      if (order.filter((entry) => entry === 'A').length >= 4) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(
      order.filter((entry) => entry !== 'A'),
      ['POST_B1', 'POST_B2', 'POST_B3', 'POST_B4'],
      '失敗した投稿の後ろに並んだ投稿が先に処理される',
    );
    const aAttempts = order.filter((entry) => entry === 'A').length;
    assert.ok(aAttempts >= 4, `失敗した投稿が繰り返し処理される (実際: ${aAttempts} 回)`);
    assert.ok(
      order.indexOf('POST_B4') < order.lastIndexOf('A'),
      '失敗した投稿は先頭ではなく最後へ移る',
    );
    assert.ok(
      service.pendingJobsByPostId.has(Number(failPost.id)),
      '失敗した投稿はキューに残り、検査から落ちない',
    );
  } finally {
    service.stop();
  }
});

function toolResponse(calls) {
  return {
    choices: [{
      message: {
        tool_calls: calls.map(([name, args], index) => ({
          id: `call_${index}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(args || {}) },
        })),
      },
    }],
  };
}

function makeToolService(db, generate, { storageAdapter, maxImages, toolMaxTurns } = {}) {
  return new AutoModerationService({
    dbAdapter: db,
    storageAdapter,
    moderationConfig: {
      enabled: true, prompt: '基準', provider: 'mock', model: 'mock', mode: 'v2',
      authorAge: true, toolCall: true, ...(maxImages ? { maxImages } : {}),
      ...(toolMaxTurns ? { toolMaxTurns } : {}),
    },
    ageVerifyConfig: { margin: 5, unknown: 'warn', postMinSamples: 5 },
    aiService: { generate },
  });
}

test('(n) ツールのターン上限は設定でき、既定は無制限', async () => {
  const { db, author } = await setup();
  const post = await db.createPost({ userId: author.id, content: '本文' });
  let calls = 0;
  const never = async () => {
    calls += 1;
    return toolResponse([]);
  };
  const unlimited = makeToolService(db, never);
  assert.equal(unlimited.toolMaxTurns, 0, '既定は無制限');
  const limited = makeToolService(db, never, { toolMaxTurns: 2 });
  assert.equal(limited.toolMaxTurns, 2);
  await assert.rejects(limited._classifyWithTools(post, ''), /必須のツールが呼び出されませんでした/);
  assert.equal(calls, 2, '上限のターン数で打ち切られる');
});

test('(o) テキスト判定でラベルの無い応答は安全とみなさずエラーにする', async () => {
  const { db, author } = await setup();
  const post = await db.createPost({ userId: author.id, content: '判定対象の本文' });
  const empty = makeService(db, { respond: '' });
  await assert.rejects(
    empty.service._classify(post, ''),
    (error) => error.code === 'AI_INVALID_RESPONSE',
  );
  const labeled = makeService(db, { respond: '<low> <reason>Harassment</reason>' });
  const result = await labeled.service._classify(post, '');
  assert.equal(result.level, 2);
  assert.equal(result.reason, 'Harassment');
});

test('(p) ツール判定で呼び出しの無いターンが続いたら打ち切る', async () => {
  const { db, author } = await setup();
  const post = await db.createPost({ userId: author.id, content: '本文' });
  let calls = 0;
  const service = makeToolService(db, async () => {
    calls += 1;
    return toolResponse([]);
  });
  await assert.rejects(service._classifyWithTools(post, ''), /必須のツールが呼び出されませんでした/);
  assert.equal(calls, 3, '呼び出しの無いターンが3回続いたら打ち切られる');
});

test('(j) ツールモードではツール呼び出しでモデレーションが適用され、状態がプロンプトに渡る', async () => {
  const { db, author } = await setup();
  const post = await db.createPost({ userId: author.id, content: '判定対象の本文' });
  await db.updatePost(post.id, { attachments: [{ id: 'att1', type: 'image/png', name: 'photo.png' }] });
  const requests = [];
  let turn = 0;
  const service = makeToolService(db, async (request) => {
    requests.push({ ...request, turns: request.turns.map((entry) => ({ ...entry })) });
    turn += 1;
    if (turn === 1) {
      return toolResponse([
        ['apply_cushion', {}],
        ['set_moderation_reason', { reason: 'graphic content' }],
        ['set_age_rating', { rating: 15 }],
        ['set_author_age', { band: '18-24' }],
      ]);
    }
    return toolResponse([]);
  });
  await moderate(service, db, post.id);
  const updated = await db.getPostById(post.id);
  assert.equal(updated.mask, true);
  assert.equal(updated.mask_reason, 'graphic content');
  assert.equal(updated.age_rating, 15);
  assert.ok(requests[0].tools.some((tool) => tool.name === 'get_attachments'), 'ツール定義が渡される');
  assert.equal(requests[0].turns[0].images, undefined, 'アタッチメントは最初からは付与されない');
  const instruction = requests[0].turns[0].text;
  assert.ok(instruction.includes(`投稿者ID: ${author.id}`), '投稿者IDが渡る');
  assert.ok(instruction.includes('ワンクッション: なし'), 'ワンクッションの有無が渡る');
  assert.ok(instruction.includes('photo.png'), 'アタッチメントのリストが渡る');
});

test('(k) 必須ツールが呼ばれないと、その旨が返されて追加のターンが発生する', async () => {
  const { db, author } = await setup();
  const post = await db.createPost({ userId: author.id, content: '問題のない本文' });
  const requests = [];
  let turn = 0;
  const service = makeToolService(db, async (request) => {
    requests.push({ ...request, turns: request.turns.map((entry) => ({ ...entry })) });
    turn += 1;
    if (turn === 1) return toolResponse([]);
    if (turn === 2) return toolResponse([['set_author_age', { band: '25-34' }]]);
    return toolResponse([]);
  });
  await moderate(service, db, post.id);
  assert.ok(requests.length >= 2, '追加のターンが発生する');
  const feedback = requests[1].turns.at(-1);
  assert.equal(feedback.role, 'user');
  assert.ok(feedback.text.includes('必須のツールが呼び出されていません'), '未呼び出しが返される');
  assert.ok(feedback.text.includes('set_author_age'));
  const updated = await db.getPostById(post.id);
  assert.equal(updated.mask, false);
});

test('(l) 既存のワンクッション理由はモデレーションの理由で上書きされる', async () => {
  const { db, author } = await setup();
  const post = await db.createPost({ userId: author.id, content: '流血のある本文' });
  await db.updatePost(post.id, { mask: true, mask_reason: '変な理由' });
  let turn = 0;
  const service = makeToolService(db, async () => {
    turn += 1;
    if (turn === 1) {
      return toolResponse([
        ['apply_cushion', {}],
        ['set_moderation_reason', { reason: 'explicit gore' }],
        ['set_author_age', { band: '18-24' }],
      ]);
    }
    return toolResponse([]);
  });
  await moderate(service, db, post.id);
  const updated = await db.getPostById(post.id);
  assert.equal(updated.mask, true);
  assert.equal(updated.mask_reason, 'explicit gore');
});

test('(m) get_attachments は指定したIDのアタッチメントだけを次のターンに提示する', async () => {
  const { db, author } = await setup();
  const post = await db.createPost({ userId: author.id, content: '画像つきの本文' });
  await db.updatePost(post.id, {
    attachments: [
      { id: 'file1', type: 'image/png', name: 'a.png' },
      { id: 'file2', type: 'image/png', name: 'b.png' },
    ],
  });
  const storageAdapter = {
    read: async () => ({ contentType: 'image/png', buffer: Buffer.from('png-bytes') }),
  };
  const requests = [];
  let turn = 0;
  const service = makeToolService(db, async (request) => {
    requests.push({ ...request, turns: request.turns.map((entry) => ({ ...entry })) });
    turn += 1;
    if (turn === 1) return toolResponse([['get_attachments', { attachment_ids: ['file2', 'missing-id'] }]]);
    if (turn === 2) return toolResponse([['set_author_age', { band: 'unknown' }]]);
    return toolResponse([]);
  }, { storageAdapter, maxImages: 4 });
  await moderate(service, db, post.id);
  assert.equal(requests[0].turns[0].images, undefined, '最初は画像が付かない');
  const toolTurn = requests[1].turns.find((entry) => entry.role === 'tool');
  assert.ok(toolTurn, 'ツール結果のターンがある');
  assert.equal(toolTurn.images.length, 1, '指定した画像だけが提示される');
  assert.equal(toolTurn.results[0].result.images_presented, 1);
  assert.deepEqual(toolTurn.results[0].result.attachments.map((entry) => entry.id), ['file2']);
  assert.deepEqual(toolTurn.results[0].result.not_found, ['missing-id']);
});

test('(o) プロンプトが無くてもAutoModは有効になり判定が動く', async () => {
  const { db, author } = await setup();
  const post = await db.createPost({ userId: author.id, content: 'post' });
  const service = new AutoModerationService({
    dbAdapter: db,
    storageAdapter: undefined,
    moderationConfig: {
      enabled: true, prompt: '', provider: 'mock', model: 'mock', mode: 'legacy',
      authorAge: true, toolCall: false,
    },
    ageVerifyConfig: { margin: 5, unknown: 'warn', postMinSamples: 5 },
    aiService: { generate: async () => '<low> <reason>Graphic violence</reason>' },
  });
  assert.equal(service.enabled, true);
  await moderate(service, db, post.id);
  const after = await db.getPostById(post.id);
  assert.equal(after.mask, true);
  assert.equal(after.mask_reason, 'Graphic violence');
});

test('nextAgeEstimate: 高い方向も差が小さければ最低1は進む（デッドゾーンなし）', () => {
  assert.equal(nextAgeEstimate(14, 16), 15, '差2でも1進む');
  assert.equal(nextAgeEstimate(21, 29), 22, '差8は2割で1進む');
  assert.equal(nextAgeEstimate(29, 21), 25, '若い方向は差の半分');
  assert.equal(nextAgeEstimate(20, 20), 20);
  assert.equal(nextAgeEstimate(null, 16), 16);
  assert.equal(nextAgeEstimate(20, null), 20);
});

test('(q) 同時処理数は設定値まで並行して処理される', async () => {
  const { db, author } = await setup();
  let active = 0;
  let maxActive = 0;
  const aiService = {
    generate: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 40));
      active -= 1;
      return '<safe>';
    },
  };
  const service = new AutoModerationService({
    dbAdapter: db,
    storageAdapter: undefined,
    moderationConfig: { enabled: true, prompt: '基準', provider: 'mock', model: 'mock', mode: 'v2', authorAge: true, toolCall: false, maxConcurrent: 3 },
    ageVerifyConfig: { margin: 5, unknown: 'warn', postMinSamples: 5 },
    aiService,
  });
  for (let i = 0; i < 6; i++) {
    const post = await db.createPost({ userId: author.id, content: `CONCURRENT_${i}` });
    service.enqueue(post);
  }
  const start = Date.now();
  while (Date.now() - start < 10000) {
    if (!service.processing && service.queue.length <= service.queueHead) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(maxActive > 1 && maxActive <= 3, `同時に処理されたのは ${maxActive} 件`);
});
