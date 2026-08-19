'use strict';

const express = require('express');
const config = require('../config');
const { requireAuthAllowFrozen } = require('../middleware/auth');
const { serializeUserBrief } = require('../utils/serialize');
const { getPublicUrl } = require('../utils/nyaitterAddress');
const {
  normalizeUserId,
  normalizeRole,
  getImposterMetadata,
  getImposterRole,
  isImposter,
  canManageImposter,
  toImposterSettings,
  listOwnedImposters,
  listAccessibleImposters,
} = require('../services/ImposterService');

const router = express.Router();

function getDbAdapter(req) {
  return req.app.locals.dbAdapter;
}

async function deleteStoredAttachments(storage, keys) {
  if (!storage || !Array.isArray(keys) || keys.length === 0) return;
  try {
    if (typeof storage.deleteMany === 'function') await storage.deleteMany(keys);
    else if (typeof storage.delete === 'function') await Promise.all(keys.map((key) => storage.delete(key)));
  } catch (error) {
    console.warn('[imposters] attachment deletion failed:', error.message);
  }
}

function requireInteractiveSession(req, res, next) {
  if (req.user?.tokenType !== 'session' || !req.user?.sessionTokenHash) {
    return res.status(403).json({ error: 'ログイン済み端末のセッションが必要です。' });
  }
  return next();
}

function serializeImposter(user, operatorId, publicUrl) {
  const metadata = getImposterMetadata(user);
  return {
    ...serializeUserBrief(user, publicUrl),
    imposter: {
      is_imposter: true,
      role: getImposterRole(user, operatorId),
      member_count: metadata?.members.length || 0,
      members: metadata?.members || [],
    },
  };
}

async function getManageableImposter(req, imposterId) {
  const db = getDbAdapter(req);
  const imposter = await db.getUserById(imposterId);
  if (!imposter || !isImposter(imposter)) return { db, imposter: null };
  if (!canManageImposter(imposter, req.user.id)) return { db, imposter: null };
  return { db, imposter };
}

router.get('/', requireAuthAllowFrozen, requireInteractiveSession, async (req, res) => {
  const db = getDbAdapter(req);
  try {
    const imposters = await listAccessibleImposters(db, req.user.id);
    res.json({
      imposters: imposters.map((imposter) => serializeImposter(
        imposter,
        req.user.id,
        getPublicUrl(req),
      )),
      limit: config.limits.impostersPerParent,
    });
  } catch (error) {
    console.error('[imposters] list error:', error);
    res.status(500).json({ error: 'インポスター一覧の取得に失敗しました。' });
  }
});

router.post('/', requireAuthAllowFrozen, requireInteractiveSession, async (req, res) => {
  const db = getDbAdapter(req);
  const parent = await db.getUserById(req.user.id);
  if (!parent || isImposter(parent)) {
    return res.status(403).json({ error: 'インポスターから新しいインポスターを作成することはできません。' });
  }

  const name = String(req.body?.name || '').trim();
  if (!name || name.length > config.limits.userNameLength.max) {
    return res.status(400).json({ error: 'インポスター名の長さが正しくありません。' });
  }

  try {
    const owned = await listOwnedImposters(db, parent.id);
    if (owned.length >= config.limits.impostersPerParent) {
      return res.status(409).json({ error: `インポスターは最大${config.limits.impostersPerParent}件まで作成できます。` });
    }

    const imposter = await db.createUser({
      name,
      auth_provider: 'imposter',
      settings: {
        imposter: toImposterSettings(parent.id),
      },
    });
    res.status(201).json({
      imposter: serializeImposter(imposter, parent.id, getPublicUrl(req)),
    });
  } catch (error) {
    console.error('[imposters] create error:', error);
    res.status(500).json({ error: 'インポスターの作成に失敗しました。' });
  }
});

