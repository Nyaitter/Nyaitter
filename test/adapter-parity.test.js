'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const InMemoryAdapter = require('../server/adapters/database/InMemoryAdapter');
const LocalStorageAdapter = require('../server/adapters/storage/local/LocalStorageAdapter');
const ImageNormalizingStorageAdapter = require('../server/adapters/storage/ImageNormalizingStorageAdapter');
const StorageAdapter = require('../server/adapters/storage/StorageAdapter');
const DatabaseAdapter = require('../server/adapters/database/DatabaseAdapter');
const path = require('path');
const fs = require('fs');

test('DatabaseAdapter base class defines all required contract methods', () => {
  const db = new DatabaseAdapter();
  const baseMethods = Object.getOwnPropertyNames(DatabaseAdapter.prototype)
    .filter((m) => m !== 'constructor' && typeof db[m] === 'function');
  
  assert.ok(baseMethods.length > 50, `Expected > 50 methods, found ${baseMethods.length}`);
});

test('StorageAdapter base class defines all required contract methods', () => {
  const storage = new StorageAdapter();
  const baseMethods = Object.getOwnPropertyNames(StorageAdapter.prototype)
    .filter((m) => m !== 'constructor' && typeof storage[m] === 'function');
  
  assert.ok(baseMethods.includes('upload'));
  assert.ok(baseMethods.includes('delete'));
  assert.ok(baseMethods.includes('getPublicUrl'));
  assert.ok(baseMethods.includes('read'));
  assert.ok(baseMethods.includes('copy'));
  assert.ok(baseMethods.includes('deleteMany'));
  assert.ok(baseMethods.includes('getUsage'));
  assert.ok(baseMethods.includes('listFiles'));
});

