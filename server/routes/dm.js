const api = require('../utils/ApiRegistry');
const crypto = require('crypto');
const { requireAuth } = require('../middleware/auth');
const { hasBlockRelationship } = require('../utils/blockRelationship');
const { normalizeBlockList } = require('../utils/blockList');
const { getVisibleDmUnreadCount } = require('../services/DmVisibilityService');
const config = require('../config');
const { attachDisplayRanks, publicDisplayRanks } = require('../utils/rankDisplay');
const { isWithinRange, describeIntegerRange } = require('../utils/settingFormats');

const router = api.createRouter({
	tag: 'dm',
	basePath: '/dm',
	description: 'ダイレクトメッセージAPI',
});

const { createRateLimiter } = require('../middleware/rateLimit');
const dmSendLimiter = createRateLimiter(config.rateLimit.dmSend);

function getDbAdapter(req) {
	return req.app.locals.dbAdapter;
}

function lengthError(label, range) {
	return `${label} must be ${describeIntegerRange(range)} characters`;
}

function canonicalDmValue(value) {
	if (Array.isArray(value)) return value.map(canonicalDmValue);
	if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalDmValue(value[key])]));
	return value;
}

async function publishDmMessage(req, userIds, dmId, message, sender = null) {
	const realtime = req.app.locals.realtime;
	if (!realtime) return;

	const db = getDbAdapter(req);
	const senderId = Number(message?.userid);
	let blockedUserIds = new Set();
	const recipientIds = new Set((userIds || []).map(Number));
	if (Number.isInteger(senderId) && senderId >= 0) {
		const memberIds = [senderId, ...recipientIds];
		let usersById = null;
		try {
			const users = db.getUsersByIds
				? await db.getUsersByIds(memberIds)
				: await Promise.all(memberIds.map((id) => db.getUserById(id)));
			usersById = new Map((users || []).filter(Boolean).map((user) => [Number(user.id), user]));
		} catch (_) {
			// 会話相手の取得に失敗しても、DM 配信自体は継続する。
		}
		blockedUserIds = await getBlockedDmMemberIds(db, senderId, [...recipientIds], usersById);
	}
	for (const userId of new Set((userIds || []).map(Number))) {
		if (!Number.isInteger(userId) || userId < 0) continue;
		if (blockedUserIds.has(userId)) {
			continue;
		}
		try {
			realtime.publishDmMessage(userId, dmId, message, sender);
		} catch (error) {
			console.warn('[dm] message realtime delivery failed:', error.message);
		}
	}
}

async function publishDmUnreadCounts(req, userIds, dmId = null) {
	const realtime = req.app.locals.realtime;
	if (!realtime) return;

	await Promise.all([...new Set((userIds || []).map(Number))].map(async (userId) => {
		if (!Number.isInteger(userId) || userId < 0) return;
		try {
			await realtime.publishDmUnreadCount(userId, getDbAdapter(req), dmId);
		} catch (error) {
			console.warn('[dm] unread realtime delivery failed:', error.message);
		}
	}));
}

async function publishDmReadEvent(req, userIds, dmId, readerId) {
	const realtime = req.app.locals.realtime;
	if (!realtime) return;

	for (const userId of new Set((userIds || []).map(Number))) {
		if (!Number.isInteger(userId) || userId < 0) continue;
		try {
			if (typeof realtime.publishDmRead === 'function') {
				realtime.publishDmRead(userId, dmId, readerId);
			} else if (typeof realtime.sendToUser === 'function') {
				realtime.sendToUser(userId, {
					type: 'dm_read',
					dm_id: String(dmId),
					reader_id: Number(readerId),
				});
			}
		} catch (error) {
			console.warn('[dm] read realtime delivery failed:', error.message);
		}
	}
}

function serializeDmMember(user) {
	return {
		id: user.id,
		name: user.name || '',
		scid: user.scid || null,
		icon_data: user.icon_data || null,
		display_ranks: publicDisplayRanks(user),
	};
}

async function appendSystemEvent(req, dmId, actorId, content) {
	const db = getDbAdapter(req);
	const message = { id: crypto.randomUUID(), type: 'system', userid: Number(actorId), content, created_at: new Date().toISOString() };
	const updated = await db.appendToGroupDm(dmId, message, Number(actorId));
	if (!updated) throw new Error('DM system event could not be saved');
	const actor = await db.getUserById(actorId);
	await attachDisplayRanks(db, [actor]);
	await publishDmMessage(req, updated.member || [], dmId, message, actor ? serializeDmMember(actor) : null);
	await publishDmUnreadCounts(req, updated.member || [], dmId);
	return updated;
}

function invitationEvent(actorId, invitedIds) {
	return `@${actorId}が@${invitedIds[0]}${invitedIds.length > 1 ? `、ほか${invitedIds.length - 1}人のユーザー` : ''}を招待しました`;
}

function dmState(dm) {
	return {
		state_version: String(dm.state_version ?? 0),
		host_id: Number(dm.host_id),
		member: (dm.member || []).map(Number),
		accepted: (Array.isArray(dm.accepted) ? dm.accepted : (Array.isArray(dm.unread?._accepted) ? dm.unread._accepted : dm.member || [])).map(Number),
	};
}

async function buildDmPayload(db, dms, userId, { includePosts = true } = {}) {
	const memberIds = [...new Set((dms || []).flatMap((dm) => dm.member || []))];
	let users = [];
	let usersFetchSucceeded = true;
	if (memberIds.length > 0) {
		try {
			users = db.getUsersByIds
				? await db.getUsersByIds(memberIds)
				: await Promise.all(memberIds.map((id) => db.getUserById(id)));
		} catch (_) {
			users = [];
			usersFetchSucceeded = false;
		}
	}
	await attachDisplayRanks(db, users);
	const usersById = usersFetchSucceeded
		? new Map((users || []).filter(Boolean).map((user) => [Number(user.id), user]))
		: null;
	const records = await Promise.all(
		(dms || []).map(async (dm) => {
			let source = dm;
			if (!includePosts && typeof db.getGroupDm === 'function') {
				// 一覧では post が最新1件に切り詰められる場合があるため、ブロック関係が
				// ある会話だけ全履歴を取得し、表示可能な件数を正確に数える。
				const authorIds = (dm.post || []).map((message) => Number(message?.userid)).filter(Number.isInteger);
				const blocked = await getBlockedDmMemberIds(db, userId, [...(dm.member || []), ...authorIds], usersById);
				if (blocked.size > 0) {
					try {
						const full = await db.getGroupDm(dm.id);
						if (full) source = full;
					} catch (_) {
						// 全履歴が取れない場合は切り詰められたまま返す。
					}
				}
			}
			return serializeGroupDm(db, source, userId, { includePosts, usersById });
		}),
	);
	return {
		dm: records,
		members: (users || []).filter(Boolean).map(serializeDmMember),
		unread_total: records.reduce((sum, dm) => sum + Number(dm.unread_count || 0), 0),
	};
}

