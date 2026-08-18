const { Pool } = require('pg');
const crypto = require('crypto');
const DatabaseAdapter = require('../DatabaseAdapter');
const {
	buildExternalNyaitterAddress,
	formatNyaitterId,
} = require('../../../utils/nyaitterAddress');
const appConfig = require('../../../config');
const { normalizeTarget } = require('../../../utils/notification');
const { normalizeBlockList } = require('../../../utils/blockList');
const {
	createSnapshot,
	normalizeSnapshot,
} = require('../../../services/DataMigrationService');
const {
	exportPostgresSnapshot,
	importPostgresSnapshot,
} = require('../../../services/DataMigrationSql');

class PostgresAdapter extends DatabaseAdapter {
	constructor(options = {}) {
		super();
		this.config = options;
		this.pool = null;
		this.transactionRetries = Math.max(
			0,
			Math.min(10, Math.floor(Number(options.transactionRetries) || 5)),
		);
		this.retryBaseDelayMs = Math.max(
			10,
			Math.min(5000, Math.floor(Number(options.retryBaseDelayMs) || 50)),
		);
	}

	async connect() {
		const connectionString = String(
			this.config.connectionString || process.env.DATABASE_URL || '',
		).trim();

		if (!connectionString) {
			throw new Error('PostgreSQL connection string is required (DATABASE_URL or config.database.postgres.connectionString)');
		}

		let parsedConnectionString;
		try {
			parsedConnectionString = new URL(connectionString);
		} catch (_) {
			throw new Error('Invalid PostgreSQL connection string. Set DATABASE_URL to a complete postgres:// or postgresql:// URL.');
		}
		if (!['postgres:', 'postgresql:'].includes(parsedConnectionString.protocol)) {
			throw new Error('Invalid PostgreSQL connection string protocol. DATABASE_URL must start with postgres:// or postgresql://.');
		}
		if (!parsedConnectionString.hostname && !parsedConnectionString.searchParams.get('host')) {
			throw new Error('Invalid PostgreSQL connection string host. Set a hostname in DATABASE_URL, or use the host query parameter for a local Unix socket.');
		}
		const sslMode = parsedConnectionString.searchParams.get('sslmode');
		if (
			sslMode &&
			!['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full', 'no-verify'].includes(sslMode)
		) {
			throw new Error('Invalid PostgreSQL sslmode. Use disable, allow, prefer, require, verify-ca, verify-full, or no-verify.');
		}

		const poolOptions = {
			connectionString,
			max: this.config.poolSize || 10,
			min: Math.min(this.config.poolSize || 10, this.config.poolMin || 2),
			idleTimeoutMillis: this.config.poolIdleTimeoutMs || 300000,
			connectionTimeoutMillis: this.config.connectionTimeoutMs || 15000,
			keepAlive: true,
			keepAliveInitialDelayMillis: 10000,
		};
		if (this.config.sslCa) {
			poolOptions.ssl = { ca: this.config.sslCa, rejectUnauthorized: true };
		} else if (this.config.ssl === true) {
			poolOptions.ssl = { rejectUnauthorized: false };
		}
		this.pool = new Pool(poolOptions);

		let client;
		try {
			client = await this.pool.connect();
			await client.query('SELECT 1');
		} catch (error) {
			await this.pool.end();
			this.pool = null;
			if (['EAI_AGAIN', 'ENOTFOUND'].includes(error?.code)) {
				throw new Error(`PostgreSQL host "${error.hostname || 'unknown'}" could not be resolved. Check DATABASE_URL and set the complete database connection URL, not a name such as "base".`);
			}
			throw error;
		} finally {
			client?.release();
		}

		console.log('[PostgresAdapter] Connected to PostgreSQL');
	}

	async disconnect() {
		if (this.pool) {
			await this.pool.end();
			this.pool = null;
			console.log('[PostgresAdapter] Disconnected from PostgreSQL');
		}
	}

	async exportDataSnapshot() {
		if (!this.pool) throw new Error('PostgreSQL adapter is not connected');
		return exportPostgresSnapshot(this.pool, 'postgres');
	}

	async importDataSnapshot(snapshot, options = {}) {
		if (!this.pool) throw new Error('PostgreSQL adapter is not connected');
		return importPostgresSnapshot(this.pool, normalizeSnapshot(snapshot), options);
	}

	_reassignReportSnapshotUserIds(snapshot, previousId, nextId) {
		if (!snapshot || typeof snapshot !== 'object') return { snapshot, changed: false };
		const updated = JSON.parse(JSON.stringify(snapshot));
		let changed = false;
		if (Number(updated?.subjectUser?.id) === previousId) {
			updated.subjectUser.id = nextId;
			changed = true;
		}
		for (const member of updated?.dm?.members || []) {
			if (Number(member?.id) !== previousId) continue;
			member.id = nextId;
			changed = true;
		}
		return { snapshot: updated, changed };
	}

	_isRetryableTransactionError(error) {
		return error?.code === '40001' || /restart transaction/i.test(error?.message || '');
	}

	async _waitForTransactionRetry(attempt) {
		const delay = Math.min(
			2000,
			this.retryBaseDelayMs * (2 ** Math.max(0, attempt - 1)),
		);
		await new Promise((resolve) => setTimeout(resolve, delay));
	}

	async _withTransaction(operation) {
		let lastError;
		for (let attempt = 0; attempt <= this.transactionRetries; attempt += 1) {
			const client = await this.pool.connect();
			let started = false;
			try {
				await client.query('BEGIN');
				started = true;
				const result = await operation(client);
				await client.query('COMMIT');
				return result;
			} catch (error) {
				lastError = error;
				if (started) {
					try {
						await client.query('ROLLBACK');
					} catch (_) {
						// The original query error is more useful to callers.
					}
				}
				if (
					!this._isRetryableTransactionError(error) ||
					attempt >= this.transactionRetries
				) {
					throw error;
				}
				await this._waitForTransactionRetry(attempt + 1);
			} finally {
				client.release();
			}
		}
		throw lastError;
	}

	_normalizeUserBlockList(user) {
		if (!user) return null;
		return {
			...user,
			block: normalizeBlockList(user.block, user.id),
		};
	}

	async getUserByScid(scid) {
		const { rows } = await this.pool.query(
			'SELECT * FROM users WHERE scid = $1 LIMIT 1',
			[scid]
		);
		return this._normalizeUserBlockList(rows[0]);
	}

	async getUserById(id) {
		const { rows } = await this.pool.query(
			'SELECT * FROM users WHERE id = $1 LIMIT 1',
			[id]
		);
		return this._normalizeUserBlockList(rows[0]);
	}

