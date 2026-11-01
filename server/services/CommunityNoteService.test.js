'use strict';

// コミュニティノート評価の回帰テスト（サービス直接駆動）。
// H-D1: reviewer 成否は独立集合・重み付きでのみ決まること。
// D-M2: 通知作成の失敗で claim が消費されず、再試行で通知が届くこと。
// D-M3: 票が0件でも過去の reputation イベントを巻き戻せること。
// H-E2: 作成理由は文字列・{code}・{side, code} の全形式で保存対象になること。

process.env.NOTE_EVALUATION_HMAC_SECRET = process.env.NOTE_EVALUATION_HMAC_SECRET || 'test-secret-key-for-notes-1234567890';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const notesService = require('./CommunityNoteService');
const notesRoute = require('../routes/notes');
const { buildPolicy } = require('../utils/reputationPolicy');
const { containsProtectedStatus, publicSettings } = require('../utils/protectedStatus');

const NOTE_AUTHOR = 100;
const POST_AUTHOR = 200;

function makeDb({ noteStatus = 'limited', votes = [], edges = [], reasons = [] } = {}) {
  const state = {
    note: { id: 1, postId: 10, userId: NOTE_AUTHOR, status: noteStatus, createdAt: '2026-01-01T00:00:00.000Z' },
    events: new Map(),
    applied: [],
    notifications: [],
    claims: new Set(),
    failNotificationTimes: 0,
  };
  const manifest = {
    basis: 'admission-evidence', complete: true, version: 'v1', evidenceRef: 'note:1:relations:v1',
    coveredUserIds: [...new Set([...votes.map((v) => v.userId), NOTE_AUTHOR, POST_AUTHOR])].sort((a, b) => a - b),
    edges,
  };
  const evidence = {
    version: 1,
    ratings: votes.map((v) => ({ userId: v.userId, helpful: v.helpful, weight: v.weight ?? 1, revision: 1, castAt: v.castAt })),
    admissions: votes.map((v) => ({
      userId: v.userId, revision: 1, admittedAt: v.castAt, authorized: true, legacy: false,
      weight: v.weight ?? 1, evidenceRef: `note:1:vote:${v.userId}:revision:1`, relationManifest: manifest,
    })),
  };
  const db = {
    async getNote(id) { return Number(id) === 1 ? { ...state.note } : null; },
    async getPostById() { return { id: 10, userId: POST_AUTHOR, createdAt: '2026-01-01T00:00:00.000Z' }; },
    async getNoteVoteEvidence() { return evidence; },
    async listNoteDistributionsByNote() { return []; },
    async getReputationProfile() { return {}; },
    async getTrustBasisProfile() { return { trust: { score: 0, successes: 0 } }; },
    async replaceReputationEvents(scope, events, evaluation = null) {
      if (evaluation && evaluation.version !== evidence.version) return false;
      state.events.set(scope, events);
      if (evaluation) {
        state.note.status = evaluation.status;
        state.applied.push({ scope, events, evaluation });
      }
      return true;
    },
    async listNoteNegativeReasons() { return reasons; },
    async claimReputationNotice(key) { if (state.claims.has(key)) return false; state.claims.add(key); return true; },
    async releaseReputationNotice(key) { state.claims.delete(key); return true; },
    async createNotification(data) {
      if (state.failNotificationTimes > 0) { state.failNotificationTimes -= 1; throw new Error('notification store unavailable'); }
      state.notifications.push(data);
      return { id: state.notifications.length, ...data };
    },
    async upsertNoteDistribution() { return true; },
    async listNotesByPost() { return [{ ...state.note }]; },
    async getReputationEvidence() { return []; },
    async listPositivePostUsers() { return []; },
  };
  return { db, state };
}

function reviewerEvents(state) {
  return (state.events.get('note:1') || []).filter((e) => String(e.key).startsWith('reviewer:'));
}

test('H-D1: 関係者クラスタの後出し票だけでは reviewer イベントは決まらない', async () => {
  const cluster = [11, 12, 13, 14, 15];
  const edges = [];
  for (const a of cluster) for (const b of cluster) if (a < b) edges.push([a, b]);
  const votes = [
    { userId: 1, helpful: true, castAt: '2026-01-02T00:00:00.000Z' },
    ...cluster.map((userId) => ({ userId, helpful: true, castAt: '2026-01-03T00:00:00.000Z' })),
  ];
  const { db, state } = makeDb({ votes, edges });
  await notesService.evaluate(1, db);
  assert.equal(reviewerEvents(state).length, 0);
});

test('H-D1: 独立した後続票が揃えば reviewer イベントは従来どおり決まる', async () => {
  const votes = [
    { userId: 1, helpful: true, castAt: '2026-01-02T00:00:00.000Z' },
    ...[21, 22, 23, 24, 25].map((userId) => ({ userId, helpful: true, castAt: '2026-01-03T00:00:00.000Z' })),
  ];
  const { db, state } = makeDb({ votes });
  await notesService.evaluate(1, db);
  const own = reviewerEvents(state).filter((e) => e.key === 'reviewer:1');
  assert.equal(own.length, 1);
  assert.equal(own[0].amount, 1);
  assert.equal(own[0].successes, 1);
});

