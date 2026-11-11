'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreRecommendedPosts, ageProximityScore, AGE_PROXIMITY_MAX } = require('./recommendation');

test('ageProximityScore: 同年齢で最大、差が開くほど減り、不明なら 0', () => {
  assert.equal(ageProximityScore(20, 20), AGE_PROXIMITY_MAX);
  const near = ageProximityScore(20, 23);
  const far = ageProximityScore(20, 40);
  assert.ok(near > far && far > 0, `near=${near} far=${far}`);
  assert.ok(Math.abs(ageProximityScore(20, 26) - AGE_PROXIMITY_MAX / Math.E) < 0.01);
  assert.equal(ageProximityScore(null, 20), 0);
  assert.equal(ageProximityScore(20, null), 0);
  assert.equal(ageProximityScore(undefined, undefined), 0);
});

function post(id, userId, extra = {}) {
  return { id, userId, createdAt: new Date('2026-01-01T00:00:00Z'), tags: [], likeCount: 0, starCount: 0, repostCount: 0, replyCount: 0, ...extra };
}

test('scoreRecommendedPosts: 近い年齢の投稿者の投稿が上に来る', () => {
  const now = new Date('2026-01-01T01:00:00Z').getTime();
  const posts = [post(1, 2), post(2, 3)];
  const scored = scoreRecommendedPosts(posts, {
    viewerId: 1,
    viewerAgeEstimate: 20,
    authorAgeEstimates: new Map([[2, 21], [3, 45]]),
    now,
    limit: 10,
  });
  assert.equal(scored[0].authorId, 2);
  assert.ok(scored[0].score - scored[1].score > 5, `diff=${scored[0].score - scored[1].score}`);
});

test('scoreRecommendedPosts: 年齢が無ければボーナスなし（同条件は同点）', () => {
  const now = new Date('2026-01-01T01:00:00Z').getTime();
  const posts = [post(1, 2), post(2, 3)];
  const scored = scoreRecommendedPosts(posts, { viewerId: 1, now, limit: 10 });
  assert.equal(scored[0].score, scored[1].score);
});

test('scoreRecommendedPosts: 投稿に埋め込まれた年齢だけではボーナスは付かない', () => {
  const now = new Date('2026-01-01T01:00:00Z').getTime();
  // 年齢はゲート済みの authorAgeEstimates 経由でのみ使う。候補行の埋め込み値は
  // V2 無効時にも残りうるため、採点では参照しない。
  const posts = [post(1, 2, { author_age_estimate: 40 }), post(2, 3, { author_age_estimate: 19 })];
  const scored = scoreRecommendedPosts(posts, { viewerId: 1, viewerAgeEstimate: 20, now, limit: 10 });
  assert.equal(scored[0].score, scored[1].score);
});

test('dislikedAuthorCounts: 1回はペナルティ留まり、2回で除外される', () => {
  const now = new Date('2026-01-01T01:00:00Z').getTime();
  const posts = [post(1, 2), post(2, 3), post(3, 4)];
  const base = scoreRecommendedPosts(posts, { viewerId: 1, now, limit: 10 });
  const soft = scoreRecommendedPosts(posts, { viewerId: 1, now, limit: 10, dislikedAuthorCounts: new Map([[2, 1]]) });
  assert.equal(soft.length, 3, '1回では除外されない');
  assert.ok(soft.find((s) => s.authorId === 2).score < base.find((s) => s.authorId === 2).score, '1回でスコアが下がる');
  const hard = scoreRecommendedPosts(posts, { viewerId: 1, now, limit: 10, dislikedAuthorCounts: new Map([[2, 2], [3, 5]]) });
  assert.deepEqual(hard.map((s) => s.authorId), [4], '2回以上は著者ごと除外');
});

test('negativeTagCounts: 2回以上のタグだけがペナルティになり、1回では効かない', () => {
  const now = new Date('2026-01-01T01:00:00Z').getTime();
  const posts = [post(1, 2, { tags: ['炎上'] }), post(2, 3, { tags: ['日常'] })];
  const one = scoreRecommendedPosts(posts, { viewerId: 1, now, limit: 10, negativeTagCounts: new Map([['炎上', 1]]) });
  assert.equal(one.find((s) => s.id === 1).score, one.find((s) => s.id === 2).score, '1回では同点');
  const many = scoreRecommendedPosts(posts, { viewerId: 1, now, limit: 10, negativeTagCounts: new Map([['炎上', 5]]) });
  assert.ok(many.find((s) => s.id === 1).score < many.find((s) => s.id === 2).score, '繰り返されると沈む');
});

test('reactedPostIds: 一律減点ではなく乗算で強く沈む', () => {
  const now = new Date('2026-01-01T01:00:00Z').getTime();
  const posts = [post(1, 2), post(2, 3)];
  const plain = scoreRecommendedPosts(posts, { viewerId: 1, now, limit: 10 });
  const reacted = scoreRecommendedPosts(posts, { viewerId: 1, now, limit: 10, reactedPostIds: new Set([1]) });
  const ratio = reacted.find((s) => s.id === 1).score / plain.find((s) => s.id === 1).score;
  assert.ok(Math.abs(ratio - 0.3) < 1e-9, `ratio=${ratio}`);
});

