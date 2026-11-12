'use strict';

function normalizeBlockUserId(value) {
    if (
        value === null ||
        value === undefined ||
        (typeof value === 'string' && value.trim() === '')
    ) {
        return null;
    }
    const id = Number(value);
    return Number.isInteger(id) && id >= 0 ? id : null;
}

/**
 * ブロックリストを永続化・可視性判定で共通利用する形式へ正規化する。
 * 有効な非負整数だけを残し、重複と自分自身を除外して昇順にする。
 */
function normalizeBlockList(value, ownerUserId = null) {
    const ownerId = normalizeBlockUserId(ownerUserId);
    if (!Array.isArray(value)) return [];

    return [...new Set(value
        .map(normalizeBlockUserId)
        .filter((id) => id !== null && id !== ownerId))]
        .sort((left, right) => left - right);
}

module.exports = {
    normalizeBlockUserId,
    normalizeBlockList,
};