	async getUserByNyaitterAddress(address) {
		const { rows } = await this.pool.query(
			'SELECT * FROM users WHERE nyaitter_address = $1 LIMIT 1',
			[address]
		);
		return this._normalizeUserBlockList(rows[0]);
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
								`INSERT INTO users (id, scid, name, handle, nyaitter_address, auth_provider, provider_domain, external_id, external_profile, uuid, settings, "block", bio, header_image, icon_data, created_at)
								 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, NOW()) RETURNING *`,
							[id, userData.scid || null, userData.name || userData.scid || handle, handle, address,
										 provider, userData.provider_domain || null, userData.external_id || null,
										 userData.external_profile || null, userData.uuid || null,
										 userData.settings ? JSON.stringify(userData.settings) : '{}',
										 JSON.stringify(normalizeBlockList(userData.block, id)),
										 userData.bio || userData.me || '', userData.header_image || null,
										 userData.icon_data || null],

				);
			return this._normalizeUserBlockList(rows[0]);
		} catch (error) {
				if (error.code !== '23505') throw error;
			}
		}
		throw new Error('Could not allocate a unique Nyaitter ID');
	}

	async searchUsers(query, limit = 20, offset = 0) {
		const q = `%${query.toLowerCase()}%`;
		const digits = String(query).replace(/^#/, '').replace(/\D/g, '');
		const safeLimit = Math.max(Number(limit) || 0, 0);
		const safeOffset = Math.max(Number(offset) || 0, 0);
		const { rows } = await this.pool.query(
			`SELECT id, name, scid, handle, nyaitter_address, auth_provider, provider_domain, external_id
			 FROM users
			 WHERE LOWER(COALESCE(scid, '')) LIKE $1
				OR LOWER(COALESCE(name, '')) LIKE $1
									OR LOWER(COALESCE(handle, '')) LIKE $1
					OR CAST(id AS TEXT) LIKE $1
					OR CAST(COALESCE(external_id, -1) AS TEXT) LIKE $1

			 ORDER BY id ASC LIMIT $2 OFFSET $3`,
			[digits ? `%${digits}%` : q, safeLimit, safeOffset]
		);
		return rows;
	}

	async getUsersByIds(userIds) {
		const ids = [...new Set((userIds || []).map(Number).filter(Number.isInteger))];
		if (ids.length === 0) return [];
		// 投稿・通知の可視性とシリアライズでは settings / shadow / 権限情報も必要になる。
		// ここで必要な属性をまとめて返すことで、呼び出し側のユーザーごとの再取得を避ける。
		const { rows } = await this.pool.query(
							`SELECT id, account_operation, name, scid, icon_data, handle, nyaitter_address,

				auth_provider, provider_domain, external_id, settings, "block", bio,
				header_image, verify, admin, "freeze", shadow, uuid, created_at
			 FROM users WHERE id = ANY($1::int[])`,
			[ids]
		);
		return rows.map((row) => this._normalizeUserBlockList(row));
	}

	async getAllUsers() {
		const { rows } = await this.pool.query('SELECT * FROM users ORDER BY id ASC');
		return rows.map((row) => this._normalizeUserBlockList(row));
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
			const token = typeof meta.token === 'string' && meta.token
				? meta.token
				: crypto.randomBytes(appConfig.auth.sessionTokenBytes).toString('hex');
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

		async getUserBySessionToken(token) {
			const { rows } = await this.pool.query(
				`SELECT u.*
				 FROM sessions AS s
				 INNER JOIN users AS u ON u.id = s.user_id
				 WHERE s.token = $1 AND s.expires_at > NOW()
				 LIMIT 1`,
				[token],
			);
			if (!rows[0]) {
				await this.pool.query('DELETE FROM sessions WHERE token = $1 AND expires_at <= NOW()', [token]);
				return null;
			}
			return this._normalizeUserBlockList(rows[0]);
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

	async _synchronizePostIdSequence() {
		// 外部データ移行などで明示IDが投入された後でも、シーケンスを後退させずに
		// posts.id の最大値以上へ同期する。次回の nextval() は必ず未使用IDになる。
		await this.pool.query(
			`WITH table_state AS (
				SELECT COALESCE(MAX(id), 0)::bigint AS max_id FROM posts
			), sequence_state AS (
				SELECT last_value::bigint AS last_value FROM nyaitter_posts_id_seq
			)
			SELECT setval(
				'nyaitter_posts_id_seq',
				GREATEST(table_state.max_id, sequence_state.last_value),
				true
			)
			FROM table_state CROSS JOIN sequence_state`,
		);
	}

	async createPost(postData) {
		const values = [
			postData.userId,
			postData.content,
			postData.attachments ? JSON.stringify(postData.attachments) : null,
			!!postData.mask,
			!!postData.lock,
			!!postData.announcement,
			postData.replyTo ? Number(postData.replyTo) : null,
			postData.repostTo ? Number(postData.repostTo) : null,
		];
		const insertPost = () => this.pool.query(
			`INSERT INTO posts (user_id, content, attachments, mask, lock, announcement, reply_to, repost_to, created_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
			 RETURNING *`,
			values,
		);

		try {
			const { rows } = await insertPost();
			return this._normalizePost(rows[0] || null);
		} catch (error) {
			// 既存データの最大IDよりシーケンスが遅れている場合だけ、一度同期して再試行する。
			if (error?.code !== '23505' || error?.constraint !== 'posts_pkey') throw error;
			await this._synchronizePostIdSequence();
			const { rows } = await insertPost();
			return this._normalizePost(rows[0] || null);
		}
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
		// D1 Workerと同じく、DBからは各集計行・閲覧者のリアクション行だけを取得し、
		// APIへ返す値はアプリケーション側のMap / Setで組み立てる。
		const ids = [...new Set((postIds || []).map(Number)
			.filter((id) => Number.isSafeInteger(id) && id > 0))];
		if (ids.length === 0) return [];

		const parsedViewerId = Number(currentUserId);
		const viewerId = Number.isSafeInteger(parsedViewerId) && parsedViewerId > 0
			? parsedViewerId
			: null;
		const [likeResult, starResult, repostResult, replyResult, myLikesResult, myStarsResult] = await Promise.all([
			this.pool.query(
				`SELECT post_id, COUNT(*)::int AS count FROM likes
				 WHERE post_id = ANY($1::int[])
				 GROUP BY post_id`,
				[ids],
			),
			this.pool.query(
				`SELECT post_id, COUNT(*)::int AS count FROM stars
				 WHERE post_id = ANY($1::int[])
				 GROUP BY post_id`,
				[ids],
			),
			this.pool.query(
				`SELECT post_id, COUNT(*)::int AS count FROM reposts
				 WHERE post_id = ANY($1::int[])
				 GROUP BY post_id`,
				[ids],
			),
			this.pool.query(
				`SELECT reply_to AS post_id, COUNT(*)::int AS count FROM posts
				 WHERE reply_to = ANY($1::int[])
				 GROUP BY reply_to`,
				[ids],
			),
			viewerId == null
				? Promise.resolve({ rows: [] })
				: this.pool.query(
					`SELECT post_id FROM likes
					 WHERE user_id = $1 AND post_id = ANY($2::int[])`,
					[viewerId, ids],
				),
			viewerId == null
				? Promise.resolve({ rows: [] })
				: this.pool.query(
					`SELECT post_id FROM stars
					 WHERE user_id = $1 AND post_id = ANY($2::int[])`,
					[viewerId, ids],
				),
		]);

		const countMap = (rows) => new Map((rows || []).map((row) => [
			Number(row.post_id),
			Math.max(0, Number(row.count) || 0),
		]));
		const likeMap = countMap(likeResult.rows);
		const starMap = countMap(starResult.rows);
		const repostMap = countMap(repostResult.rows);
		const replyMap = countMap(replyResult.rows);
		const myLikesSet = new Set((myLikesResult.rows || []).map((row) => Number(row.post_id)));
		const myStarsSet = new Set((myStarsResult.rows || []).map((row) => Number(row.post_id)));

		return ids.map((id) => ({
			post_id: id,
			like_count: likeMap.get(id) || 0,
			star_count: starMap.get(id) || 0,
			repost_count: repostMap.get(id) || 0,
			reply_count: replyMap.get(id) || 0,
			liked_by_me: myLikesSet.has(id),
			starred_by_me: myStarsSet.has(id),
		}));
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
			`SELECT * FROM posts WHERE reply_to IS NULL ORDER BY created_at DESC, id DESC LIMIT $1`,
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

	async getPostsByUserId(userId, limit = 50, _currentUserId = null) {
		const { rows } = await this.pool.query(
			`SELECT * FROM posts WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
			[userId, limit]
		);
		// 呼び出し元は共通の serializePostsBatch() で必要な関連情報を一括取得する。
		// ここで投稿ごとの getPostDetail() を行わず、N+1クエリを避ける。
		return rows.map((row) => this._normalizePost(row));
	}

		async getProfilePostIds({ userId, subType = 'all', limit = 30, offset = 0, beforeId = null } = {}) {
			const normalizedLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
			const normalizedOffset = Math.max(0, Number(offset) || 0);
			const normalizedBeforeId = Number.isInteger(Number(beforeId)) && Number(beforeId) > 0
				? Number(beforeId)
				: null;
			const values = [Number(userId)];
			const clauses = ['user_id = $1'];
			if (subType === 'posts_only') clauses.push('reply_to IS NULL');
			if (subType === 'replies_only') clauses.push('reply_to IS NOT NULL');
			if (normalizedBeforeId != null) {
				values.push(normalizedBeforeId);
				clauses.push(`id < $${values.length}`);
			}
			values.push(normalizedLimit + 1);
			const limitParam = values.length;
			let offsetSql = '';
			if (normalizedBeforeId == null) {
				values.push(normalizedOffset);
				offsetSql = ` OFFSET $${values.length}`;
			}
			const { rows } = await this.pool.query(
				`SELECT id FROM posts WHERE ${clauses.join(' AND ')}
				 ORDER BY created_at DESC, id DESC LIMIT $${limitParam}${offsetSql}`,
				values,
			);
			const ids = rows.slice(0, normalizedLimit).map((row) => row.id);
			return {
				ids,
				has_more: rows.length > normalizedLimit,
				next_cursor: rows.length > normalizedLimit && ids.length > 0 ? ids[ids.length - 1] : null,
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
		// 添付単位で展開してからSQL側でページングする。従来のように全投稿・全添付を
		// Node.jsへ転送してsliceする必要がないため、長期利用ユーザーのプロフィール表示を抑制できる。
		const { rows } = await this.pool.query(
			`SELECT p.id AS post_id,
					attachment.file->>'id' AS file_id,
					COALESCE(attachment.file->>'type', 'file') AS file_type
			 FROM posts p
			 CROSS JOIN LATERAL jsonb_array_elements(p.attachments) WITH ORDINALITY AS attachment(file, position)
			 WHERE p.user_id = $1
			   AND jsonb_typeof(p.attachments) = 'array'
			   AND jsonb_array_length(p.attachments) > 0
			 ORDER BY p.created_at DESC, p.id DESC, attachment.position ASC
			 LIMIT $2 OFFSET $3`,
			[userId, normalizedLimit, normalizedOffset]
		);
		return rows.map((row) => ({
			post_id: Number(row.post_id),
			file_id: row.file_id,
			file_type: row.file_type || 'file',
			type: row.file_type || 'file',
		}));
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

		async getTimelinePostIds({ tab = 'foryou', followIds = [], limit = 30, offset = 0, beforeId = null } = {}) {
			const normalizedLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
			const normalizedOffset = Math.max(0, Number(offset) || 0);
			const normalizedBeforeId = Number.isInteger(Number(beforeId)) && Number(beforeId) > 0
				? Number(beforeId)
				: null;
			let query;
			let values;
			if (tab === 'following') {
				const ids = [...new Set((followIds || []).map(Number).filter(Number.isInteger))];
				if (ids.length === 0) return { ids: [], has_more: false, next_cursor: null };
				if (normalizedBeforeId != null) {
					query = `SELECT id FROM posts WHERE user_id = ANY($1::int[]) AND reply_to IS NULL AND id < $2
						ORDER BY created_at DESC, id DESC LIMIT $3`;
					values = [ids, normalizedBeforeId, normalizedLimit + 1];
				} else {
					query = `SELECT id FROM posts WHERE user_id = ANY($1::int[]) AND reply_to IS NULL
						ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`;
					values = [ids, normalizedLimit + 1, normalizedOffset];
				}
			} else if (tab === 'announce') {
				if (normalizedBeforeId != null) {
					query = `SELECT id FROM posts WHERE announcement = TRUE AND reply_to IS NULL
						AND id < $1 ORDER BY created_at DESC, id DESC LIMIT $2`;
					values = [normalizedBeforeId, normalizedLimit + 1];
				} else {
					query = `SELECT id FROM posts WHERE announcement = TRUE AND reply_to IS NULL
						ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2`;
					values = [normalizedLimit + 1, normalizedOffset];
				}
			} else if (normalizedBeforeId != null) {
				query = `SELECT id FROM posts WHERE reply_to IS NULL AND id < $1 ORDER BY created_at DESC, id DESC LIMIT $2`;
				values = [normalizedBeforeId, normalizedLimit + 1];
			} else {
				query = `SELECT id FROM posts WHERE reply_to IS NULL ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2`;
				values = [normalizedLimit + 1, normalizedOffset];
			}
			const { rows } = await this.pool.query(query, values);
			const ids = rows.slice(0, normalizedLimit).map((row) => row.id);
			return {
				ids,
				has_more: rows.length > normalizedLimit,
				next_cursor: rows.length > normalizedLimit && ids.length > 0 ? ids[ids.length - 1] : null,
			};
		}

		async getRecommendedPostIds({ viewerId = null, limit = 30, offset = 0, beforeId = null } = {}) {
			const normalizedLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
			const normalizedOffset = Math.max(0, Number(offset) || 0);
			const normalizedBeforeId = Number.isInteger(Number(beforeId)) && Number(beforeId) > 0
				? Number(beforeId)
				: null;
			const normalizedViewerId = Number.isInteger(Number(viewerId)) ? Number(viewerId) : null;
			const scoringBlockSize = Math.max(240, normalizedLimit * 8);
			const candidateLimit = scoringBlockSize + 1;
			const values = [];
			const candidateClauses = ['p.reply_to IS NULL'];
			if (normalizedBeforeId != null) {
				values.push(normalizedBeforeId);
				candidateClauses.push(`p.id < $${values.length}`);
			}
			values.push(candidateLimit);
			const candidateLimitParam = values.length;
			values.push(normalizedOffset);
			const candidateOffsetParam = values.length;
			values.push(scoringBlockSize);
			const scoringBlockSizeParam = values.length;
			const personalScoreCtes = [];
			if (normalizedViewerId != null) {
				values.push(normalizedViewerId);
				const likeViewerParam = values.length;
				values.push(normalizedViewerId);
				const starViewerParam = values.length;
				values.push(normalizedViewerId);
				const directViewerParam = values.length;
				values.push(normalizedViewerId);
				const secondDegreeViewerParam = values.length;
				values.push(normalizedViewerId);
				const secondDegreeExcludeParam = values.length;
				personalScoreCtes.push(
					`viewer_like_affinity AS (
						SELECT p.user_id, COUNT(*)::int AS count
						FROM likes l JOIN posts p ON p.id = l.post_id
						WHERE l.user_id = $${likeViewerParam}
						GROUP BY p.user_id
					), viewer_star_affinity AS (
						SELECT p.user_id, COUNT(*)::int AS count
						FROM stars s JOIN posts p ON p.id = s.post_id
						WHERE s.user_id = $${starViewerParam}
						GROUP BY p.user_id
					), direct_follows AS (
						SELECT following_id AS user_id FROM follows WHERE follower_id = $${directViewerParam}
					), second_degree_follows AS (
						SELECT DISTINCT f2.following_id AS user_id
						FROM follows f1 JOIN follows f2 ON f2.follower_id = f1.following_id
						WHERE f1.follower_id = $${secondDegreeViewerParam}
							AND f2.following_id <> $${secondDegreeExcludeParam}
					)`,
				);
			}
			const { rows } = await this.pool.query(
				`WITH candidate_source AS (
					SELECT p.id, p.user_id, p.created_at
					FROM posts p
					WHERE ${candidateClauses.join(' AND ')}
					ORDER BY p.created_at DESC, p.id DESC
					LIMIT $${candidateLimitParam} OFFSET $${candidateOffsetParam}
				), candidates AS (
					SELECT id, user_id, created_at
					FROM candidate_source
					ORDER BY created_at DESC, id DESC
					LIMIT $${scoringBlockSizeParam}
				), like_counts AS (
					SELECT l.post_id, COUNT(*)::int AS count
					FROM likes l JOIN candidates c ON c.id = l.post_id
					GROUP BY l.post_id
				), star_counts AS (
					SELECT s.post_id, COUNT(*)::int AS count
					FROM stars s JOIN candidates c ON c.id = s.post_id
					GROUP BY s.post_id
				), repost_counts AS (
					SELECT r.post_id, COUNT(*)::int AS count
					FROM reposts r JOIN candidates c ON c.id = r.post_id
					GROUP BY r.post_id
				)${personalScoreCtes.length > 0 ? `, ${personalScoreCtes.join(', ')}` : ''}, scored AS (
					SELECT c.id, c.created_at,
						48.0 / (1.0 + GREATEST(0, EXTRACT(EPOCH FROM (NOW() - c.created_at)) / 3600.0) / 6.0)
						+ LEAST(22.0,
							COALESCE(l.count, 0) * 4.0 / (COALESCE(l.count, 0) + 4.0)
							+ COALESCE(s.count, 0) * 8.0 / (COALESCE(s.count, 0) + 2.0)
							+ COALESCE(r.count, 0) * 10.0 / (COALESCE(r.count, 0) + 2.0))
						${normalizedViewerId != null ? `+ CASE WHEN df.user_id IS NOT NULL THEN 24.0 WHEN sdf.user_id IS NOT NULL THEN 10.0 ELSE 0.0 END
						+ LEAST(20.0, COALESCE(vla.count, 0) * 4.0)
						+ LEAST(32.0, COALESCE(vsa.count, 0) * 8.0)` : ''} AS score
					FROM candidates c
					LEFT JOIN like_counts l ON l.post_id = c.id
					LEFT JOIN star_counts s ON s.post_id = c.id
					LEFT JOIN repost_counts r ON r.post_id = c.id
					${normalizedViewerId != null ? `LEFT JOIN viewer_like_affinity vla ON vla.user_id = c.user_id
					LEFT JOIN viewer_star_affinity vsa ON vsa.user_id = c.user_id
					LEFT JOIN direct_follows df ON df.user_id = c.user_id
					LEFT JOIN second_degree_follows sdf ON sdf.user_id = c.user_id` : ''}
				), score_stats AS (
					SELECT AVG(score) AS average_score FROM scored
				)
				SELECT
					COALESCE(
						array_agg(s.id ORDER BY s.score DESC, s.created_at DESC, s.id DESC),
						ARRAY[]::integer[]
					) AS ids,
					(SELECT COUNT(*)::int FROM candidate_source) AS candidate_count
				FROM scored s
				CROSS JOIN score_stats stats
				WHERE s.score >= stats.average_score * 0.75`,
				values,
			);
			const ids = Array.isArray(rows[0]?.ids)
				? rows[0].ids.map(Number).filter(Number.isInteger)
				: [];
			const candidateCount = Math.max(0, Number(rows[0]?.candidate_count) || 0);
			return {
				ids,
				has_more: candidateCount > scoringBlockSize,
				next_cursor: null,
				next_offset: normalizedOffset + Math.min(candidateCount, scoringBlockSize),
				use_offset_pagination: true,
			};
		}

		async searchPostIds(query, limit = 30, offset = 0, beforeId = null) {
			const q = String(query || '').trim();
			if (!q) return { ids: [], has_more: false, next_cursor: null };
			const normalizedLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
			const normalizedOffset = Math.max(0, Number(offset) || 0);
			const normalizedBeforeId = Number.isInteger(Number(beforeId)) && Number(beforeId) > 0
				? Number(beforeId)
				: null;
			const { rows } = normalizedBeforeId != null
				? await this.pool.query(
					`SELECT id FROM posts WHERE content ILIKE $1 AND id < $2
					 ORDER BY created_at DESC, id DESC LIMIT $3`,
					[`%${q}%`, normalizedBeforeId, normalizedLimit + 1],
				)
				: await this.pool.query(
					`SELECT id FROM posts WHERE content ILIKE $1
					 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
					[`%${q}%`, normalizedLimit + 1, normalizedOffset],
				);
			const ids = rows.slice(0, normalizedLimit).map((row) => row.id);
			return {
				ids,
				has_more: rows.length > normalizedLimit,
				next_cursor: rows.length > normalizedLimit && ids.length > 0 ? ids[ids.length - 1] : null,
			};
		}

	async getPostDetail(id, currentUserId = null) {
		// D1のバッチメトリクスと同じ契約にそろえ、リアクション状態は
		// PostgreSQLのEXISTS列ではなく共通のアプリケーション側組み立て値を使う。
		const { rows } = await this.pool.query(
			`SELECT p.*,
				author.id AS author_id,
				author.name AS author_name,
				author.scid AS author_scid,
				parent.id AS parent_id,
				parent.content AS parent_content,
				parent_author.id AS parent_author_id,
				parent_author.name AS parent_author_name
			 FROM posts p
			 LEFT JOIN users author ON author.id = p.user_id
			 LEFT JOIN posts parent ON parent.id = p.reply_to
			 LEFT JOIN users parent_author ON parent_author.id = parent.user_id
			 WHERE p.id = $1`,
			[id],
		);
		const detail = rows[0];
		if (!detail) return null;
		const [metric] = await this.getPostMetricsBatch([id], currentUserId);

		const normalized = this._normalizePost(detail);
		return {
			...normalized,
			author: detail.author_id == null
				? null
				: { id: detail.author_id, name: detail.author_name || '', scid: detail.author_scid || null },
			like_count: Number(metric.like_count || 0),
			star_count: Number(metric.star_count || 0),
			liked_by_me: !!metric.liked_by_me,
			starred_by_me: !!metric.starred_by_me,
			parent_post: detail.parent_id == null
				? null
				: {
					id: detail.parent_id,
					content: detail.parent_content ? String(detail.parent_content).substring(0, 100) : '',
					author: detail.parent_author_id == null
						? null
						: { id: detail.parent_author_id, name: detail.parent_author_name || '' },
				},
		};
	}

	async getTimelinePosts(params) {
		const posts = await this.getRecentPosts(params.limit || 30);
		return { posts, hasMore: posts.length === (params.limit || 30) };
	}

	async toggleLike(userId, postId) {
		return this._withTransaction(async (client) => {
			const deleted = await client.query(
				'DELETE FROM likes WHERE user_id = $1 AND post_id = $2 RETURNING 1',
				[userId, postId],
			);
			let liked = false;
			if (deleted.rowCount === 0) {
				const inserted = await client.query(
					`INSERT INTO likes (user_id, post_id, created_at)
					 VALUES ($1, $2, NOW())
					 ON CONFLICT (user_id, post_id) DO NOTHING
					 RETURNING 1`,
					[userId, postId],
				);
				liked = inserted.rowCount > 0;
				if (!liked) {
					const existing = await client.query(
						'SELECT 1 FROM likes WHERE user_id = $1 AND post_id = $2',
						[userId, postId],
					);
					liked = existing.rowCount > 0;
				}
			}
			const countResult = await client.query(
				'SELECT COUNT(*)::int AS count FROM likes WHERE post_id = $1',
				[postId],
			);
			return { liked, count: Number(countResult.rows[0]?.count || 0) };
		});
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
		return this._withTransaction(async (client) => {
			const deleted = await client.query(
				'DELETE FROM stars WHERE user_id = $1 AND post_id = $2 RETURNING 1',
				[userId, postId],
			);
			let starred = false;
			if (deleted.rowCount === 0) {
				const inserted = await client.query(
					`INSERT INTO stars (user_id, post_id, created_at)
					 VALUES ($1, $2, NOW())
					 ON CONFLICT (user_id, post_id) DO NOTHING
					 RETURNING 1`,
					[userId, postId],
				);
				starred = inserted.rowCount > 0;
				if (!starred) {
					const existing = await client.query(
						'SELECT 1 FROM stars WHERE user_id = $1 AND post_id = $2',
						[userId, postId],
					);
					starred = existing.rowCount > 0;
				}
			}
			const countResult = await client.query(
				'SELECT COUNT(*)::int AS count FROM stars WHERE post_id = $1',
				[postId],
			);
			return { starred, count: Number(countResult.rows[0]?.count || 0) };
		});
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
			 ORDER BY created_at DESC`,
			[userId]
		);
		return rows.map((row) => Number(row.post_id));
	}

	async getStarIds(userId) {
		const { rows } = await this.pool.query(
			`SELECT post_id FROM stars
			 WHERE user_id = $1
			 ORDER BY created_at DESC`,
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
			`SELECT * FROM group_dms WHERE $1::INTEGER = ANY(member) ORDER BY time DESC`,
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
		const id = crypto.randomUUID();
		const { rows } = await this.pool.query(
			`INSERT INTO group_dms (id, host_id, title, member, post, unread, time, created_at)
			 VALUES ($1, $2, $3, $4, '[]'::jsonb, '{}'::jsonb, NOW(), NOW())
			 RETURNING *`,
			[id, dmData.hostId, dmData.title || '', member]
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
		return this._withTransaction(async (client) => {
			const { rows: existingRows } = await client.query(
				'SELECT * FROM group_dms WHERE id = $1 FOR UPDATE',
				[dmId]
			);
			const row = existingRows[0];
			if (!row) return null;

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
			return this._serializeGroupDmRow(rows[0], senderId);
		});
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

		async getFollowRelationshipSnapshot(userId, candidateUserIds) {
			const normalizedUserId = Number(userId);
			const ids = [...new Set((candidateUserIds || [])
				.map(Number)
				.filter((id) => Number.isInteger(id) && id !== normalizedUserId))];
			if (ids.length === 0) return { followingIds: [], followerIds: [] };

			const { rows } = await this.pool.query(
				`SELECT following_id AS user_id, 'following' AS direction
				 FROM follows
				 WHERE follower_id = $1 AND following_id = ANY($2::int[])
				 UNION ALL
				 SELECT follower_id AS user_id, 'follower' AS direction
				 FROM follows
				 WHERE following_id = $1 AND follower_id = ANY($2::int[])`,
				[normalizedUserId, ids],
			);
			const followingIds = [];
			const followerIds = [];
			for (const row of rows) {
				if (row.direction === 'following') followingIds.push(Number(row.user_id));
				if (row.direction === 'follower') followerIds.push(Number(row.user_id));
			}
			return { followingIds, followerIds };
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
		return this._withTransaction(async (client) => {
			const { rows: postRows } = await client.query(
				'SELECT user_id FROM posts WHERE id = $1',
				[postId]
			);
			if (postRows.length === 0 || Number(postRows[0].user_id) !== Number(userId)) {
				return false;
			}

			await client.query('DELETE FROM likes WHERE post_id = $1', [postId]);
			await client.query('DELETE FROM stars WHERE post_id = $1', [postId]);
			await client.query('DELETE FROM reposts WHERE post_id = $1', [postId]);
			await client.query('DELETE FROM pinned_posts WHERE post_id = $1', [postId]);
			await client.query('DELETE FROM posts WHERE id = $1', [postId]);
			return true;
		});
	}

	async togglePin(userId, postId) {
		const { rows: postRows } = await this.pool.query(
			'SELECT user_id FROM posts WHERE id = $1',
			[postId]
		);
			if (postRows.length === 0 || Number(postRows[0].user_id) !== Number(userId)) {
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
			return rows.map((row) => this._normalizePost(row));
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
			return rows.map((row) => this._normalizePost(row));
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
		return this._withTransaction(async (client) => {
			await client.query('DELETE FROM likes WHERE post_id = $1', [postId]);
			await client.query('DELETE FROM stars WHERE post_id = $1', [postId]);
			await client.query('DELETE FROM reposts WHERE post_id = $1', [postId]);
			await client.query('DELETE FROM pinned_posts WHERE post_id = $1', [postId]);
			await client.query('DELETE FROM posts WHERE id = $1', [postId]);
			return true;
		});
	}

	async createNotification(notificationData) {
		const target = normalizeTarget(notificationData.target, {
			postId: notificationData.postId,
			open: notificationData.open,
		});
		const { rows } = await this.pool.query(
					`INSERT INTO notifications
					 (user_id, type, from_user_id, post_id, target, message, read, clicked, created_at)
					 VALUES ($1, $2, $3, $4, $5::jsonb, $6, false, false, NOW())
				 RETURNING *`,
				[
					notificationData.userId,
					notificationData.type,
					notificationData.fromUserId ?? null,
					target?.kind === 'post' ? target.id : null,
					JSON.stringify(target),
					typeof notificationData.message === 'string' ? notificationData.message : null,
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

	async markAllNotificationsAsClicked(userId) {
		await this.pool.query(
			'UPDATE notifications SET read = true, clicked = true WHERE user_id = $1 AND (read = false OR clicked = false)',
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

		_mapModerationReport(row) {
			if (!row) return null;
			return {
				id: Number(row.id),
				reporterUserId: Number(row.reporter_user_id),
				targetKind: row.target_kind,
				targetId: String(row.target_id),
				description: row.description || '',
				targetSnapshot: row.target_snapshot || {},
				assignmentType: row.assignment_type || 'report',
				status: row.status,
				assignedAdminId: row.assigned_admin_id == null ? null : Number(row.assigned_admin_id),
				assignedAt: row.assigned_at || null,
				excludedAdminIds: Array.isArray(row.excluded_admin_ids)
					? row.excluded_admin_ids.map(Number).filter(Number.isInteger)
					: [],
				resolution: row.resolution || null,
				createdAt: row.created_at,
				resolvedAt: row.resolved_at || null,
			};
		}

		async createModerationReport(reportData) {
			const { rows } = await this.pool.query(
					`INSERT INTO moderation_reports
						(reporter_user_id, target_kind, target_id, description, target_snapshot, assignment_type, status, created_at)
					 VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'pending', COALESCE($7::timestamptz, NOW()))
					 RETURNING *`,
				[
					reportData.reporterUserId,
					reportData.targetKind,
					reportData.targetId,
					String(reportData.description || ''),
					JSON.stringify(reportData.targetSnapshot || {}),
					['freeze_appeal', 'verification_application'].includes(reportData.assignmentType)
						? reportData.assignmentType
						: 'report',
					reportData.createdAt || null,
				],
			);
			return this._mapModerationReport(rows[0]);
		}

			async getOpenModerationAppealByUserId(userId) {
				const { rows } = await this.pool.query(
					`SELECT * FROM moderation_reports
					 WHERE reporter_user_id = $1 AND assignment_type = 'freeze_appeal' AND status <> 'resolved'
					 ORDER BY created_at DESC LIMIT 1`,
					[userId],
				);
				return this._mapModerationReport(rows[0]);
			}

			async getOpenModerationVerificationByUserId(userId) {
				const { rows } = await this.pool.query(
					`SELECT * FROM moderation_reports
					 WHERE reporter_user_id = $1 AND assignment_type = 'verification_application' AND status <> 'resolved'
					 ORDER BY created_at DESC LIMIT 1`,
					[userId],
				);
				return this._mapModerationReport(rows[0]);
			}

			async getModerationReportById(reportId) {
				const { rows } = await this.pool.query(
					'SELECT * FROM moderation_reports WHERE id = $1 LIMIT 1',
					[reportId],
				);
				return this._mapModerationReport(rows[0]);
			}

		async listModerationReportsForAdmin(adminId, options = {}) {
			const status = options.status || 'assigned';
			const limit = Math.max(1, Math.min(Number(options.limit) || 50, 100));
			const offset = Math.max(0, Number(options.offset) || 0);
			const { rows } = await this.pool.query(
				`SELECT * FROM moderation_reports
				 WHERE assigned_admin_id = $1
				   AND ($2::text IS NULL OR status = $2)
				 ORDER BY COALESCE(assigned_at, created_at) DESC, id DESC
				 LIMIT $3 OFFSET $4`,
				[adminId, status || null, limit, offset],
			);
			return rows.map((row) => this._mapModerationReport(row));
		}

		async getModerationAdminWorkloads(excludedAdminIds = []) {
			const excluded = [...new Set((excludedAdminIds || []).map(Number).filter(Number.isInteger))];
			const { rows } = await this.pool.query(
				`SELECT u.id AS admin_id, COUNT(r.id)::int AS active_count
				 FROM users u
				 LEFT JOIN moderation_reports r
				   ON r.assigned_admin_id = u.id AND r.status = 'assigned'
				 WHERE u.admin = TRUE
				   AND COALESCE(u."freeze", '') = ''
				   AND NOT (u.id = ANY($1::int[]))
				 GROUP BY u.id`,
				[excluded],
			);
			return rows.map((row) => ({
				adminId: Number(row.admin_id),
				activeCount: Number(row.active_count || 0),
			}));
		}

		async assignModerationReport(reportId, assignment = {}) {
			const excluded = [...new Set((assignment.excludedAdminIds || []).map(Number).filter(Number.isInteger))];
			const hasExpected = Object.prototype.hasOwnProperty.call(assignment, 'expectedAdminId');
			const { rows } = await this.pool.query(
				`UPDATE moderation_reports
				 SET status = 'assigned', assigned_admin_id = $2,
					 assigned_at = COALESCE($3::timestamptz, NOW()),
					 excluded_admin_ids = $4::jsonb
				 WHERE id = $1 AND status <> 'resolved'
				   AND ($5::boolean = false OR assigned_admin_id IS NOT DISTINCT FROM $6::int)
				 RETURNING *`,
				[
					reportId,
					assignment.adminId,
					assignment.assignedAt || null,
					JSON.stringify(excluded),
					hasExpected,
					hasExpected ? Number(assignment.expectedAdminId) : null,
				],
			);
			return this._mapModerationReport(rows[0]);
		}

		async getOverdueModerationReports(cutoff) {
			const { rows } = await this.pool.query(
				`SELECT * FROM moderation_reports
				 WHERE status = 'assigned' AND assigned_at IS NOT NULL AND assigned_at <= $1::timestamptz
				 ORDER BY assigned_at ASC`,
				[cutoff],
			);
			return rows.map((row) => this._mapModerationReport(row));
		}

		async getUnassignedModerationReports(limit = 100) {
			const { rows } = await this.pool.query(
				`SELECT * FROM moderation_reports
				 WHERE status = 'pending'
				 ORDER BY created_at ASC, id ASC LIMIT $1`,
				[Math.max(1, Math.min(Number(limit) || 100, 100))],
			);
			return rows.map((row) => this._mapModerationReport(row));
		}

		async resolveModerationReport(reportId, adminId, resolution) {
			const { rows } = await this.pool.query(
				`UPDATE moderation_reports
				 SET status = 'resolved', resolution = $3::jsonb, resolved_at = NOW()
				 WHERE id = $1 AND assigned_admin_id = $2 AND status = 'assigned'
				 RETURNING *`,
				[reportId, adminId, JSON.stringify(resolution || {})],
			);
			return this._mapModerationReport(rows[0]);
		}

		async deleteModerationReport(reportId) {
			const result = await this.pool.query(
				'DELETE FROM moderation_reports WHERE id = $1',
				[reportId],
			);
			return result.rowCount > 0;
		}

		async upsertPushSubscription(userId, subscription) {
		const { rows } = await this.pool.query(
			`INSERT INTO push_subscriptions
				(user_id, endpoint, expiration_time, p256dh, auth, session_token, created_at, updated_at)
			 VALUES ($1, $2, to_timestamp($3 / 1000.0), $4, $5, $6, NOW(), NOW())
			 ON CONFLICT (user_id, endpoint)
			 DO UPDATE SET
				expiration_time = EXCLUDED.expiration_time,
				p256dh = EXCLUDED.p256dh,
				auth = EXCLUDED.auth,
				session_token = COALESCE(EXCLUDED.session_token, push_subscriptions.session_token),
				updated_at = NOW()
			 RETURNING *`,
			[
				userId,
				subscription.endpoint,
				subscription.expirationTime ?? null,
				subscription.keys.p256dh,
				subscription.keys.auth,
				subscription.sessionToken ?? null,
			],
		);
		return rows[0] || null;
	}

	async getPushSubscriptions(userId) {
		const { rows } = await this.pool.query(
			`SELECT endpoint, expiration_time, p256dh, auth, session_token
			 FROM push_subscriptions
			 WHERE user_id = $1`,
			[userId],
		);
		return rows.map((row) => ({
			endpoint: row.endpoint,
			expirationTime: row.expiration_time ? new Date(row.expiration_time).getTime() : null,
			keys: { p256dh: row.p256dh, auth: row.auth },
			sessionToken: row.session_token || null,
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
				 ORDER BY created_at DESC, id DESC
				 LIMIT $2`,
			[q, limit]
		);


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
			return rows.map(({ score: _score, ...row }) => this._normalizePost(row));
		}

		async getTrendingHashtags(limit = 10) {
		const normalizedLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
		const { rows } = await this.pool.query(
			'SELECT content FROM posts ORDER BY created_at DESC LIMIT 500'
		);
		const counts = new Map();
		for (const row of rows) {
			const matches = (row.content || '').match(/#([^<>/@#\s]+)/g) || [];
			const uniqueTags = new Set(matches.map((match) => match.slice(1).toLowerCase()));
			for (const tag of uniqueTags) {
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
		if (profileData.block !== undefined) {
			fields.push(`"block" = $${idx++}::jsonb`);
			values.push(JSON.stringify(normalizeBlockList(profileData.block, userId)));
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
		return this._normalizeUserBlockList(rows[0]);
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

	async beginAccountOperation(userId, operation) {
		if (!['reassigning', 'deleting'].includes(operation)) throw new Error('Invalid account operation');
		const { rows } = await this.pool.query(
			`UPDATE users
			 SET account_operation = $2
			 WHERE id = $1
			   AND auth_provider <> 'nyaitter'
			   AND account_operation IS NULL
			 RETURNING *`,
			[userId, operation],
		);
		return this._normalizeUserBlockList(rows[0] || null);
	}

	async finishAccountOperation(userId, operation) {
		const { rows } = await this.pool.query(
			`UPDATE users SET account_operation = NULL
			 WHERE id = $1 AND account_operation = $2
			 RETURNING *`,
			[userId, operation],
		);
		return this._normalizeUserBlockList(rows[0] || null);
	}

	async reassignUserId(userId) {
		return this._withTransaction(async (client) => {
			const { rows: userRows } = await client.query(
				`SELECT * FROM users
				 WHERE id = $1 AND auth_provider <> 'nyaitter' AND account_operation = 'reassigning'
				 FOR UPDATE`,
				[userId],
			);
			const user = userRows[0];
			if (!user) return null;

			const previousId = Number(user.id);
			const { rows: countRows } = await client.query('SELECT COUNT(*)::bigint AS count FROM users');
			const digits = Math.max(4, String(Math.max(Number(countRows[0]?.count) || 1, 1)).length);
			const upperBound = 10 ** digits;
			let nextId = null;
			for (let attempt = 0; attempt < 100; attempt += 1) {
				const candidate = crypto.randomInt(0, upperBound);
				if (candidate === previousId) continue;
				const { rows } = await client.query('SELECT 1 FROM users WHERE id = $1 LIMIT 1', [candidate]);
				if (rows.length === 0) {
					nextId = candidate;
					break;
				}
			}
			if (nextId == null) throw new Error('Could not allocate a unique Nyaitter ID');

			await client.query(
				`UPDATE users
					 SET "block" = COALESCE((
						SELECT jsonb_agg(CASE WHEN value = to_jsonb($1::int) THEN to_jsonb($2::int) ELSE value END)
						FROM jsonb_array_elements(COALESCE("block", '[]'::jsonb)) AS value
					 ), '[]'::jsonb)
					 WHERE "block" @> jsonb_build_array(to_jsonb($1::int))`,
				[previousId, nextId],
			);
			await client.query(
				'UPDATE dm_channels SET participants = array_replace(participants, $1, $2) WHERE $1 = ANY(participants)',
				[previousId, nextId],
			);
			await client.query(
				`UPDATE group_dms
				 SET member = array_replace(member, $1, $2),
					 post = COALESCE((
						SELECT jsonb_agg(CASE
							WHEN message->>'userid' = $1::text THEN jsonb_set(message, '{userid}', to_jsonb($2::int), true)
							ELSE message
						END)
						FROM jsonb_array_elements(COALESCE(post, '[]'::jsonb)) AS message
					 ), '[]'::jsonb),
					 unread = CASE
						WHEN unread ? $1::text THEN (unread - $1::text) || jsonb_build_object($2::text, unread -> $1::text)
						ELSE unread
					 END
				 WHERE $1 = ANY(member) OR host_id = $1 OR unread ? $1::text`,
				[previousId, nextId],
			);
			await client.query(
				`UPDATE notifications
				 SET target = jsonb_set(target, '{id}', to_jsonb($2::int), false)
				 WHERE target->>'kind' = 'user' AND target->>'id' = $1::text`,
				[previousId, nextId],
			);
			const { rows: reportRows } = await client.query(
				'SELECT id, target_kind, target_id, target_snapshot, excluded_admin_ids FROM moderation_reports FOR UPDATE',
			);
			for (const report of reportRows) {
				const { snapshot, changed } = this._reassignReportSnapshotUserIds(report.target_snapshot, previousId, nextId);
				const targetId = report.target_kind === 'user' && String(report.target_id) === String(previousId)
					? String(nextId)
					: report.target_id;
				const excluded = Array.isArray(report.excluded_admin_ids)
					? report.excluded_admin_ids.map((id) => Number(id) === previousId ? nextId : Number(id))
					: report.excluded_admin_ids;
				const excludedChanged = Array.isArray(report.excluded_admin_ids)
					&& excluded.some((id, index) => Number(id) !== Number(report.excluded_admin_ids[index]));
				if (!changed && targetId === report.target_id && !excludedChanged) continue;
				await client.query(
					`UPDATE moderation_reports
					 SET target_id = $2, target_snapshot = $3::jsonb, excluded_admin_ids = $4::jsonb
					 WHERE id = $1`,
					[report.id, targetId, JSON.stringify(snapshot || {}), JSON.stringify(excluded || [])],
				);
			}
			await client.query('UPDATE logs SET nyaitter_id = $2 WHERE nyaitter_id = $1', [previousId, nextId]);

			const { rows } = await client.query(
				`UPDATE users
				 SET id = $2, handle = $3
				 WHERE id = $1
				 RETURNING *`,
				[previousId, nextId, formatNyaitterId(nextId)],
			);
			return this._normalizeUserBlockList(rows[0] || null);
		});
	}

	async getAccountAttachmentKeys(userId) {
		const { rows } = await this.pool.query(
			'SELECT attachments FROM posts WHERE user_id = $1',
			[userId],
		);
		const keys = new Set();
		for (const row of rows) {
			const attachments = Array.isArray(row.attachments) ? row.attachments : [];
			for (const attachment of attachments) {
				const key = attachment?.id || attachment?.key;
				if (typeof key === 'string' && key.startsWith('attachments/')) keys.add(key);
			}
		}
		return [...keys];
	}

	async deleteAccount(userId) {
		return this._withTransaction(async (client) => {
			const { rows: userRows } = await client.query(
				`SELECT id FROM users WHERE id = $1 AND account_operation = 'deleting' FOR UPDATE`,
				[userId],
			);
			if (!userRows[0]) return false;

			const { rows: postRows } = await client.query('SELECT id FROM posts WHERE user_id = $1', [userId]);
			const postIds = postRows.map((row) => Number(row.id));
			if (postIds.length > 0) {
				await client.query('UPDATE posts SET reply_to = NULL WHERE reply_to = ANY($1::int[])', [postIds]);
				await client.query('UPDATE posts SET repost_to = NULL WHERE repost_to = ANY($1::int[])', [postIds]);
			}

			const { rows: channelRows } = await client.query(
				`SELECT id, participants FROM dm_channels WHERE $1 = ANY(participants) FOR UPDATE`,
				[userId],
			);
			for (const channel of channelRows) {
				const participants = (channel.participants || []).map(Number).filter((id) => id !== Number(userId));
				if (participants.length < 2) await client.query('DELETE FROM dm_channels WHERE id = $1', [channel.id]);
				else await client.query('UPDATE dm_channels SET participants = $2::int[] WHERE id = $1', [channel.id, participants]);
			}

			const { rows: groupRows } = await client.query(
				`SELECT id, host_id, member, post, unread
				 FROM group_dms
				 WHERE host_id = $1 OR $1 = ANY(member)
				 FOR UPDATE`,
				[userId],
			);
			for (const group of groupRows) {
				const members = (group.member || []).map(Number).filter((id) => id !== Number(userId));
				if (members.length === 0) {
					await client.query('DELETE FROM group_dms WHERE id = $1', [group.id]);
					continue;
				}
				const messages = Array.isArray(group.post)
					? group.post.filter((message) => Number(message?.userid) !== Number(userId))
					: [];
				const unread = { ...(group.unread || {}) };
				delete unread[String(userId)];
				const hostId = Number(group.host_id) === Number(userId) ? members[0] : Number(group.host_id);
				await client.query(
					`UPDATE group_dms
					 SET host_id = $2, member = $3::int[], post = $4::jsonb, unread = $5::jsonb
					 WHERE id = $1`,
					[group.id, hostId, members, JSON.stringify(messages), JSON.stringify(unread)],
				);
			}

			await client.query(
				`UPDATE users
					 SET "block" = COALESCE((
						SELECT jsonb_agg(value)
						FROM jsonb_array_elements_text(COALESCE("block", '[]'::jsonb)) AS value
						WHERE value <> $1::text
					 ), '[]'::jsonb)
					 WHERE "block" @> jsonb_build_array($1::text)`,
				[userId],
			);
			await client.query('DELETE FROM moderation_reports WHERE reporter_user_id = $1', [userId]);
			await client.query('DELETE FROM logs WHERE nyaitter_id = $1', [String(userId)]);
			const result = await client.query('DELETE FROM users WHERE id = $1', [userId]);
			return result.rowCount > 0;
		});
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
		post.announcement = !!post.announcement;
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