function validatedDmAttachments(message) {
	if (message.attachments === undefined) return undefined;
	if (!Array.isArray(message.attachments)) {
		throw new Error('attachments must be an array');
	}
	if (message.attachments.length > 50) {
		throw new Error('Too many attachments');
	}
	for (const attachment of message.attachments) {
		if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) {
			throw new Error('Invalid attachment');
		}
	}
	return message.attachments;
}

function normalizeClientMessage(message, userId) {
	if (!message || typeof message !== 'object') {
		throw new Error('message is required');
	}
	if (message.type === 'system') {
		throw new Error('System messages cannot be sent by users');
	}
	const attachments = validatedDmAttachments(message);
	if (message.reply_to !== undefined && (typeof message.reply_to !== 'string' || !message.reply_to.trim() || message.reply_to.length > 256 || message.reply_to !== message.reply_to.trim())) {
		throw new Error('Invalid reply_to');
	}

	const content = String(message.content || '').trim();

	// E2E暗号化メッセージ
	if (message.e2e && typeof message.e2e === 'object') {
		if (!config.dm.e2eEnabled) {
			throw new Error('DM E2E encryption is temporarily disabled');
		}
		if (content) {
			throw new Error('E2E messages must not contain plaintext content');
		}
		const e2e = message.e2e;
		if (e2e.v !== 1) {
			throw new Error('Unsupported E2E format');
		}
			if (
				typeof e2e.eph !== 'string' ||
				!isWithinRange(e2e.eph.length, config.limits.dmE2eEphemeralKeyLength)
			) {
				throw new Error(lengthError('e2e.eph', config.limits.dmE2eEphemeralKeyLength));
			}
		if (!e2e.ct || typeof e2e.ct !== 'object') {
			throw new Error('e2e.ct is required');
		}
		const ctEntries = Object.entries(e2e.ct);
		if (ctEntries.length === 0) {
			throw new Error('e2e.ct is empty');
		}
		let totalDataLength = 0;
		for (const [recipientId, entry] of ctEntries) {
			const numericId = Number(recipientId);
			if (!Number.isInteger(numericId) || numericId < 0) {
				throw new Error('Invalid E2E recipient id');
			}
			if (!entry || typeof entry !== 'object') {
				throw new Error('Invalid E2E ciphertext entry');
			}
			if (
				typeof entry.iv !== 'string' || entry.iv.length === 0 ||
				typeof entry.data !== 'string' || entry.data.length === 0
			) {
				throw new Error('Invalid E2E ciphertext');
			}
				if (!isWithinRange(entry.data.length, config.limits.dmE2eCiphertextLength)) {
					throw new Error(lengthError('E2E ciphertext', config.limits.dmE2eCiphertextLength));
				}
			totalDataLength += entry.data.length;
		}
			if (!isWithinRange(totalDataLength, config.limits.dmE2ePayloadLength)) {
				throw new Error(lengthError('E2E payload', config.limits.dmE2ePayloadLength));
			}
		return {
			id: crypto.randomUUID(),
			created_at: new Date().toISOString(),
			type: 'user',
			userid: userId,
			content: '',
			e2e,
			...(message.reply_to !== undefined ? { reply_to: message.reply_to } : {}),
			...(attachments !== undefined ? { attachments } : {}),
		};
	}

	if (content && !isWithinRange(content.length, config.limits.dmContentLength)) {
		throw new Error(lengthError('DM content', config.limits.dmContentLength));
	}
	if (!content && (!attachments || attachments.length === 0)) {
		throw new Error('Message content or attachments are required');
	}

	return {
		id: crypto.randomUUID(),
		created_at: new Date().toISOString(),
		type: 'user',
		userid: userId,
		content,
		...(message.reply_to !== undefined ? { reply_to: message.reply_to } : {}),
		...(attachments !== undefined ? { attachments } : {}),
	};
}

function messageTimestampValue(message) {
	return message?.created_at || message?.createdAt || message?.time || null;
}

function computeSerializedReadCount(dm, message, index, totalRawCount) {
	if (message.read_count !== undefined) {
		return typeof message.read_count === 'number' ? message.read_count : 0;
	}
	const unreadMap = dm.unread || {};
	const senderId = Number(message.userid);
	const recipients = (dm.member || []).map(Number).filter((id) => id !== senderId);
	let readers = 0;
	for (const recipientId of recipients) {
		const unreadForRecipient = Number(unreadMap[recipientId] ?? unreadMap[String(recipientId)] ?? 0);
		const unreadStartIndex = Math.max(0, totalRawCount - unreadForRecipient);
		if (index < unreadStartIndex) {
			readers += 1;
		}
	}
	return readers;
}

// 保存済みメッセージと GET 応答の post 要素は、read_count の補完と時刻の
// 表現（created_at / createdAt / time）だけが異なる。比較はその2点だけを
// 応答時の値にそろえ、それ以外の項目は本文の型を含めて厳密に比べる。
function serializedMessageShape(message, derivedReadCount) {
	const { time: _time, createdAt: _createdAt, read_count: readCount, created_at: _createdAtField, ...rest } = message || {};
	const effectiveReadCount = readCount !== undefined
		? (typeof readCount === 'number' ? readCount : 0)
		: (derivedReadCount ?? null);
	return canonicalDmValue({
		...rest,
		created_at: messageTimestampValue(message),
		read_count: effectiveReadCount,
	});
}

function hasExtraTimestampTampering(requested, original) {
	for (const key of ['time', 'createdAt']) {
		if (Object.prototype.hasOwnProperty.call(requested || {}, key) && requested[key] !== (original || {})[key]) {
			return true;
		}
	}
	return false;
}

function hasMessageHistoryChanged(requested, original, derivedReadCount) {
	if (hasExtraTimestampTampering(requested, original)) {
		return true;
	}
	if (JSON.stringify(serializedMessageShape(requested, derivedReadCount)) !== JSON.stringify(serializedMessageShape(original, derivedReadCount))) {
		return true;
	}
	// 保存時に前後の空白は取り除かれるため、空白だけの変更は改変とみなす。
	const trimmed = typeof requested.content === 'string' ? requested.content.trim() : '';
	return trimmed !== '' && trimmed !== String(original.content ?? '');
}

function hasHistoryEditBeyondDeletion(requested, original, removedIds, derivedReadCount) {
	if (hasExtraTimestampTampering(requested, original)) return true;
	const req = serializedMessageShape(requested, derivedReadCount);
	const orig = serializedMessageShape(original, derivedReadCount);
	if (req.reply_to !== orig.reply_to && !(req.reply_to === undefined && removedIds.has(orig.reply_to))) return true;
	delete req.reply_to;
	delete orig.reply_to;
	if (JSON.stringify(req) !== JSON.stringify(orig)) return true;
	const trimmed = typeof requested.content === 'string' ? requested.content.trim() : '';
	return trimmed !== '' && trimmed !== String(original.content ?? '');
}

