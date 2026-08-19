'use strict';

const IMPOSTER_ROLES = new Set(['manager', 'editor']);

function normalizeUserId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function normalizeRole(value, fallback = 'editor') {
  return IMPOSTER_ROLES.has(value) ? value : fallback;
}

function getImposterMetadata(user) {
  const source = user?.settings?.imposter;
  const parentId = normalizeUserId(source?.parent_id);
  if (!parentId) return null;

  const members = Array.isArray(source.members)
    ? source.members
      .map((member) => {
        const userId = normalizeUserId(member?.user_id);
        return userId
          ? { user_id: userId, role: normalizeRole(member?.role) }
          : null;
      })
      .filter(Boolean)
    : [];

  return {
    parent_id: parentId,
    members: [...new Map(members.map((member) => [member.user_id, member])).values()],
  };
}

function isImposter(user) {
  return getImposterMetadata(user) != null;
}

function getImposterRole(user, operatorId) {
  const metadata = getImposterMetadata(user);
  const normalizedOperatorId = normalizeUserId(operatorId);
  if (!metadata || !normalizedOperatorId) return null;
  if (metadata.parent_id === normalizedOperatorId) return 'owner';
  return metadata.members.find((member) => member.user_id === normalizedOperatorId)?.role || null;
}

function canOperateImposter(user, operatorId) {
  return getImposterRole(user, operatorId) != null;
}

function canManageImposter(user, operatorId) {
  const role = getImposterRole(user, operatorId);
  return role === 'owner' || role === 'manager';
}

function toImposterSettings(parentId, members = []) {
  return {
    parent_id: normalizeUserId(parentId),
    members: members
      .map((member) => {
        const userId = normalizeUserId(member?.user_id);
        return userId ? { user_id: userId, role: normalizeRole(member?.role) } : null;
      })
      .filter(Boolean),
  };
}

async function listImposters(db) {
  const users = await db.getAllUsers();
  return (users || []).filter(isImposter);
}

async function listOwnedImposters(db, parentId) {
  const normalizedParentId = normalizeUserId(parentId);
  if (!normalizedParentId) return [];
  const imposters = await listImposters(db);
  return imposters.filter(
    (imposter) => getImposterMetadata(imposter)?.parent_id === normalizedParentId,
  );
}

async function listAccessibleImposters(db, operatorId) {
  const normalizedOperatorId = normalizeUserId(operatorId);
  if (!normalizedOperatorId) return [];
  const imposters = await listImposters(db);
  return imposters.filter((imposter) => canOperateImposter(imposter, normalizedOperatorId));
}

module.exports = {
  IMPOSTER_ROLES,
  normalizeUserId,
  normalizeRole,
  getImposterMetadata,
  isImposter,
  getImposterRole,
  canOperateImposter,
  canManageImposter,
  toImposterSettings,
  listOwnedImposters,
  listAccessibleImposters,
};
