'use strict';

const {
    normalizeBlockUserId,
    normalizeBlockList,
} = require('./blockList');

function normalizeUserId(value) {
    return normalizeBlockUserId(value);
}

function blocksUser(user, targetUserId) {
    const targetId = normalizeUserId(targetUserId);
    if (targetId == null) return false;
    return normalizeBlockList(user?.block, user?.id).includes(targetId);
}

/**
 * 二者のどちらか一方が他方をブロックしているかを返す。
 * ブロックの可視性・通知・DM制御は、すべてこの対称的な関係で判断する。
 */
async function hasBlockRelationship(db, firstUserId, secondUserId) {
    const firstId = normalizeUserId(firstUserId);
    const secondId = normalizeUserId(secondUserId);
    if (firstId == null || secondId == null || firstId === secondId) return false;
    if (typeof db?.getUserById !== 'function') return false;

    const [firstUser, secondUser] = await Promise.all([
        db.getUserById(firstId),
        db.getUserById(secondId),
    ]);
    return blocksUser(firstUser, secondId) || blocksUser(secondUser, firstId);
}

module.exports = {
    normalizeUserId,
    blocksUser,
    hasBlockRelationship,
};