function validateMessageHistoryUpdate(existingMessages, requestedMessages, userId, readCountById = null) {
	if (!Array.isArray(requestedMessages)) {
		throw new Error('post must be an array');
	}

	const existingById = new Map(existingMessages.map((message) => [message.id, message]));
	const requestedIds = new Set();
	for (const message of requestedMessages) {
		if (!message || typeof message.id !== 'string' || requestedIds.has(message.id)) {
			throw new Error('Invalid message history');
		}
		requestedIds.add(message.id);
	}
	const removedIds = new Set();
	for (const original of existingMessages) {
		if (requestedIds.has(original.id)) continue;
		if (original.userid !== userId || original.type !== 'user') {
			throw new Error('You can only delete your own messages');
		}
		removedIds.add(original.id);
	}

	for (const [index, message] of requestedMessages.entries()) {
		const original = existingById.get(message.id);
		if (!original) {
			throw new Error('New messages must use the send endpoint');
		}
		if (original.userid !== userId) {
			if (hasMessageHistoryChanged(message, original, readCountById?.get(original.id))) {
				throw new Error('You can only edit your own messages');
			}
			requestedMessages[index] = original;
			continue;
		}
		if (message.userid !== userId) {
			throw new Error('You can only edit your own messages');
		}
		// システムメッセージは本人の発言ではないため、変更せずに残すことだけ認める。
		if (original.type !== 'user') {
			if (hasMessageHistoryChanged(message, original, readCountById?.get(original.id))) throw new Error('You can only edit your own messages');
			requestedMessages[index] = original;
			continue;
		}
		if (message.type !== 'user') {
			throw new Error('You can only edit your own messages');
		}
		// 暗号化メッセージは単一編集（PATCH）でも変更できないため、履歴更新でも暗号文の差し替えを認めない。
		if ((original.e2e !== undefined || message.e2e !== undefined)
			&& JSON.stringify(canonicalDmValue(message.e2e ?? null)) !== JSON.stringify(canonicalDmValue(original.e2e ?? null))) {
			throw new Error('E2E messages cannot be edited');
		}
		if (message.reply_to !== original.reply_to && !(message.reply_to === undefined && removedIds.has(original.reply_to))) throw new Error('Reply reference cannot be edited');
		if (!original.e2e && message.content !== undefined && typeof message.content !== 'string') {
			throw new Error('Invalid message content');
		}
		validatedDmAttachments(message);
		const content = String(message.content || '').trim();
		if (content && !message.e2e && !isWithinRange(content.length, config.limits.dmContentLength)) {
			throw new Error(lengthError('DM content', config.limits.dmContentLength));
		}
	}

	if (removedIds.size === 0) return removedIds;

	// 削除したメッセージを返信先にしている自分のメッセージは、参照先の表示だけ外す
	// (残したままだと存在しないIDを指してしまう)。
	const requestedPatched = requestedMessages.map((message) => {
		if (!removedIds.has(message.reply_to)) return message;
		// 相手の行は一切変更しない（自分の削除で他人の発言を書き換えない）。
		if (Number(message.userid) !== Number(userId)) return message;
		const { reply_to: _replyTo, ...rest } = message;
		return rest;
	});
	requestedMessages.splice(0, requestedMessages.length, ...requestedPatched);
	return removedIds;
}

async function findDirectDmBetweenUsers(db, userId, otherUserId) {
	const memberIds = Array.from(new Set([Number(userId), Number(otherUserId)]));
	if (memberIds.length === 0 || memberIds.some((id) => !Number.isInteger(id) || id < 0)) {
		return null;
	}
	if (typeof db.findGroupDmByMembers === 'function') {
		return db.findGroupDmByMembers(memberIds);
	}
	// findGroupDmByMembers を持たないアダプタでは一覧から完全一致を探す。
	const dms = await db.getGroupDmsForUser(Number(userId));
	const normalizedMemberIds = [...memberIds].sort((a, b) => a - b);
	return (dms || []).find((dm) => {
		if (!Array.isArray(dm?.member)) return false;
		const members = dm.member.map(Number).sort((a, b) => a - b);
		return members.length === normalizedMemberIds.length
			&& members.every((id, index) => id === normalizedMemberIds[index]);
	}) || null;
}

async function getBlockedDmMemberIds(db, userId, memberIds, usersById = null) {
	const blockedMemberIds = new Set();
	const userCache = usersById instanceof Map ? usersById : null;
	for (const memberId of new Set((memberIds || []).map(Number))) {
		if (memberId === Number(userId)) continue;
		if (userCache && userCache.has(Number(userId)) && userCache.has(memberId)) {
			const userBlocksMember = normalizeBlockList(userCache.get(Number(userId))?.block, userId).includes(memberId);
			const memberBlocksUser = normalizeBlockList(userCache.get(memberId)?.block, memberId).includes(Number(userId));
			if (userBlocksMember || memberBlocksUser) blockedMemberIds.add(memberId);
			continue;
		}
		// 一括取得が部分結果の場合は、欠けた相手をブロックなしとみなさず個別に確認する。
		if (await hasBlockRelationship(db, userId, memberId)) {
			blockedMemberIds.add(memberId);
		}
	}
	return blockedMemberIds;
}

async function hasBlockedDmMemberPair(db, memberIds) {
	const uniqueMemberIds = [...new Set((memberIds || []).map(Number))];
	let usersById = null;
	try {
		const users = db.getUsersByIds
			? await db.getUsersByIds(uniqueMemberIds)
			: await Promise.all(uniqueMemberIds.map((id) => db.getUserById(id)));
		usersById = new Map((users || []).filter(Boolean).map((user) => [Number(user.id), user]));
	} catch (_) {
		// 会話相手を取得できない場合は、ブロック関係なしとして扱う。
	}
	if (usersById && uniqueMemberIds.every((id) => usersById.has(id))) {
		for (let index = 0; index < uniqueMemberIds.length; index += 1) {
			const firstId = uniqueMemberIds[index];
			const firstBlocks = new Set(normalizeBlockList(usersById.get(firstId)?.block, firstId));
			for (let otherIndex = index + 1; otherIndex < uniqueMemberIds.length; otherIndex += 1) {
				const secondId = uniqueMemberIds[otherIndex];
				if (firstBlocks.has(secondId) || normalizeBlockList(usersById.get(secondId)?.block, secondId).includes(firstId)) {
					return true;
				}
			}
		}
		return false;
	}
	for (let index = 0; index < uniqueMemberIds.length; index += 1) {
		for (let otherIndex = index + 1; otherIndex < uniqueMemberIds.length; otherIndex += 1) {
			if (await hasBlockRelationship(db, uniqueMemberIds[index], uniqueMemberIds[otherIndex])) {
				return true;
			}
		}
	}
	return false;
}

function normalizeDmMemberIds(value) {
	let parsed = value;
	if (typeof parsed === 'string') {
		try {
			parsed = JSON.parse(parsed);
		} catch (_) {
			parsed = [];
		}
	}
	if (!Array.isArray(parsed)) return [];
	return parsed
		.map((member) => member && typeof member === 'object' ? (member.id ?? member.user_id ?? member.userId) : member)
		.map(Number)
		.filter((id) => Number.isInteger(id) && id >= 0);
}

