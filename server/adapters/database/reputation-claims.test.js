'use strict';

// アダプタ側フォローアップ（Area G）の回帰テスト。
// G-1: 通知 claim の解放。通知作成が失敗したら claim が解放され、再評価で通知が届くこと
//      （サービス側 notifyWithClaim が期待する releaseNoteNotification /
//        releaseReputationNotice を実アダプタが持つこと）。
// G-2: listNoteNegativeReasons(noteId, userIds) の第2引数。独立票のユーザーID集合が
//      渡された場合、そのユーザーの否定理由だけを集計し、関係者の後出し否定票の
//      理由を含まないこと。渡されない場合は従来どおり全票を集計すること。

process.env.NOTE_EVALUATION_HMAC_SECRET = "x".repeat(40);

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const InMemoryAdapter = require('./InMemoryAdapter');
const PostgresAdapter = require('./postgres/PostgresAdapter');
const D1Adapter = require('./d1/D1Adapter');
const notesService = require('../../services/CommunityNoteService');

function seedNegativeReasons(adapter) {
  // 独立票 11,12,13 と、独立集合に入らない関係者 98,99 の否定票。
  const ratings = [
    [11, false], [12, false], [13, false], [98, false], [99, false], [14, true],
  ];
  for (const [userId, helpful] of ratings) {
    adapter.noteRatings.set(`1:${userId}`, { noteId: 1, userId, helpful });
  }
  const reasons = [
    [11, 'unclear'], [12, 'unclear'], [13, 'biased'],
    [99, 'missing_source'], [98, 'missing_source'],
    [14, 'unclear'],
  ];
  for (const [userId, code] of reasons) {
    adapter.noteRatingReasons.set(`1:${userId}:${code}`, { noteId: 1, userId, code });
  }
}

test('G-1/G-2 InMemory: claim/release の往復と否定理由の独立票フィルタ', async () => {
  const adapter = new InMemoryAdapter();
  adapter.noteDistributions.set('1:42', { noteId: 1, userId: 42, tier: 1, notified: false });
  adapter.noteDistributions.set('1:43', { noteId: 1, userId: 43, tier: 0, notified: false });

  assert.equal(await adapter.claimNoteNotification(1, 42), true);
  assert.equal(await adapter.claimNoteNotification(1, 42), false, '二重 claim はできない');
  assert.equal(await adapter.claimNoteNotification(1, 43), false, 'tier 0 は claim 対象外');
  assert.equal(await adapter.releaseNoteNotification(1, 42), true);
  assert.equal(adapter.noteDistributions.get('1:42').notified, false);
  assert.equal(await adapter.releaseNoteNotification(1, 42), false, '未 claim の解放は false');
  assert.equal(await adapter.claimNoteNotification(1, 42), true, '解放後は再 claim できる');

  assert.equal(await adapter.claimReputationNotice('note-rejected:1'), true);
  assert.equal(await adapter.claimReputationNotice('note-rejected:1'), false);
  assert.equal(await adapter.releaseReputationNotice('note-rejected:1'), true);
  assert.equal(await adapter.releaseReputationNotice('note-rejected:1'), false);
  assert.equal(await adapter.claimReputationNotice('note-rejected:1'), true, '解放後は再 claim できる');

  seedNegativeReasons(adapter);
  assert.deepEqual(
    await adapter.listNoteNegativeReasons(1, [11, 12, 13]),
    ['わかりにくい', '偏っている'],
    '独立票以外（関係者 98/99）の理由「ソースがない」を含まない',
  );
  assert.deepEqual(
    await adapter.listNoteNegativeReasons(1),
    ['わかりにくい', 'ソースがない', '偏っている'],
    '第2引数なしでは従来どおり全票を集計する',
  );
  assert.deepEqual(await adapter.listNoteNegativeReasons(1, []), [], '空集合では理由なし');
});

