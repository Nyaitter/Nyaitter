const DatabaseAdapter = require('../DatabaseAdapter');

const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

function boundedInteger(value, fallback, minimum, maximum) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function requireId(value, fieldName = 'id', minimum = 0) {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum) {
		throw new TypeError(`${fieldName} must be an integer greater than or equal to ${minimum}`);
	}
	return parsed;
}

function mapSession(session) {
	if (!session) return null;
	return {
		id: session.id || session.session_id,
		token: session.token,
		userId: session.userId ?? session.user_id,
		expiresAt: session.expiresAt || session.expires_at,
		createdAt: session.createdAt || session.created_at,
		ipHash: session.ipHash ?? session.ip_hash ?? null,
		ipMasked: session.ipMasked ?? session.ip_masked ?? '旧セッション',
		userAgent: session.userAgent ?? session.user_agent ?? '不明な端末',
	};
}

function mapLoginApproval(approval) {
	if (!approval) return null;
	return {
		id: approval.id,
		userId: approval.userId ?? approval.user_id,
		ipHash: approval.ipHash ?? approval.ip_hash,
		ipMasked: approval.ipMasked ?? approval.ip_masked,
		userAgent: approval.userAgent ?? approval.user_agent,
		pollTokenHash: approval.pollTokenHash ?? approval.poll_token_hash,
		status: approval.status,
		createdAt: approval.createdAt ?? approval.created_at,
		expiresAt: approval.expiresAt ?? approval.expires_at,
		decidedAt: approval.decidedAt ?? approval.decided_at,
		consumedAt: approval.consumedAt ?? approval.consumed_at,
	};
}

function normalizePost(post) {
	if (!post) return post;
	post.userId = post.userId ?? post.user_id;
	post.replyTo = post.replyTo ?? post.reply_to ?? null;
	post.repostTo = post.repostTo ?? post.repost_to ?? null;
	post.createdAt = post.createdAt ?? post.created_at ?? null;
	post.mask = !!post.mask;
	post.lock = !!post.lock;
	if (post.attachments && typeof post.attachments === 'string') {
		try {
			post.attachments = JSON.parse(post.attachments);
		} catch (_) {}
	}
	if (!Array.isArray(post.attachments)) {
		post.attachments = post.attachments ? [post.attachments] : [];
	}
	return post;
}

function serializeGroupDm(row, userId = null) {
	if (!row) return null;
	const unread = row.unread || {};
	const res = {
		id: row.id,
		title: row.title || '',
		member: Array.isArray(row.member) ? row.member.map(Number) : [],
		host_id: row.host_id ?? row.hostId,
		time: row.time instanceof Date ? row.time.toISOString() : (row.time || null),
		post: Array.isArray(row.post) ? row.post : [],
	};
	if (row.unread !== undefined) {
		res.unread = row.unread;
	}
	if (userId !== null && userId !== undefined) {
		res.unread_count = Number(unread[userId] ?? unread[String(userId)] ?? row.unread_count ?? 0);
	}
	return res;
}

class D1Adapter extends DatabaseAdapter {
	constructor(options = {}) {
		super();
		this.workerUrl = options.workerUrl || process.env.D1_WORKER_URL || '';
		this.authToken = options.authToken || process.env.D1_WORKER_TOKEN || '';
		this.fetchImpl = options.fetch || globalThis.fetch;
		this.requestTimeoutMs = boundedInteger(options.requestTimeoutMs ?? process.env.D1_REQUEST_TIMEOUT_MS, 10000, 100, 60000);
		this.retryAttempts = boundedInteger(options.retryAttempts ?? process.env.D1_RETRY_ATTEMPTS, 1, 0, 4);
		this.retryBaseDelayMs = boundedInteger(options.retryBaseDelayMs ?? process.env.D1_RETRY_BASE_DELAY_MS, 120, 0, 5000);
		this.readCacheSeconds = boundedInteger(options.readCacheSeconds ?? process.env.D1_READ_CACHE_SECONDS, 0, 0, 60);
		this.batchMaxItems = boundedInteger(options.batchMaxItems ?? process.env.D1_BATCH_MAX_ITEMS, 100, 1, 500);
		this.readCache = new Map();
		this.inFlightReads = new Map();
	}