function getAcceptedDmMemberIds(dm) {
	if (dm?.accepted !== undefined && dm?.accepted !== null) {
		return normalizeDmMemberIds(dm.accepted);
	}
	if (dm?.unread && Object.prototype.hasOwnProperty.call(dm.unread, '_accepted')) {
		return normalizeDmMemberIds(dm.unread._accepted);
	}
	return normalizeDmMemberIds(dm?.member);
}

async function serializeGroupDm(db, dm, userId, { includePosts = true, usersById = null, blockedMemberIds: providedBlockedMemberIds = null } = {}) {
	const rawMessages = dm.post ? dm.post.slice() : [];
	// 退出済みの送信者も履歴には残る。現在のメンバーだけで判定すると再び見えてしまう。
	const authorIds = rawMessages.map((message) => Number(message?.userid)).filter(Number.isInteger);
	const blockedMemberIds = providedBlockedMemberIds
		? new Set([...providedBlockedMemberIds].map(Number))
		: await getBlockedDmMemberIds(db, userId, [...(dm.member || []), ...authorIds], usersById && authorIds.every((id) => usersById.has(id)) ? usersById : null);
	const totalRawCount = rawMessages.length;
	const rawMessageIds = new Set(rawMessages.map((message) => message?.id));

	const messages = rawMessages
		.map((message, index) => ({ message, index }))
		.filter(({ message }) => !blockedMemberIds.has(Number(message?.userid)))
		.map(({ message, index }) => {
			const { time, createdAt, ...rest } = message || {};
			const serialized = {
				...rest,
				created_at: message?.created_at || createdAt || time || null,
				read_count: computeSerializedReadCount(dm, message || {}, index, totalRawCount),
			};
			// 削除済みメッセージへの返信参照は、存在しないIDを指すため応答から外す。
			if (serialized.reply_to !== undefined && !rawMessageIds.has(serialized.reply_to)) {
				delete serialized.reply_to;
			}
			return serialized;
		});
	const latestMessage = messages.length > 0 ? messages[messages.length - 1] : null;
	const unreadCount = Number(
		dm.unread?.[userId] ?? dm.unread?.[String(userId)] ?? dm.unread_count ?? 0,
	);
	const acceptedList = getAcceptedDmMemberIds(dm);
	const isPending = !acceptedList.includes(Number(userId));
	// 一覧取得では dm.post が最新1件のみの正規化済み DM が返るため、
	// 会話全体の件数は dm.message_count を優先し、無ければ従来どおり件数でフォールバックする。
	// (InMemory / D1 アダプタは message_count を返さない可能性がある)
	const rawMessageCount = Number(dm.message_count);
	// ブロック相手のメッセージが含まれる場合は全件数を返すと非表示分が推測できるため、表示可能な件数だけを返す。
	const messageCount = blockedMemberIds.size > 0
		? messages.length
		: (dm.message_count !== undefined
			&& dm.message_count !== null
			&& Number.isFinite(rawMessageCount))
			? rawMessageCount
			: messages.length;

	return {
		id: dm.id,
		title: dm.title || '',
		member: dm.member.slice(),
		is_accepted: !isPending,
		is_pending: isPending,
		host_id: dm.host_id,
		...(dm.state_version == null ? {} : { state_version: String(dm.state_version) }),
		created_at: dm.created_at || dm.createdAt || dm.time || null,
		post: includePosts ? messages : [],
		message_count: messageCount,
		latest_message: includePosts ? null : (latestMessage ? {
			id: latestMessage.id,
			created_at: latestMessage.created_at,
			type: latestMessage.type,
			userid: latestMessage.userid || null,
			content: latestMessage.e2e
				? '🔒 暗号化されたメッセージ'
				: String(latestMessage.content || '').slice(0, 200),
		} : null),
		// ブロックした相手の未読数から、メッセージの存在を推測できないようにする。
		unread_count: blockedMemberIds.size > 0 || isPending ? 0 : unreadCount,
	};
}

router.get({
	path: '/',
	summary: 'DMグループ一覧の取得',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = req.user.id;
	const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
	const offset = parseInt(req.query.offset, 10) || 0;

	try {
		const dms = await db.getGroupDmsForUser(userId, { limit, offset });
		const payload = await buildDmPayload(db, dms, userId, { includePosts: false });
		res.json(payload);
	} catch (err) {
		console.error('[dm] list error:', err);
		res.status(500).json({ error: 'DMの取得に失敗しました' });
	}
});

router.get({
	path: '/unread',
	summary: 'DM全体の未読件数取得',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = req.user.id;

	try {
		const count = await getVisibleDmUnreadCount(db, userId);
		res.json({ unread_count: count });
	} catch (err) {
		console.error('[dm] unread error:', err);
		res.status(500).json({ error: '未読数の取得に失敗しました' });
	}
});

router.get({
	path: '/unread-counts',
	summary: 'DMグループごとの未読件数マップ取得',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = req.user.id;

	try {
		const dms = await db.getGroupDmsForUser(userId);
		const payload = await buildDmPayload(db, dms, userId, { includePosts: false });
		const unreadByDm = {};
		for (const d of payload.dm) {
			unreadByDm[d.id] = d.unread_count || 0;
		}
		res.json({
			unread_total: payload.unread_total,
			unread_by_dm: unreadByDm,
		});
	} catch (err) {
		console.error('[dm] unread-counts error:', err);
		res.status(500).json({ error: '未読サマリーの取得に失敗しました' });
	}
});

router.get({
	path: '/find',
	summary: '指定ユーザーとの1対1 DMグループの検索',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const currentUserId = Number(req.user.id);
	const otherUserId = Number(req.query.user_id);

	if (!Number.isInteger(otherUserId) || otherUserId < 0) {
		return res.status(400).json({ error: '有効なuser_idを指定してください' });
	}

	try {
		const directDm = await findDirectDmBetweenUsers(db, currentUserId, otherUserId);
		if (!directDm) {
			return res.json({ dm: null });
		}
		res.json({ dm: await serializeGroupDm(db, directDm, currentUserId) });
	} catch (err) {
		console.error('[dm] find direct dm error:', err);
		res.status(500).json({ error: 'DMの検索に失敗しました' });
	}
});

router.get({
	path: '/keys',
	summary: 'DMメンバーのE2E公開鍵一覧取得',
	auth: 'required',
}, requireAuth, async (req, res) => {
	if (!config.dm.e2eEnabled) {
		return res.status(410).json({ error: 'DM E2E encryption is temporarily disabled' });
	}
	const db = getDbAdapter(req);

	try {
		const rawIds = String(req.query.user_ids || '')
			.split(',')
			.map((s) => parseInt(s.trim(), 10))
			.filter((n) => Number.isInteger(n) && n >= 0);
		if (rawIds.length === 0) {
			return res.json({ keys: {} });
		}
		const rows = await db.getDmPublicKeys(rawIds);
		const keys = {};
		for (const row of rows) {
			keys[String(row.user_id)] = row.public_key;
		}
		res.json({ keys });
	} catch (err) {
		console.error('[dm] keys error:', err);
		res.status(500).json({ error: '公開鍵の取得に失敗しました' });
	}
});