router.post('/:imposterId/members', requireAuthAllowFrozen, requireInteractiveSession, async (req, res) => {
  const imposterId = normalizeUserId(req.params.imposterId);
  const memberId = normalizeUserId(req.body?.user_id);
  if (!imposterId || !memberId) {
    return res.status(400).json({ error: 'インポスターIDと共同運用者IDが必要です。' });
  }

  try {
    const { db, imposter } = await getManageableImposter(req, imposterId);
    if (!imposter) return res.status(403).json({ error: 'インポスターの管理権限がありません。' });
    const metadata = getImposterMetadata(imposter);
    if (memberId === metadata.parent_id || memberId === imposter.id) {
      return res.status(400).json({ error: '親IDまたはインポスター自身を共同運用者に追加することはできません。' });
    }
    const member = await db.getUserById(memberId);
    if (!member) return res.status(404).json({ error: '共同運用者が見つかりません。' });

    const members = metadata.members.filter((entry) => entry.user_id !== memberId);
    members.push({ user_id: memberId, role: normalizeRole(req.body?.role) });
    const updated = await db.updateUserProfile(imposter.id, {
      settings: {
        ...(imposter.settings || {}),
        imposter: toImposterSettings(metadata.parent_id, members),
      },
    });
    res.json({ imposter: serializeImposter(updated, req.user.id, getPublicUrl(req)) });
  } catch (error) {
    console.error('[imposters] add member error:', error);
    res.status(500).json({ error: '共同運用者の追加に失敗しました。' });
  }
});

router.patch('/:imposterId/members/:memberId', requireAuthAllowFrozen, requireInteractiveSession, async (req, res) => {
  const imposterId = normalizeUserId(req.params.imposterId);
  const memberId = normalizeUserId(req.params.memberId);
  if (!imposterId || !memberId) return res.status(400).json({ error: 'IDが正しくありません。' });

  try {
    const { db, imposter } = await getManageableImposter(req, imposterId);
    if (!imposter) return res.status(403).json({ error: 'インポスターの管理権限がありません。' });
    const metadata = getImposterMetadata(imposter);
    if (!metadata.members.some((entry) => entry.user_id === memberId)) {
      return res.status(404).json({ error: '共同運用者が見つかりません。' });
    }
    const members = metadata.members.map((entry) => (
      entry.user_id === memberId
        ? { user_id: memberId, role: normalizeRole(req.body?.role) }
        : entry
    ));
    const updated = await db.updateUserProfile(imposter.id, {
      settings: {
        ...(imposter.settings || {}),
        imposter: toImposterSettings(metadata.parent_id, members),
      },
    });
    res.json({ imposter: serializeImposter(updated, req.user.id, getPublicUrl(req)) });
  } catch (error) {
    console.error('[imposters] update member error:', error);
    res.status(500).json({ error: '共同運用者の更新に失敗しました。' });
  }
});

router.delete('/:imposterId/members/:memberId', requireAuthAllowFrozen, requireInteractiveSession, async (req, res) => {
  const imposterId = normalizeUserId(req.params.imposterId);
  const memberId = normalizeUserId(req.params.memberId);
  if (!imposterId || !memberId) return res.status(400).json({ error: 'IDが正しくありません。' });

  try {
    const { db, imposter } = await getManageableImposter(req, imposterId);
    if (!imposter) return res.status(403).json({ error: 'インポスターの管理権限がありません。' });
    const metadata = getImposterMetadata(imposter);
    const members = metadata.members.filter((entry) => entry.user_id !== memberId);
    if (members.length === metadata.members.length) {
      return res.status(404).json({ error: '共同運用者が見つかりません。' });
    }
    const updated = await db.updateUserProfile(imposter.id, {
      settings: {
        ...(imposter.settings || {}),
        imposter: toImposterSettings(metadata.parent_id, members),
      },
    });
    res.json({ imposter: serializeImposter(updated, req.user.id, getPublicUrl(req)) });
  } catch (error) {
    console.error('[imposters] remove member error:', error);
    res.status(500).json({ error: '共同運用者の削除に失敗しました。' });
  }
});

router.delete('/:imposterId', requireAuthAllowFrozen, requireInteractiveSession, async (req, res) => {
  const imposterId = normalizeUserId(req.params.imposterId);
  if (!imposterId) return res.status(400).json({ error: 'インポスターIDが正しくありません。' });

  try {
    const db = getDbAdapter(req);
    const imposter = await db.getUserById(imposterId);
    const metadata = getImposterMetadata(imposter);
    if (!imposter || !metadata || metadata.parent_id !== req.user.id) {
      return res.status(403).json({ error: 'インポスターを削除する権限がありません。' });
    }
    const attachmentKeys = await db.getAccountAttachmentKeys(imposter.id);
    await db.invalidateAllSessions(imposter.id);
    const deleted = await db.deleteAccount(imposter.id);
    if (!deleted) throw new Error('Imposter deletion did not complete');
    await deleteStoredAttachments(req.app.locals.storageAdapter, attachmentKeys);
    res.json({ success: true });
  } catch (error) {
    console.error('[imposters] delete error:', error);
    res.status(500).json({ error: 'インポスターの削除に失敗しました。' });
  }
});

module.exports = router;