	async connect() {
		if (!this.workerUrl) {
			throw new Error('D1Adapter requires workerUrl (or D1_WORKER_URL env var)');
		}
		if (typeof this.fetchImpl !== 'function') {
			throw new Error('D1Adapter requires a Fetch-compatible implementation');
		}

		let endpoint;
		try {
			endpoint = new URL(this.workerUrl);
		} catch (_) {
			throw new Error('D1Adapter workerUrl must be an absolute URL');
		}
		if (!['https:', 'http:'].includes(endpoint.protocol)) {
			throw new Error('D1Adapter workerUrl must use HTTP(S)');
		}
		if (endpoint.protocol !== 'https:' && process.env.NODE_ENV === 'production') {
			throw new Error('D1Adapter requires an HTTPS workerUrl in production');
		}
		endpoint.pathname = endpoint.pathname.replace(/\/+$/, '');
		this.workerUrl = endpoint.toString().replace(/\/+$/, '');
		console.log('[D1Adapter] Using D1 via Worker proxy:', endpoint.origin);
	}

	async disconnect() {
		this.readCache.clear();
		this.inFlightReads.clear();
	}

	_clearReadCache() {
		this.readCache.clear();
	}

	_readCached(cacheKey) {
		const cached = this.readCache.get(cacheKey);
		if (!cached) return undefined;
		if (cached.expiresAt <= Date.now()) {
			this.readCache.delete(cacheKey);
			return undefined;
		}
		return cached.value;
	}

	_isRetryable(error) {
		if (error && RETRYABLE_STATUS_CODES.has(Number(error.status))) return true;
		return error?.name === 'AbortError' || error?.name === 'TimeoutError' || error instanceof TypeError;
	}

	async _sleep(milliseconds) {
		if (milliseconds <= 0) return;
		await new Promise((resolve) => setTimeout(resolve, milliseconds));
	}

	async _executeRequest(path, { method = 'GET', body = null, retry = false } = {}) {
		if (!this.workerUrl) throw new Error('D1Adapter is not connected');
		const bodyText = body == null ? undefined : JSON.stringify(body);
		const maximumAttempts = retry ? this.retryAttempts : 0;

		for (let attempt = 0; ; attempt += 1) {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
			try {
				const response = await this.fetchImpl(`${this.workerUrl}${path}`, {
					method,
					headers: {
						...(bodyText ? { 'Content-Type': 'application/json' } : {}),
						...(this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {}),
					},
					body: bodyText,
					signal: controller.signal,
				});
				if (!response || !response.ok) {
					const text = response ? (await response.text()).slice(0, 500) : '';
					const error = new Error(`D1 Worker error: ${response?.status || 0}${text ? ` ${text}` : ''}`);
					error.status = response?.status;
					throw error;
				}
				return await response.json();
			} catch (error) {
				if (!retry || attempt >= maximumAttempts || !this._isRetryable(error)) throw error;
				await this._sleep(this.retryBaseDelayMs * (2 ** attempt));
			} finally {
				clearTimeout(timeout);
			}
		}
	}

	async _request(path, {
		method = 'GET', body = null, cacheKey = null, cacheSeconds = 0, retry = false,
	} = {}) {
		const normalizedCacheKey = cacheKey || null;
		if (!normalizedCacheKey) {
			return this._executeRequest(path, { method, body, retry });
		}

		const cached = this._readCached(normalizedCacheKey);
		if (cached !== undefined) return cached;
		const existing = this.inFlightReads.get(normalizedCacheKey);
		if (existing) return existing;

		const request = this._executeRequest(path, { method, body, retry })
			.then((value) => {
				if (cacheSeconds > 0) {
					this.readCache.set(normalizedCacheKey, {
						value,
						expiresAt: Date.now() + cacheSeconds * 1000,
					});
				}
				return value;
			})
			.finally(() => this.inFlightReads.delete(normalizedCacheKey));
		this.inFlightReads.set(normalizedCacheKey, request);
		return request;
	}

	async _read(path, { body = null, cacheKey = null, cacheSeconds = this.readCacheSeconds } = {}) {
		return this._request(path, {
			method: body == null ? 'GET' : 'POST',
			body,
			cacheKey: cacheKey || `${path}:${body == null ? '' : JSON.stringify(body)}`,
			cacheSeconds,
			retry: true,
		});
	}

	async _write(path, body = null) {
		const result = await this._request(path, {
			method: 'POST',
			body,
			retry: false,
		});
		this._clearReadCache();
		return result;
	}