router.post({
	path: '/keys',
	summary: '自分のE2E暗号化公開鍵の登録・更新',
	auth: 'required',
}, requireAuth, async (req, res) => {
	if (!config.dm.e2eEnabled) {
		return res.status(410).json({ error: 'DM E2E encryption is temporarily disabled' });
	}
	const db = getDbAdapter(req);
	const { public_key } = req.body || {};

	if (typeof public_key !== 'string' || public_key.length < 10 || public_key.length > 2048) {
		return res.status(400).json({ error: 'public_key is required' });
	}

	try {
		await db.setDmPublicKey(req.user.id, public_key);
		res.json({ success: true });
	} catch (err) {
		console.error('[dm] set keys error:', err);
		res.status(500).json({ error: '公開鍵の登録に失敗しました' });
	}
});

router.post({
	path: '/',
	summary: '新規DMグループの作成',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = req.user.id;
	const { member, title } = req.body || {};

	try {
		if (!Array.isArray(member) || member.length === 0) {
			return res.status(400).json({ error: 'member is required' });
		}

		const memberIds = Array.from(new Set(member)).map(Number);
		if (memberIds.some((id) => !Number.isInteger(id) || id < 0)) {
			return res.status(400).json({ error: 'Invalid member ids' });
		}
		if (!memberIds.includes(userId)) {
			memberIds.unshift(userId);
		}

		const membersToValidate = memberIds.filter((id) => id !== userId);
		const targetUsers = [];
		for (const memberId of membersToValidate) {
			const user = await db.getUserById(memberId);
			if (!user) {
				return res
					.status(404)
					.json({ error: `User ${memberId} not found` });
			}
			const invitationPolicy = user.settings?.dm_invitation || user.settings?.dm_permission || 'require_approval';
			if (invitationPolicy === 'deny' || invitationPolicy === 'reject') {
				return res.status(403).json({
					error: `${user.name || 'ユーザー'}はDMの招待を受け付けていません`,
				});
			}
			targetUsers.push(user);
		}
		if (await hasBlockedDmMemberPair(db, memberIds)) {
			return res.status(403).json({
				error: 'ブロック関係のユーザーとDMを作成できません',
			});
		}

		const existing = await db.findGroupDmByMembers(memberIds);
		if (existing) {
			return res.json({
				dm: await serializeGroupDm(db, existing, userId),
				created: false,
			});
		}

		const acceptedMembers = [userId];
		for (const targetUser of targetUsers) {
			const memberId = targetUser.id;
			const invitationPolicy = targetUser.settings?.dm_invitation || targetUser.settings?.dm_permission || 'require_approval';
			if (invitationPolicy === 'always' || invitationPolicy === 'allow') {
				acceptedMembers.push(memberId);
			} else if (typeof db.isFollowing === 'function' && await db.isFollowing(memberId, userId)) {
				acceptedMembers.push(memberId);
			}
		}

		let dm = await db.createGroupDm({
			hostId: userId,
			member: memberIds,
			accepted: acceptedMembers,
			title: typeof title === 'string' ? title.trim() : '',
		});
		dm = await appendSystemEvent(req, dm.id, userId, `@${userId}が参加しました`);
		const invitedIds = memberIds.filter(id => Number(id) !== Number(userId));
		if (invitedIds.length) dm = await appendSystemEvent(req, dm.id, userId, invitationEvent(userId, invitedIds));
		for (const id of acceptedMembers.filter(id => Number(id) !== Number(userId))) {
			dm = await appendSystemEvent(req, dm.id, id, `@${id}が参加しました`);
		}

		res.status(201).json({ dm: await serializeGroupDm(db, dm, userId), created: true });
	} catch (err) {
		console.error('[dm] create error:', err);
		res.status(500).json({ error: 'DM 作成に失敗しました' });
	}
});

router.get({
	path: '/:dmId',
	summary: 'DMグループの詳細とメッセージ一覧の取得',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = req.user.id;
	const dmId = req.params.dmId;

	try {
		const dm = await db.getGroupDm(dmId);
		if (!dm) {
			return res.status(404).json({ error: 'DM not found' });
		}
		if (!dm.member.includes(userId)) {
			return res.status(403).json({ error: 'Forbidden' });
		}
				if (req.query.mark_read === '1' && getAcceptedDmMemberIds(dm).includes(Number(userId))) {
					const unreadBefore = Number(dm.unread?.[userId] || 0);
					// 未読が無い場合は既読化で状態版を進めない（連打による他メンバーの更新妨害を防ぐ）。
					if (unreadBefore > 0) {
						await db.markGroupDmRead(dmId, userId);
						await publishDmUnreadCounts(req, [userId], dmId);
						const otherMembers = (dm.member || []).filter((id) => Number(id) !== Number(userId));
						await publishDmReadEvent(req, otherMembers, dmId, userId);
					}
					const refreshed = await db.getGroupDm(dmId);
				return res.json(await buildDmPayload(db, [refreshed || dm], userId));
				}
		res.json(await buildDmPayload(db, [dm], userId));
	} catch (err) {
		console.error('[dm] get error:', err);
		res.status(500).json({ error: 'DM 取得に失敗しました' });
	}
});