test('H-D1: 後続一致は件数ではなく重み付き比率で判定する', async () => {
  // 件数比率は 5/7 ≈ 0.714 で laterRatio(0.7) を超えるが、重み付きでは 5/7.6 ≈ 0.658 で中間帯に入る。
  const votes = [
    { userId: 1, helpful: true, castAt: '2026-01-02T00:00:00.000Z' },
    ...[31, 32, 33, 34, 35].map((userId) => ({ userId, helpful: true, weight: 1, castAt: '2026-01-03T00:00:00.000Z' })),
    ...[36, 37].map((userId) => ({ userId, helpful: false, weight: 1.3, castAt: '2026-01-03T00:00:00.000Z' })),
  ];
  const { db, state } = makeDb({ votes });
  await notesService.evaluate(1, db);
  assert.equal(reviewerEvents(state).filter((e) => e.key === 'reviewer:1').length, 0);
});

test('D-M3: 票が0件でも evaluate が止まらず、イベントを空に巻き戻せる', async () => {
  const { db, state } = makeDb({ noteStatus: 'public', votes: [] });
  const note = await notesService.evaluate(1, db);
  assert.ok(note);
  assert.equal(note.status, 'limited');
  assert.equal(state.applied.length, 1);
  assert.deepEqual(state.applied[0].events, []);
});

test('D-M2: 却下通知の作成が失敗しても claim が解放され、再試行で届く', async () => {
  const votes = [41, 42, 43, 44, 45].map((userId, i) => ({
    userId, helpful: false, castAt: `2026-01-0${i + 2}T00:00:00.000Z`,
  }));
  const { db, state } = makeDb({ votes, reasons: ['内容が不正確'] });
  state.failNotificationTimes = 1;
  const first = await notesService.evaluate(1, db);
  assert.equal(first.status, 'rejected');
  assert.equal(state.notifications.length, 0);
  assert.equal(state.claims.has('note-rejected:1'), false);
  await notesService.evaluate(1, db);
  assert.equal(state.notifications.length, 1);
  assert.equal(state.notifications[0].type, 'note_rate');
  assert.ok(state.notifications[0].message.includes('内容が不正確'));
});

test('H-E2: 作成理由は文字列・{code}・{side, code} 形式を受け付け、無効コードは除外する', () => {
  const allowed = new Set(['misleading', 'outdated', 'satire']);
  const codes = notesRoute.normalizeReasonCodes(
    ['misleading', { code: 'outdated' }, { side: 'create', code: 'satire', label: '風刺' }, 'bogus', { label: 'x' }, 42, { code: 'misleading' }],
    allowed,
  );
  assert.deepEqual(codes, ['misleading', 'outdated', 'satire']);
});

test('A-Low: sources は件数と長さに上限がある', () => {
  const many = Array.from({ length: 15 }, (_, i) => ({ url: `https://example.com/${i}`, title: 't' }));
  assert.equal(notesRoute.normalizeSources(many).length, 10);
  const longUrl = `https://example.com/${'a'.repeat(3000)}`;
  assert.equal(notesRoute.normalizeSources([{ url: longUrl }]).length, 0);
  assert.equal(notesRoute.normalizeSources([{ url: 'http://example.com/x' }]).length, 0);
});

test('D-Low: reputationPolicy の安全域検証', () => {
  assert.doesNotThrow(() => buildPolicy({}));
  assert.throws(() => buildPolicy({ notes: { penalty: 100 } }));
  assert.throws(() => buildPolicy({ notes: { minPublicSample: 500 } }));
  assert.throws(() => buildPolicy({
    trust: { Suspicious: { minScore: 500, rateMultiplier: 0.5, queuePriority: -2, disabledFeatures: ['notes', 'uploads'] } },
  }));
});

test('D-Low: protectedStatus のキー漏れ対策', () => {
  assert.equal(containsProtectedStatus({ scores: 1 }), true);
  assert.equal(containsProtectedStatus({ successes: 1 }), true);
  assert.equal(containsProtectedStatus({ TrustScore: 1 }), true);
  assert.equal(containsProtectedStatus({ display_ranks: ['writer'] }), true);
  assert.equal(containsProtectedStatus({ profile: { note: 'hello' } }), false);
  assert.deepEqual(publicSettings({ TrustScore: 5, bio: 'hi' }), { bio: 'hi' });
});

test('統合: 公開・却下の reputation イベントは trust ディメンションに一本化される', async () => {
  const helpfulVotes = [
    { userId: 1, helpful: true, castAt: '2026-01-02T00:00:00.000Z' },
    ...[21, 22, 23, 24, 25].map((userId) => ({ userId, helpful: true, castAt: '2026-01-03T00:00:00.000Z' })),
  ];
  const pub = makeDb({ votes: helpfulVotes });
  const publicNote = await notesService.evaluate(1, pub.db);
  assert.equal(publicNote.status, 'public');
  const pubEvents = pub.state.events.get('note:1') || [];
  const writerEvent = pubEvents.find((e) => e.key === 'writer');
  assert.equal(writerEvent.dimension, 'trust');
  assert.equal(writerEvent.amount, 2);
  assert.equal(writerEvent.successes, 1);
  assert.equal(writerEvent.metadata.independentWriter, true);
  assert.ok(pubEvents.filter((e) => String(e.key).startsWith('reviewer:')).every((e) => e.dimension === 'trust'));

  const rejectVotes = [41, 42, 43, 44, 45].map((userId, i) => ({
    userId, helpful: false, castAt: `2026-01-0${i + 2}T00:00:00.000Z`,
  }));
  const rej = makeDb({ votes: rejectVotes, reasons: [] });
  const rejectedNote = await notesService.evaluate(1, rej.db);
  assert.equal(rejectedNote.status, 'rejected');
  const rejEvents = rej.state.events.get('note:1') || [];
  assert.deepEqual(rejEvents.map((e) => [e.key, e.dimension, e.amount]), [['writer', 'trust', -2], ['rejected', 'trust', -2]]);
});