	_query(path, values = {}) {
		const query = new URLSearchParams();
		for (const [key, value] of Object.entries(values)) {
			if (value != null && value !== '') query.set(key, String(value));
		}
		const encoded = query.toString();
		return encoded ? `${path}?${encoded}` : path;
	}

	_normalizeIds(ids, { fieldName = 'id', minimum = 0 } = {}) {
		if (!Array.isArray(ids)) throw new TypeError('ids must be an array');
		return [...new Set(ids.map((id) => requireId(id, fieldName, minimum)))].slice(0, this.batchMaxItems);
	}

	_limit(value, fallback = 20, maximum = 100) {
		return boundedInteger(value, fallback, 1, maximum);
	}

	_offset(value) {
		return boundedInteger(value, 0, 0, 1000000);
	}

	async createSession(userId, meta = {}) {
		const session = await this._write('/sessions', {
			userId: requireId(userId, 'userId'),
			...meta,
		});
		return mapSession(session);
	}

	async getSessionByToken(token) {
		if (!token) return null;
		const session = await this._read(`/sessions/token/${encodeURIComponent(String(token))}`, { cacheSeconds: 0 });
		return mapSession(session);
	}

	async invalidateSession(token) {
		if (!token) return false;
		const result = await this._write('/sessions/invalidate', { token: String(token) });
		return typeof result === 'boolean' ? result : !!result?.success;
	}

	async getUserSessions(userId) {
		const sessions = await this._read(`/users/${requireId(userId, 'userId')}/sessions`, { cacheSeconds: 0 });
		return Array.isArray(sessions) ? sessions.map(mapSession) : [];
	}

	async invalidateAllSessions(userId) {
		const result = await this._write(`/users/${requireId(userId, 'userId')}/sessions/invalidate-all`);
		return Number(result?.count ?? result ?? 0);
	}

	async invalidateSessionsByIp(userId, ipHash) {
		const result = await this._write(`/users/${requireId(userId, 'userId')}/sessions/invalidate-ip`, {
			ipHash: String(ipHash),
		});
		return Number(result?.count ?? result ?? 0);
	}

	async trustLoginIp(userId, { ipHash, ipMasked }) {
		return this._write(`/users/${requireId(userId, 'userId')}/trusted-ips`, {
			ipHash: String(ipHash),
			ipMasked: ipMasked || '不明なIPアドレス',
		});
	}

	async getTrustedLoginIp(userId, ipHash) {
		return this._read(`/users/${requireId(userId, 'userId')}/trusted-ips/${encodeURIComponent(String(ipHash))}`, { cacheSeconds: 0 });
	}

	async countTrustedLoginIps(userId) {
		const result = await this._read(`/users/${requireId(userId, 'userId')}/trusted-ips/count`, { cacheSeconds: 0 });
		return Number(result?.count ?? result ?? 0);
	}

	async revokeTrustedLoginIp(userId, ipHash) {
		const result = await this._write(`/users/${requireId(userId, 'userId')}/trusted-ips/${encodeURIComponent(String(ipHash))}/revoke`);
		return typeof result === 'boolean' ? result : !!result?.success;
	}

	async createLoginApproval(approvalData) {
		const approval = await this._write('/login-approvals', approvalData);
		return mapLoginApproval(approval);
	}

	async getLoginApproval(id) {
		if (!id) return null;
		const approval = await this._read(`/login-approvals/${encodeURIComponent(String(id))}`, { cacheSeconds: 0 });
		return mapLoginApproval(approval);
	}

	async getLoginApprovalByPollToken(id, pollTokenHash) {
		if (!id || !pollTokenHash) return null;
		const approval = await this._write(`/login-approvals/${encodeURIComponent(String(id))}/poll`, {
			pollTokenHash: String(pollTokenHash),
		});
		return mapLoginApproval(approval);
	}

	async decideLoginApproval(userId, id, decision) {
		const approval = await this._write(`/login-approvals/${encodeURIComponent(String(id))}/decision`, {
			userId: requireId(userId, 'userId'),
			decision: String(decision),
		});
		return mapLoginApproval(approval);
	}

	async consumeLoginApproval(id, pollTokenHash) {
		const approval = await this._write(`/login-approvals/${encodeURIComponent(String(id))}/consume`, {
			pollTokenHash: String(pollTokenHash),
		});
		return mapLoginApproval(approval);
	}

