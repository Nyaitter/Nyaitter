'use strict';

// グループ内のポストの報告はグループのモデレーターへ割り当て、
// サイトの管理者へは割り当てないことの検証。

const assert = require('node:assert/strict');
const { test } = require('node:test');
const InMemoryAdapter = require('../adapters/database/InMemoryAdapter');
const { ModerationReportService } = require('./ModerationReportService');
const { createGroupWithDefaultRoles } = require('./GroupService');

async function setup() {
  const db = new InMemoryAdapter();
  const service = new ModerationReportService({ dbAdapter: db });
  const siteAdmin = await db.createUser({ name: 'site-admin', admin: true });
  const owner = await db.createUser({ name: 'owner' });
  const author = await db.createUser({ name: 'author' });
  const reporter = await db.createUser({ name: 'reporter' });
  const group = await createGroupWithDefaultRoles(db, { ownerId: owner.id, name: 'test group' });
  return { db, service, siteAdmin, owner, author, reporter, group };
}

test('グループ内のポストの報告はグループの所有者に割り当てられる', async () => {
  const { db, service, siteAdmin, owner, author, reporter, group } = await setup();
  const post = await db.createPost({ userId: author.id, content: 'group post', groupId: group.id });
  const report = await service.createReport({
    reporterUserId: reporter.id,
    targetKind: 'post',
    targetId: post.id,
    description: '問題のあるポストです',
  });
  assert.equal(report.status, 'assigned');
  assert.equal(Number(report.assignedAdminId), Number(owner.id));
  assert.notEqual(Number(report.assignedAdminId), Number(siteAdmin.id));
  assert.equal(report.targetSnapshot.post.groupId, group.id);
});

test('グループ外のポストの報告はサイトの管理者に割り当てられる', async () => {
  const { db, service, siteAdmin, author, reporter } = await setup();
  const post = await db.createPost({ userId: author.id, content: 'plain post' });
  const report = await service.createReport({
    reporterUserId: reporter.id,
    targetKind: 'post',
    targetId: post.id,
    description: '問題のあるポストです',
  });
  assert.equal(report.status, 'assigned');
  assert.equal(Number(report.assignedAdminId), Number(siteAdmin.id));
});

test('グループのモデレーターはワンクッションと理由を付けられる', async () => {
  const { db, service, owner, author, reporter, group } = await setup();
  const post = await db.createPost({ userId: author.id, content: 'group post', groupId: group.id });
  const report = await service.createReport({
    reporterUserId: reporter.id,
    targetKind: 'post',
    targetId: post.id,
    description: '問題のあるポストです',
  });
  const resolved = await service.resolveReport({
    reportId: report.id,
    adminId: owner.id,
    actions: { maskPost: true, maskReason: '暴力的' },
  });
  assert.equal(resolved.status, 'resolved');
  const after = await db.getPostById(post.id);
  assert.equal(Boolean(after.mask), true);
  assert.equal(after.mask_reason ?? after.maskReason, '暴力的');
});

test('グループのモデレーターはアカウントへの処分を実行できない', async () => {
  const { db, service, owner, author, reporter, group } = await setup();
  const post = await db.createPost({ userId: author.id, content: 'group post', groupId: group.id });
  const report = await service.createReport({
    reporterUserId: reporter.id,
    targetKind: 'post',
    targetId: post.id,
    description: '問題のあるポストです',
  });
  await assert.rejects(
    service.resolveReport({
      reportId: report.id,
      adminId: owner.id,
      actions: { freeze: true, freezeReason: '荒らし', targetUserId: author.id },
    }),
    /グループ内の報告では実行できない/,
  );
  const after = await service.getReportById(report.id);
  assert.equal(after.status, 'assigned');
});

async function trustScore(db, userId) {
  const profile = await db.getReputationProfile(userId);
  return profile?.trust?.score ?? 0;
}

test('報告の解決で報告者と対象者の信頼スコアは上がらない', async () => {
  {
    const { db, service, siteAdmin, author, reporter } = await setup();
    const post = await db.createPost({ userId: author.id, content: 'plain post' });
    const report = await service.createReport({
      reporterUserId: reporter.id,
      targetKind: 'post',
      targetId: post.id,
      description: '問題のあるポストです',
    });
    await service.resolveReport({
      reportId: report.id,
      adminId: siteAdmin.id,
      actions: { maskPost: true, maskReason: 'テスト' },
    });
    assert.equal(await trustScore(db, reporter.id), 0);
    assert.ok((await trustScore(db, author.id)) < 0);
  }
  {
    const { db, service, siteAdmin, author, reporter } = await setup();
    const post = await db.createPost({ userId: author.id, content: 'plain post' });
    const report = await service.createReport({
      reporterUserId: reporter.id,
      targetKind: 'post',
      targetId: post.id,
      description: '問題のあるポストです',
    });
    await service.resolveReport({ reportId: report.id, adminId: siteAdmin.id, actions: {} });
    assert.equal(await trustScore(db, reporter.id), 0);
    assert.equal(await trustScore(db, author.id), 0);
  }
  {
    const { db, service, siteAdmin, author, reporter } = await setup();
    const post = await db.createPost({ userId: author.id, content: 'plain post' });
    const report = await service.createReport({
      reporterUserId: reporter.id,
      targetKind: 'post',
      targetId: post.id,
      description: '問題のあるポストです',
    });
    await service.resolveReport({
      reportId: report.id,
      adminId: siteAdmin.id,
      actions: { falseReport: true, evidence: '根拠のない報告であることを確認しました' },
    });
    assert.equal(await trustScore(db, reporter.id), 0);
    assert.equal(await trustScore(db, author.id), 0);
  }
});