test('affinity: 複数タグ一致が単一一致より明確に高い（飽和緩和）', () => {
  const now = new Date('2026-01-01T01:00:00Z').getTime();
  const profile = new Map([['猫', 12], ['写真', 12]]);
  const posts = [post(1, 2, { tags: ['猫'] }), post(2, 3, { tags: ['猫', '写真'] }), post(3, 4, { tags: [] })];
  const scored = scoreRecommendedPosts(posts, { viewerId: 1, now, limit: 10, keywordProfile: profile });
  const one = scored.find((s) => s.id === 1).score;
  const two = scored.find((s) => s.id === 2).score;
  const none = scored.find((s) => s.id === 3).score;
  assert.ok(two - one > 8, `two-one=${two - one}`);
  assert.ok(one - none > 20, `one-none=${one - none}`);
});

test('NFKC: 全角タグと半角タグが一致する', () => {
  const now = new Date('2026-01-01T01:00:00Z').getTime();
  const profile = new Map([['ＡＩ', 12]]);
  const posts = [post(1, 2, { tags: ['AI'] }), post(2, 3, { tags: [] })];
  const scored = scoreRecommendedPosts(posts, { viewerId: 1, now, limit: 10, keywordProfile: profile });
  assert.ok(scored.find((s) => s.id === 1).score > scored.find((s) => s.id === 2).score);
});

test('IDF-lite: ありふれたタグの一致は、珍しいタグの一致より弱い', () => {
  const now = new Date('2026-01-01T01:00:00Z').getTime();
  const profile = new Map([['日常', 12], ['陶芸', 12]]);
  const posts = [];
  for (let i = 0; i < 10; i += 1) posts.push(post(100 + i, 50 + i, { tags: ['日常'] }));
  posts.push(post(1, 2, { tags: ['日常'] }));
  posts.push(post(2, 3, { tags: ['陶芸'] }));
  const scored = scoreRecommendedPosts(posts, { viewerId: 1, now, limit: 30, keywordProfile: profile });
  assert.ok(scored.find((s) => s.id === 2).score > scored.find((s) => s.id === 1).score);
});

test('発見枠: 圏外候補を入れても元の5位は残り、落ちるのは末尾', () => {
  const now = new Date('2026-01-01T01:00:00Z').getTime();
  const follows = new Set([10, 11, 12, 13, 14, 15]);
  const posts = [];
  for (let i = 0; i < 6; i += 1) {
    posts.push(post(100 + i, 10 + i, { likeCount: 50 - i * 5 }));
  }
  posts.push(post(200, 99, { likeCount: 1 }));
  const scored = scoreRecommendedPosts(posts, { viewerId: 1, now, limit: 6, directFollows: follows });
  const ids = scored.map((s) => s.id);
  assert.ok(ids.includes(104), `元の5位が消えている: order=${ids}`);
  assert.ok(!ids.includes(105), `末尾が落ちていない: order=${ids}`);
});

test('発見枠: 拡張フォローは発動条件にも「フォロー中」判定にも数えない', () => {
  const now = new Date('2026-01-01T01:00:00Z').getTime();
  // 直接フォロー4人 + 拡張フォロー多数では発動しない。
  const direct = new Set([10, 11, 12, 13]);
  const extended = new Set([20, 21, 22, 23, 24, 25]);
  const posts = [];
  for (let i = 0; i < 4; i += 1) posts.push(post(100 + i, 10 + i, { likeCount: 50 - i * 5 }));
  for (let i = 0; i < 6; i += 1) posts.push(post(200 + i, 20 + i, { likeCount: 40 - i }));
  posts.push(post(300, 99, { likeCount: 1 }));
  const scored = scoreRecommendedPosts(posts, { viewerId: 1, now, limit: 10, directFollows: direct, extendedFollows: extended });
  assert.notEqual(scored[4].authorId, 99, '直接フォローが5未満では発見枠は発動しない');

  // 上位が拡張フォローの著者で埋まる場合は、すでに未フォローの著者が
  // 上位にいるため、発見枠の強制挿入は起きず自然な順序のままになる。
  const direct2 = new Set([10, 11, 12, 13, 14, 15]);
  const posts2 = [];
  for (let i = 0; i < 5; i += 1) posts2.push(post(200 + i, 20 + i, { likeCount: 60 - i * 5 }));
  for (let i = 0; i < 6; i += 1) posts2.push(post(100 + i, 10 + i, { likeCount: 0, createdAt: new Date('2025-01-01T00:00:00Z') }));
  posts2.push(post(300, 99, { likeCount: 1 }));
  const scored2 = scoreRecommendedPosts(posts2, { viewerId: 1, now, limit: 6, directFollows: direct2, extendedFollows: extended });
  assert.deepEqual(scored2.map((s) => s.authorId), [20, 21, 22, 23, 24, 99], `order=${scored2.map((s) => s.authorId)}`);
});

test('発見枠: 上位がフォロー中著者だけなら非フォローの最良候補が5位に入る', () => {
  const now = new Date('2026-01-01T01:00:00Z').getTime();
  const follows = new Set([10, 11, 12, 13, 14, 15]);
  const posts = [];
  for (let i = 0; i < 6; i += 1) {
    posts.push(post(100 + i, 10 + i, { likeCount: 50 - i * 5 }));
  }
  posts.push(post(200, 99, { likeCount: 1 }));
  const scored = scoreRecommendedPosts(posts, { viewerId: 1, now, limit: 6, directFollows: follows });
  assert.equal(scored.length, 6);
  assert.equal(scored[4].authorId, 99, `order=${scored.map((s) => s.authorId)}`);
});