	async createBotToken(userId, tokenId, tokenHash, name) {
		return this._write(`/users/${requireId(userId, 'userId')}/bot-tokens`, {
			tokenId: String(tokenId),
			tokenHash: String(tokenHash),
			name: String(name || ''),
		});
	}

	async getBotTokenById(tokenId) {
		if (!tokenId) return null;
		return this._read(`/bot-tokens/${encodeURIComponent(String(tokenId))}`, { cacheSeconds: 0 });
	}

	async getUserBotTokens(userId) {
		const tokens = await this._read(`/users/${requireId(userId, 'userId')}/bot-tokens`, { cacheSeconds: 0 });
		return Array.isArray(tokens) ? tokens : [];
	}

	async revokeBotToken(userId, tokenId) {
		const result = await this._write(`/users/${requireId(userId, 'userId')}/bot-tokens/${encodeURIComponent(String(tokenId))}/revoke`);
		return typeof result === 'boolean' ? result : !!result?.success;
	}

	async updateBotTokenLastUsed(tokenId) {
		if (!tokenId) return;
		return this._write(`/bot-tokens/${encodeURIComponent(String(tokenId))}/last-used`);
	}

	async getUserByScid(scid) {
		return this._read(`/users/scid/${encodeURIComponent(String(scid))}`);
	}

	async getUserById(id) {
		const userId = requireId(id, 'id');
		return this._read(`/users/${userId}`);
	}

	async getUserByNyaitterAddress(address) {
		return this._read(`/users/address/${encodeURIComponent(String(address))}`);
	}

	async getOrCreateExternalUser(params) {
		return this._write('/users/external', params);
	}

	async createUser(userData) {
		return this._write('/users', userData);
	}

	async searchUsers(query, limit = 20) {
		return this._read(this._query('/users/search', {
			q: String(query || ''), limit: this._limit(limit),
		}));
	}

	async getUsersByIds(userIds) {
		const ids = this._normalizeIds(userIds);
		if (ids.length === 0) return [];
		return this._read('/users/batch', { body: { ids } });
	}

	async getAllUsers() {
		const users = await this._read('/users', { cacheSeconds: 0 });
		return Array.isArray(users) ? users : [];
	}

	async getUserStatus(userId) {
		return this._read(`/users/${requireId(userId, 'userId')}/status`, { cacheSeconds: 0 });
	}

	async setUserStatus(userId, status) {
		return this._write(`/users/${requireId(userId, 'userId')}/status`, status);
	}

	async updateUserProfile(userId, profileData) {
		return this._write(`/users/${requireId(userId, 'userId')}/profile`, profileData);
	}

	async toggleFollow(followerId, followingId) {
		return this._write(`/users/${requireId(followingId, 'followingId')}/follow`, {
			followerId: requireId(followerId, 'followerId'),
		});
	}

	async isFollowing(followerId, followingId) {
		const result = await this._read(this._query(`/users/${requireId(followingId, 'followingId')}/is-following`, {
			followerId: requireId(followerId, 'followerId'),
		}), { cacheSeconds: 0 });
		return typeof result === 'boolean' ? result : !!result?.following;
	}

	async getFollowing(userId, limit = 100) {
		const list = await this._read(this._query(`/users/${requireId(userId, 'userId')}/following`, {
			limit: this._limit(limit, 100, 500),
		}), { cacheSeconds: 0 });
		return Array.isArray(list) ? list : [];
	}

	async getFollowers(userId, limit = 100) {
		const list = await this._read(this._query(`/users/${requireId(userId, 'userId')}/followers`, {
			limit: this._limit(limit, 100, 500),
		}), { cacheSeconds: 0 });
		return Array.isArray(list) ? list : [];
	}

	async getFollowingCount(userId) {
		const res = await this._read(`/users/${requireId(userId, 'userId')}/following/count`, { cacheSeconds: 0 });
		return Number(res?.count ?? res ?? 0);
	}

	async getFollowerCount(userId) {
		const res = await this._read(`/users/${requireId(userId, 'userId')}/followers/count`, { cacheSeconds: 0 });
		return Number(res?.count ?? res ?? 0);
	}

	async getFollowIds(userId) {
		const ids = await this._read(`/users/${requireId(userId, 'userId')}/following/ids`, { cacheSeconds: 0 });
		return Array.isArray(ids) ? ids.map(Number) : [];
	}

	async createPost(postData) {
		const post = await this._write('/posts', postData);
		return normalizePost(post);
	}

