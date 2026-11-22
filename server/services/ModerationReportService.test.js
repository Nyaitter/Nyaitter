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
