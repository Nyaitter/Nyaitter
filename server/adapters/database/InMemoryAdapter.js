const DatabaseAdapter = require('./DatabaseAdapter');
const config = require('../../config');
const crypto = require('crypto');
const {
	buildExternalNyaitterAddress,
	formatNyaitterId,
} = require('../../utils/nyaitterAddress');
const { normalizeTarget } = require('../../utils/notification');
const { normalizeBlockList } = require('../../utils/blockList');

class InMemoryAdapter extends DatabaseAdapter {
	constructor() {
		super();
		this.users = new Map(); // id -> user
		this.scidToId = new Map(); // scid -> id
					this.sessions = new Map(); // token -> { userId, expiresAt, ... }
			this.trustedLoginIps = new Map(); // `${userId}:${ipHash}` -> trust record
			this.loginApprovals = new Map(); // approvalId -> pending login approval
			this.botTokens = new Map(); // tokenId -> { userId, tokenHash, name, ... }
		this.posts = new Map();
		// 投稿読み取りを投稿総数に比例させないための補助インデックス。
		this.postIdsNewest = []; // newest -> oldest
		this.postIdsByUser = new Map(); // userId -> newest -> oldest post IDs
			this.replyIdsByParent = new Map(); // parent post ID -> newest -> oldest reply IDs
			this.replyCountByParent = new Map(); // post ID -> direct/indirect descendant reply count
		this.likeCountByPost = new Map();
		this.starCountByPost = new Map();
		this.repostCountByPost = new Map();
					this.likes = new Map(); // `${userId}:${postId}` -> true
			this.stars = new Map();
			this.likedPostIdsByUser = new Map(); // userId -> Set(postId)
			this.starredPostIdsByUser = new Map(); // userId -> Set(postId)

		this.dmChannels = new Map(); // channelId -> { id, participants, messages, ... }
		this.groupDms = new Map(); // dmId -> { id, title, member, host_id, time, post, unread }
		this.groupDmIdsByMember = new Map(); // userId -> Set(dmId)
		this.groupDmUnreadTotalByMember = new Map(); // userId -> unread total
		this.dmE2EKeys = new Map(); // userId -> public key (base64url)
		this.follows = new Map(); // `${followerId}:${followingId}` -> true
		this.followingIdsByUser = new Map(); // followerId -> Set(followingId)
		this.followerIdsByUser = new Map(); // followingId -> Set(followerId)
			this.notifications = new Map(); // userId -> [notification]
			this.notificationsById = new Map(); // notificationId -> notification
			this.unreadNotificationCounts = new Map(); // userId -> unread count
			this.moderationReports = new Map(); // reportId -> report record
			this.nextModerationReportId = 1;
			this.pushSubscriptions = new Map(); // userId -> Map(endpoint -> subscription)
		this.reposts = new Map(); // `${userId}:${postId}` -> true
		this.pinnedPosts = new Map(); // `${userId}:${postId}` -> true
		this.nextPostId = 1;
		this.nextNotificationId = 1;
		this.nextDmId = 1;
		this.logs = []; // { scratch_id, nyaitter_id, masked_ip_uuid, log_time }

		this.nyaitterAddressToId = new Map();
	}

		_updateReplyCountsForAncestors(parentPostId, delta) {
			let currentId = Number(parentPostId);
			const visited = new Set();
			while (Number.isInteger(currentId) && !visited.has(currentId)) {
				visited.add(currentId);
				const nextCount = Math.max(0, (this.replyCountByParent.get(currentId) || 0) + delta);
				if (nextCount === 0) this.replyCountByParent.delete(currentId);
				else this.replyCountByParent.set(currentId, nextCount);
				const currentPost = this.posts.get(currentId);
				currentId = currentPost?.replyTo != null ? Number(currentPost.replyTo) : NaN;
			}
		}

		_addPostIndexes(post) {
			if (!post || !Number.isInteger(Number(post.id))) return;
		const postId = Number(post.id);
		const userId = Number(post.userId);
		this.postIdsNewest.unshift(postId);
		if (!this.postIdsByUser.has(userId)) this.postIdsByUser.set(userId, []);
		this.postIdsByUser.get(userId).unshift(postId);
		if (post.replyTo != null) {
			const parentId = Number(post.replyTo);
			if (!this.replyIdsByParent.has(parentId)) this.replyIdsByParent.set(parentId, []);
				this.replyIdsByParent.get(parentId).unshift(postId);
				this._updateReplyCountsForAncestors(parentId, 1);
		}
		this.likeCountByPost.set(postId, this.likeCountByPost.get(postId) || 0);
		this.starCountByPost.set(postId, this.starCountByPost.get(postId) || 0);
		this.repostCountByPost.set(postId, this.repostCountByPost.get(postId) || 0);
	}

	_removePostIndexes(post) {
		if (!post || !Number.isInteger(Number(post.id))) return;
		const postId = Number(post.id);
		const removeId = (items) => {
			const index = items ? items.indexOf(postId) : -1;
			if (index >= 0) items.splice(index, 1);
		};
		removeId(this.postIdsNewest);
		removeId(this.postIdsByUser.get(Number(post.userId)));
		if (post.replyTo != null) {
			const parentId = Number(post.replyTo);
			const replies = this.replyIdsByParent.get(parentId);
			removeId(replies);
				this._updateReplyCountsForAncestors(parentId, -1);
				if (!replies || replies.length === 0) this.replyIdsByParent.delete(parentId);
		}
		this.likeCountByPost.delete(postId);
		this.starCountByPost.delete(postId);
		this.repostCountByPost.delete(postId);
	}

	_addGroupDmMemberIndexes(dm) {
		for (const memberId of dm.member || []) {
			const normalizedMemberId = Number(memberId);
			if (!this.groupDmIdsByMember.has(normalizedMemberId)) this.groupDmIdsByMember.set(normalizedMemberId, new Set());
			this.groupDmIdsByMember.get(normalizedMemberId).add(dm.id);
			const unread = Number(dm.unread?.[normalizedMemberId] || 0);
			if (unread > 0) {
				this.groupDmUnreadTotalByMember.set(normalizedMemberId, (this.groupDmUnreadTotalByMember.get(normalizedMemberId) || 0) + unread);
			}
		}
	}

	_removeGroupDmMemberIndexes(dm) {
		for (const memberId of dm.member || []) {
			const normalizedMemberId = Number(memberId);
			const ids = this.groupDmIdsByMember.get(normalizedMemberId);
			if (ids) {
				ids.delete(dm.id);
				if (ids.size === 0) this.groupDmIdsByMember.delete(normalizedMemberId);
			}
			const unread = Number(dm.unread?.[normalizedMemberId] || 0);
			if (unread > 0) {
				const nextTotal = Math.max(0, (this.groupDmUnreadTotalByMember.get(normalizedMemberId) || 0) - unread);
				if (nextTotal === 0) this.groupDmUnreadTotalByMember.delete(normalizedMemberId);
				else this.groupDmUnreadTotalByMember.set(normalizedMemberId, nextTotal);
			}
		}
	}

			_updateUserReactionIndex(index, userId, postId, active) {
			const normalizedUserId = Number(userId);
			const normalizedPostId = Number(postId);
			if (active) {
				if (!index.has(normalizedUserId)) index.set(normalizedUserId, new Set());
				index.get(normalizedUserId).add(normalizedPostId);
				return;
			}
			const postIds = index.get(normalizedUserId);
			if (!postIds) return;
			postIds.delete(normalizedPostId);
			if (postIds.size === 0) index.delete(normalizedUserId);
		}

		_updateFollowIndexes(followerId, followingId, following) {

		const follower = Number(followerId);
		const followingUser = Number(followingId);
		if (following) {
			if (!this.followingIdsByUser.has(follower)) this.followingIdsByUser.set(follower, new Set());
			if (!this.followerIdsByUser.has(followingUser)) this.followerIdsByUser.set(followingUser, new Set());
			this.followingIdsByUser.get(follower).add(followingUser);
			this.followerIdsByUser.get(followingUser).add(follower);
			return;
		}
		const followingIds = this.followingIdsByUser.get(follower);
		if (followingIds) {
			followingIds.delete(followingUser);
			if (followingIds.size === 0) this.followingIdsByUser.delete(follower);
		}
		const followerIds = this.followerIdsByUser.get(followingUser);
		if (followerIds) {
			followerIds.delete(follower);
			if (followerIds.size === 0) this.followerIdsByUser.delete(followingUser);
		}
	}