	async getPostById(id) {
		const postId = requireId(id, 'postId', 1);
		const post = await this._read(`/posts/${postId}`);
		return normalizePost(post);
	}

	async getPostsByIds(postIds) {
		const ids = this._normalizeIds(postIds, { fieldName: 'postId', minimum: 1 });
		if (ids.length === 0) return [];
		const posts = await this._read('/posts/batch', { body: { ids } });
		return Array.isArray(posts) ? posts.map(normalizePost) : [];
	}

	async getPostMetricsBatch(postIds, currentUserId = null) {
		const ids = this._normalizeIds(postIds, { fieldName: 'postId', minimum: 1 });
		if (ids.length === 0) return [];
		const body = {
			ids,
			currentUserId: currentUserId == null ? null : requireId(currentUserId, 'currentUserId'),
		};
		return this._read('/posts/metrics/batch', { body });
	}

	async updatePost(postId, fields) {
		const post = await this._write(`/posts/${requireId(postId, 'postId', 1)}`, fields);
		return normalizePost(post);
	}

	async deletePost(postId, userId) {
		const result = await this._write(`/posts/${requireId(postId, 'postId', 1)}/delete`, {
			userId: requireId(userId, 'userId'),
		});
		return typeof result === 'boolean' ? result : !!result?.success;
	}

	async adminDeletePost(postId) {
		const result = await this._write(`/posts/${requireId(postId, 'postId', 1)}/admin-delete`);
		return typeof result === 'boolean' ? result : !!result?.success;
	}

	async getRecentPosts(limit = 30) {
		const posts = await this._read(this._query('/posts/recent', { limit: this._limit(limit, 30) }));
		return Array.isArray(posts) ? posts.map(normalizePost) : [];
	}

	async getPostsByUserId(userId, limit = 50, currentUserId = null) {
		const posts = await this._read(this._query(`/users/${requireId(userId, 'userId')}/posts`, {
			limit: this._limit(limit, 50),
			currentUserId: currentUserId == null ? null : requireId(currentUserId, 'currentUserId'),
		}));
		return Array.isArray(posts) ? posts.map(normalizePost) : [];
	}

	async getTimelinePosts(params = {}) {
		const limit = this._limit(params.limit, 30);
		const posts = await this.getRecentPosts(limit);
		return { posts, hasMore: posts.length === limit };
	}

	async getTimelinePostIds({ tab = 'foryou', followIds = [], limit = 30, offset = 0 } = {}) {
		const body = {
			tab: String(tab),
			followIds: this._normalizeIds(followIds),
			limit: this._limit(limit, 30),
			offset: this._offset(offset),
		};
		return this._read('/posts/timeline/ids', { body, cacheSeconds: 0 });
	}

	async getRecommendedPostIds({ limit = 30, offset = 0 } = {}) {
		return this._read(this._query('/posts/recommended/ids', {
			limit: this._limit(limit, 30), offset: this._offset(offset),
		}), { cacheSeconds: 0 });
	}

	async getProfilePostIds({ userId, subType = 'all', limit = 30, offset = 0 } = {}) {
		return this._read(this._query(`/users/${requireId(userId, 'userId')}/post-ids`, {
			subType: String(subType || 'all'), limit: this._limit(limit, 30), offset: this._offset(offset),
		}), { cacheSeconds: 0 });
	}

	async searchPostIds(query, limit = 30, offset = 0) {
		return this._read(this._query('/posts/search/ids', {
			q: String(query || ''), limit: this._limit(limit, 30), offset: this._offset(offset),
		}), { cacheSeconds: 0 });
	}

	async searchPosts(query, limit = 20) {
		const posts = await this._read(this._query('/posts/search', { q: String(query || ''), limit: this._limit(limit) }), { cacheSeconds: 0 });
		return Array.isArray(posts) ? posts.map(normalizePost) : [];
	}

	async getReplyPostIds(parentPostId, limit = 50, offset = 0) {
		return this._read(this._query(`/posts/${requireId(parentPostId, 'parentPostId', 1)}/reply-ids`, {
			limit: this._limit(limit, 50), offset: this._offset(offset),
		}), { cacheSeconds: 0 });
	}

	async getThreadReplyPostIds(parentPostId, limit = 50, offset = 0) {
		return this._read(this._query(`/posts/${requireId(parentPostId, 'parentPostId', 1)}/thread-reply-ids`, {
			limit: this._limit(limit, 50), offset: this._offset(offset),
		}), { cacheSeconds: 0 });
	}