test('信頼スコアを得ているポストを処分しても対象者のスコアは上がらない', async () => {
  const { db, service, siteAdmin, author, reporter } = await setup();
  const ReputationService = require('./ReputationService');
  const post = await db.createPost({ userId: author.id, content: 'popular post' });
  await db.replaceReputationEvents(`post-trust:${post.id}`, [
    ReputationService.event('post', author.id, 'trust', 6.02, 0, '2026-11-01'),
  ]);
  const before = await trustScore(db, author.id);
  assert.ok(before > 0);
  const report = await service.createReport({
    reporterUserId: reporter.id,
    targetKind: 'post',
    targetId: post.id,
    description: '問題のあるポストです',
  });
  await service.resolveReport({
    reportId: report.id,
    adminId: siteAdmin.id,
    actions: { maskPost: true, maskReason: 'テスト' },
  });
  assert.ok((await trustScore(db, author.id)) < before);
});

test('同じポストへの複数の報告は1件に統合され、理由が一覧になる', async () => {
  const { db, service, author, reporter } = await setup();
  const reporter2 = await db.createUser({ name: 'reporter2' });
  const post = await db.createPost({ userId: author.id, content: 'plain post' });
  const first = await service.createReport({
    reporterUserId: reporter.id,
    targetKind: 'post',
    targetId: post.id,
    description: '理由その1です',
  });
  const second = await service.createReport({
    reporterUserId: reporter2.id,
    targetKind: 'post',
    targetId: post.id,
    description: '理由その2です',
  });
  assert.equal(second.id, first.id);
  const merged = await service.getReportById(first.id);
  assert.equal(merged.reports.length, 2);
  assert.deepEqual(merged.reports.map((entry) => entry.description), ['理由その1です', '理由その2です']);
  assert.deepEqual(merged.reports.map((entry) => entry.reporter_id), [reporter.id, reporter2.id]);

  const again = await service.createReport({
    reporterUserId: reporter.id,
    targetKind: 'post',
    targetId: post.id,
    description: '理由その1です',
  });
  assert.equal(again.id, first.id);
  assert.equal((await service.getReportById(first.id)).reports.length, 2);
});

test('統合された報告を処分しても対象者の減点は1件分だけ', async () => {
  const { db, service, siteAdmin, author, reporter } = await setup();
  const reporter2 = await db.createUser({ name: 'reporter2' });
  const post = await db.createPost({ userId: author.id, content: 'plain post' });
  const first = await service.createReport({
    reporterUserId: reporter.id,
    targetKind: 'post',
    targetId: post.id,
    description: '理由その1です',
  });
  await service.createReport({
    reporterUserId: reporter2.id,
    targetKind: 'post',
    targetId: post.id,
    description: '理由その2です',
  });
  await service.resolveReport({
    reportId: first.id,
    adminId: siteAdmin.id,
    actions: { maskPost: true, maskReason: 'テスト' },
  });
  assert.equal(await trustScore(db, author.id), -5);
});

test('完了したリクエストは削除されず、完了済みとして確認できる', async () => {
  const { db, service, siteAdmin, owner, author, reporter } = await setup();
  const post = await db.createPost({ userId: author.id, content: 'plain post' });
  const report = await service.createReport({
    reporterUserId: reporter.id,
    targetKind: 'post',
    targetId: post.id,
    description: '問題のあるポストです',
  });
  await service.resolveReport({
    reportId: report.id,
    adminId: siteAdmin.id,
    actions: { maskPost: true, maskReason: 'テスト' },
  });
  const kept = await service.getReportById(report.id);
  assert.equal(kept.status, 'resolved');
  const completed = await service.listReports({ status: 'resolved', adminId: siteAdmin.id });
  assert.ok(completed.some((entry) => entry.id === report.id));
  const active = await service.listReports({ status: 'assigned', adminId: siteAdmin.id });
  assert.ok(!active.some((entry) => entry.id === report.id));
  // 完了後は別の担当者が対応し直すことはできない。
  await assert.rejects(
    service.resolveReport({ reportId: report.id, adminId: owner.id, actions: {} }),
    /権限がありません/,
  );
  // 担当者本人が再び解決を呼んでも、結果は変わらない。
  await service.resolveReport({ reportId: report.id, adminId: siteAdmin.id, actions: {} });
  const after = await service.getReportById(report.id);
  assert.equal(after.status, 'resolved');
  assert.equal(after.resolution.actionTaken, true);
  assert.equal(Boolean((await db.getPostById(post.id)).mask), true);
});
