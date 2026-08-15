const { hasBlockRelationship } = require('../utils/blockRelationship');

function getDmUnreadCount(dm, userId) {
	return Number(
		dm?.unread?.[userId] ??
		dm?.unread?.[String(userId)] ??
		dm?.unread_count ??
		0,
	);
}

async function hasBlockedDmMember(db, userId, memberIds) {
	for (const memberId of new Set((memberIds || []).map(Number))) {
		if (memberId === Number(userId)) continue;
		if (await hasBlockRelationship(db, userId, memberId)) return true;
	}
	return false;
}

/**
 * 閲覧者に表示できるDMの未読合計を返す。
 * ブロック関係を含む会話は、相手メッセージと存在を推測できる未読数の双方を除外する。
 */
async function getVisibleDmUnreadCount(db, userId) {
	if (typeof db?.getGroupDmsForUser !== 'function') {
		return db?.getGroupDmUnreadTotal
			? db.getGroupDmUnreadTotal(userId)
			: 0;
	}

	const dms = await db.getGroupDmsForUser(userId);
	let unreadCount = 0;
	for (const dm of dms || []) {
		if (await hasBlockedDmMember(db, userId, dm.member || [])) continue;
		unreadCount += getDmUnreadCount(dm, userId);
	}
	return unreadCount;
}

module.exports = {
	getDmUnreadCount,
	hasBlockedDmMember,
	getVisibleDmUnreadCount,
};