router.put({
	path: '/:dmId',
	summary: 'DMグループの設定・メンバー更新',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = req.user.id;
	const dmId = req.params.dmId;
	const body = req.body || {};

	try {
		const dm = structuredClone(await db.getGroupDm(dmId));
		if (!dm) {
			return res.status(404).json({ error: 'DM not found' });
		}
		if (!dm.member.includes(userId)) {
			return res.status(403).json({ error: 'Forbidden' });
		}

		const updates = {};
		const expectedState = dmState(dm);
		const historyWithoutVersion = body.post !== undefined && body.state_version === undefined;
		if (body.state_version !== undefined) {
			if (typeof body.state_version !== 'string' || !/^(0|[1-9]\d{0,14})$/.test(body.state_version)) {
				return res.status(400).json({ error: 'Invalid state_version' });
			}
			if (dm.state_version == null) return res.status(503).json({ error: 'DM version checking is unavailable' });
			if (body.state_version !== expectedState.state_version) return res.status(409).json({ error: 'DM changed; reload and retry' });
		}
		const expectedPost = body.post !== undefined ? structuredClone(dm.post || []) : undefined;
		const previousMemberIds = [...dm.member];
		const previousHostId = dm.host_id;
		const previousTitle = dm.title || '';
		const isHost = dm.host_id === userId;

			if (body.post !== undefined) {
			if (!getAcceptedDmMemberIds(dm).includes(Number(userId))) return res.status(403).json({ error: 'DM invitation must be accepted' });
			// 検証関数は受信配列をその場で正規化するため、破壊を局所化する。
			const requestedPost = structuredClone(body.post);
			try {
				const blocked = await getBlockedDmMemberIds(db, userId, expectedPost.map((message) => Number(message?.userid)).filter(Number.isInteger));
				const visiblePost = expectedPost.filter((message) => !blocked.has(Number(message?.userid)));
				const readCountById = new Map(expectedPost.map((message, index) => [message.id, computeSerializedReadCount(dm, message, index, expectedPost.length)]));
				const removedIds = validateMessageHistoryUpdate(visiblePost, requestedPost, userId, readCountById);
				if (historyWithoutVersion) {
					const visibleById = new Map(visiblePost.map((message) => [message.id, message]));
					const edited = requestedPost.some((message) => {
						const original = visibleById.get(message.id);
						return original && Number(original.userid) === Number(userId) && original.type === 'user' && hasHistoryEditBeyondDeletion(message, original, removedIds, readCountById.get(original.id));
					});
					if (edited) return res.status(400).json({ error: 'state_version is required for message edits' });
				}
				// 見えない行はクライアントから受け取らず、保存済みの値と順序を保つ。
				const requestedById = new Map(requestedPost.map((message) => [message.id, message]));
				const expectedVisibleOrder = visiblePost.filter((message) => requestedById.has(message.id)).map((message) => message.id);
				if (expectedVisibleOrder.some((id, index) => requestedPost[index]?.id !== id)) throw new Error('Message order cannot be changed');
				if (historyWithoutVersion) {
					// 世代なし経路では送信オブジェクトを保存せず、サーバー側の最新行から削除分だけを除く。
					updates.post = expectedPost.flatMap((message) => {
						if (blocked.has(Number(message?.userid))) return [message];
						if (!requestedById.has(message.id)) return [];
						if (Number(message.userid) === Number(userId) && removedIds.has(message.reply_to)) {
							const { reply_to: _replyTo, ...rest } = message;
							return [rest];
						}
						return [message];
					});
				} else {
					updates.post = expectedPost.flatMap((message) => blocked.has(Number(message?.userid)) ? [message] : (requestedById.has(message.id) ? [requestedById.get(message.id)] : []));
				}
			} catch (error) {
				const status = error.message && error.message.startsWith('You can only') ? 403 : 400;
				return res.status(status).json({ error: error.message || 'Invalid message update' });
			}
		}

		if (body.title !== undefined || body.member !== undefined || body.host_id !== undefined) {
			if (!isHost) {
				return res.status(403).json({ error: 'Host only' });
			}
			if (body.title !== undefined) {
				updates.title =
					typeof body.title === 'string' ? body.title.trim() : '';
			}
			if (body.member !== undefined) {
				const memberIds = Array.from(new Set(body.member)).map(Number);
				if (
					memberIds.some((id) => !Number.isInteger(id) || id < 0)
				) {
					return res.status(400).json({ error: 'Invalid member ids' });
				}
				if (!memberIds.includes(userId)) {
					return res.status(400).json({ error: 'Host must stay a member' });
				}
				if (await hasBlockedDmMemberPair(db, memberIds)) {
					return res.status(403).json({
						error: 'ブロック関係のユーザーをDMに招待できません',
					});
				}

				const currentAccepted = (Array.isArray(dm.accepted)
					? dm.accepted.slice()
					: (Array.isArray(dm.unread?._accepted) ? dm.unread._accepted.slice() : (dm.member || []).slice()))
					.filter((id) => dm.member.includes(Number(id)));
				const newlyAddedMemberIds = memberIds.filter((id) => !dm.member.includes(id));
				for (const newMemberId of newlyAddedMemberIds) {
					const user = await db.getUserById(newMemberId);
					if (!user) {
						return res.status(404).json({ error: `User ${newMemberId} not found` });
					}
					const invitationPolicy = user.settings?.dm_invitation || user.settings?.dm_permission || 'require_approval';
					if (invitationPolicy === 'deny' || invitationPolicy === 'reject') {
						return res.status(403).json({
							error: `${user.name || 'ユーザー'}はDMの招待を受け付けていません`,
						});
					}
					if (invitationPolicy === 'always' || invitationPolicy === 'allow') {
						if (!currentAccepted.includes(newMemberId)) {
							currentAccepted.push(newMemberId);
						}
					} else if (typeof db.isFollowing === 'function' && await db.isFollowing(newMemberId, userId)) {
						if (!currentAccepted.includes(newMemberId)) {
							currentAccepted.push(newMemberId);
						}
					}
				}

				updates.member = memberIds;
				updates.accepted = currentAccepted;
			}
			if (body.host_id !== undefined) {
				if (!dm.member.includes(Number(body.host_id))) {
					return res.status(400).json({ error: 'New host must be a member' });
				}
				updates.host_id = Number(body.host_id);
			}
		}

		if (Object.keys(updates).length === 0) {
			return res.json({
				dm: await serializeGroupDm(db, dm, userId),
			});
		}

			let updated = await db.updateGroupDm(dmId, updates, expectedPost, expectedState, body.post !== undefined);
			if (!updated) return res.status(409).json({ error: 'DM changed; reload and retry' });
            await req.app.locals.calls?.refreshDm(dmId);
			const newlyInvited = (updates.member || []).filter(id => !previousMemberIds.includes(id));
			if (newlyInvited.length) updated = await appendSystemEvent(req, dmId, userId, invitationEvent(userId, newlyInvited));
			for (const id of newlyInvited.filter(id => getAcceptedDmMemberIds(updated).includes(id))) {
				updated = await appendSystemEvent(req, dmId, id, `@${id}が参加しました`);
			}
			if (updates.host_id !== undefined && Number(updates.host_id) !== Number(previousHostId)) {
				updated = await appendSystemEvent(req, dmId, userId, `@${userId}がホスト権限を@${updates.host_id}に委譲しました`);
			}
			if (updates.title !== undefined && updates.title !== previousTitle) {
				updated = await appendSystemEvent(req, dmId, userId, `@${userId}がグループ名を「${updates.title}」に変更しました`);
			}
			if (updates.member) {
				const removedMemberIds = previousMemberIds.filter((id) => !updates.member.map(Number).includes(Number(id)));
				for (const removedId of removedMemberIds) {
					updated = await appendSystemEvent(req, dmId, userId, `@${userId}が@${removedId}を退出させました`);
				}
			}
			if (updates.member) {
				await publishDmUnreadCounts(req, [...previousMemberIds, ...updated.member], dmId);
			}
			res.json({
			dm: await serializeGroupDm(db, updated, userId),
		});
	} catch (err) {
		console.error('[dm] update error:', err);
		if (err.code === 'DM_GUARDED_UPDATE_UNAVAILABLE') return res.status(503).json({ error: 'DM version checking is unavailable' });
		res.status(500).json({ error: 'DM 更新に失敗しました' });
	}
});

