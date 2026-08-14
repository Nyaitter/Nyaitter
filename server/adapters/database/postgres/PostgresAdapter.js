const { Pool } = require('pg');
const crypto = require('crypto');
const DatabaseAdapter = require('../DatabaseAdapter');
const {
	buildExternalNyaitterAddress,
	formatNyaitterId,
} = require('../../../utils/nyaitterAddress');
const appConfig = require('../../../config');
const { normalizeTarget } = require('../../../utils/notification');

class PostgresAdapter extends DatabaseAdapter {
	constructor(options = {}) {
		super();
		this.config = options;
		this.pool = null;
	}

	async connect() {
		const connectionString = this.config.connectionString || process.env.DATABASE_URL;

		if (!connectionString) {
			throw new Error('PostgreSQL connection string is required (DATABASE_URL or config.connectionString)');
		}

		this.pool = new Pool({
			connectionString,
			max: this.config.poolSize || 10,
			ssl: this.config.ssl ? { rejectUnauthorized: false } : false,
		});

		const client = await this.pool.connect();
		await client.query('SELECT 1');
		client.release();

		console.log('[PostgresAdapter] Connected to PostgreSQL');
	}

	async disconnect() {
		if (this.pool) {
			await this.pool.end();
			this.pool = null;
			console.log('[PostgresAdapter] Disconnected from PostgreSQL');
		}
	}

	async getUserByScid(scid) {
		const { rows } = await this.pool.query(
			'SELECT * FROM users WHERE scid = $1 LIMIT 1',
			[scid]
		);
		return rows[0] || null;
	}

	async getUserById(id) {
		const { rows } = await this.pool.query(
			'SELECT * FROM users WHERE id = $1 LIMIT 1',
			[id]
		);
		return rows[0] || null;
	}

	async getUserByNyaitterAddress(address) {
		const { rows } = await this.pool.query(
			'SELECT * FROM users WHERE nyaitter_address = $1 LIMIT 1',
			[address]
		);
		return rows[0] || null;
	}

	async getOrCreateExternalUser({ providerDomain, externalId, profile = {} }) {
		const address = buildExternalNyaitterAddress(externalId, providerDomain);

		let user = await this.getUserByNyaitterAddress(address);
		if (user) return user;
		return this.createUser({
			name: profile.name || formatNyaitterId(externalId),
			me: profile.me || profile.bio || '',
			bio: profile.bio || profile.me || '',
			icon_data: profile.icon_data || null,
			header_image: profile.header_image || null,
			handle: formatNyaitterId(externalId),
			nyaitter_address: address,
			auth_provider: 'nyaitter',
			provider_domain: providerDomain,
			external_id: externalId,
			external_profile: profile.external_profile || profile,
		});
	}