	async getPostDetail(id, currentUserId = null) {
		return this._read(this._query(`/posts/${requireId(id, 'postId', 1)}/detail`, {
			currentUserId: currentUserId == null ? null : requireId(currentUserId, 'currentUserId'),
		}));
	}

	async getTrendingPosts(limit = 20) {
		const posts = await this._read(this._query('/posts/trending', { limit: this._limit(limit) }), { cacheSeconds: 0 });
		return Array.isArray(posts) ? posts.map(normalizePost) : [];
	}

	async getTrendingHashtags(limit = 10) {
		const list = await this._read(this._query('/posts/trending-hashtags', { limit: this._limit(limit, 10, 50) }), { cacheSeconds: 0 });
		return Array.isArray(list) ? list : [];
	}

	async getPostCount(userId) {
		const res = await this._read(`/users/${requireId(userId, 'userId')}/posts/count`, { cacheSeconds: 0 });
		return Number(res?.count ?? res ?? 0);
	}

	async getMediaCount(userId) {
		const res = await this._read(`/users/${requireId(userId, 'userId')}/media/count`, { cacheSeconds: 0 });
		return Number(res?.count ?? res ?? 0);
	}

	async getMediaPosts(userId, limit = 15, offset = 0) {
		const list = await this._read(this._query(`/users/${requireId(userId, 'userId')}/media`, {
			limit: this._limit(limit, 15, 100), offset: this._offset(offset),
		}), { cacheSeconds: 0 });
		return Array.isArray(list) ? list : [];
	}

	async getReplyCount(postId) {
		const res = await this._read(`/posts/${requireId(postId, 'postId', 1)}/replies/count`, { cacheSeconds: 0 });
		return Number(res?.count ?? res ?? 0);
	}

	async toggleLike(userId, postId) {
		return this._write(`/posts/${requireId(postId, 'postId', 1)}/like`, { userId: requireId(userId, 'userId') });
	}

	async getLikeCount(postId) {
		const res = await this._read(`/posts/${requireId(postId, 'postId', 1)}/likes/count`, { cacheSeconds: 0 });
		return Number(res?.count ?? res ?? 0);
	}

	async hasUserLikedPost(userId, postId) {
		const res = await this._read(this._query(`/posts/${requireId(postId, 'postId', 1)}/likes/check`, {
			userId: requireId(userId, 'userId'),
		}), { cacheSeconds: 0 });
		return typeof res === 'boolean' ? res : !!res?.liked;
	}

	async getLikeIds(userId) {
		const list = await this._read(`/users/${requireId(userId, 'userId')}/likes/ids`, { cacheSeconds: 0 });
		return Array.isArray(list) ? list.map(Number) : [];
	}

	async toggleStar(userId, postId) {
		return this._write(`/posts/${requireId(postId, 'postId', 1)}/star`, { userId: requireId(userId, 'userId') });
	}

	async getStarCount(postId) {
		const res = await this._read(`/posts/${requireId(postId, 'postId', 1)}/stars/count`, { cacheSeconds: 0 });
		return Number(res?.count ?? res ?? 0);
	}

	async hasUserStarredPost(userId, postId) {
		const res = await this._read(this._query(`/posts/${requireId(postId, 'postId', 1)}/stars/check`, {
			userId: requireId(userId, 'userId'),
		}), { cacheSeconds: 0 });
		return typeof res === 'boolean' ? res : !!res?.starred;
	}

	async getStarIds(userId) {
		const list = await this._read(`/users/${requireId(userId, 'userId')}/stars/ids`, { cacheSeconds: 0 });
		return Array.isArray(list) ? list.map(Number) : [];
	}

	async togglePin(userId, postId) {
		return this._write(`/posts/${requireId(postId, 'postId', 1)}/pin`, { userId: requireId(userId, 'userId') });
	}

	async getPinnedPosts(userId) {
		const posts = await this._read(`/users/${requireId(userId, 'userId')}/pinned`, { cacheSeconds: 0 });
		return Array.isArray(posts) ? posts.map(normalizePost) : [];
	}

	async getPinnedPostId(userId) {
		const res = await this._read(`/users/${requireId(userId, 'userId')}/pinned/id`, { cacheSeconds: 0 });
		if (res == null) return null;
		if (typeof res === 'number') return res;
		return res.postId != null ? Number(res.postId) : (res.id != null ? Number(res.id) : null);
	}