router.delete({
	path: '/:dmId',
	summary: 'DMグループの削除',
	auth: 'required',
}, requireAuth, dmSendLimiter, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = req.user.id;
	const dmId = req.params.dmId;

	try {
		const dm = structuredClone(await db.getGroupDm(dmId));
		if (!dm) {
			return res.status(404).json({ error: 'DM not found' });
		}
		if (dm.host_id !== userId) {
			// メンバーである非ホストには従来どおりホスト権限エラーを返し、
			// 非メンバーには対象が無い場合と同じ応答で存在を推測させない。
			if ((dm.member || []).map(Number).includes(Number(userId))) {
				return res.status(403).json({ error: 'Host only' });
			}
			return res.status(404).json({ error: 'DM not found' });
		}

			if (!await db.deleteGroupDm(dmId, dmState(dm))) return res.status(409).json({ error: 'DM changed; reload and retry' });
            await req.app.locals.calls?.refreshDm(dmId);
			await publishDmUnreadCounts(req, dm.member, dmId);
			res.json({ success: true });
	} catch (err) {
		console.error('[dm] delete error:', err);
		res.status(500).json({ error: 'DM の解散に失敗しました' });
	}
});

router.delete({
	path: '/:dmId/messages/:messageId',
	summary: 'DMメッセージの削除',
	auth: 'required',
}, requireAuth, dmSendLimiter, async (req, res) => {
	const db = getDbAdapter(req);
	const { dmId, messageId } = req.params;
	const userId = Number(req.user.id);
	try {
		const dm = structuredClone(await db.getGroupDm(dmId));
		// 存在と所有の区別が付かないよう、この経路の失敗はすべて同じ応答にする。
		if (!dm) return res.status(404).json({ error: 'Message not found' });
		if (!dm.member.map(Number).includes(userId) || !getAcceptedDmMemberIds(dm).includes(userId)) return res.status(404).json({ error: 'Message not found' });
		if (dm.state_version == null) return res.status(503).json({ error: 'DM version checking is unavailable' });
		const original = dm.post || [];
		const matches = original.filter((message) => message.id === messageId);
		if (!matches.length) return res.status(404).json({ error: 'Message not found' });
		if (matches.length !== 1 || matches[0].type !== 'user' || Number(matches[0].userid) !== userId) return res.status(404).json({ error: 'Message not found' });
		const post = original.filter((message) => message.id !== messageId).map((message) => {
			if (message.type !== 'user' || Number(message.userid) !== userId || message.reply_to !== messageId) return message;
			const { reply_to: _replyTo, ...rest } = message;
			return rest;
		});
		const updated = await db.updateGroupDm(dmId, { post }, original, dmState(dm), true);
		if (!updated) return res.status(409).json({ error: 'DM changed; reload and retry' });
		return res.json({ success: true });
	} catch (error) {
		console.error('[dm] message delete error:', error);
		if (error.code === 'DM_GUARDED_UPDATE_UNAVAILABLE') return res.status(503).json({ error: 'DM version checking is unavailable' });
		return res.status(500).json({ error: 'メッセージ削除に失敗しました' });
	}
});

router.patch({
	path: '/:dmId/messages/:messageId',
	summary: 'DMメッセージの編集',
	auth: 'required',
}, requireAuth, dmSendLimiter, async (req, res) => {
	const db = getDbAdapter(req);
	const { dmId, messageId } = req.params;
	const userId = Number(req.user.id);
	const content = req.body?.content;
	if (typeof content !== 'string' || !content.trim() || !isWithinRange(content.trim().length, config.limits.dmContentLength)) {
		return res.status(400).json({ error: lengthError('DM content', config.limits.dmContentLength) });
	}
	try {
		// 世代が渡された場合は履歴PUTと同様に照合する（アダプタ側の行ロック/CASと併せて競合を防ぐ）。
		if (req.body?.state_version !== undefined) {
			if (typeof req.body.state_version !== 'string' || !/^(0|[1-9]\d{0,14})$/.test(req.body.state_version)) {
				return res.status(400).json({ error: 'Invalid state_version' });
			}
			const dmForCheck = await db.getGroupDm(dmId);
			if (!dmForCheck) return res.status(404).json({ error: 'Message or DM not found' });
			if (dmForCheck.state_version == null) return res.status(503).json({ error: 'DM version checking is unavailable' });
			if (String(dmForCheck.state_version) !== req.body.state_version) {
				return res.status(409).json({ error: 'DM changed; reload and retry' });
			}
		}
		const result = await db.editGroupDmMessage(dmId, messageId, userId, content.trim());
		if (!result || result.error) {
			if (result?.error === 'not_found') return res.status(404).json({ error: 'Message or DM not found' });
			if (result?.error === 'forbidden') return res.status(403).json({ error: 'Forbidden' });
			return res.status(500).json({ error: 'メッセージ編集に失敗しました' });
		}
		if (!result.message || !Array.isArray(result.member)) {
			return res.status(500).json({ error: 'メッセージ編集に失敗しました' });
		}
		const blocked = await getBlockedDmMemberIds(db, userId, result.member);
		for (const memberId of result.member) {
			if (blocked.has(Number(memberId))) continue;
			try {
				req.app.locals.realtime?.sendToUser(Number(memberId), { type: 'dm_message_edited', dm_id: String(dmId), message: result.message });
			} catch (error) {
				console.warn('[dm] edit realtime delivery failed:', error.message);
			}
		}
		return res.json({ success: true, message: result.message });
	} catch (error) {
		console.error('[dm] edit error:', error);
		return res.status(500).json({ error: 'メッセージ編集に失敗しました' });
	}
});