test('G-1/G-2 evaluate: InMemory 実アダプタの claim 解放で却下通知が再試行で届き、理由は独立票のみ', async () => {
  const NOTE_AUTHOR = 100;
  const POST_AUTHOR = 200;
  const mem = new InMemoryAdapter();
  // 却下票を付けた独立ユーザー 41..45 の理由と、投票者ですらない 99 の後出し理由。
  for (const userId of [41, 42, 43, 44, 45]) {
    mem.noteRatings.set(`1:${userId}`, { noteId: 1, userId, helpful: false });
  }
  mem.noteRatings.set('1:99', { noteId: 1, userId: 99, helpful: false });
  const memReasons = [[41, 'unclear'], [42, 'unclear'], [43, 'biased'], [99, 'missing_source']];
  for (const [userId, code] of memReasons) {
    mem.noteRatingReasons.set(`1:${userId}:${code}`, { noteId: 1, userId, code });
  }

  const votes = [41, 42, 43, 44, 45].map((userId, i) => ({
    userId, helpful: false, castAt: `2026-01-0${i + 2}T00:00:00.000Z`,
  }));
  const manifest = {
    basis: 'admission-evidence', complete: true, version: 'v1', evidenceRef: 'note:1:relations:v1',
    coveredUserIds: [...votes.map((v) => v.userId), NOTE_AUTHOR, POST_AUTHOR].sort((a, b) => a - b),
    edges: [],
  };
  const evidence = {
    version: 1,
    ratings: votes.map((v) => ({ userId: v.userId, helpful: v.helpful, weight: 1, revision: 1, castAt: v.castAt })),
    admissions: votes.map((v) => ({
      userId: v.userId, revision: 1, admittedAt: v.castAt, authorized: true, legacy: false,
      weight: 1, evidenceRef: `note:1:vote:${v.userId}:revision:1`, relationManifest: manifest,
    })),
  };
  const state = {
    note: { id: 1, postId: 10, userId: NOTE_AUTHOR, status: 'limited', createdAt: '2026-01-01T00:00:00.000Z' },
    notifications: [],
    failNotificationTimes: 1,
  };
  const db = {
    async getNote(id) { return Number(id) === 1 ? { ...state.note } : null; },
    async getPostById() { return { id: 10, userId: POST_AUTHOR, createdAt: '2026-01-01T00:00:00.000Z' }; },
    async getNoteVoteEvidence() { return evidence; },
    async listNoteDistributionsByNote() { return []; },
    async getReputationProfile() { return {}; },
    async getTrustBasisProfile() { return { trust: { score: 0, successes: 0 } }; },
    async replaceReputationEvents(scope, events, evaluation = null) {
      if (evaluation) state.note.status = evaluation.status;
      return true;
    },
    // claim / release / 理由集計は InMemory 実アダプタへ委譲する。
    claimReputationNotice: (key) => mem.claimReputationNotice(key),
    releaseReputationNotice: (key) => mem.releaseReputationNotice(key),
    listNoteNegativeReasons: (noteId, userIds) => mem.listNoteNegativeReasons(noteId, userIds),
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

  const first = await notesService.evaluate(1, db);
  assert.equal(first.status, 'rejected');
  assert.equal(state.notifications.length, 0, '1回目は通知作成が失敗する');
  assert.equal(mem.reputationNoticeClaims.has('note-rejected:1'), false, '失敗で claim が解放される');

  await notesService.evaluate(1, db);
  assert.equal(state.notifications.length, 1, '再評価で通知が届く');
  assert.equal(state.notifications[0].type, 'note_rate');
  assert.ok(state.notifications[0].message.includes('わかりにくい'), '独立票の理由が入る');
  assert.ok(!state.notifications[0].message.includes('ソースがない'), '独立票以外の理由は入らない');
  assert.equal(mem.reputationNoticeClaims.has('note-rejected:1'), true, '成功後は claim が保持される');
});

let PGlite = null;
for (const candidate of [
  '/tmp/opencode/reputation-pgverify/node_modules/@electric-sql/pglite',
  '/tmp/pglite-test/node_modules/@electric-sql/pglite',
]) {
  try { ({ PGlite } = require(candidate)); break; } catch (_) { /* try next */ }
}

test('G-1/G-2 Postgres (PGlite): claim/release と否定理由フィルタ', { skip: PGlite ? false : 'PGlite が見つからないためスキップ' }, async () => {
  const sql = new PGlite();
  try {
    await sql.exec(`
      CREATE TABLE note_distribution(note_id INTEGER NOT NULL, user_id INTEGER NOT NULL, tier INTEGER NOT NULL DEFAULT 1, notified BOOLEAN NOT NULL DEFAULT FALSE, PRIMARY KEY(note_id, user_id));
      CREATE TABLE reputation_notice_claims(notice_key TEXT PRIMARY KEY);
      CREATE TABLE note_reason_tag_defs(code TEXT PRIMARY KEY, side TEXT NOT NULL, label_ja TEXT NOT NULL);
      CREATE TABLE note_ratings(note_id INTEGER NOT NULL, user_id INTEGER NOT NULL, helpful BOOLEAN NOT NULL, PRIMARY KEY(note_id, user_id));
      CREATE TABLE note_rating_reasons(note_id INTEGER NOT NULL, user_id INTEGER NOT NULL, code TEXT NOT NULL, PRIMARY KEY(note_id, user_id, code));
      INSERT INTO note_distribution VALUES(1, 42, 1, FALSE), (1, 43, 0, FALSE);
      INSERT INTO note_reason_tag_defs VALUES
        ('unclear', 'negative', 'わかりにくい'),
        ('biased', 'negative', '偏っている'),
        ('missing_source', 'negative', 'ソースがない');
      INSERT INTO note_ratings VALUES(1, 11, FALSE), (1, 12, FALSE), (1, 13, FALSE), (1, 98, FALSE), (1, 99, FALSE), (1, 14, TRUE);
      INSERT INTO note_rating_reasons VALUES
        (1, 11, 'unclear'), (1, 12, 'unclear'), (1, 13, 'biased'),
        (1, 99, 'missing_source'), (1, 98, 'missing_source'), (1, 14, 'unclear');
    `);
    const adapter = Object.create(PostgresAdapter.prototype);
    adapter.pool = { query: (text, params) => sql.query(text, params) };

    assert.equal(await adapter.claimNoteNotification(1, 42), true);
    assert.equal(await adapter.claimNoteNotification(1, 42), false);
    assert.equal(await adapter.claimNoteNotification(1, 43), false, 'tier 0 は claim 対象外');
    assert.equal(await adapter.releaseNoteNotification(1, 42), true);
    assert.equal(await adapter.releaseNoteNotification(1, 42), false);
    assert.equal(await adapter.claimNoteNotification(1, 42), true, '解放後は再 claim できる');

    assert.equal(await adapter.claimReputationNotice('note-rejected:1'), true);
    assert.equal(await adapter.claimReputationNotice('note-rejected:1'), false);
    assert.equal(await adapter.releaseReputationNotice('note-rejected:1'), true);
    assert.equal(await adapter.releaseReputationNotice('note-rejected:1'), false);
    assert.equal(await adapter.claimReputationNotice('note-rejected:1'), true);

    assert.deepEqual(await adapter.listNoteNegativeReasons(1, [11, 12, 13]), ['わかりにくい', '偏っている']);
    assert.deepEqual(await adapter.listNoteNegativeReasons(1), ['わかりにくい', 'ソースがない', '偏っている']);
    assert.deepEqual(await adapter.listNoteNegativeReasons(1, []), []);
  } finally {
    await sql.close();
  }
});

test('G-1/G-2 D1: アダプタの経路と Worker のハンドラ契約', async () => {
  const adapter = Object.create(D1Adapter.prototype);
  const writes = [];
  const reads = [];
  adapter._write = async (p, body) => { writes.push([p, body]); return true; };
  adapter._read = async (p) => { reads.push(p); return []; };

  assert.equal(await adapter.releaseNoteNotification(1, 42), true);
  assert.deepEqual(writes[0], ['/reputation/release-note-notification', { noteId: 1, userId: 42 }]);
  assert.equal(await adapter.releaseReputationNotice('note-rejected:1'), true);
  assert.deepEqual(writes[1], ['/reputation/release-notice', { key: 'note-rejected:1' }]);

  await adapter.listNoteNegativeReasons(1, [11, 12]);
  assert.equal(reads[0], '/community-notes/1/negative-reasons?userIds=11%2C12');
  await adapter.listNoteNegativeReasons(1);
  assert.equal(reads[1], '/community-notes/1/negative-reasons', '第2引数なしでは従来の URL のまま');

  const source = fs.readFileSync(path.join(__dirname, '../../../workers/d1-proxy/src/index.js'), 'utf8');
  assert.ok(source.includes("pathname==='/reputation/release-note-notification'"), 'Worker に release-note-notification がある');
  assert.ok(source.includes('UPDATE note_distribution SET notified=0 WHERE note_id=? AND user_id=? AND notified=1'));
  assert.ok(source.includes("pathname==='/reputation/release-notice'"), 'Worker に release-notice がある');
  assert.ok(source.includes('DELETE FROM reputation_notice_claims WHERE notice_key=?'));
  const negativeHandler = source.slice(source.indexOf('/negative-reasons$/.test(pathname)'));
  assert.ok(negativeHandler.slice(0, 1600).includes("url.searchParams.get('userIds')"), 'Worker が userIds を読む');
  assert.ok(negativeHandler.slice(0, 1600).includes('r.user_id IN ('), 'Worker が user_id で絞る');
});

test('統合: reviewer outcome は trust ディメンションで確定し、旧ディメンションは書けない', async () => {
  const adapter = new InMemoryAdapter();
  adapter.users.set(11, { id: 11 });
  adapter.users.set(22, { id: 22 });
  await adapter.replaceReputationEvents('note:5', [
    { key: 'reviewer:11', userId: 11, dimension: 'trust', amount: 1, successes: 1, day: '2026-01-02', cap: null, metadata: { authorId: 22, ratedAt: '2026-01-02T00:00:00.000Z' } },
  ]);
  const profile = await adapter.getReputationProfile(11);
  assert.equal(profile.trust.score, 1);
  assert.equal(profile.trust.successes, 1);
  assert.equal(profile.writer, undefined);
  assert.equal(profile.reviewer, undefined);
  await assert.rejects(adapter.replaceReputationEvents('note:6', [
    { key: 'writer', userId: 11, dimension: 'writer', amount: 2, successes: 1, day: '2026-01-02', cap: null, metadata: {} },
  ]));
});

test('統合: basis は独立ゲートを満たさない note 由来の正の額を数えない', async () => {
  const adapter = new InMemoryAdapter();
  adapter.users.set(11, { id: 11 });
  await adapter.replaceReputationEvents('note:7', [
    { key: 'writer', userId: 11, dimension: 'trust', amount: 2, successes: 1, day: '2026-01-03', cap: null, metadata: { independentWriter: false } },
  ]);
  await adapter.replaceReputationEvents('note:8', [
    { key: 'writer', userId: 11, dimension: 'trust', amount: 3, successes: 1, day: '2026-01-04', cap: null, metadata: { independentWriter: true } },
  ]);
  const full = await adapter.getReputationProfile(11);
  assert.equal(full.trust.score, 5);
  const basis = await adapter.getTrustBasisProfile(11);
  assert.equal(basis.trust.score, 3);
  assert.equal(basis.trust.successes, 1);
  const basisExcluded = await adapter.getTrustBasisProfile(11, { excludeScope: 'note:8' });
  assert.equal(basisExcluded.trust.score, 0);
});