	async connect() {
		console.log('[InMemoryAdapter] メモリDBを初期化しました');
	}

	async disconnect() {}

	_normalizeUserBlockList(user) {
		if (!user) return null;
		user.block = normalizeBlockList(user.block, user.id);
		return user;
	}

	async getUserByScid(scid) {
		const id = this.scidToId.get(scid);
		return id !== undefined
			? this._normalizeUserBlockList(this.users.get(id))
			: null;
	}

	async getUserById(id) {
		return this._normalizeUserBlockList(this.users.get(id));
	}

	async getUserByNyaitterAddress(address) {
		if (!this.nyaitterAddressToId) return null;
		const id = this.nyaitterAddressToId.get(address);
		return id != null
			? this._normalizeUserBlockList(this.users.get(id))
			: null;
	}

	async getOrCreateExternalUser({
		providerDomain,
		externalId,
		profile = {},
	}) {
		const address = buildExternalNyaitterAddress(externalId, providerDomain);

		let user = await this.getUserByNyaitterAddress(address);
		if (user) return user;

		const id = this._allocateUserId();
		user = this._withUserDefaults({
			id,
			name: profile.name || formatNyaitterId(externalId),
			me: profile.me || profile.bio || '',
			bio: profile.bio || profile.me || '',
			icon_data: profile.icon_data || null,
			header_image: profile.header_image || null,
			scid: null,
			handle: formatNyaitterId(externalId),
			nyaitter_address: address,
			auth_provider: 'nyaitter',
			provider_domain: providerDomain,
			external_id: externalId,
			external_profile: profile.external_profile || profile,
			uuid: null,
			settings: {},
			created_at: new Date(),
		});

		this.users.set(id, user);
		this.nyaitterAddressToId.set(address, id);

		return user;
	}

	
	_withUserDefaults(user) {
		const normalized = {
			me: '',
			icon_data: null,
			header_image: null,
			block: [],
			notice: [],
			notification_unread_count: 0,
			admin: false,
			verify: false,
			freeze: null,
			shadow: false,
			lock: false,
			...(user || {}),
		};
		normalized.block = normalizeBlockList(normalized.block, normalized.id);
		return normalized;
	}

	async createUser(userData) {
		const id = this._allocateUserId();
			const handle = userData.auth_provider === 'nyaitter' && userData.external_id != null
				? formatNyaitterId(userData.external_id)
				: formatNyaitterId(id);

		const adminScids = (process.env.ADMIN_SCIDS || '')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);

		const user = this._withUserDefaults({
			id,
				name: userData.name || userData.scid || userData.handle,
				me: userData.me || userData.bio || '',
				bio: userData.bio || userData.me || '',
				icon_data: userData.icon_data || null,
				header_image: userData.header_image || null,
				scid: userData.scid || null,
				handle: handle,
				nyaitter_address: userData.nyaitter_address || null,

			auth_provider: userData.auth_provider || 'local',
			provider_domain: userData.provider_domain || null,
			external_id: userData.external_id || null,
			external_profile: userData.external_profile || null,
			uuid: userData.uuid || null,
			settings: userData.settings || {},
			admin: userData.admin || (userData.scid && adminScids.includes(userData.scid)),
			created_at: new Date(),
		});

		this.users.set(id, user);
		if (user.scid) this.scidToId.set(user.scid, id);
		if (user.nyaitter_address) {
			this.nyaitterAddressToId = this.nyaitterAddressToId || new Map();
			this.nyaitterAddressToId.set(user.nyaitter_address, id);
		}

