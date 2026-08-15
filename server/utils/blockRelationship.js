function normalizeUserId(value) {
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

function blocksUser(user, targetUserId) {
	const targetId = normalizeUserId(targetUserId);
	if (targetId == null || !Array.isArray(user?.block)) return false;
	return user.block.map(Number).includes(targetId);
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