router.post({
	path: '/:dmId/messages',
	summary: 'DMメッセージの送信',
	auth: 'required',
}, requireAuth, dmSendLimiter, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = req.user.id;
	const dmId = req.params.dmId;
	const { message, request_id: requestId } = req.body || {};

	try {
		if (!message || typeof message !== 'object') {
			return res.status(400).json({ error: 'message is required' });
		}
		if (requestId !== undefined && (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId))) {
			return res.status(400).json({ error: 'request_id must be a UUID' });
		}
		if (requestId !== undefined && !db.supportsGroupDmSendIdempotency) {
			return res.status(503).json({ error: 'DM send idempotency is unavailable' });
		}

		const dm = structuredClone(await db.getGroupDm(dmId));
		if (!dm) {
			return res.status(404).json({ error: 'DM not found' });
		}
		if (!dm.member.includes(userId)) {
			return res.status(403).json({ error: 'Forbidden' });
		}

		let msg;
		try {
			msg = normalizeClientMessage(message, userId);
		} catch (error) {
			return res.status(400).json({ error: error.message || 'Invalid message' });
		}

		if (msg.e2e) {
			const recipients = new Set(
				Object.keys(msg.e2e.ct || {}).map((id) => Number(id)),
			);
			for (const memberId of dm.member) {
				if (!recipients.has(Number(memberId))) {
					return res
						.status(400)
						.json({ error: 'E2E message must be encrypted for all members' });
				}
			}
		}

		const sender = await db.getUserById(userId);
		await attachDisplayRanks(db, [sender]);
		const blockedMemberIds = await getBlockedDmMemberIds(db, userId, [...(dm.member || []), ...(dm.post || []).map((item) => Number(item?.userid)).filter(Number.isInteger)]);
		if (msg.reply_to !== undefined) {
			const target = (dm.post || []).find((item) => item.id === msg.reply_to);
			if (!target || target.type !== 'user' || target.deleted || target.deleted_at || blockedMemberIds.has(Number(target.userid))) {
				return res.status(400).json({ error: 'Reply target is unavailable' });
			}
		}
		const newlyJoined = !getAcceptedDmMemberIds(dm).includes(Number(userId));
		const joinEvent = newlyJoined ? { id: crypto.randomUUID(), type: 'system', userid: Number(userId), content: `@${userId}が参加しました`, created_at: new Date().toISOString() } : null;
		const requestPayload = { content: msg.content, ...(msg.e2e ? { e2e: msg.e2e } : {}), ...(msg.attachments ? { attachments: msg.attachments } : {}), ...(msg.reply_to !== undefined ? { reply_to: msg.reply_to } : {}) };
		const requestHash = requestId === undefined ? undefined : crypto.createHash('sha256').update(JSON.stringify(canonicalDmValue(requestPayload))).digest('hex');
		const updated = await db.appendToGroupDm(dmId, msg, userId, { expectedState: dmState(dm), joinEvent, ...(requestId === undefined ? {} : { requestId: requestId.toLowerCase(), requestHash }) });
		if (!updated) return res.status(409).json({ error: 'DM changed; reload and retry' });
		if (updated.idempotencyConflict) return res.status(409).json({ error: 'request_id was already used for a different message' });
		if (updated.idempotencyReplay) return res.status(201).json({ dm: await serializeGroupDm(db, updated, userId, { blockedMemberIds }), message: updated.idempotencyReplay });
		try {
			if (joinEvent) await publishDmMessage(req, updated.member || [], dmId, joinEvent, sender ? serializeDmMember(sender) : null);
			await publishDmMessage(req, updated.member || dm.member || [], dmId, msg, sender ? serializeDmMember(sender) : null);
			await publishDmUnreadCounts(
				req,
				(updated.member || []).filter((memberId) => newlyJoined || Number(memberId) !== Number(userId)),
				dmId,
			);
		} catch (error) {
			console.warn('[dm] send realtime delivery failed:', error.message);
		}

		res.status(201).json({
			dm: await serializeGroupDm(db, updated, userId, { blockedMemberIds }),
			message: msg,
		});
	} catch (err) {
		console.error('[dm] send error:', err);
		res.status(500).json({ error: 'メッセージ送信に失敗しました' });
	}
});

router.post({
	path: '/:dmId/accept',
	summary: 'DMグループ招待の受諾',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const { dmId } = req.params;
	const userId = req.user.id;

	try {
		const dm = structuredClone(await db.getGroupDm(dmId));
		if (!dm) return res.status(404).json({ error: 'DM が見つかりません' });

		const accepted = getAcceptedDmMemberIds(dm);
		if (!dm.member.includes(Number(userId))) return res.status(403).json({ error: 'Forbidden' });
		const newlyJoined = !accepted.includes(Number(userId));
		if (newlyJoined) accepted.push(Number(userId));
		let updated = dm;
		if (newlyJoined) {
			updated = await db.updateGroupDm(dmId, { accepted }, undefined, dmState(dm));
			if (!updated) return res.status(409).json({ error: 'DM changed; reload and retry' });
			updated = await appendSystemEvent(req, dmId, userId, `@${userId}が参加しました`);
			await publishDmUnreadCounts(req, [userId], dmId);
		}
		res.json({ success: true, dm: await serializeGroupDm(db, updated || dm, userId) });
	} catch (err) {
		console.error('[dm] accept error:', err);
		res.status(500).json({ error: '招待の受諾に失敗しました' });
	}
});

router.post({
	path: '/:dmId/decline',
	summary: 'DMグループ招待の拒否',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const { dmId } = req.params;
	const userId = req.user.id;

	try {
		const dm = structuredClone(await db.getGroupDm(dmId));
		if (!dm) return res.status(404).json({ error: 'DM が見つかりません' });

		if (!dm.member.includes(Number(userId))) return res.status(403).json({ error: 'Forbidden' });
		if (getAcceptedDmMemberIds(dm).includes(Number(userId))) {
			return res.status(400).json({ error: '招待待ちではありません' });
		}
		if (!await db.leaveGroupDm(dmId, userId, dmState(dm))) return res.status(409).json({ error: 'DM changed; reload and retry' });
		await req.app.locals.calls?.refreshDm(dmId);
		await publishDmUnreadCounts(req, [userId], dmId);
		res.json({ success: true });
	} catch (err) {
		console.error('[dm] decline error:', err);
		res.status(500).json({ error: '招待の拒否に失敗しました' });
	}
});

router.post({
	path: '/:dmId/read',
	summary: 'DMメッセージの既読マーク',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const { dmId } = req.params;
	const userId = req.user.id;

	try {
		const dm = await db.getGroupDm(dmId);
		if (!dm) return res.status(404).json({ error: 'DM が見つかりません' });
		if (!dm.member.includes(userId)) {
			return res.status(403).json({ error: 'Forbidden' });
		}
		if (!getAcceptedDmMemberIds(dm).includes(Number(userId))) {
			return res.status(403).json({ error: 'DM招待を承認してください' });
		}

		// 未読が無い場合は既読化で状態版を進めない（連打による他メンバーの更新妨害を防ぐ）。
		const unreadBefore = Number(dm.unread?.[userId] ?? dm.unread?.[String(userId)] ?? dm.unread_count ?? 0);
		if (unreadBefore <= 0) {
			return res.json({ success: true });
		}

		await db.markGroupDmRead(dmId, userId);
		const otherMembers = (dm.member || []).filter((id) => Number(id) !== Number(userId));
		await publishDmReadEvent(req, otherMembers, dmId, userId);
		await publishDmUnreadCounts(req, [userId], dmId);

		res.json({ success: true });
	} catch (err) {
		console.error('[dm] mark read error:', err);
		res.status(500).json({ error: '既読処理に失敗しました' });
	}
});

router.post({
	path: '/:dmId/leave',
	summary: 'DMグループからの脱退',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = req.user.id;
	const dmId = req.params.dmId;

	try {
		const dm = structuredClone(await db.getGroupDm(dmId));
		if (!dm) {
			return res.status(404).json({ error: 'DM not found' });
		}
		if (!dm.member.includes(userId)) {
			return res.status(403).json({ error: 'Forbidden' });
		}

		if (!await db.leaveGroupDm(dmId, userId, dmState(dm))) return res.status(409).json({ error: 'DM changed; reload and retry' });
        await req.app.locals.calls?.refreshDm(dmId);
		await appendSystemEvent(req, dmId, userId, `@${userId}が退出しました`);
		await publishDmUnreadCounts(req, [userId], dmId);
		res.json({ success: true });
	} catch (err) {
		console.error('[dm] leave error:', err);
		res.status(500).json({ error: 'DM から退出できませんでした' });
	}
});

module.exports = router;