		return user;
	}

	
	_allocateUserId() {
		let digits = 4;
		while (this.users.size >= 10 ** digits) digits += 1;
		const upperBound = 10 ** digits;
		for (let attempt = 0; attempt < 100; attempt += 1) {
			const id = crypto.randomInt(0, upperBound);
			if (!this.users.has(id)) return id;
		}
		for (let id = 0; id < upperBound; id += 1) {
			if (!this.users.has(id)) return id;
		}
		digits += 1;
		return crypto.randomInt(0, 10 ** digits);
	}

	
	async searchUsers(query, limit = 20) {
		if (!query || query.trim().length === 0) {
			return [];
		}

		const q = query.toLowerCase();
		const results = [];

		for (const user of this.users.values()) {
			const nyaitterId = formatNyaitterId(
				user.auth_provider === 'nyaitter' && user.external_id != null
					? user.external_id
					: user.id,
			).toLowerCase();
			const scid = String(user.scid || '').toLowerCase();
			const name = String(user.name || '').toLowerCase();
			const profile = String(user.me || '').toLowerCase();
			if (
				nyaitterId.includes(q.replace(/^#/, '#')) ||
				scid.includes(q) ||
				name.includes(q) ||
				profile.includes(q)
			) {
				results.push(this._normalizeUserBlockList(user));

				if (results.length >= limit) break;
			}
		}

		return results;
	}

	
	async getUsersByIds(userIds) {
		const results = [];
		for (const id of userIds) {
			const user = this._normalizeUserBlockList(this.users.get(id));
			if (user) {
				results.push(user);
			}
		}
		return results;
	}

	
	async getAllUsers() {
		return Array.from(this.users.values()).map((user) =>
			this._normalizeUserBlockList(user),
		);
	}

	async createSession(userId, meta = {}) {
		const token = typeof meta.token === 'string' && meta.token
			? meta.token
			: crypto.randomBytes(config.auth.sessionTokenBytes).toString('hex');
		const msPerDay = 1000 * 60 * 60 * 24;
		const expiresAt = new Date(Date.now() + msPerDay * config.auth.sessionExpiryDays);
		const session = {
			id: crypto.randomBytes(16).toString('base64url'),
			token,
			userId: Number(userId),
			expiresAt,
			createdAt: new Date(),
			ipHash: meta.ipHash || null,
			ipMasked: meta.ipMasked || '不明なIPアドレス',
			userAgent: meta.userAgent || '不明な端末',
		};
		this.sessions.set(token, session);
		return { ...session };
	}

	async getSessionByToken(token) {
		const session = this.sessions.get(token);
		if (!session) return null;
		if (session.expiresAt < new Date()) {
			this.sessions.delete(token);
			return null;
		}
		return { ...session };
	}

	async invalidateSession(token) {
		return this.sessions.delete(token);
	}

	async getUserSessions(userId) {
		const now = new Date();
		const result = [];
		for (const [token, session] of this.sessions.entries()) {
			if (session.expiresAt <= now) {
				this.sessions.delete(token);
				continue;
			}
			if (Number(session.userId) === Number(userId)) result.push({ ...session, token });
		}
		return result.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
	}

	async invalidateAllSessions(userId) {
		let count = 0;
		for (const [token, session] of this.sessions.entries()) {
			if (Number(session.userId) === Number(userId)) {
				this.sessions.delete(token);
				count++;
			}
		}
		return count;
	}

	_trustedLoginIpKey(userId, ipHash) {
		return `${Number(userId)}:${String(ipHash)}`;
	}

	async trustLoginIp(userId, { ipHash, ipMasked }) {
		if (!ipHash) throw new Error('ipHash is required');
		const key = this._trustedLoginIpKey(userId, ipHash);
		const existing = this.trustedLoginIps.get(key);
		const now = new Date();
		const trusted = {
			userId: Number(userId),
			ipHash: String(ipHash),
			ipMasked: ipMasked || existing?.ipMasked || '不明なIPアドレス',
			createdAt: existing?.createdAt || now,
			lastUsedAt: now,
		};
		this.trustedLoginIps.set(key, trusted);
		return { ...trusted };
	}

	async getTrustedLoginIp(userId, ipHash) {
		const trusted = this.trustedLoginIps.get(this._trustedLoginIpKey(userId, ipHash));
		return trusted ? { ...trusted } : null;
	}

	async countTrustedLoginIps(userId) {
		let count = 0;
		for (const trusted of this.trustedLoginIps.values()) {
			if (Number(trusted.userId) === Number(userId)) count++;
		}
		return count;
	}

	async revokeTrustedLoginIp(userId, ipHash) {
		return this.trustedLoginIps.delete(this._trustedLoginIpKey(userId, ipHash));
	}

	async invalidateSessionsByIp(userId, ipHash) {
		let count = 0;
		for (const [token, session] of this.sessions.entries()) {
			if (Number(session.userId) === Number(userId) && session.ipHash === ipHash) {
				this.sessions.delete(token);
				count++;
			}
		}
		return count;
	}

	async createLoginApproval(approvalData) {
		const id = crypto.randomBytes(18).toString('base64url');
		const approval = {
			id,
			userId: Number(approvalData.userId),
			ipHash: String(approvalData.ipHash),
			ipMasked: approvalData.ipMasked || '不明なIPアドレス',
			userAgent: approvalData.userAgent || '不明な端末',
			pollTokenHash: String(approvalData.pollTokenHash),
			status: 'pending',
			createdAt: new Date(),
			expiresAt: new Date(approvalData.expiresAt),
			decidedAt: null,
			consumedAt: null,
		};
		this.loginApprovals.set(id, approval);
		return { ...approval };
	}

	async getLoginApproval(id) {
		const approval = this.loginApprovals.get(String(id));
		if (!approval) return null;
		if (approval.status === 'pending' && approval.expiresAt <= new Date()) approval.status = 'expired';
		return { ...approval };
	}

	async getLoginApprovalByPollToken(id, pollTokenHash) {
		const approval = await this.getLoginApproval(id);
		if (!approval || approval.pollTokenHash !== String(pollTokenHash)) return null;
		return approval;
	}

	async decideLoginApproval(userId, id, decision) {
		const approval = await this.getLoginApproval(id);
		if (!approval || Number(approval.userId) !== Number(userId)) return null;
		if (approval.status !== 'pending') return { ...approval };
		const stored = this.loginApprovals.get(String(id));
		stored.status = decision === 'approve' ? 'approved' : 'denied';
		stored.decidedAt = new Date();
		return { ...stored };
	}

	async consumeLoginApproval(id, pollTokenHash) {
		const approval = await this.getLoginApprovalByPollToken(id, pollTokenHash);
		if (!approval || approval.status !== 'approved') return null;
		const stored = this.loginApprovals.get(approval.id);
		stored.status = 'consumed';
		stored.consumedAt = new Date();
		return { ...stored };
	}

	async createBotToken(userId, tokenId, tokenHash, name) {
		const record = {
			tokenId,
			userId,
			tokenHash,
			name,
			createdAt: new Date(),
			lastUsedAt: null,
		};
		this.botTokens.set(tokenId, record);
		return record;
	}

	async getBotTokenById(tokenId) {
		return this.botTokens.get(tokenId) || null;
	}

	async getUserBotTokens(userId) {
		const result = [];
		for (const record of this.botTokens.values()) {
			if (record.userId === userId) {
				result.push({
					tokenId: record.tokenId,
					name: record.name,
					createdAt: record.createdAt,
					lastUsedAt: record.lastUsedAt,
				});
			}
		}
		return result;
	}

	async revokeBotToken(userId, tokenId) {
		const record = this.botTokens.get(tokenId);
		if (record && record.userId === userId) {
			this.botTokens.delete(tokenId);
			return true;
		}
		return false;
	}

	async updateBotTokenLastUsed(tokenId) {
		const record = this.botTokens.get(tokenId);
		if (record) {
			record.lastUsedAt = new Date();
		}
	}

	async createPost(postData) {
		const id = this.nextPostId++;
		const post = {
			id,
			userId: postData.userId,
			content: postData.content,
			attachments: postData.attachments || null,
			mask: !!postData.mask,
			lock: !!postData.lock,
			announcement: !!postData.announcement,
			replyTo: postData.replyTo || null,
			repostTo: postData.repostTo || null,
			createdAt: new Date(),
		};
		this.posts.set(id, post);
		this._addPostIndexes(post);
		return post;
	}

			async getPostById(id) {
			return this.posts.get(id) || null;
		}

		async getPostsByIds(postIds) {
			const uniqueIds = [...new Set((postIds || []).map(Number).filter(Number.isInteger))];
			return uniqueIds
				.map((id) => this.posts.get(id))
				.filter(Boolean);
		}

		async getPostMetricsBatch(postIds, currentUserId = null) {
			const ids = [...new Set((postIds || []).map(Number).filter(Number.isInteger))];
			return ids.map((id) => ({
				post_id: id,
				like_count: this.likeCountByPost.get(id) || 0,
				star_count: this.starCountByPost.get(id) || 0,
				reply_count: this.replyCountByParent.get(id) || 0,
				repost_count: this.repostCountByPost.get(id) || 0,
				liked_by_me: currentUserId != null && this.likes.has(`${Number(currentUserId)}:${id}`),
				starred_by_me: currentUserId != null && this.stars.has(`${Number(currentUserId)}:${id}`),
			}));
		}

		async updatePost(postId, fields) {

		const post = this.posts.get(postId);
		if (!post) return null;
		if (fields.content !== undefined) post.content = fields.content;
		if (fields.attachments !== undefined) post.attachments = fields.attachments;
					if (fields.mask !== undefined) post.mask = !!fields.mask;
			if (fields.lock !== undefined) post.lock = !!fields.lock;
			return post;

	}

	
		async getPostDetail(id, currentUserId = null) {
		const postId = Number(id);
		const post = this.posts.get(postId);
		if (!post) return null;

		// このアダプターでは関連データがすべてMap索引にあるため、非同期メソッドを
		// 経由せず直接参照して、不要なPromise生成を避ける。
		const author = this.users.get(Number(post.userId)) || null;
		const likeCount = this.likeCountByPost.get(postId) || 0;
		const starCount = this.starCountByPost.get(postId) || 0;
		const viewerId = currentUserId == null ? null : Number(currentUserId);
		const likedByMe = viewerId != null && this.likes.has(`${viewerId}:${postId}`);
		const starredByMe = viewerId != null && this.stars.has(`${viewerId}:${postId}`);
		let parentPost = null;
		if (post.replyTo) {
			const parent = this.posts.get(Number(post.replyTo));
			if (parent) {
				const parentAuthor = this.users.get(Number(parent.userId)) || null;
				parentPost = {
					id: parent.id,
					content: parent.content?.substring(
						0,
						config.limits.parentPostPreviewLength,
					),
					author: parentAuthor
						? { id: parentAuthor.id, name: parentAuthor.name }
						: null,
				};
			}
		}

		return {
			...post,
			author: author
				? {
						id: author.id,
						name: author.name,
						scid: author.scid,
					}
				: null,
			like_count: likeCount,
			liked_by_me: likedByMe,
			star_count: starCount,
			starred_by_me: starredByMe,
			parent_post: parentPost,
		};
	}

	
	async getRecentPosts(limit = config.limits.timelineDefaultLimit) {
		const normalizedLimit = Math.max(0, Number(limit) || 0);
		const posts = [];
		for (const id of this.postIdsNewest) {
			const post = this.posts.get(id);
			if (!post || post.replyTo != null) continue;
			posts.push(post);
			if (posts.length >= normalizedLimit) break;
		}
		return posts;
	}

	
		async getPostsByUserId(userId, limit = config.limits.timelineDefaultLimit, _currentUserId = null) {
			const ids = this.postIdsByUser.get(Number(userId)) || [];
			return ids
				.slice(0, Math.max(0, Number(limit) || 0))
				.map((id) => this.posts.get(id))
				.filter(Boolean);
		}

	async toggleLike(userId, postId) {
		const key = `${userId}:${postId}`;
		const currentlyLiked = this.likes.has(key);

		const currentCount = this.likeCountByPost.get(postId) || 0;
			if (currentlyLiked) {
				this.likes.delete(key);
				this._updateUserReactionIndex(this.likedPostIdsByUser, userId, postId, false);
				this.likeCountByPost.set(postId, Math.max(0, currentCount - 1));
			} else {
				this.likes.set(key, true);
				this._updateUserReactionIndex(this.likedPostIdsByUser, userId, postId, true);
				this.likeCountByPost.set(postId, currentCount + 1);
			}

		const count = this.likeCountByPost.get(postId) || 0;

		return {
			liked: !currentlyLiked,
			count,
		};
	}

	getLikeCountForPost(postId) {
		return this.likeCountByPost.get(Number(postId)) || 0;
	}

	async getLikeCount(postId) {
		return this.getLikeCountForPost(postId);
	}

	async hasUserLikedPost(userId, postId) {
		return this.likes.has(`${userId}:${postId}`);
	}

	async toggleStar(userId, postId) {
		const key = `${userId}:${postId}`;
		const currentlyStarred = this.stars.has(key);

		const currentCount = this.starCountByPost.get(postId) || 0;
			if (currentlyStarred) {
				this.stars.delete(key);
				this._updateUserReactionIndex(this.starredPostIdsByUser, userId, postId, false);
				this.starCountByPost.set(postId, Math.max(0, currentCount - 1));
			} else {
				this.stars.set(key, true);
				this._updateUserReactionIndex(this.starredPostIdsByUser, userId, postId, true);
				this.starCountByPost.set(postId, currentCount + 1);
			}

		const count = this.starCountByPost.get(postId) || 0;

		return {
			starred: !currentlyStarred,
			count,
		};
	}

	getStarCountForPost(postId) {
		return this.starCountByPost.get(Number(postId)) || 0;
	}

	async getStarCount(postId) {
		return this.getStarCountForPost(postId);
	}

	async hasUserStarredPost(userId, postId) {
		return this.stars.has(`${userId}:${postId}`);
	}

	
	async getDmList(userId) {
		// 簡易実装：uniqueChannelId に userId が含まれるチャネルをすべて返す
		const channels = Array.from(this.dmChannels.values())
			.filter((ch) => ch.participants.includes(userId))
			.map((ch) => {
				const otherUserId = ch.participants.find((id) => id !== userId);
				const otherUser = otherUserId
					? this.getUserById(otherUserId)
					: null;

				const lastMsg = ch.messages[ch.messages.length - 1] || null;

				return {
					id: ch.id,
					participants: ch.participants,
					other_user: otherUser
						? {
								id: otherUser.id,
								name: otherUser.name,
								scid: otherUser.scid,
							}
						: null,
					last_message: lastMsg
						? {
								id: lastMsg.id,
								content: lastMsg.content,
								sender_id: lastMsg.senderId,
								sent_at: lastMsg.sentAt,
							}
						: null,
					unread_count: ch.unreadCounts?.[userId] || 0,
				};
			});

		return channels;
	}

	
	async getOrCreateDmChannel(userId1, userId2) {
		const [user1, user2] =
			userId1 < userId2 ? [userId1, userId2] : [userId2, userId1];
		const channelId = `${user1}:${user2}`;

		if (!this.dmChannels.has(channelId)) {
			this.dmChannels.set(channelId, {
				id: channelId,
				participants: [user1, user2],
				messages: [],
				createdAt: new Date(),
				unreadCounts: { [user1]: 0, [user2]: 0 },
			});
		}

		return this.dmChannels.get(channelId);
	}

	
	async getDmMessages(channelId, limit = 50, offset = 0) {
		const channel = this.dmChannels.get(channelId);
		if (!channel) return [];

		const allMessages = channel.messages.slice().reverse();
		return allMessages.slice(offset, offset + limit).reverse();
	}

	
	async sendDmMessage(channelId, senderId, content) {
		const channel = this.dmChannels.get(channelId);
		if (!channel) throw new Error('Channel not found');

		const message = {
			id: Date.now() + Math.random(),
			channelId,
			senderId,
			content,
			sentAt: new Date(),
			readAt: null,
		};

		channel.messages.push(message);

		for (const participantId of channel.participants) {
			if (participantId !== senderId) {
				channel.unreadCounts[participantId] =
					(channel.unreadCounts[participantId] || 0) + 1;
			}
		}

		return message;
	}

	
	async markDmMessagesAsRead(channelId, userId) {
		const channel = this.dmChannels.get(channelId);
		if (!channel) throw new Error('Channel not found');

		channel.unreadCounts[userId] = 0;

		for (const msg of channel.messages) {
			if (msg.senderId !== userId && !msg.readAt) {
				msg.readAt = new Date();
			}
		}
	}

	
	async getUnreadDmCount(userId) {
		let total = 0;
		for (const channel of this.dmChannels.values()) {
			if (channel.participants.includes(userId)) {
				total += channel.unreadCounts[userId] || 0;
			}
		}
		return total;
	}

	_serializeGroupDm(dm, userId) {
		return {
			id: dm.id,
			title: dm.title || '',
			member: dm.member.slice(),
			host_id: dm.host_id,
			time: dm.time,
			post: dm.post ? dm.post.slice() : [],
			unread_count: (dm.unread && dm.unread[userId]) || 0,
		};
	}

	async getGroupDmsForUser(userId) {
		const dmIds = this.groupDmIdsByMember.get(Number(userId)) || new Set();
		const result = [...dmIds]
			.map((dmId) => this.groupDms.get(dmId))
			.filter(Boolean)
			.map((dm) => this._serializeGroupDm(dm, userId));
		result.sort((a, b) => new Date(b.time) - new Date(a.time));
		return result;
	}

		async getGroupDm(dmId) {
			return this.groupDms.get(dmId)
				|| this.groupDms.get(Number(dmId))
				|| null;
		}

	async createGroupDm(dmData) {
		const id = this.nextDmId++;
		const dm = {
			id,
			host_id: dmData.hostId,
			member: dmData.member.slice(),
			title: dmData.title || '',
			time: new Date().toISOString(),
			post: [],
			unread: {},
		};
		this.groupDms.set(id, dm);
		this._addGroupDmMemberIndexes(dm);
		return this._serializeGroupDm(dm, dmData.hostId);
	}

	async updateGroupDm(dmId, updates) {
		const dm = this.groupDms.get(Number(dmId));
		if (!dm) return null;

		if (updates.title !== undefined) dm.title = updates.title;
		if (updates.member !== undefined) {
			this._removeGroupDmMemberIndexes(dm);
			const memberSet = new Set(updates.member.map(Number).filter(Number.isInteger));
			dm.member = Array.from(memberSet);
			this._addGroupDmMemberIndexes(dm);
		}
		if (updates.host_id !== undefined && updates.host_id !== null) {
			dm.host_id = updates.host_id;
		}
		if (updates.post !== undefined) dm.post = updates.post.slice();
		if (updates.time !== undefined) dm.time = updates.time;

		return this._serializeGroupDm(dm, dm.host_id);
	}

	async appendToGroupDm(dmId, message, senderId = null) {
		const dm = this.groupDms.get(Number(dmId));
		if (!dm) return null;

		dm.post = dm.post || [];
		dm.post.push(message);
		dm.time = message.time || new Date().toISOString();

		if (senderId !== null) {
			dm.unread = dm.unread || {};
			for (const memberId of dm.member) {
				if (memberId !== senderId) {
					dm.unread[memberId] = (dm.unread[memberId] || 0) + 1;
					this.groupDmUnreadTotalByMember.set(memberId, (this.groupDmUnreadTotalByMember.get(memberId) || 0) + 1);
				}
			}
		}

		return this._serializeGroupDm(dm, senderId);
	}

	async markGroupDmRead(dmId, userId) {
		const dm = this.groupDms.get(Number(dmId));
		if (!dm) return;
		dm.unread = dm.unread || {};
		const previous = Number(dm.unread[userId] || 0);
		dm.unread[userId] = 0;
		if (previous > 0) {
			const nextTotal = Math.max(0, (this.groupDmUnreadTotalByMember.get(Number(userId)) || 0) - previous);
			if (nextTotal === 0) this.groupDmUnreadTotalByMember.delete(Number(userId));
			else this.groupDmUnreadTotalByMember.set(Number(userId), nextTotal);
		}
	}

	async getGroupDmUnreadCounts(userId) {
		const dmIds = this.groupDmIdsByMember.get(Number(userId)) || new Set();
		return [...dmIds].map((dmId) => {
			const dm = this.groupDms.get(dmId);
			return { dm_id: dmId, unread_count: Number(dm?.unread?.[userId] || 0) };
		});
	}

	async getGroupDmUnreadTotal(userId) {
		return this.groupDmUnreadTotalByMember.get(Number(userId)) || 0;
	}

	async deleteGroupDm(dmId) {
		const normalizedDmId = Number(dmId);
		const dm = this.groupDms.get(normalizedDmId);
		if (!dm) return false;
		this._removeGroupDmMemberIndexes(dm);
		return this.groupDms.delete(normalizedDmId);
	}

	async leaveGroupDm(dmId, userId) {
		const dm = this.groupDms.get(Number(dmId));
		if (!dm) return false;
		this._removeGroupDmMemberIndexes(dm);
		dm.member = dm.member.filter((id) => id !== userId);
		if (dm.unread) delete dm.unread[userId];
		this._addGroupDmMemberIndexes(dm);
		return true;
	}

	async findGroupDmByMembers(memberIds) {
		const target = memberIds.slice().sort((a, b) => a - b);
		for (const dm of this.groupDms.values()) {
			const current = dm.member.slice().sort((a, b) => a - b);
			if (
				current.length === target.length &&
				current.every((id, i) => id === target[i])
			) {
				return dm;
			}
		}
		return null;
	}

	async getDmPublicKeys(userIds) {
		const ids = Array.from(
			new Set((userIds || []).map(Number).filter((id) => Number.isInteger(id) && id >= 0)),
		);
		return ids
			.filter((id) => this.dmE2EKeys.has(id))
			.map((id) => ({ user_id: id, public_key: this.dmE2EKeys.get(id) }));
	}

	async setDmPublicKey(userId, publicKey) {
		this.dmE2EKeys.set(Number(userId), String(publicKey));
	}

	async toggleFollow(followerId, followingId) {
		if (followerId === followingId) {
			throw new Error('Cannot follow yourself');
		}

		const key = `${followerId}:${followingId}`;
		const currentlyFollowing = this.follows.has(key);

		if (currentlyFollowing) {
			this.follows.delete(key);
			this._updateFollowIndexes(followerId, followingId, false);
		} else {
			this.follows.set(key, true);
			this._updateFollowIndexes(followerId, followingId, true);
		}

		return {
			following: !currentlyFollowing,
		};
	}

	async isFollowing(followerId, followingId) {
		return this.follows.has(`${followerId}:${followingId}`);
	}

	async getFollowing(userId, limit = config.limits.followingDefaultLimit) {
		const ids = this.followingIdsByUser.get(Number(userId)) || new Set();
		return [...ids]
			.slice(0, Math.max(0, Number(limit) || 0))
			.map((followingId) => this.users.get(followingId))
			.filter(Boolean);
	}

	async getFollowers(userId, limit = config.limits.followingDefaultLimit) {
		const ids = this.followerIdsByUser.get(Number(userId)) || new Set();
		return [...ids]
			.slice(0, Math.max(0, Number(limit) || 0))
			.map((followerId) => this.users.get(followerId))
			.filter(Boolean);
	}

	async deletePost(postId, userId) {
		const post = this.posts.get(postId);
		if (!post || post.userId !== userId) {
			return false;
		}

		this.posts.delete(postId);
		this._removePostIndexes(post);
		if (post.repostTo != null) {
			const repostKey = `${post.userId}:${post.repostTo}`;
			if (this.reposts.delete(repostKey)) {
				const originalId = Number(post.repostTo);
				this.repostCountByPost.set(originalId, Math.max(0, (this.repostCountByPost.get(originalId) || 1) - 1));
			}
		}

			for (const key of Array.from(this.likes.keys())) {
				if (key.endsWith(`:${postId}`)) {
					const [reactionUserId] = key.split(':').map(Number);
					this.likes.delete(key);
					this._updateUserReactionIndex(this.likedPostIdsByUser, reactionUserId, postId, false);
				}
			}
			for (const key of Array.from(this.stars.keys())) {
				if (key.endsWith(`:${postId}`)) {
					const [reactionUserId] = key.split(':').map(Number);
					this.stars.delete(key);
					this._updateUserReactionIndex(this.starredPostIdsByUser, reactionUserId, postId, false);
				}
			}
		for (const key of Array.from(this.reposts.keys())) {
			if (key.endsWith(`:${postId}`)) {
				this.reposts.delete(key);
			}
		}
		for (const key of Array.from(this.pinnedPosts.keys())) {
			if (key.endsWith(`:${postId}`)) {
				this.pinnedPosts.delete(key);
			}
		}

		return true;
	}

	async adminDeletePost(postId) {
		const post = this.posts.get(postId);
		if (!post) return false;

		this.posts.delete(postId);
		this._removePostIndexes(post);
		if (post.repostTo != null) {
			const repostKey = `${post.userId}:${post.repostTo}`;
			if (this.reposts.delete(repostKey)) {
				const originalId = Number(post.repostTo);
				this.repostCountByPost.set(originalId, Math.max(0, (this.repostCountByPost.get(originalId) || 1) - 1));
			}
		}

			for (const key of Array.from(this.likes.keys())) {
				if (key.endsWith(`:${postId}`)) {
					const [reactionUserId] = key.split(':').map(Number);
					this.likes.delete(key);
					this._updateUserReactionIndex(this.likedPostIdsByUser, reactionUserId, postId, false);
				}
			}
			for (const key of Array.from(this.stars.keys())) {
				if (key.endsWith(`:${postId}`)) {
					const [reactionUserId] = key.split(':').map(Number);
					this.stars.delete(key);
					this._updateUserReactionIndex(this.starredPostIdsByUser, reactionUserId, postId, false);
				}
			}
		for (const key of Array.from(this.reposts.keys())) {
			if (key.endsWith(`:${postId}`)) this.reposts.delete(key);
		}
		for (const key of Array.from(this.pinnedPosts.keys())) {
			if (key.endsWith(`:${postId}`)) this.pinnedPosts.delete(key);
		}

		// Note: Attachment cleanup should be handled at route level with storageAdapter

		return true;
	}

	async togglePin(userId, postId) {
		const post = this.posts.get(postId);
		if (!post || post.userId !== userId) {
			throw new Error('Cannot pin a post you do not own');
		}

		const key = `${userId}:${postId}`;
		const currentlyPinned = this.pinnedPosts.has(key);

		if (currentlyPinned) {
			this.pinnedPosts.delete(key);
		} else {
			this.pinnedPosts.set(key, true);
		}

		return {
			pinned: !currentlyPinned,
		};
	}

	async getPinnedPosts(userId) {
		const result = [];
		for (const key of this.pinnedPosts.keys()) {
			const [uId, postId] = key.split(':').map(Number);
			if (uId === userId) {
				const post = this.posts.get(postId);
				if (post) {
					result.push(post);
				}
			}
		}
		return result;
	}

	async repostPost(userId, postId) {
		const originalPost = this.posts.get(postId);
		if (!originalPost) {
			throw new Error('Post not found');
		}

		const key = `${userId}:${postId}`;
		if (this.reposts.has(key)) {
			throw new Error('Already reposted');
		}

		this.reposts.set(key, true);
		this.repostCountByPost.set(postId, (this.repostCountByPost.get(postId) || 0) + 1);

		const repostId = this.nextPostId++;
		const repost = {
			id: repostId,
			userId,
			content: null,
			attachments: null,
			mask: originalPost.mask,
			lock: !!originalPost.lock,
			repostTo: postId,
			createdAt: new Date(),
		};
		this.posts.set(repostId, repost);
		this._addPostIndexes(repost);

		return repost;
	}

	async getReposts(userId) {
		const result = [];
		for (const key of this.reposts.keys()) {
			const [uId, postId] = key.split(':').map(Number);
			if (uId === userId) {
				const post = this.posts.get(postId);
				if (post) {
					result.push({
						id: post.id,
						content: post.content,
						repostOf: postId,
						createdAt: post.createdAt,
					});
				}
			}
		}
		return result;
	}

	async getRepostsOfPost(postId, limit = 50) {
		const result = [];
		for (const key of this.reposts.keys()) {
			const [uId, pId] = key.split(':').map(Number);
			if (pId === postId) {
				const user = this.users.get(uId);
				if (user) {
					result.push({
						userId: uId,
						name: user.name,
						handle: user.handle,
					});
					if (result.length >= limit) break;
				}
			}
		}
		return result;
	}

	getRepostCountForPost(postId) {
		return this.repostCountByPost.get(Number(postId)) || 0;
	}

	async getRepostCount(postId) {
		return this.getRepostCountForPost(postId);
	}

		async createNotification(notificationData) {
			const id = this.nextNotificationId++;
			const userId = Number(notificationData.userId);
			const notification = {
				id,
				userId,
				type: notificationData.type,
				fromUserId: notificationData.fromUserId ?? null,
				target: normalizeTarget(notificationData.target, {
					postId: notificationData.postId,
					open: notificationData.open,
				}),
				read: false,
				clicked: false,
				message: typeof notificationData.message === 'string' ? notificationData.message : null,
				createdAt: new Date(),
			};

			if (!this.notifications.has(userId)) this.notifications.set(userId, []);
			this.notifications.get(userId).push(notification);
			this.notificationsById.set(id, notification);
			this.unreadNotificationCounts.set(
				userId,
				(this.unreadNotificationCounts.get(userId) || 0) + 1,
			);
			return notification;
		}

		async getNotifications(userId, limit = 50, offset = 0) {
			const notifications = this.notifications.get(Number(userId)) || [];
			// 追加順が古い→新しいなので、配列の複製・全件ソートを避けて後方から切り出す。
			const start = Math.max(0, notifications.length - Math.max(0, Number(offset) || 0) - Math.max(0, Number(limit) || 0));
			const end = Math.max(0, notifications.length - Math.max(0, Number(offset) || 0));
			return notifications.slice(start, end).reverse();
		}

		async getNotificationById(notificationId) {
			return this.notificationsById.get(Number(notificationId)) || null;
		}

		async markNotificationAsRead(notificationId) {
			const notification = this.notificationsById.get(Number(notificationId));
			if (!notification || notification.read) return;
			notification.read = true;
			const userId = Number(notification.userId);
			this.unreadNotificationCounts.set(
				userId,
				Math.max(0, (this.unreadNotificationCounts.get(userId) || 0) - 1),
			);
		}

		async markNotificationAsClicked(notificationId) {
			const notification = this.notificationsById.get(Number(notificationId));
			if (notification) notification.clicked = true;
		}

		async deleteNotification(notificationId) {
			const notification = this.notificationsById.get(Number(notificationId));
			if (!notification) return false;
			const userId = Number(notification.userId);
			const notifications = this.notifications.get(userId) || [];
			const index = notifications.indexOf(notification);
			if (index >= 0) notifications.splice(index, 1);
			if (notifications.length === 0) this.notifications.delete(userId);
			this.notificationsById.delete(Number(notificationId));
			if (!notification.read) {
				this.unreadNotificationCounts.set(
					userId,
					Math.max(0, (this.unreadNotificationCounts.get(userId) || 0) - 1),
				);
			}
			return true;
		}

		async markAllNotificationsAsRead(userId) {
			const normalizedUserId = Number(userId);
			const notifications = this.notifications.get(normalizedUserId) || [];
			for (const notification of notifications) notification.read = true;
			this.unreadNotificationCounts.set(normalizedUserId, 0);
		}

		async markAllNotificationsAsClicked(userId) {
			const normalizedUserId = Number(userId);
			const notifications = this.notifications.get(normalizedUserId) || [];
			for (const notification of notifications) {
				notification.read = true;
				notification.clicked = true;
			}
			this.unreadNotificationCounts.set(normalizedUserId, 0);
		}

		async getUnreadNotificationCount(userId) {
			return this.unreadNotificationCounts.get(Number(userId)) || 0;
		}

		_copyModerationReport(report) {
			if (!report) return null;
			return {
				...report,
				targetSnapshot: JSON.parse(JSON.stringify(report.targetSnapshot || {})),
				excludedAdminIds: [...(report.excludedAdminIds || [])],
				resolution: report.resolution == null
					? null
					: JSON.parse(JSON.stringify(report.resolution)),
			};
		}

		async createModerationReport(reportData) {
			const now = reportData.createdAt ? new Date(reportData.createdAt) : new Date();
			const report = {
				id: this.nextModerationReportId++,
				reporterUserId: Number(reportData.reporterUserId),
				targetKind: String(reportData.targetKind),
				targetId: String(reportData.targetId),
				description: String(reportData.description || ''),
				targetSnapshot: JSON.parse(JSON.stringify(reportData.targetSnapshot || {})),
				assignmentType: ['freeze_appeal', 'verification_application'].includes(reportData.assignmentType)
					? reportData.assignmentType
					: 'report',
				status: 'pending',
				assignedAdminId: null,
				assignedAt: null,
				excludedAdminIds: [],
				resolution: null,
				createdAt: now,
				resolvedAt: null,
			};
			this.moderationReports.set(report.id, report);
			return this._copyModerationReport(report);
		}

		async getOpenModerationAppealByUserId(userId) {
			const appeal = [...this.moderationReports.values()]
				.filter((report) => Number(report.reporterUserId) === Number(userId))
				.filter((report) => report.assignmentType === 'freeze_appeal' && report.status !== 'resolved')
				.sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))[0];
			return this._copyModerationReport(appeal);
		}

		async getOpenModerationVerificationByUserId(userId) {
			const request = [...this.moderationReports.values()]
				.filter((report) => Number(report.reporterUserId) === Number(userId))
				.filter((report) => report.assignmentType === 'verification_application' && report.status !== 'resolved')
				.sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))[0];
			return this._copyModerationReport(request);
		}

		async getModerationReportById(reportId) {
			return this._copyModerationReport(this.moderationReports.get(Number(reportId)));
		}

		async listModerationReportsForAdmin(adminId, options = {}) {
			const status = options.status || 'assigned';
			const limit = Math.max(1, Math.min(Number(options.limit) || 50, 100));
			const offset = Math.max(0, Number(options.offset) || 0);
			return [...this.moderationReports.values()]
				.filter((report) => Number(report.assignedAdminId) === Number(adminId))
				.filter((report) => !status || report.status === status)
				.sort((left, right) => new Date(right.assignedAt || right.createdAt) - new Date(left.assignedAt || left.createdAt))
				.slice(offset, offset + limit)
				.map((report) => this._copyModerationReport(report));
		}

		async getModerationAdminWorkloads(excludedAdminIds = []) {
			const excluded = new Set((excludedAdminIds || []).map(Number));
			return [...this.users.values()]
				.filter((user) => Boolean(user.admin) && !user.freeze && !excluded.has(Number(user.id)))
				.map((user) => ({
					adminId: Number(user.id),
					activeCount: [...this.moderationReports.values()].filter((report) => (
						report.status === 'assigned' && Number(report.assignedAdminId) === Number(user.id)
					)).length,
				}));
		}

		async assignModerationReport(reportId, assignment = {}) {
			const report = this.moderationReports.get(Number(reportId));
			if (!report || report.status === 'resolved') return null;
			if (
				assignment.expectedAdminId !== undefined &&
				Number(report.assignedAdminId) !== Number(assignment.expectedAdminId)
			) return null;
			report.status = 'assigned';
			report.assignedAdminId = Number(assignment.adminId);
			report.assignedAt = assignment.assignedAt
				? new Date(assignment.assignedAt)
				: new Date();
			report.excludedAdminIds = [...new Set((assignment.excludedAdminIds || report.excludedAdminIds || [])
				.map(Number)
				.filter(Number.isInteger))];
			return this._copyModerationReport(report);
		}

		async getOverdueModerationReports(cutoff) {
			const deadline = new Date(cutoff);
			return [...this.moderationReports.values()]
				.filter((report) => report.status === 'assigned' && report.assignedAt && new Date(report.assignedAt) <= deadline)
				.map((report) => this._copyModerationReport(report));
		}

		async getUnassignedModerationReports(limit = 100) {
			return [...this.moderationReports.values()]
				.filter((report) => report.status === 'pending')
				.sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt))
				.slice(0, Math.max(1, Math.min(Number(limit) || 100, 100)))
				.map((report) => this._copyModerationReport(report));
		}

		async resolveModerationReport(reportId, adminId, resolution) {
			const report = this.moderationReports.get(Number(reportId));
			if (
				!report || report.status !== 'assigned' ||
				Number(report.assignedAdminId) !== Number(adminId)
			) return null;
			report.status = 'resolved';
			report.resolution = JSON.parse(JSON.stringify(resolution || {}));
			report.resolvedAt = new Date();
			return this._copyModerationReport(report);
		}

		async deleteModerationReport(reportId) {
			return this.moderationReports.delete(Number(reportId));
		}

		async upsertPushSubscription(userId, subscription) {
		const normalizedUserId = Number(userId);
		if (!this.users.has(normalizedUserId)) return null;
		if (!this.pushSubscriptions.has(normalizedUserId)) {
			this.pushSubscriptions.set(normalizedUserId, new Map());
		}

		const now = new Date().toISOString();
		const subscriptions = this.pushSubscriptions.get(normalizedUserId);
		const existing = subscriptions.get(subscription.endpoint);
		const record = {
			user_id: normalizedUserId,
			endpoint: subscription.endpoint,
			expiration_time: subscription.expirationTime ?? null,
			p256dh: subscription.keys.p256dh,
			auth: subscription.keys.auth,
			session_token: subscription.sessionToken || existing?.session_token || null,
			created_at: existing?.created_at || now,
			updated_at: now,
		};
		subscriptions.set(record.endpoint, record);
		return { ...record };
	}

	async getPushSubscriptions(userId) {
		const subscriptions = this.pushSubscriptions.get(Number(userId));
		if (!subscriptions) return [];
		return [...subscriptions.values()].map((subscription) => ({
			endpoint: subscription.endpoint,
			expirationTime: subscription.expiration_time,
			keys: { p256dh: subscription.p256dh, auth: subscription.auth },
			sessionToken: subscription.session_token || null,
		}));
	}

	async deletePushSubscription(userId, endpoint) {
		const normalizedUserId = Number(userId);
		const subscriptions = this.pushSubscriptions.get(normalizedUserId);
		if (!subscriptions) return false;
		const deleted = subscriptions.delete(endpoint);
		if (subscriptions.size === 0) this.pushSubscriptions.delete(normalizedUserId);
		return deleted;
	}

	async searchPosts(query, limit = 20) {
		const result = await this.searchPostIds(query, limit, 0);
		return result.ids.map((id) => this.posts.get(id)).filter(Boolean);
	}

	async getTrendingPosts(limit = 20) {
		const normalizedLimit = Math.max(1, Number(limit) || 20);
		const top = [];
			for (const postId of this.postIdsNewest) {
				const post = this.posts.get(postId);
				if (!post || post.replyTo != null) continue;
				const score = (this.likeCountByPost.get(postId) || 0)
				+ (this.starCountByPost.get(postId) || 0) * 2
				+ (this.repostCountByPost.get(postId) || 0) * 3;
			const item = { post, score };
			let insertAt = top.findIndex((candidate) => (
				candidate.score < score || (candidate.score === score && candidate.post.id < post.id)
			));
			if (insertAt < 0) insertAt = top.length;
			if (insertAt < normalizedLimit) {
				top.splice(insertAt, 0, item);
				if (top.length > normalizedLimit) top.pop();
			}
		}
		return top.map((item) => item.post);
	}

	async updateUserProfile(userId, profileData) {
		const user = this.users.get(userId);
		if (!user) return null;

		const allowed = [
			'name',
			'me',
			'bio',
			'header_image',
			'icon_data',
			'settings',
			'block',
			'verify',
			'freeze',
			'shadow',
			'lock',
			'admin',
		];
		for (const key of allowed) {
			if (profileData[key] !== undefined) {
				user[key] =
					key === 'block'
						? normalizeBlockList(profileData[key], userId)
						: profileData[key];
			}
		}

		return this._normalizeUserBlockList(user);
	}

		async getLikeIds(userId) {
			return [...(this.likedPostIdsByUser.get(Number(userId)) || [])];
		}

		async getStarIds(userId) {
			return [...(this.starredPostIdsByUser.get(Number(userId)) || [])];
		}

		async getFollowIds(userId) {
			return [...(this.followingIdsByUser.get(Number(userId)) || [])];
		}

	async getFollowRelationshipSnapshot(userId, candidateUserIds) {
		const normalizedUserId = Number(userId);
		const candidates = [...new Set((candidateUserIds || [])
			.map(Number)
			.filter((id) => Number.isInteger(id) && id !== normalizedUserId))];
		const followingIds = [];
		const followerIds = [];
		for (const candidateId of candidates) {
			if (this.follows.has(`${normalizedUserId}:${candidateId}`)) followingIds.push(candidateId);
			if (this.follows.has(`${candidateId}:${normalizedUserId}`)) followerIds.push(candidateId);
		}
		return { followingIds, followerIds };
	}

	async getPinnedPostId(userId) {
		for (const key of this.pinnedPosts.keys()) {
			const [uId, postId] = key.split(':').map(Number);
			if (uId === userId) return postId;
		}
		return null;
	}

		async getFollowingCount(userId) {
			return (this.followingIdsByUser.get(Number(userId)) || new Set()).size;
		}

		async getFollowerCount(userId) {
			return (this.followerIdsByUser.get(Number(userId)) || new Set()).size;
		}

		async getPostCount(userId) {
			return (this.postIdsByUser.get(Number(userId)) || []).length;
		}

	async getRanking(type, limit = 50) {
		const fieldByType = {
			followers: 'follower_count',
			posts: 'post_count',
			likes: 'like_count',
			stars: 'star_count',
		};
		const metricField = fieldByType[type];
		if (!metricField) throw new Error('Invalid ranking type');

		const rows = [];
		for (const user of this.users.values()) {
			let value = 0;
			if (type === 'followers') value = await this.getFollowerCount(user.id);
			if (type === 'posts') value = await this.getPostCount(user.id);
			if (type === 'likes' || type === 'stars') {
				const reactions = type === 'likes' ? this.likes : this.stars;
				for (const key of reactions.keys()) {
					const [, postId] = key.split(':').map(Number);
					if (this.posts.get(postId)?.userId === user.id) value += 1;
				}
			}
			rows.push({
				user_id: user.id,
				name: user.name,
				scid: user.scid,
				icon_data: user.icon_data,
				[metricField]: value,
			});
		}

		return rows
			.sort((a, b) => b[metricField] - a[metricField] || a.user_id - b.user_id)
			.slice(0, limit);
	}

	async getUserRanking(type, userId) {
		const fieldByType = {
			followers: 'follower_count',
			posts: 'post_count',
			likes: 'like_count',
			stars: 'star_count',
		};
		const metricField = fieldByType[type];
		if (!metricField) throw new Error('Invalid ranking type');

		const rows = await this.getRanking(type, this.users.size);
		const index = rows.findIndex((row) => row.user_id === userId);
		return {
			rank: index >= 0 ? index + 1 : null,
			[metricField]: index >= 0 ? rows[index][metricField] : 0,
		};
	}

	async getMediaCount(userId) {
		const postIds = this.postIdsByUser.get(Number(userId)) || [];
		let count = 0;
		for (const postId of postIds) {
			const post = this.posts.get(postId);
			if (Array.isArray(post?.attachments) && post.attachments.length > 0) count++;
		}
		return count;
	}

	
	async getMediaPosts(userId, limit = 15, offset = 0) {
		const userPosts = (this.postIdsByUser.get(Number(userId)) || [])
			.map((postId) => this.posts.get(postId))
			.filter(Boolean);

		const items = [];
		for (const post of userPosts) {
			if (!Array.isArray(post.attachments)) continue;
			for (const att of post.attachments) {
				items.push({
					post_id: post.id,
					file_id: att.id,
					file_type: att.type || 'file',
					type: att.type || 'file',
				});
			}
		}
		return items.slice(offset, offset + limit);
	}

	async getReplyCount(postId) {
		return this.replyCountByParent.get(Number(postId)) || 0;
	}

		async getReplyPostIds(parentPostId, limit = 50, offset = 0) {
				const normalizedLimit = Math.max(1, Number(limit) || 50);
				const normalizedOffset = Math.max(0, Number(offset) || 0);
				const replyIds = this.replyIdsByParent.get(Number(parentPostId)) || [];
				const window = replyIds.slice(normalizedOffset, normalizedOffset + normalizedLimit + 1);
				return { ids: window.slice(0, normalizedLimit), has_more: window.length > normalizedLimit };
			}

			async getThreadReplyPostIds(parentPostId, limit = 50, offset = 0) {
				const normalizedLimit = Math.max(1, Number(limit) || 50);
				const normalizedOffset = Math.max(0, Number(offset) || 0);
				const ids = [];
				const visited = new Set();
				const visit = (parentId) => {
					for (const childId of this.replyIdsByParent.get(Number(parentId)) || []) {
						const normalizedChildId = Number(childId);
						if (!Number.isInteger(normalizedChildId) || visited.has(normalizedChildId)) continue;
						visited.add(normalizedChildId);
						ids.push(normalizedChildId);
						visit(normalizedChildId);
					}
				};
				visit(parentPostId);
				const window = ids.slice(normalizedOffset, normalizedOffset + normalizedLimit + 1);
				return { ids: window.slice(0, normalizedLimit), has_more: window.length > normalizedLimit };
			}

		
			async getProfilePostIds({ userId, subType = 'all', limit = 30, offset = 0, beforeId = null } = {}) {
			const normalizedLimit = Math.max(1, Number(limit) || 30);
			const normalizedBeforeId = Number.isInteger(Number(beforeId)) && Number(beforeId) > 0
				? Number(beforeId)
				: null;
			const normalizedOffset = normalizedBeforeId == null ? Math.max(0, Number(offset) || 0) : 0;
			const sourceIds = this.postIdsByUser.get(Number(userId)) || [];
			const matched = sourceIds.filter((id) => {
				const post = this.posts.get(id);
				if (!post || (normalizedBeforeId != null && Number(id) >= normalizedBeforeId)) return false;
				return subType === 'all' || (subType === 'posts_only' ? post.replyTo == null : post.replyTo != null);
			});
			const window = matched.slice(normalizedOffset, normalizedOffset + normalizedLimit + 1);
			const ids = window.slice(0, normalizedLimit);
			return {
				ids,
				has_more: window.length > normalizedLimit,
				next_cursor: window.length > normalizedLimit && ids.length > 0 ? ids[ids.length - 1] : null,
			};
		}

		async getTimelinePostIds({ tab = 'foryou', followIds = [], limit = 30, offset = 0, beforeId = null } = {}) {
			const normalizedLimit = Math.max(1, Number(limit) || 30);
			const normalizedBeforeId = Number.isInteger(Number(beforeId)) && Number(beforeId) > 0
				? Number(beforeId)
				: null;
			const normalizedOffset = normalizedBeforeId == null ? Math.max(0, Number(offset) || 0) : 0;
			const followSet = tab === 'following' ? new Set((followIds || []).map(Number)) : null;
			const matched = [];
			for (const id of this.postIdsNewest) {
				const post = this.posts.get(id);
				if (!post || post.replyTo != null || (normalizedBeforeId != null && Number(id) >= normalizedBeforeId)) continue;
				const matches = tab === 'following'
					? followSet.has(Number(post.userId))
					: tab === 'announce'
						? post.announcement === true
						: true;
				if (!matches) continue;
				matched.push(id);
				if (matched.length >= normalizedOffset + normalizedLimit + 1) break;
			}
			const window = matched.slice(normalizedOffset, normalizedOffset + normalizedLimit + 1);
			const ids = window.slice(0, normalizedLimit);
			return {
				ids,
				has_more: window.length > normalizedLimit,
				next_cursor: window.length > normalizedLimit && ids.length > 0 ? ids[ids.length - 1] : null,
			};
		}

		async getRecommendedPostIds({ viewerId = null, limit = 30, offset = 0, beforeId = null } = {}) {
			const normalizedLimit = Math.max(1, Number(limit) || 30);
			const normalizedBeforeId = Number.isInteger(Number(beforeId)) && Number(beforeId) > 0
				? Number(beforeId)
				: null;
			const normalizedOffset = normalizedBeforeId == null ? Math.max(0, Number(offset) || 0) : 0;
			const candidateLimit = Math.min(
				1000,
				Math.max(500, normalizedOffset + normalizedLimit + 1),
			);
			const normalizedViewerId = Number.isInteger(Number(viewerId)) ? Number(viewerId) : null;
			const directFollowIds = normalizedViewerId == null
				? new Set()
				: new Set(this.followingIdsByUser.get(normalizedViewerId) || []);
			const secondDegreeFollowIds = new Set();
			for (const followedUserId of directFollowIds) {
				for (const candidateUserId of this.followingIdsByUser.get(followedUserId) || []) {
					if (candidateUserId !== normalizedViewerId && !directFollowIds.has(candidateUserId)) {
						secondDegreeFollowIds.add(candidateUserId);
					}
				}
			}
			const affinityByAuthor = new Map();
			const addAffinity = (postIds, field) => {
				for (const postId of postIds) {
					const reactedPost = this.posts.get(postId);
					if (!reactedPost) continue;
					const authorId = Number(reactedPost.userId);
					const affinity = affinityByAuthor.get(authorId) || { likes: 0, stars: 0 };
					affinity[field] += 1;
					affinityByAuthor.set(authorId, affinity);
				}
			};
			if (normalizedViewerId != null) {
				addAffinity(this.likedPostIdsByUser.get(normalizedViewerId) || [], 'likes');
				addAffinity(this.starredPostIdsByUser.get(normalizedViewerId) || [], 'stars');
			}

			const candidates = [];
			for (const id of this.postIdsNewest) {
				const post = this.posts.get(id);
				if (!post || post.replyTo != null || (normalizedBeforeId != null && Number(id) >= normalizedBeforeId)) continue;
				candidates.push(post);
				if (candidates.length >= candidateLimit) break;
			}
			const now = Date.now();
			const scored = candidates.map((post) => {
				const authorId = Number(post.userId);
				const ageHours = Math.max(0, (now - new Date(post.createdAt || post.created_at).getTime()) / 3600000);
				const recencyScore = 48 / (1 + ageHours / 6);
				const affinity = affinityByAuthor.get(authorId) || { likes: 0, stars: 0 };
				const affinityScore = Math.min(20, affinity.likes * 4) + Math.min(32, affinity.stars * 8);
				const graphScore = directFollowIds.has(authorId)
					? 24
					: secondDegreeFollowIds.has(authorId)
						? 10
						: 0;
				const engagementScore = Math.min(
					22,
					Math.log1p(this.likeCountByPost.get(Number(post.id)) || 0) * 2
						+ Math.log1p(this.starCountByPost.get(Number(post.id)) || 0) * 4
						+ Math.log1p(this.repostCountByPost.get(Number(post.id)) || 0) * 5,
				);
				return { post, score: recencyScore + graphScore + affinityScore + engagementScore };
			});
			scored.sort((left, right) => (
				right.score - left.score
				|| new Date(right.post.createdAt || right.post.created_at).getTime() - new Date(left.post.createdAt || left.post.created_at).getTime()
				|| Number(right.post.id) - Number(left.post.id)
			));
			const window = scored.slice(normalizedOffset, normalizedOffset + normalizedLimit + 1);
			const ids = window.slice(0, normalizedLimit).map(({ post }) => post.id);
			return {
				ids,
				has_more: window.length > normalizedLimit,
				next_cursor: null,
				use_offset_pagination: true,
			};
		}

		async searchPostIds(query, limit = 30, offset = 0, beforeId = null) {
			if (!query || query.trim().length === 0) return { ids: [], has_more: false, next_cursor: null };
			const q = query.toLowerCase().trim();
			const normalizedLimit = Math.max(1, Number(limit) || 30);
			const normalizedBeforeId = Number.isInteger(Number(beforeId)) && Number(beforeId) > 0
				? Number(beforeId)
				: null;
			const normalizedOffset = normalizedBeforeId == null ? Math.max(0, Number(offset) || 0) : 0;
			const matched = [];
			for (const id of this.postIdsNewest) {
				const post = this.posts.get(id);
				if (!post || (normalizedBeforeId != null && Number(id) >= normalizedBeforeId)) continue;
				if (!(post.content || '').toLowerCase().includes(q)) continue;
				matched.push(id);
				if (matched.length >= normalizedOffset + normalizedLimit + 1) break;
			}
			const window = matched.slice(normalizedOffset, normalizedOffset + normalizedLimit + 1);
			const ids = window.slice(0, normalizedLimit);
			return {
				ids,
				has_more: window.length > normalizedLimit,
				next_cursor: window.length > normalizedLimit && ids.length > 0 ? ids[ids.length - 1] : null,
			};
		}

	
	async getTrendingHashtags(limit = 10) {
		const counts = new Map();
		for (const post of this.posts.values()) {
			const content = post.content || '';
			const matches = content.match(/#([^<>/@#\s]+)/g) || [];
			const uniqueTags = new Set(matches.map((match) => match.slice(1).toLowerCase()));
			for (const tag of uniqueTags) {
				counts.set(tag, (counts.get(tag) || 0) + 1);
			}
		}
		return Array.from(counts.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, limit)
			.map(([tag_name, occurrence_count]) => ({
				tag_name,
				occurrence_count,
			}));
	}

	
	async getUserStatus(userId) {
		const user = this.users.get(userId);
		if (!user) return null;
		return { shadow: !!user.shadow };
	}

	
	async setUserStatus(userId, status) {
		const user = this.users.get(userId);
		if (!user) return null;
		if (status.shadow !== undefined) user.shadow = !!status.shadow;
		return { shadow: !!user.shadow };
	}

	async addLog(entry) {
		this.logs.push({
			scratch_id: entry.scratch_id || '',
			nyaitter_id: entry.nyaitter_id || null,
			masked_ip_uuid: entry.masked_ip_uuid || '',
			log_time: new Date(),
		});
	}

	async getLogs(limit = 20, offset = 0) {
		const sorted = this.logs
			.slice()
			.sort((a, b) => new Date(b.log_time) - new Date(a.log_time));
		return sorted.slice(offset, offset + limit);
	}
}

module.exports = InMemoryAdapter;