	async repostPost(userId, postId) {
		const post = await this._write(`/posts/${requireId(postId, 'postId', 1)}/repost`, { userId: requireId(userId, 'userId') });
		return normalizePost(post);
	}

	async getReposts(userId) {
		const posts = await this._read(`/users/${requireId(userId, 'userId')}/reposts`, { cacheSeconds: 0 });
		return Array.isArray(posts) ? posts.map(normalizePost) : [];
	}

	async getRepostsOfPost(postId, limit = 50) {
		const list = await this._read(this._query(`/posts/${requireId(postId, 'postId', 1)}/reposts`, {
			limit: this._limit(limit, 50),
		}), { cacheSeconds: 0 });
		return Array.isArray(list) ? list : [];
	}

	async getRepostCount(postId) {
		const res = await this._read(`/posts/${requireId(postId, 'postId', 1)}/reposts/count`, { cacheSeconds: 0 });
		return Number(res?.count ?? res ?? 0);
	}

	async getDmList(userId) {
		return this._read(this._query('/dm/list', { userId: requireId(userId, 'userId') }), { cacheSeconds: 0 });
	}

	async getOrCreateDmChannel(userId1, userId2) {
		return this._write('/dm/channel', {
			userId1: requireId(userId1, 'userId1'),
			userId2: requireId(userId2, 'userId2'),
		});
	}

	async getDmMessages(channelId, limit = 50, offset = 0) {
		return this._read(this._query(`/dm/messages/${encodeURIComponent(String(channelId))}`, {
			limit: this._limit(limit, 50), offset: this._offset(offset),
		}), { cacheSeconds: 0 });
	}

	async sendDmMessage(channelId, senderId, content) {
		return this._write('/dm/messages', {
			channelId: String(channelId), senderId: requireId(senderId, 'senderId'), content,
		});
	}

	async markDmMessagesAsRead(channelId, userId) {
		return this._write('/dm/read', { channelId: String(channelId), userId: requireId(userId, 'userId') });
	}

	async getUnreadDmCount(userId) {
		const res = await this._read(this._query('/dm/unread', { userId: requireId(userId, 'userId') }), { cacheSeconds: 0 });
		return Number(res?.count ?? res ?? 0);
	}

	async getGroupDmsForUser(userId) {
		const list = await this._read(`/users/${requireId(userId, 'userId')}/group-dms`, { cacheSeconds: 0 });
		return Array.isArray(list) ? list.map((item) => serializeGroupDm(item, userId)) : [];
	}

	async getGroupDm(dmId) {
		if (dmId == null || dmId === '') return null;
		const dm = await this._read(`/group-dms/${encodeURIComponent(String(dmId))}`, { cacheSeconds: 0 });
		return serializeGroupDm(dm);
	}

	async createGroupDm(dmData) {
		const dm = await this._write('/group-dms', {
			hostId: requireId(dmData.hostId, 'hostId'),
			member: this._normalizeIds(dmData.member || []),
			title: String(dmData.title || ''),
		});
		return serializeGroupDm(dm, dmData.hostId);
	}

	async updateGroupDm(dmId, updates) {
		const dm = await this._write(`/group-dms/${encodeURIComponent(String(dmId))}/update`, updates);
		return serializeGroupDm(dm, dm?.host_id ?? dm?.hostId);
	}

	async appendToGroupDm(dmId, message, senderId = null) {
		const dm = await this._write(`/group-dms/${encodeURIComponent(String(dmId))}/messages`, {
			message,
			senderId: senderId == null ? null : requireId(senderId, 'senderId'),
		});
		return serializeGroupDm(dm, senderId);
	}

	async markGroupDmRead(dmId, userId) {
		return this._write(`/group-dms/${encodeURIComponent(String(dmId))}/read`, {
			userId: requireId(userId, 'userId'),
		});
	}

	async getGroupDmUnreadCounts(userId) {
		const list = await this._read(`/users/${requireId(userId, 'userId')}/group-dms/unread-counts`, { cacheSeconds: 0 });
		return Array.isArray(list) ? list : [];
	}

	async getGroupDmUnreadTotal(userId) {
		const res = await this._read(`/users/${requireId(userId, 'userId')}/group-dms/unread-total`, { cacheSeconds: 0 });
		return Number(res?.total ?? res?.count ?? res ?? 0);
	}

