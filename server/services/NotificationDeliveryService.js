const {
	hasBlockRelationship,
	normalizeUserId,
} = require('../utils/blockRelationship');

/**
 * 送信者と通知先の間にブロック関係がなければ通知を作成する。
 * fromUserId を持たないシステム通知は従来どおり作成する。
 */
async function createNotificationIfAllowed(db, notificationData) {
	const recipientId = normalizeUserId(notificationData?.userId);
	const senderId = normalizeUserId(notificationData?.fromUserId);
	if (
		recipientId != null &&
		senderId != null &&
		recipientId !== senderId &&
		await hasBlockRelationship(db, recipientId, senderId)
	) {
		return null;
	}
	return db.createNotification(notificationData);
}

module.exports = {
	createNotificationIfAllowed,
};
