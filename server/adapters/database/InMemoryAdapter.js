const DatabaseAdapter = require('./DatabaseAdapter');
const config = require('../../config');
const crypto = require('crypto');
const {
	buildExternalNyaitterAddress,
	formatNyaitterId,
} = require('../../utils/nyaitterAddress');
const { normalizeTarget } = require('../../utils/notification');

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
		this.dmChannels = new Map(); // channelId -> { id, participants, messages, ... }
		this.groupDms = new Map(); // dmId -> { id, title, member, host_id, time, post, unread }
		this.groupDmIdsByMember = new Map(); // userId -> Set(dmId)
		this.groupDmUnreadTotalByMember = new Map(); // userId -> unread total
		this.dmE2EKeys = new Map(); // userId -> public key (base64url)
		this.follows = new Map(); // `${followerId}:${followingId}` -> true
		this.followingIdsByUser = new Map(); // followerId -> Set(followingId)
		this.followerIdsByUser = new Map(); // followingId -> Set(followerId)
		this.notifications = new Map(); // userId -> [notification]
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

	async getUserByScid(scid) {
		const id = this.scidToId.get(scid);
		return id !== undefined ? this.users.get(id) : null;
	}

	async getUserById(id) {
		return this.users.get(id) || null;
	}

	async getUserByNyaitterAddress(address) {
		if (!this.nyaitterAddressToId) return null;
		const id = this.nyaitterAddressToId.get(address);
		return id ? this.users.get(id) : null;
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
		return {
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
				results.push(user);

				if (results.length >= limit) break;
			}
		}

		return results;
	}

	
	async getUsersByIds(userIds) {
		const results = [];
		for (const id of userIds) {
			const user = this.users.get(id);
			if (user) {
				results.push(user);
			}
		}
		return results;
	}

	
	async getAllUsers() {
		return Array.from(this.users.values());
	}

	async createSession(userId, meta = {}) {
		const token = crypto.randomBytes(config.auth.sessionTokenBytes).toString('hex');
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
		const post = this.posts.get(id);
		if (!post) return null;

		const author = this.getUserById(post.userId);
		const likeCount = this.getLikeCountForPost(id);
		const starCount = this.getStarCountForPost(id);

		const likedByMe = currentUserId
			? this.hasUserLikedPost(currentUserId, id)
			: false;
		const starredByMe = currentUserId
			? this.hasUserStarredPost(currentUserId, id)
			: false;

		let parentPost = null;
		if (post.replyTo) {
			const parent = this.posts.get(post.replyTo);
			if (parent) {
				const parentAuthor = this.getUserById(parent.userId);
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

	
	async getPostsByUserId(userId, limit = config.limits.timelineDefaultLimit, currentUserId = null) {
		const ids = this.postIdsByUser.get(Number(userId)) || [];
		const sliced = ids.slice(0, Math.max(0, Number(limit) || 0));
		return Promise.all(sliced.map((id) => this.getPostDetail(id, currentUserId)));
	}

	async toggleLike(userId, postId) {
		const key = `${userId}:${postId}`;
		const currentlyLiked = this.likes.has(key);

		const currentCount = this.likeCountByPost.get(postId) || 0;
		if (currentlyLiked) {
			this.likes.delete(key);
			this.likeCountByPost.set(postId, Math.max(0, currentCount - 1));
		} else {
			this.likes.set(key, true);
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
			this.starCountByPost.set(postId, Math.max(0, currentCount - 1));
		} else {
			this.stars.set(key, true);
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
		return this.groupDms.get(Number(dmId)) || null;
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
				this.likes.delete(key);
			}
		}
		for (const key of Array.from(this.stars.keys())) {
			if (key.endsWith(`:${postId}`)) {
				this.stars.delete(key);
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
			if (key.endsWith(`:${postId}`)) this.likes.delete(key);
		}
		for (const key of Array.from(this.stars.keys())) {
			if (key.endsWith(`:${postId}`)) this.stars.delete(key);
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
		const notification = {
			id,
			userId: notificationData.userId,
			type: notificationData.type,
			fromUserId: notificationData.fromUserId ?? null,
			target: normalizeTarget(notificationData.target, {
				postId: notificationData.postId,
				open: notificationData.open,
			}),
				read: false,
				clicked: false,
				createdAt: new Date(),
		};

		if (!this.notifications.has(notificationData.userId)) {
			this.notifications.set(notificationData.userId, []);
		}
		this.notifications.get(notificationData.userId).push(notification);

		return notification;
	}

	async getNotifications(userId, limit = 50, offset = 0) {
		const notifications = this.notifications.get(userId) || [];
		const sorted = notifications
			.slice()
			.sort((a, b) => b.createdAt - a.createdAt);
		return sorted.slice(offset, offset + limit);
	}

	async getNotificationById(notificationId) {
		for (const notifications of this.notifications.values()) {
			const notif = notifications.find((n) => n.id === notificationId);
			if (notif) return notif;
		}
		return null;
	}

	async markNotificationAsRead(notificationId) {
		for (const notifications of this.notifications.values()) {
			const notif = notifications.find((n) => n.id === notificationId);
			if (notif) {
				notif.read = true;
				return;
			}
		}
	}

		async markNotificationAsClicked(notificationId) {
			for (const notifications of this.notifications.values()) {
				const notif = notifications.find((n) => n.id === notificationId);
				if (notif) {
					notif.clicked = true;
					return;
				}
			}
		}

		async deleteNotification(notificationId) {
		for (const [userId, notifications] of this.notifications.entries()) {
			const index = notifications.findIndex(
				(n) => n.id === notificationId,
			);
			if (index !== -1) {
				notifications.splice(index, 1);
				if (notifications.length === 0) {
					this.notifications.delete(userId);
				}
				return true;
			}
		}
		return false;
	}

	async markAllNotificationsAsRead(userId) {
		const notifications = this.notifications.get(userId);
		if (notifications) {
			for (const notif of notifications) {
				notif.read = true;
			}
		}
	}

	async getUnreadNotificationCount(userId) {
		const notifications = this.notifications.get(userId) || [];
		return notifications.filter((n) => !n.read).length;
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
			created_at: existing?.created_at || now,
			updated_at: now,
		};
		subscriptions.set(record.endpoint, record);
		return { ...record };
	}

	async getPushSubscriptions(userId) {
		const subscriptions = this.pushSubscriptions.get(Number(userId));
		return subscriptions ? [...subscriptions.values()].map((subscription) => ({ ...subscription })) : [];
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
		];
		for (const key of allowed) {
			if (profileData[key] !== undefined) {
				user[key] = profileData[key];
			}
		}

		return user;
	}

	async getLikeIds(userId) {
		const result = [];
		for (const key of this.likes.keys()) {
			const [uId, postId] = key.split(':').map(Number);
			if (uId === userId) result.push(postId);
		}
		return result;
	}

	async getStarIds(userId) {
		const result = [];
		for (const key of this.stars.keys()) {
			const [uId, postId] = key.split(':').map(Number);
			if (uId === userId) result.push(postId);
		}
		return result;
	}

	async getFollowIds(userId) {
		const result = [];
		for (const key of this.follows.keys()) {
			const [followerId, followingId] = key.split(':').map(Number);
			if (followerId === userId) result.push(followingId);
		}
		return result;
	}

	async getPinnedPostId(userId) {
		for (const key of this.pinnedPosts.keys()) {
			const [uId, postId] = key.split(':').map(Number);
			if (uId === userId) return postId;
		}
		return null;
	}

	async getFollowingCount(userId) {
		let count = 0;
		for (const key of this.follows.keys()) {
			const [followerId] = key.split(':').map(Number);
			if (followerId === userId) count++;
		}
		return count;
	}

	async getFollowerCount(userId) {
		let count = 0;
		for (const key of this.follows.keys()) {
			const [, followingId] = key.split(':').map(Number);
			if (followingId === userId) count++;
		}
		return count;
	}

	async getPostCount(userId) {
		let count = 0;
		for (const post of this.posts.values()) {
			if (post.userId === userId) count++;
		}
		return count;
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

		
			async getProfilePostIds({ userId, subType = 'all', limit = 30, offset = 0 } = {}) {
			const normalizedLimit = Math.max(1, Number(limit) || 30);
			const normalizedOffset = Math.max(0, Number(offset) || 0);
			const sourceIds = this.postIdsByUser.get(Number(userId)) || [];
			if (subType === 'all') {
				const window = sourceIds.slice(normalizedOffset, normalizedOffset + normalizedLimit + 1);
				return { ids: window.slice(0, normalizedLimit), has_more: window.length > normalizedLimit };
			}
			const matched = [];
			for (const id of sourceIds) {
				const post = this.posts.get(id);
				if (!post) continue;
				const matches = subType === 'posts_only' ? post.replyTo == null : post.replyTo != null;
				if (!matches) continue;
				if (matched.length < normalizedOffset + normalizedLimit + 1) matched.push(id);
				else break;
			}
			const window = matched.slice(normalizedOffset);
			return { ids: window.slice(0, normalizedLimit), has_more: window.length > normalizedLimit };
		}

		async getTimelinePostIds({ tab = 'foryou', followIds = [], limit = 30, offset = 0 } = {}) {
			const normalizedLimit = Math.max(1, Number(limit) || 30);
			const normalizedOffset = Math.max(0, Number(offset) || 0);
			if (tab !== 'following' && tab !== 'announce') {
				const matched = [];
				for (const id of this.postIdsNewest) {
					const post = this.posts.get(id);
					if (!post || post.replyTo != null) continue;
					if (matched.length < normalizedOffset + normalizedLimit + 1) matched.push(id);
					else break;
				}
				const window = matched.slice(normalizedOffset);
				return { ids: window.slice(0, normalizedLimit), has_more: window.length > normalizedLimit };
			}
			const followSet = tab === 'following' ? new Set((followIds || []).map(Number)) : null;
			const matched = [];
			for (const id of this.postIdsNewest) {
				const post = this.posts.get(id);
				if (!post) continue;
				const matches = tab === 'following'
					? followSet.has(Number(post.userId)) && post.replyTo === null
					: Number(post.userId) === 2525 && post.replyTo === null && (post.content || '').includes('#NXAnnounce');
				if (!matches) continue;
				if (matched.length < normalizedOffset + normalizedLimit + 1) matched.push(id);
				else break;
			}
			const window = matched.slice(normalizedOffset);
			return { ids: window.slice(0, normalizedLimit), has_more: window.length > normalizedLimit };
	}

	
	async getRecommendedPostIds({ limit = 30, offset = 0 } = {}) {
		const posts = await this.getTrendingPosts(offset + limit);
		const ids = posts.slice(offset, offset + limit).map((p) => p.id);
		const has_more = posts.length > offset + limit;
		return { ids, has_more };
	}

	
	async searchPostIds(query, limit = 30, offset = 0) {
		if (!query || query.trim().length === 0) return { ids: [], has_more: false };
		const q = query.toLowerCase().trim();
		const normalizedLimit = Math.max(1, Number(limit) || 30);
		const normalizedOffset = Math.max(0, Number(offset) || 0);
		const matched = [];
		for (const id of this.postIdsNewest) {
			const post = this.posts.get(id);
			if (!post || !(post.content || '').toLowerCase().includes(q)) continue;
			if (matched.length < normalizedOffset + normalizedLimit + 1) matched.push(id);
			else break;
		}
		const window = matched.slice(normalizedOffset);
		return { ids: window.slice(0, normalizedLimit), has_more: window.length > normalizedLimit };
	}

	
	async getTrendingHashtags(limit = 10) {
		const counts = new Map();
		for (const post of this.posts.values()) {
			const content = post.content || '';
			const matches = content.match(/#([^<>/@#\s]+)/g) || [];
			for (const match of matches) {
				const tag = match.slice(1).toLowerCase();
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