	async createUser(userData) {
		const provider = userData.auth_provider || 'local';
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const countResult = await this.pool.query('SELECT COUNT(*)::bigint AS count FROM users');
			const count = Number(countResult.rows[0].count);
			const digits = Math.max(4, String(Math.max(count, 1)).length);
			const id = crypto.randomInt(0, 10 ** digits);
			const handle = provider === 'nyaitter' && userData.external_id != null
				? formatNyaitterId(userData.external_id)
				: formatNyaitterId(id);
			const address = userData.nyaitter_address || null;
			try {
				const { rows } = await this.pool.query(
											`INSERT INTO users (id, scid, name, handle, nyaitter_address, auth_provider, provider_domain, external_id, external_profile, uuid, settings, bio, header_image, icon_data, created_at)
						 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW()) RETURNING *`,
						[id, userData.scid || null, userData.name || userData.scid || handle, handle, address,
							 provider, userData.provider_domain || null, userData.external_id || null,
							 userData.external_profile || null, userData.uuid || null,
							 userData.settings ? JSON.stringify(userData.settings) : '{}',
							 userData.bio || userData.me || '', userData.header_image || null,
							 userData.icon_data || null],

				);
				return rows[0];
			} catch (error) {
				if (error.code !== '23505') throw error;
			}
		}
		throw new Error('Could not allocate a unique Nyaitter ID');
	}

	async searchUsers(query, limit = 20) {
		const q = `%${query.toLowerCase()}%`;
		const digits = String(query).replace(/^#/, '').replace(/\D/g, '');
		const { rows } = await this.pool.query(
			`SELECT id, name, scid, handle, nyaitter_address, auth_provider, provider_domain, external_id
			 FROM users
			 WHERE LOWER(COALESCE(scid, '')) LIKE $1
				OR LOWER(COALESCE(name, '')) LIKE $1
				OR LOWER(COALESCE(handle, '')) LIKE $1
				OR CAST(id AS TEXT) LIKE $1
				OR CAST(COALESCE(external_id, -1) AS TEXT) LIKE $1
			 ORDER BY id DESC LIMIT $2`,
			[digits ? `%${digits}%` : q, limit]
		);
		return rows;
	}

	async getUsersByIds(userIds) {
		if (!userIds.length) return [];
		const { rows } = await this.pool.query(
			`SELECT id, name, scid, icon_data, handle, nyaitter_address, auth_provider, provider_domain, external_id FROM users WHERE id = ANY($1)`,
			[userIds]
		);
		return rows;
	}

	async getAllUsers() {
		const { rows } = await this.pool.query('SELECT * FROM users ORDER BY id ASC');
		return rows;
	}

		_mapSession(session) {
			return {
				id: session.session_id,
				token: session.token,
				userId: session.user_id,
				expiresAt: session.expires_at,
				createdAt: session.created_at,
				ipHash: session.ip_hash || null,
				ipMasked: session.ip_masked || '旧セッション',
				userAgent: session.user_agent || '不明な端末',
			};
		}

		_mapLoginApproval(approval) {
			if (!approval) return null;
			return {
				id: approval.id,
				userId: approval.user_id,
				ipHash: approval.ip_hash,
				ipMasked: approval.ip_masked,
				userAgent: approval.user_agent,
				pollTokenHash: approval.poll_token_hash,
				status: approval.status,
				createdAt: approval.created_at,
				expiresAt: approval.expires_at,
				decidedAt: approval.decided_at,
				consumedAt: approval.consumed_at,
			};
		}

		async createSession(userId, meta = {}) {
			const token = crypto.randomBytes(appConfig.auth.sessionTokenBytes).toString('hex');
			const sessionId = crypto.randomBytes(16).toString('base64url');
			const expiresAt = new Date(Date.now() + appConfig.auth.sessionExpiryDays * 24 * 60 * 60 * 1000);
			const { rows } = await this.pool.query(
				`INSERT INTO sessions (session_id, token, user_id, expires_at, ip_hash, ip_masked, user_agent)
				 VALUES ($1, $2, $3, $4, $5, $6, $7)
				 RETURNING session_id, token, user_id, expires_at, created_at, ip_hash, ip_masked, user_agent`,
				[sessionId, token, userId, expiresAt, meta.ipHash || null, meta.ipMasked || '不明なIPアドレス', meta.userAgent || '不明な端末'],
			);
			return this._mapSession(rows[0]);
		}

		async getSessionByToken(token) {
			const { rows } = await this.pool.query(
				`SELECT session_id, token, user_id, expires_at, created_at, ip_hash, ip_masked, user_agent
				 FROM sessions WHERE token = $1 AND expires_at > NOW() LIMIT 1`,
				[token],
			);
			if (!rows[0]) {
				await this.pool.query('DELETE FROM sessions WHERE token = $1 AND expires_at <= NOW()', [token]);
				return null;
			}
			return this._mapSession(rows[0]);
		}

		async invalidateSession(token) {
			const { rowCount } = await this.pool.query('DELETE FROM sessions WHERE token = $1', [token]);
			return rowCount > 0;
		}

		async getUserSessions(userId) {
			const { rows } = await this.pool.query(
				`SELECT session_id, token, user_id, expires_at, created_at, ip_hash, ip_masked, user_agent
				 FROM sessions WHERE user_id = $1 AND expires_at > NOW() ORDER BY created_at DESC`,
				[userId],
			);
			return rows.map((session) => this._mapSession(session));
		}

		async invalidateAllSessions(userId) {
			const { rowCount } = await this.pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
			return rowCount;
		}

		async invalidateSessionsByIp(userId, ipHash) {
			const { rowCount } = await this.pool.query(
				'DELETE FROM sessions WHERE user_id = $1 AND ip_hash = $2',
				[userId, ipHash],
			);
			return rowCount;
		}

		async createBotToken(userId, tokenId, tokenHash, name) {
			const { rows } = await this.pool.query(
				`INSERT INTO bot_tokens (token_id, user_id, token_hash, name, created_at)
				 VALUES ($1, $2, $3, $4, NOW())
				 RETURNING token_id, user_id, token_hash, name, created_at, last_used_at`,
				[tokenId, userId, tokenHash, name],
			);
			return {
				tokenId: rows[0].token_id,
				userId: rows[0].user_id,
				tokenHash: rows[0].token_hash,
				name: rows[0].name,
				createdAt: rows[0].created_at,
				lastUsedAt: rows[0].last_used_at,
			};
		}

		async getBotTokenById(tokenId) {
			const { rows } = await this.pool.query(
				'SELECT token_id, user_id, token_hash, name, created_at, last_used_at FROM bot_tokens WHERE token_id = $1',
				[tokenId],
			);
			if (!rows[0]) return null;
			return {
				tokenId: rows[0].token_id,
				userId: rows[0].user_id,
				tokenHash: rows[0].token_hash,
				name: rows[0].name,
				createdAt: rows[0].created_at,
				lastUsedAt: rows[0].last_used_at,
			};
		}

		async getUserBotTokens(userId) {
			const { rows } = await this.pool.query(
				'SELECT token_id, name, created_at, last_used_at FROM bot_tokens WHERE user_id = $1 ORDER BY created_at DESC',
				[userId],
			);
			return rows.map((r) => ({
				tokenId: r.token_id,
				name: r.name,
				createdAt: r.created_at,
				lastUsedAt: r.last_used_at,
			}));
		}

		async revokeBotToken(userId, tokenId) {
			const { rowCount } = await this.pool.query(
				'DELETE FROM bot_tokens WHERE user_id = $1 AND token_id = $2',
				[userId, tokenId],
			);
			return rowCount > 0;
		}

		async updateBotTokenLastUsed(tokenId) {
			await this.pool.query(
				'UPDATE bot_tokens SET last_used_at = NOW() WHERE token_id = $1',
				[tokenId],
			);
		}

		async trustLoginIp(userId, { ipHash, ipMasked }) {
			const { rows } = await this.pool.query(
				`INSERT INTO trusted_login_ips (user_id, ip_hash, ip_masked)
				 VALUES ($1, $2, $3)
				 ON CONFLICT (user_id, ip_hash) DO UPDATE SET ip_masked = EXCLUDED.ip_masked, last_used_at = NOW()
				 RETURNING user_id, ip_hash, ip_masked, created_at, last_used_at`,
				[userId, ipHash, ipMasked || '不明なIPアドレス'],
			);
			return {
				userId: rows[0].user_id, ipHash: rows[0].ip_hash, ipMasked: rows[0].ip_masked,
				createdAt: rows[0].created_at, lastUsedAt: rows[0].last_used_at,
			};
		}

		async getTrustedLoginIp(userId, ipHash) {
			const { rows } = await this.pool.query(
				'SELECT user_id, ip_hash, ip_masked, created_at, last_used_at FROM trusted_login_ips WHERE user_id = $1 AND ip_hash = $2',
				[userId, ipHash],
			);
			if (!rows[0]) return null;
			return { userId: rows[0].user_id, ipHash: rows[0].ip_hash, ipMasked: rows[0].ip_masked, createdAt: rows[0].created_at, lastUsedAt: rows[0].last_used_at };
		}

		async countTrustedLoginIps(userId) {
			const { rows } = await this.pool.query('SELECT COUNT(*)::INTEGER AS count FROM trusted_login_ips WHERE user_id = $1', [userId]);
			return rows[0].count;
		}

		async revokeTrustedLoginIp(userId, ipHash) {
			const { rowCount } = await this.pool.query('DELETE FROM trusted_login_ips WHERE user_id = $1 AND ip_hash = $2', [userId, ipHash]);
			return rowCount > 0;
		}

		async createLoginApproval(approvalData) {
			const id = crypto.randomBytes(18).toString('base64url');
			const { rows } = await this.pool.query(
				`INSERT INTO login_approvals (id, user_id, ip_hash, ip_masked, user_agent, poll_token_hash, status, expires_at)
				 VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
				 RETURNING *`,
				[id, approvalData.userId, approvalData.ipHash, approvalData.ipMasked || '不明なIPアドレス', approvalData.userAgent || '不明な端末', approvalData.pollTokenHash, approvalData.expiresAt],
			);
			return this._mapLoginApproval(rows[0]);
		}

		async getLoginApproval(id) {
			await this.pool.query("UPDATE login_approvals SET status = 'expired' WHERE id = $1 AND status = 'pending' AND expires_at <= NOW()", [id]);
			const { rows } = await this.pool.query('SELECT * FROM login_approvals WHERE id = $1', [id]);
			return this._mapLoginApproval(rows[0]);
		}

		async getLoginApprovalByPollToken(id, pollTokenHash) {
			await this.pool.query("UPDATE login_approvals SET status = 'expired' WHERE id = $1 AND status = 'pending' AND expires_at <= NOW()", [id]);
			const { rows } = await this.pool.query('SELECT * FROM login_approvals WHERE id = $1 AND poll_token_hash = $2', [id, pollTokenHash]);
			return this._mapLoginApproval(rows[0]);
		}

		async decideLoginApproval(userId, id, decision) {
			const status = decision === 'approve' ? 'approved' : 'denied';
			const { rows } = await this.pool.query(
				`UPDATE login_approvals SET status = $3, decided_at = NOW()
				 WHERE id = $1 AND user_id = $2 AND status = 'pending' AND expires_at > NOW()
				 RETURNING *`,
				[id, userId, status],
			);
			if (rows[0]) return this._mapLoginApproval(rows[0]);
			const existing = await this.getLoginApproval(id);
			return existing && Number(existing.userId) === Number(userId) ? existing : null;
		}

		async consumeLoginApproval(id, pollTokenHash) {
			const { rows } = await this.pool.query(
				`UPDATE login_approvals SET status = 'consumed', consumed_at = NOW()
				 WHERE id = $1 AND poll_token_hash = $2 AND status = 'approved' AND expires_at > NOW()
				 RETURNING *`,
				[id, pollTokenHash],
			);
			return this._mapLoginApproval(rows[0]);
		}

	async createPost(postData) {
		const { rows } = await this.pool.query(
			`INSERT INTO posts (user_id, content, attachments, mask, lock, reply_to, repost_to, created_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
			 RETURNING *`,
			[
				postData.userId,
				postData.content,
				postData.attachments ? JSON.stringify(postData.attachments) : null,
				!!postData.mask,
				!!postData.lock,
				postData.replyTo || null,
				postData.repostTo || null
			]
		);
		return this._normalizePost(rows[0] || null);
	}

	async getPostById(id) {
		const { rows } = await this.pool.query(
			'SELECT * FROM posts WHERE id = $1',
			[id]
		);
		const row = rows[0] || null;
		return this._normalizePost(row);
	}

	async getPostsByIds(postIds) {
		const ids = [...new Set((postIds || []).map(Number).filter(Number.isInteger))];
		if (ids.length === 0) return [];
		const { rows } = await this.pool.query(
			'SELECT * FROM posts WHERE id = ANY($1::int[])',
			[ids],
		);
		return rows.map((row) => this._normalizePost(row));
	}

	async getPostMetricsBatch(postIds, currentUserId = null) {
		const ids = [...new Set((postIds || []).map(Number).filter(Number.isInteger))];
		if (ids.length === 0) return [];
		const { rows } = await this.pool.query(
			`WITH RECURSIVE requested AS (
				SELECT DISTINCT UNNEST($1::int[]) AS post_id
			),
			like_counts AS (
				SELECT post_id, COUNT(*)::int AS count FROM likes
				WHERE post_id = ANY($1::int[]) GROUP BY post_id
			),
			star_counts AS (
				SELECT post_id, COUNT(*)::int AS count FROM stars
				WHERE post_id = ANY($1::int[]) GROUP BY post_id
			),
				reply_tree AS (
					SELECT requested.post_id AS root_post_id, child.id, ARRAY[child.id] AS path
					FROM requested
					JOIN posts child ON child.reply_to = requested.post_id
					UNION ALL
					SELECT tree.root_post_id, child.id, tree.path || child.id
					FROM reply_tree tree
					JOIN posts child ON child.reply_to = tree.id
					WHERE NOT child.id = ANY(tree.path)
				),
				reply_counts AS (
					SELECT root_post_id AS post_id, COUNT(*)::int AS count
					FROM reply_tree
					GROUP BY root_post_id
				),
			repost_counts AS (
				SELECT post_id, COUNT(*)::int AS count FROM reposts
				WHERE post_id = ANY($1::int[]) GROUP BY post_id
			)
			SELECT requested.post_id,
				COALESCE(like_counts.count, 0)::int AS like_count,
				COALESCE(star_counts.count, 0)::int AS star_count,
				COALESCE(reply_counts.count, 0)::int AS reply_count,
				COALESCE(repost_counts.count, 0)::int AS repost_count,
				CASE WHEN $2::int IS NULL THEN false ELSE EXISTS(
					SELECT 1 FROM likes WHERE user_id = $2::int AND post_id = requested.post_id
				) END AS liked_by_me,
				CASE WHEN $2::int IS NULL THEN false ELSE EXISTS(
					SELECT 1 FROM stars WHERE user_id = $2::int AND post_id = requested.post_id
				) END AS starred_by_me
			FROM requested
			LEFT JOIN like_counts ON like_counts.post_id = requested.post_id
			LEFT JOIN star_counts ON star_counts.post_id = requested.post_id
			LEFT JOIN reply_counts ON reply_counts.post_id = requested.post_id
			LEFT JOIN repost_counts ON repost_counts.post_id = requested.post_id`,
			[ids, currentUserId == null ? null : Number(currentUserId)],
		);
		return rows;
	}

	async updatePost(postId, fields) {
		const sets = [];
		const values = [];
		if (fields.content !== undefined) {
			values.push(fields.content);
			sets.push(`content = $${values.length}`);
		}
		if (fields.attachments !== undefined) {
			values.push(fields.attachments ? JSON.stringify(fields.attachments) : null);
			sets.push(`attachments = $${values.length}`);
		}
		if (fields.mask !== undefined) {
			values.push(!!fields.mask);
			sets.push(`mask = $${values.length}`);
		}
		if (fields.lock !== undefined) {
			values.push(!!fields.lock);
			sets.push(`lock = $${values.length}`);
		}
		if (sets.length === 0) {
			return this.getPostById(postId);
		}
		values.push(postId);
		const { rows } = await this.pool.query(
			`UPDATE posts SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
			values
		);
		return this._normalizePost(rows[0] || null);
	}

	async getRecentPosts(limit = 30) {
		const { rows } = await this.pool.query(
			`SELECT * FROM posts WHERE reply_to IS NULL ORDER BY created_at DESC LIMIT $1`,
			[limit]
		);
		return rows.map(r => this._normalizePost(r));
	}

	async getPostCount(userId) {
		const { rows } = await this.pool.query(
			'SELECT COUNT(*)::int AS count FROM posts WHERE user_id = $1',
			[userId]
		);
		return Number(rows[0].count);
	}

	async getPostsByUserId(userId, limit = 50, currentUserId = null) {
		const { rows } = await this.pool.query(
			`SELECT * FROM posts WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
			[userId, limit]
		);
		const posts = rows.map(r => this._normalizePost(r));
		return Promise.all(posts.map(p => this.getPostDetail(p.id, currentUserId)));
	}

	async getProfilePostIds({ userId, subType = 'all', limit = 30, offset = 0 } = {}) {
		const clauses = ['user_id = $1'];
		if (subType === 'posts_only') clauses.push('reply_to IS NULL');
		if (subType === 'replies_only') clauses.push('reply_to IS NOT NULL');
		const { rows } = await this.pool.query(
			`SELECT id FROM posts WHERE ${clauses.join(' AND ')}
			 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
			[userId, limit + 1, offset],
		);
		return {
			ids: rows.slice(0, limit).map((row) => row.id),
			has_more: rows.length > limit,
		};
	}

	async getMediaCount(userId) {
		const { rows } = await this.pool.query(
			`SELECT COUNT(*)::int AS count FROM posts
			 WHERE user_id = $1
			   AND jsonb_typeof(attachments) = 'array'
			   AND jsonb_array_length(attachments) > 0`,
			[userId]
		);
		return Number(rows[0].count);
	}

	async getMediaPosts(userId, limit = 15, offset = 0) {
		const normalizedLimit = Math.max(1, Math.min(Number(limit) || 15, 100));
		const normalizedOffset = Math.max(0, Number(offset) || 0);
		const { rows } = await this.pool.query(
			`SELECT id, attachments FROM posts
			 WHERE user_id = $1
			   AND jsonb_typeof(attachments) = 'array'
			   AND jsonb_array_length(attachments) > 0
			 ORDER BY created_at DESC, id DESC`,
			[userId]
		);
		const items = [];
		for (const row of rows) {
			const attachments = Array.isArray(row.attachments) ? row.attachments : [];
			for (const file of attachments) {
				items.push({
					post_id: row.id,
					file_id: file.id,
					file_type: file.type || 'file',
					type: file.type || 'file',
				});
			}
		}
		return items.slice(normalizedOffset, normalizedOffset + normalizedLimit);
	}

	async getReplyPostIds(parentPostId, limit = 50, offset = 0) {
		const normalizedLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
		const normalizedOffset = Math.max(0, Number(offset) || 0);
		const { rows } = await this.pool.query(
			`SELECT id FROM posts WHERE reply_to = $1
			 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
			[parentPostId, normalizedLimit + 1, normalizedOffset],
		);
		return {
			ids: rows.slice(0, normalizedLimit).map((row) => row.id),
			has_more: rows.length > normalizedLimit,
		};
	}

	async getReplyCount(postId) {
		const { rows } = await this.pool.query(
			'SELECT COUNT(*)::int AS count FROM posts WHERE reply_to = $1',
			[postId]
		);
		return Number(rows[0].count);
	}

	async getThreadReplyPostIds(parentPostId, limit = 50, offset = 0) {
		const normalizedLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
		const normalizedOffset = Math.max(0, Number(offset) || 0);
		const { rows } = await this.pool.query(
			`WITH RECURSIVE reply_tree AS (
				SELECT id, reply_to, ARRAY[id] AS path
				FROM posts
				WHERE reply_to = $1
				UNION ALL
				SELECT child.id, child.reply_to, tree.path || child.id
				FROM posts child
				JOIN reply_tree tree ON child.reply_to = tree.id
				WHERE NOT child.id = ANY(tree.path)
			)
			SELECT id FROM reply_tree
			ORDER BY path
			LIMIT $2 OFFSET $3`,
			[parentPostId, normalizedLimit + 1, normalizedOffset],
		);
		return {
			ids: rows.slice(0, normalizedLimit).map((row) => row.id),
			has_more: rows.length > normalizedLimit,
		};
	}

	async getTimelinePostIds({ tab = 'foryou', followIds = [], limit = 30, offset = 0 } = {}) {
		const normalizedLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
		const normalizedOffset = Math.max(0, Number(offset) || 0);
		let query;
		let values;
		if (tab === 'following') {
			const ids = [...new Set((followIds || []).map(Number).filter(Number.isInteger))];
			if (ids.length === 0) return { ids: [], has_more: false };
			query = `SELECT id FROM posts WHERE user_id = ANY($1::int[]) AND reply_to IS NULL
				ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`;
			values = [ids, normalizedLimit + 1, normalizedOffset];
		} else if (tab === 'announce') {
			query = `SELECT id FROM posts WHERE user_id = 2525 AND reply_to IS NULL
				AND content LIKE '%#NXAnnounce%' ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2`;
			values = [normalizedLimit + 1, normalizedOffset];
		} else {
			query = `SELECT id FROM posts WHERE reply_to IS NULL ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2`;
			values = [normalizedLimit + 1, normalizedOffset];
		}
		const { rows } = await this.pool.query(query, values);
		return {
			ids: rows.slice(0, normalizedLimit).map((row) => row.id),
			has_more: rows.length > normalizedLimit,
		};
	}

	async getRecommendedPostIds({ limit = 30, offset = 0 } = {}) {
		const normalizedLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
		const normalizedOffset = Math.max(0, Number(offset) || 0);
		const candidateLimit = Math.max(500, normalizedOffset + normalizedLimit + 1);
		const { rows } = await this.pool.query(
			`WITH candidates AS (
				SELECT id, created_at FROM posts WHERE reply_to IS NULL ORDER BY created_at DESC, id DESC LIMIT $1
			), scored AS (
				SELECT c.id,
					COALESCE(l.count, 0) + COALESCE(s.count, 0) * 2 + COALESCE(r.count, 0) * 3 AS score,
					c.created_at
				FROM candidates c
				LEFT JOIN LATERAL (SELECT COUNT(*)::int AS count FROM likes WHERE post_id = c.id) l ON true
				LEFT JOIN LATERAL (SELECT COUNT(*)::int AS count FROM stars WHERE post_id = c.id) s ON true
				LEFT JOIN LATERAL (SELECT COUNT(*)::int AS count FROM reposts WHERE post_id = c.id) r ON true
			)
			SELECT id FROM scored ORDER BY score DESC, created_at DESC, id DESC LIMIT $2 OFFSET $3`,
			[candidateLimit, normalizedLimit + 1, normalizedOffset],
		);
		return {
			ids: rows.slice(0, normalizedLimit).map((row) => row.id),
			has_more: rows.length > normalizedLimit,
		};
	}

	async searchPostIds(query, limit = 30, offset = 0) {
		const q = String(query || '').trim();
		if (!q) return { ids: [], has_more: false };
		const normalizedLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
		const normalizedOffset = Math.max(0, Number(offset) || 0);
		const { rows } = await this.pool.query(
			`SELECT id FROM posts WHERE content ILIKE $1
			 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
			[`%${q}%`, normalizedLimit + 1, normalizedOffset],
		);
		return {
			ids: rows.slice(0, normalizedLimit).map((row) => row.id),
			has_more: rows.length > normalizedLimit,
		};
	}

	async getPostDetail(id, currentUserId = null) {
		const post = await this.getPostById(id);
		if (!post) return null;

		const author = await this.getUserById(post.user_id);
		const likeCount = await this.getLikeCount(id);
		const starCount = await this.getStarCount(id);

		let likedByMe = false;
		let starredByMe = false;

		if (currentUserId) {
			likedByMe = await this.hasUserLikedPost(currentUserId, id);
			starredByMe = await this.hasUserStarredPost(currentUserId, id);
		}

		let parentPost = null;
		if (post.reply_to) {
			const parent = await this.getPostById(post.reply_to);
			if (parent) {
				const parentAuthor = await this.getUserById(parent.user_id);
				parentPost = {
					id: parent.id,
					content: parent.content?.substring(0, 100),
					author: parentAuthor ? { id: parentAuthor.id, name: parentAuthor.name } : null,
				};
			}
		}

		const normalized = this._normalizePost(post);
		return {
			...normalized,
			author: author ? { id: author.id, name: author.name, scid: author.scid } : null,
			like_count: likeCount,
			star_count: starCount,
			liked_by_me: likedByMe,
			starred_by_me: starredByMe,
			parent_post: parentPost,
		};
	}

	async getTimelinePosts(params) {
		const posts = await this.getRecentPosts(params.limit || 30);
		return { posts, hasMore: posts.length === (params.limit || 30) };
	}

	async toggleLike(userId, postId) {
		const { rows } = await this.pool.query(
			`WITH deleted AS (
				DELETE FROM likes WHERE user_id = $1 AND post_id = $2 RETURNING 1
			), inserted AS (
				INSERT INTO likes (user_id, post_id, created_at)
				SELECT $1, $2, NOW() WHERE NOT EXISTS (SELECT 1 FROM deleted)
				ON CONFLICT (user_id, post_id) DO NOTHING
				RETURNING 1
			)
			SELECT EXISTS (SELECT 1 FROM inserted) AS liked,
				(SELECT COUNT(*)::int FROM likes WHERE post_id = $2)
				+ CASE WHEN EXISTS (SELECT 1 FROM inserted) THEN 1
					WHEN EXISTS (SELECT 1 FROM deleted) THEN -1 ELSE 0 END AS count`,
			[userId, postId],
		);
		return { liked: !!rows[0]?.liked, count: Number(rows[0]?.count || 0) };
	}

	async getLikeCount(postId) {
		const { rows } = await this.pool.query(
			'SELECT COUNT(*)::int as count FROM likes WHERE post_id = $1',
			[postId]
		);
		return rows[0].count;
	}

	async hasUserLikedPost(userId, postId) {
		const { rows } = await this.pool.query(
			'SELECT 1 FROM likes WHERE user_id = $1 AND post_id = $2',
			[userId, postId]
		);
		return rows.length > 0;
	}

	async toggleStar(userId, postId) {
		const { rows } = await this.pool.query(
			`WITH deleted AS (
				DELETE FROM stars WHERE user_id = $1 AND post_id = $2 RETURNING 1
			), inserted AS (
				INSERT INTO stars (user_id, post_id, created_at)
				SELECT $1, $2, NOW() WHERE NOT EXISTS (SELECT 1 FROM deleted)
				ON CONFLICT (user_id, post_id) DO NOTHING
				RETURNING 1
			)
			SELECT EXISTS (SELECT 1 FROM inserted) AS starred,
				(SELECT COUNT(*)::int FROM stars WHERE post_id = $2)
				+ CASE WHEN EXISTS (SELECT 1 FROM inserted) THEN 1
					WHEN EXISTS (SELECT 1 FROM deleted) THEN -1 ELSE 0 END AS count`,
			[userId, postId],
		);
		return { starred: !!rows[0]?.starred, count: Number(rows[0]?.count || 0) };
	}

	async getStarCount(postId) {
		const { rows } = await this.pool.query(
			'SELECT COUNT(*)::int as count FROM stars WHERE post_id = $1',
			[postId]
		);
		return rows[0].count;
	}

	async hasUserStarredPost(userId, postId) {
		const { rows } = await this.pool.query(
			'SELECT 1 FROM stars WHERE user_id = $1 AND post_id = $2',
			[userId, postId]
		);
		return rows.length > 0;
	}

	async getLikeIds(userId) {
		const { rows } = await this.pool.query(
			`SELECT post_id FROM likes
			 WHERE user_id = $1
			 ORDER BY created_at DESC, post_id ASC`,
			[userId]
		);
		return rows.map((row) => Number(row.post_id));
	}

	async getStarIds(userId) {
		const { rows } = await this.pool.query(
			`SELECT post_id FROM stars
			 WHERE user_id = $1
			 ORDER BY created_at DESC, post_id ASC`,
			[userId]
		);
		return rows.map((row) => Number(row.post_id));
	}

	async getDmList(userId) {
		const { rows } = await this.pool.query(
			`SELECT * FROM dm_channels WHERE $1 = ANY(participants)`,
			[userId]
		);
		return rows; // Further enrichment can be done in service layer
	}

	async getOrCreateDmChannel(userId1, userId2) {
		const [u1, u2] = userId1 < userId2 ? [userId1, userId2] : [userId2, userId1];
		const channelId = `${u1}:${u2}`;

		const { rows } = await this.pool.query(
			`INSERT INTO dm_channels (id, participants, created_at)
			 VALUES ($1, $2, NOW())
			 ON CONFLICT (id) DO NOTHING
			 RETURNING *`,
			[channelId, [u1, u2]]
		);

		if (rows.length > 0) return rows[0];

		const existing = await this.pool.query('SELECT * FROM dm_channels WHERE id = $1', [channelId]);
		return existing.rows[0];
	}

	async getDmMessages(channelId, limit = 50, offset = 0) {
		const { rows } = await this.pool.query(
			`SELECT * FROM dm_messages
			 WHERE channel_id = $1
			 ORDER BY sent_at DESC
			 LIMIT $2 OFFSET $3`,
			[channelId, limit, offset]
		);
		return rows;
	}

	async sendDmMessage(channelId, senderId, content) {
		const { rows } = await this.pool.query(
			`INSERT INTO dm_messages (channel_id, sender_id, content, sent_at)
			 VALUES ($1, $2, $3, NOW())
			 RETURNING *`,
			[channelId, senderId, content]
		);
		return rows[0];
	}

	async markDmMessagesAsRead(channelId, userId) {
		await this.pool.query(
			`UPDATE dm_messages SET read_at = NOW()
			 WHERE channel_id = $1 AND sender_id != $2 AND read_at IS NULL`,
			[channelId, userId]
		);
	}

	async getUnreadDmCount(userId) {
		const { rows } = await this.pool.query(
			`SELECT COUNT(*)::int as count FROM dm_messages m
			 JOIN dm_channels c ON c.id = m.channel_id
			 WHERE $1 = ANY(c.participants)
			   AND m.sender_id != $1
			   AND m.read_at IS NULL`,
			[userId]
		);
		return rows[0].count;
	}

	// routes/dm.js が実際に使用するのはこちら（1:1 の dm_channels/dm_messages は未使用の legacy 実装）。
	// InMemoryAdapter と同じシリアライズ形状・未読カウント仕様に合わせる。

	_serializeGroupDmRow(row, userId) {
		const unread = row.unread || {};
		return {
			id: row.id,
			title: row.title || '',
			member: (row.member || []).map(Number),
			host_id: row.host_id,
			time: row.time instanceof Date ? row.time.toISOString() : row.time,
			post: Array.isArray(row.post) ? row.post : [],
			unread_count: Number(unread[userId] ?? unread[String(userId)] ?? 0),
		};
	}

	async getGroupDmsForUser(userId) {
		const { rows } = await this.pool.query(
			`SELECT * FROM group_dms WHERE $1 = ANY(member) ORDER BY time DESC`,
			[userId]
		);
		return rows.map((row) => this._serializeGroupDmRow(row, userId));
	}

	async getGroupDm(dmId) {
		const { rows } = await this.pool.query(
			'SELECT * FROM group_dms WHERE id = $1 LIMIT 1',
			[dmId]
		);
		if (!rows[0]) return null;
		const row = rows[0];
		// getGroupDm() は unread を含む生データ形状で返す（呼び出し側が dm.member / dm.unread を直接参照するため）。
		return {
			id: row.id,
			title: row.title || '',
			member: (row.member || []).map(Number),
			host_id: row.host_id,
			time: row.time instanceof Date ? row.time.toISOString() : row.time,
			post: Array.isArray(row.post) ? row.post : [],
			unread: row.unread || {},
		};
	}

	async createGroupDm(dmData) {
		const member = Array.from(new Set((dmData.member || []).map(Number)));
		const { rows } = await this.pool.query(
			`INSERT INTO group_dms (host_id, title, member, post, unread, time, created_at)
			 VALUES ($1, $2, $3, '[]'::jsonb, '{}'::jsonb, NOW(), NOW())
			 RETURNING *`,
			[dmData.hostId, dmData.title || '', member]
		);
		return this._serializeGroupDmRow(rows[0], dmData.hostId);
	}

	async updateGroupDm(dmId, updates) {
		const sets = [];
		const values = [];
		let i = 1;
		let newUnread = null;

		if (updates.title !== undefined) {
			sets.push(`title = $${i++}`);
			values.push(updates.title);
		}
		if (updates.member !== undefined) {
			const memberSet = Array.from(new Set(updates.member.map(Number).filter(Number.isInteger)));
			sets.push(`member = $${i++}`);
			values.push(memberSet);

			const { rows: currentRows } = await this.pool.query(
				'SELECT unread FROM group_dms WHERE id = $1',
				[dmId]
			);
			const currentUnread = currentRows[0]?.unread || {};
			const memberKeySet = new Set(memberSet.map(String));
			newUnread = Object.fromEntries(
				Object.entries(currentUnread).filter(([key]) => memberKeySet.has(key))
			);
			sets.push(`unread = $${i++}::jsonb`);
			values.push(JSON.stringify(newUnread));
		}
		if (updates.host_id !== undefined && updates.host_id !== null) {
			sets.push(`host_id = $${i++}`);
			values.push(updates.host_id);
		}
		if (updates.post !== undefined) {
			sets.push(`post = $${i++}::jsonb`);
			values.push(JSON.stringify(updates.post));
		}
		if (updates.time !== undefined) {
			sets.push(`time = $${i++}`);
			values.push(updates.time);
		}

		if (sets.length === 0) {
			const dm = await this.getGroupDm(dmId);
			return dm && this._serializeGroupDmRow(dm, dm.host_id);
		}

		values.push(dmId);
		const { rows } = await this.pool.query(
			`UPDATE group_dms SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
			values
		);
		if (!rows[0]) return null;
		return this._serializeGroupDmRow(rows[0], rows[0].host_id);
	}

	async appendToGroupDm(dmId, message, senderId = null) {
		// unread の増分はメンバーごとに個別の値になるため、SQL側で一括計算せず
		// 現在値を読んでJS側で計算してから書き戻す（InMemoryAdapterと同じロジック）。
		const client = await this.pool.connect();
		try {
			await client.query('BEGIN');
			const { rows: existingRows } = await client.query(
				'SELECT * FROM group_dms WHERE id = $1 FOR UPDATE',
				[dmId]
			);
			const row = existingRows[0];
			if (!row) {
				await client.query('ROLLBACK');
				return null;
			}

			const time = message.time || new Date().toISOString();
			const unread = { ...(row.unread || {}) };
			if (senderId !== null) {
				for (const memberId of row.member || []) {
					const normalizedMemberId = Number(memberId);
					if (normalizedMemberId === Number(senderId)) continue;
					const key = String(normalizedMemberId);
					unread[key] = Number(unread[key] || 0) + 1;
				}
			}

			const { rows } = await client.query(
				`UPDATE group_dms
				 SET post = post || $1::jsonb,
				     time = $2,
				     unread = $3::jsonb
				 WHERE id = $4
				 RETURNING *`,
				[JSON.stringify(message), time, JSON.stringify(unread), dmId]
			);
			await client.query('COMMIT');
			return this._serializeGroupDmRow(rows[0], senderId);
		} catch (error) {
			await client.query('ROLLBACK');
			throw error;
		} finally {
			client.release();
		}
	}

	async markGroupDmRead(dmId, userId) {
		await this.pool.query(
			`UPDATE group_dms SET unread = jsonb_set(unread, $2, '0'::jsonb, true) WHERE id = $1`,
			[dmId, [String(userId)]]
		);
	}

	async getGroupDmUnreadCounts(userId) {
		const { rows } = await this.pool.query(
			`SELECT id, COALESCE((unread->>$2)::int, 0) AS unread_count
			 FROM group_dms WHERE $1 = ANY(member)`,
			[userId, String(userId)]
		);
		return rows.map((row) => ({ dm_id: row.id, unread_count: row.unread_count }));
	}

	async getGroupDmUnreadTotal(userId) {
		const { rows } = await this.pool.query(
			`SELECT COALESCE(SUM(COALESCE((unread->>$2)::int, 0)), 0)::int AS total
			 FROM group_dms WHERE $1 = ANY(member)`,
			[userId, String(userId)]
		);
		return rows[0]?.total || 0;
	}

	async deleteGroupDm(dmId) {
		const { rowCount } = await this.pool.query('DELETE FROM group_dms WHERE id = $1', [dmId]);
		return rowCount > 0;
	}

	async leaveGroupDm(dmId, userId) {
		const { rows } = await this.pool.query(
			`UPDATE group_dms
			 SET member = array_remove(member, $2),
			     unread = unread - $3
			 WHERE id = $1
			 RETURNING id`,
			[dmId, Number(userId), String(userId)]
		);
		return rows.length > 0;
	}

	async findGroupDmByMembers(memberIds) {
		const target = Array.from(new Set(memberIds.map(Number))).sort((a, b) => a - b);
		// member配列がtargetと完全一致する行を探す（順序を無視した集合比較）。
		const { rows } = await this.pool.query(
			`SELECT * FROM group_dms
			 WHERE cardinality(member) = $1
			   AND member @> $2 AND member <@ $2`,
			[target.length, target]
		);
		if (!rows[0]) return null;
		const row = rows[0];
		return {
			id: row.id,
			title: row.title || '',
			member: (row.member || []).map(Number),
			host_id: row.host_id,
			time: row.time instanceof Date ? row.time.toISOString() : row.time,
			post: Array.isArray(row.post) ? row.post : [],
			unread: row.unread || {},
		};
	}

	async getDmPublicKeys(userIds) {
		const ids = Array.from(
			new Set((userIds || []).map(Number).filter((id) => Number.isInteger(id) && id >= 0)),
		);
		if (ids.length === 0) return [];
		const { rows } = await this.pool.query(
			'SELECT user_id, public_key FROM dm_e2e_keys WHERE user_id = ANY($1::int[])',
			[ids]
		);
		return rows.map((row) => ({ user_id: row.user_id, public_key: row.public_key }));
	}

	async setDmPublicKey(userId, publicKey) {
		await this.pool.query(
			`INSERT INTO dm_e2e_keys (user_id, public_key, created_at, updated_at)
			 VALUES ($1, $2, NOW(), NOW())
			 ON CONFLICT (user_id)
			 DO UPDATE SET public_key = $2, updated_at = NOW()`,
			[Number(userId), String(publicKey)]
		);
	}

	async toggleFollow(followerId, followingId) {
		if (followerId === followingId) {
			throw new Error('Cannot follow yourself');
		}

		const { rows: existing } = await this.pool.query(
			'SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2',
			[followerId, followingId]
		);

		let following;
		if (existing.length > 0) {
			await this.pool.query(
				'DELETE FROM follows WHERE follower_id = $1 AND following_id = $2',
				[followerId, followingId]
			);
			following = false;
		} else {
			await this.pool.query(
				'INSERT INTO follows (follower_id, following_id, created_at) VALUES ($1, $2, NOW())',
				[followerId, followingId]
			);
			following = true;
		}

		return { following };
	}

	async isFollowing(followerId, followingId) {
		const { rows } = await this.pool.query(
			'SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2',
			[followerId, followingId]
		);
		return rows.length > 0;
	}

	async getFollowing(userId, limit = 100) {
		const { rows } = await this.pool.query(
			`SELECT u.id, u.name, u.scid FROM follows f
			 JOIN users u ON u.id = f.following_id
			 WHERE f.follower_id = $1
			 ORDER BY f.created_at DESC
			 LIMIT $2`,
			[userId, limit]
		);
		return rows;
	}

	async getFollowers(userId, limit = 100) {
		const { rows } = await this.pool.query(
			`SELECT u.id, u.name, u.scid FROM follows f
			 JOIN users u ON u.id = f.follower_id
			 WHERE f.following_id = $1
			 ORDER BY f.created_at DESC
			 LIMIT $2`,
			[userId, limit]
		);
		return rows;
	}

	async getFollowIds(userId) {
		const { rows } = await this.pool.query(
			`SELECT following_id FROM follows
			 WHERE follower_id = $1
			 ORDER BY created_at DESC, following_id ASC`,
			[userId]
		);
		return rows.map((row) => Number(row.following_id));
	}

	async getFollowingCount(userId) {
		const { rows } = await this.pool.query(
			'SELECT COUNT(*)::int AS count FROM follows WHERE follower_id = $1',
			[userId]
		);
		return Number(rows[0].count);
	}

	async getFollowerCount(userId) {
		const { rows } = await this.pool.query(
			'SELECT COUNT(*)::int AS count FROM follows WHERE following_id = $1',
			[userId]
		);
		return Number(rows[0].count);
	}

	async deletePost(postId, userId) {
		const client = await this.pool.connect();
		try {
			await client.query('BEGIN');

			const { rows: postRows } = await client.query(
				'SELECT user_id FROM posts WHERE id = $1',
				[postId]
			);
			if (postRows.length === 0 || postRows[0].user_id !== userId) {
				await client.query('ROLLBACK');
				return false;
			}

			await client.query('DELETE FROM likes WHERE post_id = $1', [postId]);
			await client.query('DELETE FROM stars WHERE post_id = $1', [postId]);
			// Add more cleanup if you have pinned_posts, reposts tables, etc.

			await client.query('DELETE FROM posts WHERE id = $1', [postId]);

			await client.query('COMMIT');
			return true;
		} catch (err) {
			await client.query('ROLLBACK');
			throw err;
		} finally {
			client.release();
		}
	}

	async togglePin(userId, postId) {
		const { rows: postRows } = await this.pool.query(
			'SELECT user_id FROM posts WHERE id = $1',
			[postId]
		);
		if (postRows.length === 0 || postRows[0].user_id !== userId) {
			throw new Error('Cannot pin a post you do not own');
		}

		// Simple implementation using a pins table (create if not exists in migration)
		const { rows: existing } = await this.pool.query(
			'SELECT 1 FROM pinned_posts WHERE user_id = $1 AND post_id = $2',
			[userId, postId]
		);

		let pinned;
		if (existing.length > 0) {
			await this.pool.query(
				'DELETE FROM pinned_posts WHERE user_id = $1 AND post_id = $2',
				[userId, postId]
			);
			pinned = false;
		} else {
			await this.pool.query(
				'INSERT INTO pinned_posts (user_id, post_id, created_at) VALUES ($1, $2, NOW())',
				[userId, postId]
			);
			pinned = true;
		}

		return { pinned };
	}

	async getPinnedPosts(userId) {
		const { rows } = await this.pool.query(
			`SELECT p.* FROM posts p
			 JOIN pinned_posts pp ON pp.post_id = p.id
			 WHERE pp.user_id = $1
			 ORDER BY pp.created_at DESC`,
			[userId]
		);
		return rows;
	}

	async getPinnedPostId(userId) {
		const { rows } = await this.pool.query(
			`SELECT post_id FROM pinned_posts
			 WHERE user_id = $1
			 ORDER BY created_at DESC
			 LIMIT 1`,
			[userId]
		);
		return rows.length > 0 ? Number(rows[0].post_id) : null;
	}

	async repostPost(userId, postId) {
		const original = await this.getPostById(postId);
		if (!original) throw new Error('Post not found');

		const { rows: existing } = await this.pool.query(
			'SELECT 1 FROM reposts WHERE user_id = $1 AND post_id = $2',
			[userId, postId]
		);
		if (existing.length > 0) throw new Error('Already reposted');

		await this.pool.query(
			'INSERT INTO reposts (user_id, post_id, created_at) VALUES ($1, $2, NOW())',
			[userId, postId]
		);

		// Create a repost entry as a new post record (simple approach)
		const { rows } = await this.pool.query(
			`INSERT INTO posts (user_id, content, attachments, mask, lock, repost_to, created_at)
			 VALUES ($1, $2, $3, $4, $5, $6, NOW())
			 RETURNING *`,
			[userId, original.content, original.attachments, original.mask, !!original.lock, postId]
		);

		return this._normalizePost(rows[0] || null);
	}

	async getReposts(userId) {
		const { rows } = await this.pool.query(
			`SELECT p.* FROM posts p
			 JOIN reposts r ON r.post_id = p.repost_to
			 WHERE r.user_id = $1
			 ORDER BY r.created_at DESC`,
			[userId]
		);
		return rows;
	}

	async getRepostsOfPost(postId, limit = 50) {
		const { rows } = await this.pool.query(
			`SELECT u.id as user_id, u.name, u.handle FROM reposts r
			 JOIN users u ON u.id = r.user_id
			 WHERE r.post_id = $1
			 ORDER BY r.created_at DESC
			 LIMIT $2`,
			[postId, limit]
		);
		return rows;
	}

	async getRepostCount(postId) {
		const { rows } = await this.pool.query(
			'SELECT COUNT(*)::int as count FROM reposts WHERE post_id = $1',
			[postId]
		);
		return rows[0].count;
	}

	async adminDeletePost(postId) {
		const client = await this.pool.connect();
		try {
			await client.query('BEGIN');

			await client.query('DELETE FROM likes WHERE post_id = $1', [postId]);
			await client.query('DELETE FROM stars WHERE post_id = $1', [postId]);
			await client.query('DELETE FROM reposts WHERE post_id = $1', [postId]);
			await client.query('DELETE FROM pinned_posts WHERE post_id = $1', [postId]);

			await client.query('DELETE FROM posts WHERE id = $1', [postId]);

			await client.query('COMMIT');
			return true;
		} catch (err) {
			await client.query('ROLLBACK');
			throw err;
		} finally {
			client.release();
		}
	}

	async createNotification(notificationData) {
		const target = normalizeTarget(notificationData.target, {
			postId: notificationData.postId,
			open: notificationData.open,
		});
		const { rows } = await this.pool.query(
				`INSERT INTO notifications
				 (user_id, type, from_user_id, post_id, target, read, clicked, created_at)
				 VALUES ($1, $2, $3, $4, $5::jsonb, false, false, NOW())
			 RETURNING *`,
			[
				notificationData.userId,
				notificationData.type,
				notificationData.fromUserId ?? null,
				target?.kind === 'post' ? target.id : null,
				JSON.stringify(target),
			],
		);
		return rows[0];
	}

	async getNotifications(userId, limit = 50, offset = 0) {
		const { rows } = await this.pool.query(
			`SELECT * FROM notifications 
			 WHERE user_id = $1 
			 ORDER BY created_at DESC 
			 LIMIT $2 OFFSET $3`,
			[userId, limit, offset]
		);
		return rows;
	}

	async markNotificationAsRead(notificationId) {
		await this.pool.query(
			'UPDATE notifications SET read = true WHERE id = $1',
			[notificationId]
		);
	}

	async markNotificationAsClicked(notificationId) {
		await this.pool.query(
			'UPDATE notifications SET clicked = true WHERE id = $1',
			[notificationId]
		);
	}

	async getNotificationById(notificationId) {
		const { rows } = await this.pool.query(
			'SELECT * FROM notifications WHERE id = $1',
			[notificationId]
		);
		return rows[0] || null;
	}

	async markAllNotificationsAsRead(userId) {
		await this.pool.query(
			'UPDATE notifications SET read = true WHERE user_id = $1 AND read = false',
			[userId]
		);
	}

	async deleteNotification(notificationId) {
		await this.pool.query(
			'DELETE FROM notifications WHERE id = $1',
			[notificationId]
		);
		return true;
	}

	async getUnreadNotificationCount(userId) {
		const { rows } = await this.pool.query(
			'SELECT COUNT(*)::int as count FROM notifications WHERE user_id = $1 AND read = false',
			[userId]
		);
		return rows[0].count;
	}

	async upsertPushSubscription(userId, subscription) {
		const { rows } = await this.pool.query(
			`INSERT INTO push_subscriptions
				(user_id, endpoint, expiration_time, p256dh, auth, created_at, updated_at)
			 VALUES ($1, $2, to_timestamp($3 / 1000.0), $4, $5, NOW(), NOW())
			 ON CONFLICT (user_id, endpoint)
			 DO UPDATE SET
				expiration_time = EXCLUDED.expiration_time,
				p256dh = EXCLUDED.p256dh,
				auth = EXCLUDED.auth,
				updated_at = NOW()
			 RETURNING *`,
			[
				userId,
				subscription.endpoint,
				subscription.expirationTime ?? null,
				subscription.keys.p256dh,
				subscription.keys.auth,
			],
		);
		return rows[0] || null;
	}

	async getPushSubscriptions(userId) {
		const { rows } = await this.pool.query(
			`SELECT endpoint, expiration_time, p256dh, auth
			 FROM push_subscriptions
			 WHERE user_id = $1`,
			[userId],
		);
		return rows.map((row) => ({
			endpoint: row.endpoint,
			expirationTime: row.expiration_time ? new Date(row.expiration_time).getTime() : null,
			keys: { p256dh: row.p256dh, auth: row.auth },
		}));
	}

	async deletePushSubscription(userId, endpoint) {
		const result = await this.pool.query(
			'DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2',
			[userId, endpoint],
		);
		return result.rowCount > 0;
	}

	async searchPosts(query, limit = 20) {
		const q = `%${query.toLowerCase()}%`;
		const { rows } = await this.pool.query(
			`SELECT * FROM posts 
			 WHERE LOWER(content) LIKE $1 
			 ORDER BY created_at DESC 
			 LIMIT $2`,
			[q, limit]
		);

		if (query.trim().startsWith('#')) {
			const tagQ = `%${query.toLowerCase()}%`;
			const tagRows = await this.pool.query(
				`SELECT * FROM posts 
				 WHERE LOWER(content) LIKE $1 
				 ORDER BY created_at DESC 
				 LIMIT $2`,
				[tagQ, limit]
			);
			for (const r of tagRows.rows) {
				if (!rows.find(x => x.id === r.id)) rows.push(r);
				if (rows.length >= limit) break;
			}
		}

		return rows.map(r => this._normalizePost(r));
	}

	async getTrendingPosts(limit = 20) {
		const { rows } = await this.pool.query(
			`SELECT p.*, 
				(COALESCE(l.like_count, 0) + COALESCE(s.star_count, 0) * 2 + COALESCE(r.repost_count, 0) * 3) as score
			 FROM posts p
			 LEFT JOIN (SELECT post_id, COUNT(*) as like_count FROM likes GROUP BY post_id) l ON l.post_id = p.id
			 LEFT JOIN (SELECT post_id, COUNT(*) as star_count FROM stars GROUP BY post_id) s ON s.post_id = p.id
			 LEFT JOIN (SELECT post_id, COUNT(*) as repost_count FROM reposts GROUP BY post_id) r ON r.post_id = p.id
			 ORDER BY score DESC, p.created_at DESC
			 LIMIT $1`,
			[limit]
		);
		return rows.map(r => this._normalizePost(r));
	}

	async getTrendingHashtags(limit = 10) {
		const normalizedLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
		const { rows } = await this.pool.query(
			'SELECT content FROM posts ORDER BY created_at DESC LIMIT 500'
		);
		const counts = new Map();
		for (const row of rows) {
			const matches = (row.content || '').match(/#([^<>/@#\s]+)/g) || [];
			for (const match of matches) {
				const tag = match.slice(1).toLowerCase();
				counts.set(tag, (counts.get(tag) || 0) + 1);
			}
		}
		return Array.from(counts.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, normalizedLimit)
			.map(([tag_name, occurrence_count]) => ({ tag_name, occurrence_count }));
	}

	async updateUserProfile(userId, profileData) {
		const fields = [];
		const values = [];
		let idx = 1;

		if (profileData.name !== undefined) {
			fields.push(`name = $${idx++}`);
			values.push(profileData.name);
		}
		if (profileData.bio !== undefined) {
			fields.push(`bio = $${idx++}`);
			values.push(profileData.bio);
		} else if (profileData.me !== undefined) {
			fields.push(`bio = $${idx++}`);
			values.push(profileData.me);
		}
		if (profileData.header_image !== undefined) {
			fields.push(`header_image = $${idx++}`);
			values.push(profileData.header_image);
		}
		if (profileData.icon_data !== undefined) {
			fields.push(`icon_data = $${idx++}`);
			values.push(profileData.icon_data);
		}
		if (profileData.settings !== undefined) {
			fields.push(`settings = $${idx++}`);
			values.push(JSON.stringify(profileData.settings || {}));
		}
		if (profileData.verify !== undefined) {
			fields.push(`verify = $${idx++}`);
			values.push(Boolean(profileData.verify));
		}
		if (profileData.freeze !== undefined) {
			fields.push(`"freeze" = $${idx++}`);
			values.push(profileData.freeze || null);
		}
		if (profileData.admin !== undefined) {
			fields.push(`admin = $${idx++}`);
			values.push(Boolean(profileData.admin));
		}
		if (profileData.shadow !== undefined) {
			fields.push(`shadow = $${idx++}`);
			values.push(Boolean(profileData.shadow));
		}
		if (fields.length === 0) return await this.getUserById(userId);

		values.push(userId);
		const { rows } = await this.pool.query(
			`UPDATE users SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
			values
		);
		return rows[0] || null;
	}

	async getUserStatus(userId) {
		const { rows } = await this.pool.query(
			'SELECT shadow FROM users WHERE id = $1',
			[userId]
		);
		if (!rows[0]) return null;
		return { shadow: !!rows[0].shadow };
	}

	async setUserStatus(userId, status) {
		const { rows } = await this.pool.query(
			'UPDATE users SET shadow = $2 WHERE id = $1 RETURNING shadow',
			[userId, !!(status && status.shadow)]
		);
		if (!rows[0]) return null;
		return { shadow: !!rows[0].shadow };
	}

	async addLog(entry) {
		const { rows } = await this.pool.query(
			`INSERT INTO logs (scratch_id, nyaitter_id, masked_ip_uuid, log_time)
			 VALUES ($1, $2, $3, NOW())
			 RETURNING id`,
			[entry.scratch_id || '', entry.nyaitter_id != null ? Number(entry.nyaitter_id) : null, entry.masked_ip_uuid || '']
		);
		return rows[0] || null;
	}

	async getLogs(limit = 20, offset = 0) {
		const normalizedLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
		const normalizedOffset = Math.max(0, Number(offset) || 0);
		const { rows } = await this.pool.query(
			`SELECT * FROM logs
			 ORDER BY log_time DESC, id DESC
			 LIMIT $1 OFFSET $2`,
			[normalizedLimit, normalizedOffset]
		);
		return rows;
	}

	async getRanking(type, limit = 50) {
		let query;
		if (type === 'followers') {
			query = `SELECT u.id AS user_id, u.name, u.scid, u.icon_data,
				COUNT(f.follower_id)::int AS follower_count
				FROM users u
				LEFT JOIN follows f ON f.following_id = u.id
				GROUP BY u.id
				ORDER BY follower_count DESC, u.id ASC
				LIMIT $1`;
		} else if (type === 'posts') {
			query = `SELECT u.id AS user_id, u.name, u.scid, u.icon_data,
				COUNT(p.id)::int AS post_count
				FROM users u
				LEFT JOIN posts p ON p.user_id = u.id
				GROUP BY u.id
				ORDER BY post_count DESC, u.id ASC
				LIMIT $1`;
		} else if (type === 'likes') {
			query = `SELECT u.id AS user_id, u.name, u.scid, u.icon_data,
				COALESCE(l.like_count, 0)::int AS like_count
				FROM users u
				LEFT JOIN (
					SELECT p.user_id, COUNT(*) AS like_count
					FROM likes l
					JOIN posts p ON p.id = l.post_id
					GROUP BY p.user_id
				) l ON l.user_id = u.id
				GROUP BY u.id, l.like_count
				ORDER BY like_count DESC, u.id ASC
				LIMIT $1`;
		} else if (type === 'stars') {
			query = `SELECT u.id AS user_id, u.name, u.scid, u.icon_data,
				COALESCE(s.star_count, 0)::int AS star_count
				FROM users u
				LEFT JOIN (
					SELECT p.user_id, COUNT(*) AS star_count
					FROM stars s
					JOIN posts p ON p.id = s.post_id
					GROUP BY p.user_id
				) s ON s.user_id = u.id
				GROUP BY u.id, s.star_count
				ORDER BY star_count DESC, u.id ASC
				LIMIT $1`;
		} else {
			throw new Error('Invalid ranking type');
		}
		const { rows } = await this.pool.query(query, [limit]);
		return rows;
	}

	async getUserRanking(type, userId) {
		let query;
		if (type === 'followers') {
			query = `SELECT rank, follower_count FROM (
				SELECT u.id, COUNT(f.follower_id)::int AS follower_count,
					ROW_NUMBER() OVER (ORDER BY COUNT(f.follower_id) DESC, u.id ASC)::int AS rank
				FROM users u
				LEFT JOIN follows f ON f.following_id = u.id
				GROUP BY u.id
			) t WHERE id = $1`;
		} else if (type === 'posts') {
			query = `SELECT rank, post_count FROM (
				SELECT u.id, COUNT(p.id)::int AS post_count,
					ROW_NUMBER() OVER (ORDER BY COUNT(p.id) DESC, u.id ASC)::int AS rank
				FROM users u
				LEFT JOIN posts p ON p.user_id = u.id
				GROUP BY u.id
			) t WHERE id = $1`;
		} else if (type === 'likes') {
			query = `SELECT rank, like_count FROM (
				SELECT u.id, COALESCE(l.like_count, 0)::int AS like_count,
					ROW_NUMBER() OVER (ORDER BY COALESCE(l.like_count, 0) DESC, u.id ASC)::int AS rank
				FROM users u
				LEFT JOIN (
					SELECT p.user_id, COUNT(*) AS like_count
					FROM likes l
					JOIN posts p ON p.id = l.post_id
					GROUP BY p.user_id
				) l ON l.user_id = u.id
				GROUP BY u.id, l.like_count
			) t WHERE id = $1`;
		} else if (type === 'stars') {
			query = `SELECT rank, star_count FROM (
				SELECT u.id, COALESCE(s.star_count, 0)::int AS star_count,
					ROW_NUMBER() OVER (ORDER BY COALESCE(s.star_count, 0) DESC, u.id ASC)::int AS rank
				FROM users u
				LEFT JOIN (
					SELECT p.user_id, COUNT(*) AS star_count
					FROM stars s
					JOIN posts p ON p.id = s.post_id
					GROUP BY p.user_id
				) s ON s.user_id = u.id
				GROUP BY u.id, s.star_count
			) t WHERE id = $1`;
		} else {
			throw new Error('Invalid ranking type');
		}
		const { rows } = await this.pool.query(query, [userId]);
		const metricField = type === 'followers' ? 'follower_count' : (type === 'posts' ? 'post_count' : (type === 'likes' ? 'like_count' : 'star_count'));
		return rows[0] || { rank: null, [metricField]: 0 };
	}

	// Internal: ensure attachments (JSONB) is always an array for callers
	_normalizePost(post) {
		if (!post) return post;
		post.userId = post.userId ?? post.user_id;
		post.replyTo = post.replyTo ?? post.reply_to ?? null;
		post.repostTo = post.repostTo ?? post.repost_to ?? null;
		post.createdAt = post.createdAt ?? post.created_at ?? null;
		post.mask = !!post.mask;
		post.lock = !!post.lock;
		if (post.attachments && typeof post.attachments === 'string') {
			try { post.attachments = JSON.parse(post.attachments); } catch (_) {}
		}
		if (!Array.isArray(post.attachments)) {
			post.attachments = post.attachments ? [post.attachments] : [];
		}
		return post;
	}
}

module.exports = PostgresAdapter;