	async deleteGroupDm(dmId) {
		const result = await this._write(`/group-dms/${encodeURIComponent(String(dmId))}/delete`);
		return typeof result === 'boolean' ? result : !!result?.success;
	}

	async leaveGroupDm(dmId, userId) {
		const result = await this._write(`/group-dms/${encodeURIComponent(String(dmId))}/leave`, {
			userId: requireId(userId, 'userId'),
		});
		return typeof result === 'boolean' ? result : !!result?.success;
	}

	async findGroupDmByMembers(memberIds) {
		const ids = this._normalizeIds(memberIds);
		if (ids.length === 0) return null;
		const dm = await this._write('/group-dms/find-by-members', { memberIds: ids });
		return serializeGroupDm(dm);
	}

	async getDmPublicKeys(userIds) {
		const ids = this._normalizeIds(userIds);
		if (ids.length === 0) return [];
		const list = await this._read(`/dm-e2e-keys?user_ids=${encodeURIComponent(ids.join(','))}`, { cacheSeconds: 0 });
		return Array.isArray(list) ? list : [];
	}

	async setDmPublicKey(userId, publicKey) {
		await this._write('/dm-e2e-keys', {
			userId: requireId(userId, 'userId'),
			publicKey: String(publicKey),
		});
	}

	async createNotification(notificationData) {
		return this._write('/notifications', notificationData);
	}

	async getNotifications(userId, limit = 50, offset = 0) {
		const list = await this._read(this._query(`/users/${requireId(userId, 'userId')}/notifications`, {
			limit: this._limit(limit, 50, 200), offset: this._offset(offset),
		}), { cacheSeconds: 0 });
		return Array.isArray(list) ? list : [];
	}

	async markNotificationAsRead(notificationId) {
		return this._write(`/notifications/${requireId(notificationId, 'notificationId', 1)}/read`);
	}

	async markNotificationAsClicked(notificationId) {
		return this._write(`/notifications/${requireId(notificationId, 'notificationId', 1)}/click`);
	}

	async getNotificationById(notificationId) {
		return this._read(`/notifications/${requireId(notificationId, 'notificationId', 1)}`, { cacheSeconds: 0 });
	}

	async deleteNotification(notificationId) {
		const result = await this._write(`/notifications/${requireId(notificationId, 'notificationId', 1)}/delete`);
		return typeof result === 'boolean' ? result : !!result?.success;
	}

	async markAllNotificationsAsRead(userId) {
		return this._write(`/users/${requireId(userId, 'userId')}/notifications/read-all`);
	}

	async getUnreadNotificationCount(userId) {
		const res = await this._read(`/users/${requireId(userId, 'userId')}/notifications/unread-count`, { cacheSeconds: 0 });
		return Number(res?.count ?? res ?? 0);
	}

	async upsertPushSubscription(userId, subscription) {
		return this._write(`/users/${requireId(userId, 'userId')}/push-subscriptions`, subscription);
	}

	async getPushSubscriptions(userId) {
		const list = await this._read(`/users/${requireId(userId, 'userId')}/push-subscriptions`, { cacheSeconds: 0 });
		return Array.isArray(list) ? list : [];
	}

	async deletePushSubscription(userId, endpoint) {
		const result = await this._write(`/users/${requireId(userId, 'userId')}/push-subscriptions/delete`, {
			endpoint: String(endpoint),
		});
		return typeof result === 'boolean' ? result : !!result?.success;
	}

	async getRanking(type, limit = 50) {
		const list = await this._read(this._query(`/ranking/${encodeURIComponent(String(type))}`, {
			limit: this._limit(limit, 50, 100),
		}), { cacheSeconds: 0 });
		return Array.isArray(list) ? list : (list?.data || []);
	}

	async getUserRanking(type, userId) {
		return this._read(`/users/${requireId(userId, 'userId')}/ranking/${encodeURIComponent(String(type))}`, { cacheSeconds: 0 });
	}

	async addLog(entry) {
		return this._write('/logs', entry);
	}

	async getLogs(limit = 20, offset = 0) {
		const list = await this._read(this._query('/logs', {
			limit: this._limit(limit, 20, 100), offset: this._offset(offset),
		}), { cacheSeconds: 0 });
		return Array.isArray(list) ? list : [];
	}

}

module.exports = D1Adapter;