test('InMemoryAdapter implements full user, session, group, dm, and post lifecycle', async () => {
  const db = new InMemoryAdapter();
  await db.connect();

  // 1. Create user
  const user = await db.createUser({
    name: 'TestUser',
    auth_provider: 'local',
    scid: 'test_scid_1',
  });
  assert.ok(user.id);
  assert.equal(user.name, 'TestUser');
  const originalUserId = user.id;

  // 2. Fetch by various keys
  const byId = await db.getUserById(originalUserId);
  assert.equal(byId.id, originalUserId);
  const byScid = await db.getUserByScid('test_scid_1');
  assert.equal(byScid.id, originalUserId);

  // 3. User update
  const updatedUser = await db.updateUserProfile(originalUserId, { bio: 'New bio' });
  assert.equal(updatedUser.bio, 'New bio');

  // 4. Sessions
  const session = await db.createSession(originalUserId, { userAgent: 'test-agent', ip: '127.0.0.1' });
  assert.ok(session.token);
  const fetchedSession = await db.getSessionByToken(session.token);
  assert.equal(fetchedSession.userId, originalUserId);

  const userSessions = await db.getUserSessions(originalUserId);
  assert.equal(userSessions.length, 1);

  // 5. Trust IP
  await db.trustLoginIp(originalUserId, { ipHash: 'hash1', ipMasked: '127.0.*' });
  const trusted = await db.getTrustedLoginIp(originalUserId, 'hash1');
  assert.ok(trusted);

  // 6. Login approvals
  const approval = await db.createLoginApproval({
    userId: originalUserId,
    ipHash: 'hash2',
    ipMasked: '192.168.*',
    pollTokenHash: 'pollhash1',
  });
  assert.ok(approval.id);
  const fetchedApproval = await db.getLoginApprovalByPollToken(approval.id, 'pollhash1');
  assert.ok(fetchedApproval);

  await db.decideLoginApproval(originalUserId, approval.id, 'approve');
  const consumed = await db.consumeLoginApproval(approval.id, 'pollhash1');
  assert.equal(consumed.status, 'consumed');

  // 7. Bot tokens
  await db.createBotToken(originalUserId, 'tok1', 'hash_tok1', 'MyBot');
  const tokens = await db.getUserBotTokens(originalUserId);
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].name, 'MyBot');

  // 8. Authorized apps
  const app = await db.createAuthorizedApp(originalUserId, 'app1', 'apphash1', 'TestApp', 'icon.png', ['read']);
  assert.ok(app.id);
  const userApps = await db.getUserAuthorizedApps(originalUserId);
  assert.equal(userApps.length, 1);

  // 9. Posts lifecycle
  const post = await db.createPost({
    userId: originalUserId,
    content: 'Hello #world #nyaitter test',
    tags: ['world', 'nyaitter', 'customtag'],
  });
  assert.ok(post.id);

  const postDetail = await db.getPostById(post.id);
  assert.equal(postDetail.id, post.id);

  // 10. Likes & Stars
  const likeRes = await db.toggleLike(originalUserId, post.id);
  assert.equal(likeRes.liked, true);
  const isLiked = await db.hasUserLikedPost(originalUserId, post.id);
  assert.equal(isLiked, true);

  const starRes = await db.toggleStar(originalUserId, post.id);
  assert.equal(starRes.starred, true);

  // 11. Trending (# and tags)
  const trendsSummary = await db.getTrendingHashtags(10, { summary: true });
  assert.ok(Array.isArray(trendsSummary.hashtags));
  assert.ok(Array.isArray(trendsSummary.tags));
  assert.ok(Array.isArray(trendsSummary.trends));

  // 12. Groups lifecycle
  const group = await db.createGroup({
    ownerId: originalUserId,
    name: 'Test Group',
    visibility: 'public',
  });
  assert.ok(group.id);

  const groupPost = await db.createPost({
    userId: originalUserId,
    groupId: group.id,
    content: 'Group post',
  });
  assert.ok(groupPost.id);
  const groupPostResult = await db.getGroupPostIds(group.id);
  assert.ok(groupPostResult.ids.includes(groupPost.id));

  // 13. DM lifecycle
  const user2 = await db.createUser({ name: 'User2', auth_provider: 'local' });
  const dm = await db.createGroupDm({
    hostId: originalUserId,
    member: [originalUserId, user2.id],
    title: 'DM 1-on-1',
  });
  assert.ok(dm.id);

  const appended = await db.appendToGroupDm(dm.id, { userid: originalUserId, text: 'hi' }, originalUserId);
  assert.equal(appended.post.length, 1);

  // 14. E2E Keys
  await db.setDmPublicKey(originalUserId, 'test_public_key');
  const e2eKeys = await db.getDmPublicKeys([originalUserId]);
  assert.equal(e2eKeys[0].public_key, 'test_public_key');

  // 15. Reassign User ID
  await db.beginAccountOperation(originalUserId, 'reassigning');
  const reassigned = await db.reassignUserId(originalUserId);
  assert.ok(reassigned);
  assert.notEqual(reassigned.id, originalUserId);

  // 16. Notifications
  const notif = await db.createNotification({
    userId: reassigned.id,
    type: 'admin_notice',
    message: 'Test notification',
  });
  assert.ok(notif.id);
  const notifs = await db.getNotifications(reassigned.id);
  assert.equal(notifs.length, 1);

  // 17. Snapshot Export and Import
  const snapshot = await db.exportDataSnapshot();
  assert.ok(snapshot.version);
  assert.ok(snapshot.tables);

  const db2 = new InMemoryAdapter();
  await db2.connect();
  await db2.importDataSnapshot(snapshot, { replace: true });
  const importedUser = await db2.getUserById(reassigned.id);
  assert.ok(importedUser);
  assert.equal(importedUser.name, 'TestUser');

  await db.disconnect();
  await db2.disconnect();
});

test('LocalStorageAdapter works properly for upload, read, copy, delete, listFiles, and usage', async () => {
  const tmpDir = path.join(__dirname, 'test_tmp_storage');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const storage = new LocalStorageAdapter({ uploadDir: tmpDir, publicEndpoint: 'http://localhost/uploads' });
  const result = await storage.upload({
    file: Buffer.from('hello world content'),
    fileName: 'test.txt',
    contentType: 'text/plain',
    folder: 'attachments',
  });
  assert.ok(result.id);
  assert.ok(result.url);

  const readResult = await storage.read(result.id);
  assert.equal(readResult.buffer.toString('utf-8'), 'hello world content');

  const copyResult = await storage.copy(result.id, 'attachments/copied.txt');
  assert.ok(copyResult.id);

  const list = await storage.listFiles('attachments');
  assert.ok(list.length >= 2);

  const usage = await storage.getUsage('attachments');
  assert.ok(usage > 0);

  await storage.delete(result.id);
  await storage.delete(copyResult.id);

  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('ImageNormalizingStorageAdapter delegates properly', async () => {
  const tmpDir = path.join(__dirname, 'test_tmp_image_storage');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const local = new LocalStorageAdapter({ uploadDir: tmpDir, publicEndpoint: 'http://localhost/uploads' });
  const normalizing = new ImageNormalizingStorageAdapter(local);

  // Normal text upload bypasses image normalization
  const result = await normalizing.upload({
    file: Buffer.from('non-image data'),
    fileName: 'sample.txt',
    contentType: 'text/plain',
    folder: 'attachments',
  });
  assert.ok(result.id);

  await normalizing.delete(result.id);
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});
