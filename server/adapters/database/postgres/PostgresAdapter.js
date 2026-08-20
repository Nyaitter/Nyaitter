'use strict';

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
	createAttachmentReplacementMap,
	rewriteAttachmentReferences,
} = require('../../../utils/attachmentKeys');
const {
	exportPostgresSnapshot,
	importPostgresSnapshot,
} = require('../../../services/DataMigrationSql');
const { normalizeSnapshot } = require('../../../services/DataMigrationService');

function parseJsonSafe(value, fallback = null) {
	if (value === null || value === undefined) return fallback;
	if (typeof value === 'object') return value;
	if (typeof value !== 'string') return fallback;
	try {
		return JSON.parse(value);
	} catch (_) {
		return fallback;
	}
}

function toIsoString(value, fallback = null) {
	if (value === null || value === undefined) return fallback;
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? fallback : value.toISOString();
	}
	if (typeof value === 'string') return value;
	return fallback;
}

function normalizeUserRow(row) {
	if (!row) return null;
	const id = Number(row.id);
	const rawBlock = parseJsonSafe(row.block, []);
	return {
		id,
		account_operation: row.account_operation || null,
		scid: row.scid || null,
		name: row.name || '',
		handle: row.handle || formatNyaitterId(id),
		nyaitter_address: row.nyaitter_address || null,
		auth_provider: row.auth_provider || 'local',
		provider_domain: row.provider_domain || null,
		external_id: row.external_id || null,
		external_profile: parseJsonSafe(row.external_profile, null),
		uuid: row.uuid || null,
		settings: parseJsonSafe(row.settings, {}),
		bio: row.bio || '',
		me: row.bio || '',
		header_image: row.header_image || null,
		icon_data: row.icon_data || null,
		verify: Boolean(row.verify),
		admin: Boolean(row.admin),
		freeze: row.freeze || null,
		shadow: Boolean(row.shadow),
		block: normalizeBlockList(rawBlock, id),
		created_at: toIsoString(row.created_at),
	};
}

function normalizePostTags(value) {
	const rawTags = parseJsonSafe(value, Array.isArray(value) ? value : []);
	if (!Array.isArray(rawTags)) return [];
	return [...new Set(rawTags
		.map((tag) => String(tag || '').trim().toLocaleLowerCase('ja-JP'))
		.filter((tag) => tag.length > 0 && tag.length <= 48))]
		.slice(0, 4);
}

function normalizePostRow(row) {
	if (!row) return null;
	const id = Number(row.id);
	const userId = Number(row.user_id ?? row.userId);
	const replyTo = row.reply_to ?? row.replyTo;
	const repostTo = row.repost_to ?? row.repostTo;
	const createdAt = toIsoString(row.created_at ?? row.createdAt);
	const tagsGeneratedAt = toIsoString(row.tags_generated_at ?? row.tagsGeneratedAt);
	const rawAttachments = parseJsonSafe(row.attachments, []);
	const attachments = Array.isArray(rawAttachments)
		? rawAttachments
		: (rawAttachments ? [rawAttachments] : []);
	const tags = normalizePostTags(row.tags);
	const groupId = row.group_id ?? row.groupId ?? null;
	const groupAnnouncement = Boolean(row.group_announcement ?? row.groupAnnouncement);

	return {
		id,
		userId,
		user_id: userId,
		content: row.content || '',
		tags,
		tagsGeneratedAt,
		tags_generated_at: tagsGeneratedAt,
		attachments,
		mask: Boolean(row.mask),
		lock: Boolean(row.lock),
		announcement: Boolean(row.announcement),
		groupId: groupId == null ? null : String(groupId),
		group_id: groupId == null ? null : String(groupId),
		groupAnnouncement,
		group_announcement: groupAnnouncement,
		replyTo: replyTo == null ? null : Number(replyTo),
		reply_to: replyTo == null ? null : Number(replyTo),
		repostTo: repostTo == null ? null : Number(repostTo),
		repost_to: repostTo == null ? null : Number(repostTo),
		createdAt,
		created_at: createdAt,
	};
}

function normalizeGroupRow(row) {
	if (!row) return null;
	const id = String(row.id);
	const ownerId = Number(row.owner_id ?? row.ownerId);
	const createdAt = toIsoString(row.created_at ?? row.createdAt);
	const updatedAt = toIsoString(row.updated_at ?? row.updatedAt);
	const deletedAt = toIsoString(row.deleted_at ?? row.deletedAt);
	return {
		id,
		ownerId,
		owner_id: ownerId,
		name: row.name || '',
		description: row.description || '',
		iconData: row.icon_data ?? row.iconData ?? null,
		icon_data: row.icon_data ?? row.iconData ?? null,
		headerImage: row.header_image ?? row.headerImage ?? null,
		header_image: row.header_image ?? row.headerImage ?? null,
		visibility: row.visibility || 'open',
		memberCount: Math.max(0, Number(row.member_count ?? row.memberCount) || 0),
		member_count: Math.max(0, Number(row.member_count ?? row.memberCount) || 0),
		createdAt,
		created_at: createdAt,
		updatedAt,
		updated_at: updatedAt,
		deletedAt,
		deleted_at: deletedAt,
	};
}

function normalizeGroupRoleRow(row) {
	if (!row) return null;
	const groupId = String(row.group_id ?? row.groupId);
	const permissions = parseJsonSafe(row.permissions, []);
	const createdAt = toIsoString(row.created_at ?? row.createdAt);
	const updatedAt = toIsoString(row.updated_at ?? row.updatedAt);
	return {
		id: String(row.id),
		groupId,
		group_id: groupId,
		name: row.name || '',
		permissions: Array.isArray(permissions) ? permissions.map(String) : [],
		isSystem: Boolean(row.is_system ?? row.isSystem),
		is_system: Boolean(row.is_system ?? row.isSystem),
		sortOrder: Number(row.sort_order ?? row.sortOrder) || 0,
		sort_order: Number(row.sort_order ?? row.sortOrder) || 0,
		createdAt,
		created_at: createdAt,
		updatedAt,
		updated_at: updatedAt,
	};
}

function normalizeGroupMembershipRow(row) {
	if (!row) return null;
	const groupId = String(row.group_id ?? row.groupId);
	const userId = Number(row.user_id ?? row.userId);
	const roleId = row.role_id ?? row.roleId ?? null;
	const joinedAt = toIsoString(row.joined_at ?? row.joinedAt);
	const updatedAt = toIsoString(row.updated_at ?? row.updatedAt);
	return {
		groupId,
		group_id: groupId,
		userId,
		user_id: userId,
		roleId: roleId == null ? null : String(roleId),
		role_id: roleId == null ? null : String(roleId),
		status: row.status || 'active',
		joinedAt,
		joined_at: joinedAt,
		updatedAt,
		updated_at: updatedAt,
	};
}

function normalizeGroupInviteRow(row) {
	if (!row) return null;
	const groupId = String(row.group_id ?? row.groupId);
	const inviterId = Number(row.inviter_id ?? row.inviterId);
	const inviteeId = Number(row.invitee_id ?? row.inviteeId);
	const createdAt = toIsoString(row.created_at ?? row.createdAt);
	const respondedAt = toIsoString(row.responded_at ?? row.respondedAt);
	return {
		id: String(row.id), groupId, group_id: groupId, inviterId, inviter_id: inviterId,
		inviteeId, invitee_id: inviteeId, status: row.status || 'pending',
		createdAt, created_at: createdAt, respondedAt, responded_at: respondedAt,
	};
}

function normalizeGroupJoinRequestRow(row) {
	if (!row) return null;
	const groupId = String(row.group_id ?? row.groupId);
	const userId = Number(row.user_id ?? row.userId);
	const reviewedBy = row.reviewed_by ?? row.reviewedBy ?? null;
	const createdAt = toIsoString(row.created_at ?? row.createdAt);
	const reviewedAt = toIsoString(row.reviewed_at ?? row.reviewedAt);
	return {
		id: String(row.id), groupId, group_id: groupId, userId, user_id: userId,
		status: row.status || 'pending',
		reviewedBy: reviewedBy == null ? null : Number(reviewedBy),
		reviewed_by: reviewedBy == null ? null : Number(reviewedBy),
		createdAt, created_at: createdAt, reviewedAt, reviewed_at: reviewedAt,
	};
}

function normalizeGroupDmRow(row, viewerId = null) {
	if (!row) return null;
	const member = parseJsonSafe(row.member, []);
	const unread = parseJsonSafe(row.unread, {});
	const post = parseJsonSafe(row.post, []);
	const time = toIsoString(row.time);
	const createdAt = toIsoString(row.created_at);

	const res = {
		id: String(row.id),
		host_id: Number(row.host_id ?? row.hostId),
		title: row.title || '',
		member: Array.isArray(member) ? member.map(Number).filter(Number.isInteger) : [],
		unread: typeof unread === 'object' && unread !== null ? unread : {},
		post: Array.isArray(post) ? post : [],
		time,
		created_at: createdAt,
	};
	if (viewerId != null) {
		res.unread_count = Number(res.unread[viewerId] ?? res.unread[String(viewerId)] ?? 0);
	}
	return res;
}

function normalizeModerationReportRow(row) {
	if (!row) return null;
	const excluded = parseJsonSafe(row.excluded_admin_ids ?? row.excludedAdminIds, []);
	const assignedAdminId = row.assigned_admin_id ?? row.assignedAdminId;
	return {
		id: Number(row.id),
		reporterUserId: Number(row.reporter_user_id ?? row.reporterUserId),
		targetKind: String(row.target_kind ?? row.targetKind),
		targetId: String(row.target_id ?? row.targetId),
		description: row.description || '',
		targetSnapshot: parseJsonSafe(row.target_snapshot ?? row.targetSnapshot, {}),
		assignmentType: String(row.assignment_type ?? row.assignmentType ?? 'report'),
		status: String(row.status || 'pending'),
		assignedAdminId: assignedAdminId == null ? null : Number(assignedAdminId),
		assignedAt: toIsoString(row.assigned_at ?? row.assignedAt),
		excludedAdminIds: Array.isArray(excluded) ? excluded.map(Number).filter(Number.isInteger) : [],
		resolution: parseJsonSafe(row.resolution, null),
		createdAt: toIsoString(row.created_at ?? row.createdAt),
		resolvedAt: toIsoString(row.resolved_at ?? row.resolvedAt),
	};
}

function mapSession(session) {
	if (!session) return null;
	const id = String(session.session_id || session.id);
	const userId = Number(session.user_id ?? session.userId);
	const expiresAt = toIsoString(session.expires_at || session.expiresAt);
	const createdAt = toIsoString(session.created_at || session.createdAt);
	const ipHash = session.ip_hash ?? session.ipHash ?? null;
	const ipMasked = session.ip_masked ?? session.ipMasked ?? '旧セッション';
	const userAgent = session.user_agent ?? session.userAgent ?? '不明な端末';

	return {
		id,
		session_id: id,
		token: session.token,
		userId,
		user_id: userId,
		expiresAt,
		expires_at: expiresAt,
		createdAt,
		created_at: createdAt,
		ipHash,
		ip_hash: ipHash,
		ipMasked,
		ip_masked: ipMasked,
		userAgent,
		user_agent: userAgent,
	};
}

function mapLoginApproval(approval) {
	if (!approval) return null;
	return {
		id: String(approval.id),
		userId: Number(approval.user_id ?? approval.userId),
		ipHash: approval.ip_hash ?? approval.ipHash ?? null,
		ipMasked: approval.ip_masked ?? approval.ipMasked ?? '不明なIPアドレス',
		userAgent: approval.user_agent ?? approval.userAgent ?? '不明な端末',
		pollTokenHash: String(approval.poll_token_hash ?? approval.pollTokenHash ?? ''),
		status: String(approval.status || 'pending'),
		createdAt: toIsoString(approval.created_at ?? approval.createdAt),
		expiresAt: toIsoString(approval.expires_at ?? approval.expiresAt),
		decidedAt: toIsoString(approval.decided_at ?? approval.decidedAt),
		consumedAt: toIsoString(approval.consumed_at ?? approval.consumedAt),
	};
}

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

		const poolMax = Math.max(1, Number(this.config.poolSize) || 10);
		const poolMin = Math.min(poolMax, Math.max(1, Number(this.config.poolMin) || 2));
		const poolOptions = {
			connectionString,
			max: poolMax,
			min: poolMin,
			idleTimeoutMillis: this.config.poolIdleTimeoutMs || 300000,
			connectionTimeoutMillis: this.config.connectionTimeoutMs || 15000,
			maxLifetimeSeconds: this.config.poolMaxLifetimeSeconds || 1800,
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
		const warmupClients = [];
		try {
			client = await this.pool.connect();
			await client.query('SELECT 1');
			client.release();
			client = null;

			await Promise.all(Array.from({ length: poolMin }, async () => {
				const warmupClient = await this.pool.connect();
				warmupClients.push(warmupClient);
			}));
			for (const warmupClient of warmupClients.splice(0)) warmupClient.release();
		} catch (error) {
			await this.pool.end();
			this.pool = null;
			if (['EAI_AGAIN', 'ENOTFOUND'].includes(error?.code)) {
				throw new Error(`PostgreSQL host "${error.hostname || 'unknown'}" could not be resolved. Check DATABASE_URL and set the complete database connection URL, not a name such as "base".`);
			}
			throw error;
		} finally {
			client?.release();
			for (const warmupClient of warmupClients.splice(0)) warmupClient.release();
		}

		console.log(`[PostgresAdapter] Connected to PostgreSQL (pool ${poolMin}-${poolMax})`);
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
						// Ignored to preserve original error
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
		return normalizeUserRow(user);
	}

	_normalizePost(post) {
		return normalizePostRow(post);
	}

	// ==================== User Methods ====================

	async getUserByScid(scid) {
		if (!scid) return null;
		const { rows } = await this.pool.query(
			'SELECT * FROM users WHERE LOWER(scid) = LOWER($1) LIMIT 1',
			[String(scid)],
		);
		return normalizeUserRow(rows[0]);
	}

	async getUserById(id) {
		if (id == null) return null;
		const { rows } = await this.pool.query(
			'SELECT * FROM users WHERE id = $1 LIMIT 1',
			[Number(id)],
		);
		return normalizeUserRow(rows[0]);
	}

	async getUserByNyaitterAddress(address) {
		if (!address) return null;
		const { rows } = await this.pool.query(
			'SELECT * FROM users WHERE nyaitter_address = $1 LIMIT 1',
			[String(address)],
		);
		return normalizeUserRow(rows[0]);
	}

	async getOrCreateExternalUser({ providerDomain, externalId, profile = {} }) {
		const address = buildExternalNyaitterAddress(externalId, providerDomain);

		const user = await this.getUserByNyaitterAddress(address);
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
			block: profile.block || [],
		});
	}

	async createUser(userData) {
		const provider = userData.auth_provider || 'local';
		const now = new Date().toISOString();

		for (let attempt = 0; attempt < 20; attempt += 1) {
			const countResult = await this.pool.query('SELECT COUNT(*)::bigint AS count FROM users');
			const count = Number(countResult.rows[0].count);
			const digits = Math.max(4, String(Math.max(count, 1)).length);
			const id = Math.floor(Math.random() * (10 ** digits));
			const handle = provider === 'nyaitter' && userData.external_id != null
				? formatNyaitterId(userData.external_id)
				: formatNyaitterId(id);

			const address = userData.nyaitter_address || null;
			try {
				const { rows } = await this.pool.query(
					`INSERT INTO users (id, scid, name, handle, nyaitter_address, auth_provider, provider_domain, external_id, external_profile, uuid, settings, "block", bio, header_image, icon_data, created_at)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb, $12::jsonb, $13, $14, $15, $16) RETURNING *`,
					[
						id,
						userData.scid || null,
						userData.name || userData.scid || handle,
						handle,
						address,
						provider,
						userData.provider_domain || null,
						userData.external_id || null,
						userData.external_profile ? JSON.stringify(userData.external_profile) : null,
						userData.uuid || null,
						userData.settings ? JSON.stringify(userData.settings) : '{}',
						JSON.stringify(normalizeBlockList(userData.block, id)),
						userData.bio || userData.me || '',
						userData.header_image || null,
						userData.icon_data || null,
						now,
					],
				);
				return normalizeUserRow(rows[0]);
			} catch (error) {
				if (error.code === '23505') continue;
				throw error;
			}
		}
		throw new Error('Could not allocate a unique Nyaitter ID');
	}

	async searchUsers(query, limit = 20, offset = 0) {
		const q = String(query || '').trim();
		const queryPattern = `%${q.toLowerCase()}%`;
		const digits = q.replace(/^#/, '').replace(/\D/g, '');
		const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
		const safeOffset = Math.max(Number(offset) || 0, 0);

		const { rows } = await this.pool.query(
			`SELECT id, name, scid, handle, nyaitter_address, auth_provider, provider_domain, external_id, icon_data
			 FROM users
			 WHERE LOWER(COALESCE(scid, '')) LIKE $1
				OR LOWER(COALESCE(name, '')) LIKE $1
				OR LOWER(COALESCE(handle, '')) LIKE $1
				OR CAST(id AS TEXT) LIKE $4
			 ORDER BY id DESC LIMIT $2 OFFSET $3`,
			[queryPattern, safeLimit, safeOffset, digits ? `%${digits}%` : queryPattern],
		);
		return rows.map(normalizeUserRow);
	}

	async getUsersByIds(userIds) {
		const ids = [...new Set((userIds || []).map(Number).filter(Number.isSafeInteger))];
		if (ids.length === 0) return [];
		const { rows } = await this.pool.query(
			'SELECT * FROM users WHERE id = ANY($1::int[])',
			[ids],
		);
		return rows.map(normalizeUserRow);
	}

	async getAllUsers() {
		const { rows } = await this.pool.query('SELECT * FROM users ORDER BY id ASC');
		return rows.map(normalizeUserRow);
	}

	async getRecommendedUsers(limit = 3, excludedUserId = null) {
		const normalizedLimit = Math.min(Math.max(Number(limit) || 3, 1), 100);
		const values = [normalizedLimit];
		const exclusion = excludedUserId != null && Number.isSafeInteger(Number(excludedUserId))
			? `WHERE id <> $${values.push(Number(excludedUserId))}`
			: '';
		const { rows } = await this.pool.query(
			`SELECT id, name, scid, icon_data, admin, verify,
				auth_provider, provider_domain, external_id, bio, created_at
			 FROM users
			 ${exclusion}
			 ORDER BY created_at DESC, id ASC
			 LIMIT $1`,
			values,
		);
		return rows.map(normalizeUserRow);
	}

	async getUserStatus(userId) {
		const { rows } = await this.pool.query(
			'SELECT shadow FROM users WHERE id = $1',
			[Number(userId)],
		);
		if (!rows[0]) return null;
		return { shadow: Boolean(rows[0].shadow) };
	}

	async setUserStatus(userId, status) {
		const shadow = Boolean(status && status.shadow);
		const { rows } = await this.pool.query(
			'UPDATE users SET shadow = $2 WHERE id = $1 RETURNING shadow',
			[Number(userId), shadow],
		);
		if (!rows[0]) return null;
		return { shadow: Boolean(rows[0].shadow) };
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
			fields.push(`settings = $${idx++}::jsonb`);
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
		if (fields.length === 0) return this.getUserById(userId);

		values.push(Number(userId));
		const { rows } = await this.pool.query(
			`UPDATE users SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
			values,
		);
		return normalizeUserRow(rows[0]);
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
			[Number(userId), operation],
		);
		return normalizeUserRow(rows[0] || null);
	}

	async finishAccountOperation(userId, operation) {
		const { rows } = await this.pool.query(
			`UPDATE users SET account_operation = NULL
			 WHERE id = $1 AND account_operation = $2
			 RETURNING *`,
			[Number(userId), operation],
		);
		return normalizeUserRow(rows[0] || null);
	}

	async reassignUserId(userId) {
		return this._withTransaction(async (client) => {
			const { rows: userRows } = await client.query(
				`SELECT * FROM users
				 WHERE id = $1 AND auth_provider <> 'nyaitter' AND account_operation = 'reassigning'
				 FOR UPDATE`,
				[Number(userId)],
			);
			const user = userRows[0];
			if (!user) return null;

			const previousId = Number(user.id);
			const { rows: countRows } = await client.query('SELECT COUNT(*)::bigint AS count FROM users');
			const digits = Math.max(4, String(Math.max(Number(countRows[0]?.count) || 1, 1)).length);
			const upperBound = 10 ** digits;
			let nextId = null;
			for (let attempt = 0; attempt < 100; attempt += 1) {
				const candidate = Math.floor(Math.random() * upperBound);
				if (candidate === previousId) continue;
				const { rows } = await client.query('SELECT 1 FROM users WHERE id = $1 LIMIT 1', [candidate]);
				if (rows.length === 0) {
					nextId = candidate;
					break;
				}
			}
			if (nextId == null) throw new Error('Could not allocate a unique Nyaitter ID');

			// Simple foreign keys
			await client.query('UPDATE sessions SET user_id = $2 WHERE user_id = $1', [previousId, nextId]);
			await client.query('UPDATE trusted_login_ips SET user_id = $2 WHERE user_id = $1', [previousId, nextId]);
			await client.query('UPDATE login_approvals SET user_id = $2 WHERE user_id = $1', [previousId, nextId]);
			await client.query('UPDATE bot_tokens SET user_id = $2 WHERE user_id = $1', [previousId, nextId]);
			await client.query('UPDATE posts SET user_id = $2 WHERE user_id = $1', [previousId, nextId]);
			await client.query('UPDATE likes SET user_id = $2 WHERE user_id = $1', [previousId, nextId]);
			await client.query('UPDATE stars SET user_id = $2 WHERE user_id = $1', [previousId, nextId]);
			await client.query('UPDATE reposts SET user_id = $2 WHERE user_id = $1', [previousId, nextId]);
			await client.query('UPDATE pinned_posts SET user_id = $2 WHERE user_id = $1', [previousId, nextId]);
			await client.query('UPDATE dm_messages SET sender_id = $2 WHERE sender_id = $1', [previousId, nextId]);
			await client.query('UPDATE follows SET follower_id = $2 WHERE follower_id = $1', [previousId, nextId]);
			await client.query('UPDATE follows SET following_id = $2 WHERE following_id = $1', [previousId, nextId]);
			await client.query('UPDATE dm_e2e_keys SET user_id = $2 WHERE user_id = $1', [previousId, nextId]);
			await client.query('UPDATE notifications SET user_id = $2 WHERE user_id = $1', [previousId, nextId]);
			await client.query('UPDATE notifications SET from_user_id = $2 WHERE from_user_id = $1', [previousId, nextId]);
			await client.query('UPDATE push_subscriptions SET user_id = $2 WHERE user_id = $1', [previousId, nextId]);
			await client.query('UPDATE moderation_reports SET reporter_user_id = $2 WHERE reporter_user_id = $1', [previousId, nextId]);
			await client.query('UPDATE moderation_reports SET assigned_admin_id = $2 WHERE assigned_admin_id = $1', [previousId, nextId]);
			await client.query('UPDATE logs SET nyaitter_id = $2 WHERE nyaitter_id = $1', [previousId, nextId]);

			// dm_channels participants
			const { rows: channels } = await client.query(
				'SELECT id, participants FROM dm_channels WHERE $1 = ANY(participants)',
				[previousId],
			);
			for (const channel of channels) {
				const participants = (channel.participants || []).map((id) => (Number(id) === previousId ? nextId : Number(id)));
				await client.query('UPDATE dm_channels SET participants = $2::int[] WHERE id = $1', [channel.id, participants]);
			}

			// group_dms
			const { rows: groups } = await client.query(
				'SELECT id, host_id, member, post, unread FROM group_dms WHERE host_id = $1 OR $1 = ANY(member)',
				[previousId],
			);
			for (const group of groups) {
				const member = (group.member || []).map((id) => (Number(id) === previousId ? nextId : Number(id)));
				const rawPost = Array.isArray(group.post) ? group.post : parseJsonSafe(group.post, []);
				const post = rawPost.map((msg) => (
					Number(msg?.userid) === previousId ? { ...msg, userid: nextId } : msg
				));
				const unread = { ...(typeof group.unread === 'object' && group.unread !== null ? group.unread : parseJsonSafe(group.unread, {})) };
				if (Object.prototype.hasOwnProperty.call(unread, String(previousId))) {
					unread[String(nextId)] = unread[String(previousId)];
					delete unread[String(previousId)];
				}
				const hostId = Number(group.host_id) === previousId ? nextId : Number(group.host_id);
				await client.query(
					'UPDATE group_dms SET host_id = $2, member = $3::int[], post = $4::jsonb, unread = $5::jsonb WHERE id = $1',
					[group.id, hostId, member, JSON.stringify(post), JSON.stringify(unread)],
				);
			}

			// blocked users
			const { rows: blockedUsers } = await client.query(
				'SELECT id, "block" FROM users WHERE "block" @> $1::jsonb',
				[JSON.stringify([previousId])],
			);
			for (const bu of blockedUsers) {
				const rawBlock = Array.isArray(bu.block) ? bu.block : parseJsonSafe(bu.block, []);
				const block = normalizeBlockList(rawBlock.map((id) => (Number(id) === previousId ? nextId : id)), bu.id);
				await client.query('UPDATE users SET "block" = $2::jsonb WHERE id = $1', [bu.id, JSON.stringify(block)]);
			}

			// notifications target
			const { rows: notifs } = await client.query(
				"SELECT id, target FROM notifications WHERE target->>'kind' = 'user' AND target->>'id' = $1",
				[String(previousId)],
			);
			for (const notif of notifs) {
				const target = typeof notif.target === 'object' && notif.target !== null ? notif.target : parseJsonSafe(notif.target, {});
				target.id = nextId;
				await client.query('UPDATE notifications SET target = $2::jsonb WHERE id = $1', [notif.id, JSON.stringify(target)]);
			}

			// moderation reports snapshot
			const { rows: reportRows } = await client.query('SELECT id, target_kind, target_id, target_snapshot, excluded_admin_ids FROM moderation_reports FOR UPDATE');
			for (const report of reportRows) {
				const rawSnapshot = typeof report.target_snapshot === 'object' && report.target_snapshot !== null ? report.target_snapshot : parseJsonSafe(report.target_snapshot, {});
				const { snapshot, changed } = this._reassignReportSnapshotUserIds(rawSnapshot, previousId, nextId);
				const targetId = report.target_kind === 'user' && String(report.target_id) === String(previousId)
					? String(nextId)
					: report.target_id;
				const rawExcluded = Array.isArray(report.excluded_admin_ids) ? report.excluded_admin_ids : parseJsonSafe(report.excluded_admin_ids, []);
				const excluded = rawExcluded.map((id) => (Number(id) === previousId ? nextId : Number(id)));
				const excludedChanged = excluded.some((id, index) => Number(id) !== Number(rawExcluded[index]));
				if (!changed && targetId === report.target_id && !excludedChanged) continue;
				await client.query(
					'UPDATE moderation_reports SET target_id = $2, target_snapshot = $3::jsonb, excluded_admin_ids = $4::jsonb WHERE id = $1',
					[report.id, targetId, JSON.stringify(snapshot || {}), JSON.stringify(excluded || [])],
				);
			}

			const { rows } = await client.query(
				`UPDATE users
				 SET id = $2, handle = $3
				 WHERE id = $1
				 RETURNING *`,
				[previousId, nextId, formatNyaitterId(nextId)],
			);
			return normalizeUserRow(rows[0] || null);
		});
	}

	async deleteAccount(userId) {
		return this._withTransaction(async (client) => {
			const { rows: userRows } = await client.query(
				`SELECT id FROM users WHERE id = $1 AND account_operation = 'deleting' FOR UPDATE`,
				[Number(userId)],
			);
			if (!userRows[0]) return false;

			const { rows: postRows } = await client.query('SELECT id FROM posts WHERE user_id = $1', [userId]);
			const postIds = postRows.map((row) => Number(row.id));
			if (postIds.length > 0) {
				await client.query('UPDATE posts SET reply_to = NULL WHERE reply_to = ANY($1::int[])', [postIds]);
				await client.query('UPDATE posts SET repost_to = NULL WHERE repost_to = ANY($1::int[])', [postIds]);
			}

			const { rows: channelRows } = await client.query(
				`SELECT id, participants FROM dm_channels WHERE $1::int = ANY(participants) FOR UPDATE`,
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
					 WHERE host_id = $1 OR $1::int = ANY(member)
					 FOR UPDATE`,
				[userId],
			);
			for (const group of groupRows) {
				const members = (group.member || []).map(Number).filter((id) => id !== Number(userId));
				if (members.length === 0) {
					await client.query('DELETE FROM group_dms WHERE id = $1', [group.id]);
					continue;
				}
				const rawPost = Array.isArray(group.post) ? group.post : parseJsonSafe(group.post, []);
				const messages = rawPost.filter((message) => Number(message?.userid) !== Number(userId));
				const unread = { ...(typeof group.unread === 'object' && group.unread !== null ? group.unread : parseJsonSafe(group.unread, {})) };
				delete unread[String(userId)];
				const hostId = Number(group.host_id) === Number(userId) ? members[0] : Number(group.host_id);
				await client.query(
					`UPDATE group_dms
					 SET host_id = $2, member = $3::int[], post = $4::jsonb, unread = $5::jsonb
					 WHERE id = $1`,
					[group.id, hostId, members, JSON.stringify(messages), JSON.stringify(unread)],
				);
			}

			const { rows: blockedUsers } = await client.query(
				'SELECT id, "block" FROM users WHERE "block" @> $1::jsonb',
				[JSON.stringify([Number(userId)])],
			);
			for (const bu of blockedUsers) {
				const rawBlock = Array.isArray(bu.block) ? bu.block : parseJsonSafe(bu.block, []);
				const block = normalizeBlockList(rawBlock.filter((id) => Number(id) !== Number(userId)), bu.id);
				await client.query('UPDATE users SET "block" = $2::jsonb WHERE id = $1', [bu.id, JSON.stringify(block)]);
			}

			await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
			await client.query('DELETE FROM bot_tokens WHERE user_id = $1', [userId]);
			await client.query('DELETE FROM trusted_login_ips WHERE user_id = $1', [userId]);
			await client.query('DELETE FROM login_approvals WHERE user_id = $1', [userId]);
			await client.query('DELETE FROM push_subscriptions WHERE user_id = $1', [userId]);
			await client.query('DELETE FROM moderation_reports WHERE reporter_user_id = $1', [userId]);
			await client.query('DELETE FROM logs WHERE nyaitter_id = $1', [Number(userId)]);
			const result = await client.query('DELETE FROM users WHERE id = $1', [userId]);
			return result.rowCount > 0;
		});
	}

	async getAccountAttachmentKeys(userId) {
		const { rows } = await this.pool.query(
			'SELECT attachments FROM posts WHERE user_id = $1',
			[Number(userId)],
		);
		const keys = new Set();
		for (const row of rows) {
			const attachments = Array.isArray(row.attachments) ? row.attachments : parseJsonSafe(row.attachments, []);
			for (const attachment of attachments) {
				const key = attachment?.id || attachment?.key;
				if (typeof key === 'string' && key.startsWith('attachments/')) keys.add(key);
			}
		}
		return [...keys];
	}

	async rewriteAccountAttachmentKeys(userId, replacements) {
		const replacementMap = createAttachmentReplacementMap(replacements);
		if (replacementMap.size === 0) return 0;
		return this._withTransaction(async (client) => {
			const { rows } = await client.query(
				'SELECT id, attachments FROM posts WHERE user_id = $1 FOR UPDATE',
				[Number(userId)],
			);
			let updatedCount = 0;
			for (const row of rows) {
				const rawAttachments = Array.isArray(row.attachments) ? row.attachments : parseJsonSafe(row.attachments, []);
				const { attachments, changed } = rewriteAttachmentReferences(rawAttachments, replacementMap);
				if (!changed) continue;
				await client.query(
					'UPDATE posts SET attachments = $2::jsonb WHERE id = $1',
					[row.id, JSON.stringify(attachments)],
				);
				updatedCount += 1;
			}
			return updatedCount;
		});
	}

	// ==================== Sessions ====================

	async createSession(userId, meta = {}) {
		const token = typeof meta.token === 'string' && meta.token
			? meta.token
			: crypto.randomBytes(appConfig.auth.sessionTokenBytes).toString('hex');
		const sessionId = typeof meta.sessionId === 'string' && meta.sessionId
			? meta.sessionId
			: crypto.randomBytes(16).toString('base64url');
		const expiresAt = meta.expiresAt
			? toIsoString(meta.expiresAt)
			: new Date(Date.now() + appConfig.auth.sessionExpiryDays * 24 * 60 * 60 * 1000).toISOString();
		const createdAt = new Date().toISOString();
		const ipHash = meta.ipHash || null;
		const ipMasked = meta.ipMasked || '不明なIPアドレス';
		const userAgent = meta.userAgent || '不明な端末';

		const { rows } = await this.pool.query(
			`INSERT INTO sessions (session_id, token, user_id, expires_at, created_at, ip_hash, ip_masked, user_agent)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			 RETURNING *`,
			[sessionId, token, Number(userId), expiresAt, createdAt, ipHash, ipMasked, userAgent],
		);
		return mapSession(rows[0]);
	}

	async getSessionByToken(token) {
		if (!token) return null;
		const now = new Date().toISOString();
		const { rows } = await this.pool.query(
			`SELECT * FROM sessions WHERE token = $1 AND expires_at > $2 LIMIT 1`,
			[String(token), now],
		);
		if (!rows[0]) {
			await this.pool.query('DELETE FROM sessions WHERE token = $1 AND expires_at <= $2', [String(token), now]);
			return null;
		}
		return mapSession(rows[0]);
	}

	async getUserBySessionToken(token) {
		if (!token) return null;
		const now = new Date().toISOString();
		const { rows } = await this.pool.query(
			`SELECT u.*
			 FROM sessions AS s
			 INNER JOIN users AS u ON u.id = s.user_id
			 WHERE s.token = $1 AND s.expires_at > $2
			 LIMIT 1`,
			[String(token), now],
		);
		if (!rows[0]) {
			await this.pool.query('DELETE FROM sessions WHERE token = $1 AND expires_at <= $2', [String(token), now]);
			return null;
		}
		return normalizeUserRow(rows[0]);
	}

	async invalidateSession(token) {
		if (!token) return false;
		const { rowCount } = await this.pool.query('DELETE FROM sessions WHERE token = $1', [String(token)]);
		return rowCount > 0;
	}

	async invalidateUserSessionById(userId, sessionId) {
		const now = new Date().toISOString();
		const { rows } = await this.pool.query(
			`DELETE FROM sessions
			 WHERE user_id = $1 AND session_id = $2 AND expires_at > $3
			 RETURNING token`,
			[Number(userId), String(sessionId), now],
		);
		return rows[0]?.token || null;
	}

	async revokeUserSessionsBySessionId(userId, sessionId) {
		return this._withTransaction(async (client) => {
			const now = new Date().toISOString();
			const { rows: targetRows } = await client.query(
				`SELECT ip_hash FROM sessions WHERE user_id = $1 AND session_id = $2 AND expires_at > $3`,
				[Number(userId), String(sessionId), now],
			);
			const target = targetRows[0];
			if (!target) {
				return { found: false, ipHash: null, tokens: [], invalidated: 0, trustRevoked: false };
			}
			const ipHash = target.ip_hash;
			let trustRevoked = false;
			let tokens = [];
			let invalidated = 0;

			if (ipHash) {
				const revokedResult = await client.query(
					'DELETE FROM trusted_login_ips WHERE user_id = $1 AND ip_hash = $2',
					[Number(userId), ipHash],
				);
				trustRevoked = revokedResult.rowCount > 0;

				const invalidatedResult = await client.query(
					'DELETE FROM sessions WHERE user_id = $1 AND ip_hash = $2 RETURNING token',
					[Number(userId), ipHash],
				);
				tokens = invalidatedResult.rows.map((r) => r.token);
				invalidated = invalidatedResult.rowCount;
			} else {
				const singleDel = await client.query(
					'DELETE FROM sessions WHERE user_id = $1 AND session_id = $2 RETURNING token',
					[Number(userId), String(sessionId)],
				);
				tokens = singleDel.rows.map((r) => r.token);
				invalidated = singleDel.rowCount;
			}

			return {
				found: true,
				ipHash,
				tokens,
				invalidated,
				trustRevoked,
			};
		});
	}

	async getUserSessions(userId) {
		const now = new Date().toISOString();
		const { rows } = await this.pool.query(
			`SELECT * FROM sessions WHERE user_id = $1 AND expires_at > $2 ORDER BY created_at DESC`,
			[Number(userId), now],
		);
		return rows.map(mapSession);
	}

	async invalidateAllSessions(userId) {
		const { rowCount } = await this.pool.query('DELETE FROM sessions WHERE user_id = $1', [Number(userId)]);
		return Number(rowCount || 0);
	}

	async invalidateSessionsByIp(userId, ipHash) {
		const { rowCount } = await this.pool.query(
			'DELETE FROM sessions WHERE user_id = $1 AND ip_hash = $2',
			[Number(userId), String(ipHash)],
		);
		return Number(rowCount || 0);
	}

	// ==================== Trusted Login IPs ====================

	async trustLoginIp(userId, { ipHash, ipMasked }) {
		const now = new Date().toISOString();
		const { rows } = await this.pool.query(
			`INSERT INTO trusted_login_ips (user_id, ip_hash, ip_masked, created_at, last_used_at)
			 VALUES ($1, $2, $3, $4, $4)
			 ON CONFLICT (user_id, ip_hash) DO UPDATE SET ip_masked = EXCLUDED.ip_masked, last_used_at = EXCLUDED.last_used_at
			 RETURNING *`,
			[Number(userId), String(ipHash), ipMasked || '不明なIPアドレス', now],
		);
		return {
			userId: Number(rows[0].user_id),
			ipHash: rows[0].ip_hash,
			ipMasked: rows[0].ip_masked,
			createdAt: toIsoString(rows[0].created_at),
			lastUsedAt: toIsoString(rows[0].last_used_at),
		};
	}

	async getTrustedLoginIp(userId, ipHash) {
		const { rows } = await this.pool.query(
			'SELECT * FROM trusted_login_ips WHERE user_id = $1 AND ip_hash = $2',
			[Number(userId), String(ipHash)],
		);
		if (!rows[0]) return null;
		return {
			userId: Number(rows[0].user_id),
			ipHash: rows[0].ip_hash,
			ipMasked: rows[0].ip_masked,
			createdAt: toIsoString(rows[0].created_at),
			lastUsedAt: toIsoString(rows[0].last_used_at),
		};
	}

	async countTrustedLoginIps(userId) {
		const { rows } = await this.pool.query(
			'SELECT COUNT(*)::int AS count FROM trusted_login_ips WHERE user_id = $1',
			[Number(userId)],
		);
		return Number(rows[0]?.count || 0);
	}

	async revokeTrustedLoginIp(userId, ipHash) {
		const { rowCount } = await this.pool.query(
			'DELETE FROM trusted_login_ips WHERE user_id = $1 AND ip_hash = $2',
			[Number(userId), String(ipHash)],
		);
		return rowCount > 0;
	}

	// ==================== Login Approvals ====================

	async createLoginApproval(approvalData) {
		const id = approvalData.id || crypto.randomUUID();
		const now = new Date().toISOString();
		const expiresAt = approvalData.expiresAt ? toIsoString(approvalData.expiresAt) : new Date(Date.now() + 10 * 60000).toISOString();
		const { rows } = await this.pool.query(
			`INSERT INTO login_approvals (id, user_id, ip_hash, ip_masked, user_agent, poll_token_hash, status, expires_at, created_at)
			 VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)
			 RETURNING *`,
			[
				id,
				Number(approvalData.userId),
				approvalData.ipHash || null,
				approvalData.ipMasked || '不明なIPアドレス',
				approvalData.userAgent || '不明な端末',
				String(approvalData.pollTokenHash),
				expiresAt,
				now,
			],
		);
		return mapLoginApproval(rows[0]);
	}

	async getLoginApproval(id) {
		if (!id) return null;
		const now = new Date().toISOString();
		await this.pool.query(
			"UPDATE login_approvals SET status = 'expired' WHERE id = $1 AND status = 'pending' AND expires_at <= $2",
			[String(id), now],
		);
		const { rows } = await this.pool.query('SELECT * FROM login_approvals WHERE id = $1', [String(id)]);
		return mapLoginApproval(rows[0]);
	}

	async getLoginApprovalByPollToken(id, pollTokenHash) {
		if (!id || !pollTokenHash) return null;
		const now = new Date().toISOString();
		await this.pool.query(
			"UPDATE login_approvals SET status = 'expired' WHERE id = $1 AND status = 'pending' AND expires_at <= $2",
			[String(id), now],
		);
		const { rows } = await this.pool.query(
			'SELECT * FROM login_approvals WHERE id = $1 AND poll_token_hash = $2',
			[String(id), String(pollTokenHash)],
		);
		return mapLoginApproval(rows[0]);
	}

	async decideLoginApproval(userId, id, decision) {
		const status = decision === 'approve' ? 'approved' : 'denied';
		const now = new Date().toISOString();
		const { rows } = await this.pool.query(
			`UPDATE login_approvals SET status = $3, decided_at = $4
			 WHERE id = $1 AND user_id = $2 AND status = 'pending' AND expires_at > $4
			 RETURNING *`,
			[String(id), Number(userId), status, now],
		);
		if (rows[0]) return mapLoginApproval(rows[0]);
		const existing = await this.getLoginApproval(id);
		return existing && Number(existing.userId) === Number(userId) ? existing : null;
	}

	async consumeLoginApproval(id, pollTokenHash) {
		const now = new Date().toISOString();
		const { rows } = await this.pool.query(
			`UPDATE login_approvals SET status = 'consumed', consumed_at = $3
			 WHERE id = $1 AND poll_token_hash = $2 AND status = 'approved' AND expires_at > $3
			 RETURNING *`,
			[String(id), String(pollTokenHash), now],
		);
		return mapLoginApproval(rows[0]);
	}

	// ==================== Bot Tokens ====================

	async createBotToken(userId, tokenId, tokenHash, name) {
		const now = new Date().toISOString();
		const { rows } = await this.pool.query(
			`INSERT INTO bot_tokens (token_id, user_id, token_hash, name, created_at)
			 VALUES ($1, $2, $3, $4, $5)
			 RETURNING *`,
			[String(tokenId), Number(userId), String(tokenHash), String(name || ''), now],
		);
		return {
			tokenId: rows[0].token_id,
			userId: Number(rows[0].user_id),
			tokenHash: rows[0].token_hash,
			name: rows[0].name,
			createdAt: toIsoString(rows[0].created_at),
			lastUsedAt: toIsoString(rows[0].last_used_at),
		};
	}

	async getBotTokenById(tokenId) {
		if (!tokenId) return null;
		const { rows } = await this.pool.query(
			'SELECT * FROM bot_tokens WHERE token_id = $1',
			[String(tokenId)],
		);
		if (!rows[0]) return null;
		return {
			tokenId: rows[0].token_id,
			userId: Number(rows[0].user_id),
			tokenHash: rows[0].token_hash,
			name: rows[0].name,
			createdAt: toIsoString(rows[0].created_at),
			lastUsedAt: toIsoString(rows[0].last_used_at),
		};
	}

	async getUserBotTokens(userId) {
		const { rows } = await this.pool.query(
			'SELECT token_id, name, created_at, last_used_at FROM bot_tokens WHERE user_id = $1 ORDER BY created_at DESC',
			[Number(userId)],
		);
		return rows.map((r) => ({
			tokenId: r.token_id,
			name: r.name,
			createdAt: toIsoString(r.created_at),
			lastUsedAt: toIsoString(r.last_used_at),
		}));
	}

	async revokeBotToken(userId, tokenId) {
		const { rowCount } = await this.pool.query(
			'DELETE FROM bot_tokens WHERE user_id = $1 AND token_id = $2',
			[Number(userId), String(tokenId)],
		);
		return rowCount > 0;
	}

	async updateBotTokenLastUsed(tokenId) {
		if (!tokenId) return;
		const now = new Date().toISOString();
		await this.pool.query(
			'UPDATE bot_tokens SET last_used_at = $2 WHERE token_id = $1',
			[String(tokenId), now],
		);
	}

	// ==================== Groups ====================

	async createGroup(groupData) {
		const now = groupData.createdAt ? toIsoString(groupData.createdAt) : new Date().toISOString();
		const { rows } = await this.pool.query(
			`INSERT INTO groups (id, owner_id, name, description, icon_data, header_image, visibility, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING *`,
			[
				String(groupData.id), Number(groupData.ownerId), String(groupData.name || ''),
				String(groupData.description || ''), groupData.iconData ?? null, groupData.headerImage ?? null,
				String(groupData.visibility || 'open'), now,
			],
		);
		return normalizeGroupRow(rows[0] || null);
	}

	async getGroupById(groupId) {
		const { rows } = await this.pool.query(
			`SELECT g.*, (
				SELECT COUNT(*)::int FROM group_memberships gm
				WHERE gm.group_id = g.id AND gm.status = 'active'
			) AS member_count
			FROM groups g WHERE g.id = $1 AND g.deleted_at IS NULL LIMIT 1`,
			[String(groupId)],
		);
		return normalizeGroupRow(rows[0] || null);
	}

	async updateGroup(groupId, fields) {
		const fieldMap = {
			name: 'name', description: 'description', iconData: 'icon_data', icon_data: 'icon_data',
			headerImage: 'header_image', header_image: 'header_image', visibility: 'visibility',
		};
		const sets = [];
		const values = [];
		const assigned = new Set();
		for (const [key, column] of Object.entries(fieldMap)) {
			if (fields[key] === undefined || assigned.has(column)) continue;
			assigned.add(column);
			values.push(fields[key] == null && ['icon_data', 'header_image'].includes(column) ? null : String(fields[key]));
			sets.push(`${column} = $${values.length}`);
		}
		if (sets.length === 0) return this.getGroupById(groupId);
		sets.push(`updated_at = NOW()`);
		values.push(String(groupId));
		const { rows } = await this.pool.query(
			`UPDATE groups SET ${sets.join(', ')} WHERE id = $${values.length} AND deleted_at IS NULL RETURNING *`,
			values,
		);
		return normalizeGroupRow(rows[0] || null);
	}

	async deleteGroup(groupId) {
		return this._withTransaction(async (client) => {
			const normalizedGroupId = String(groupId);
			const { rows } = await client.query(
				`UPDATE groups SET deleted_at = NOW(), updated_at = NOW()
				 WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
				[normalizedGroupId],
			);
			if (!rows[0]) return null;

			const { rows: postRows } = await client.query(
				'SELECT id FROM posts WHERE group_id = $1 FOR UPDATE',
				[normalizedGroupId],
			);
			const postIds = postRows.map((post) => Number(post.id));
			if (postIds.length > 0) {
				await client.query('UPDATE posts SET reply_to = NULL WHERE reply_to = ANY($1::int[])', [postIds]);
				await client.query('UPDATE posts SET repost_to = NULL WHERE repost_to = ANY($1::int[])', [postIds]);
				await client.query('DELETE FROM likes WHERE post_id = ANY($1::int[])', [postIds]);
				await client.query('DELETE FROM stars WHERE post_id = ANY($1::int[])', [postIds]);
				await client.query('DELETE FROM reposts WHERE post_id = ANY($1::int[])', [postIds]);
				await client.query('DELETE FROM pinned_posts WHERE post_id = ANY($1::int[])', [postIds]);
				await client.query('DELETE FROM posts WHERE id = ANY($1::int[])', [postIds]);
			}

			return normalizeGroupRow(rows[0]);
		});
	}

	async transferGroupOwnership(groupId, newOwnerId) {
		const { rows } = await this.pool.query(
			`UPDATE groups SET owner_id = $1, updated_at = NOW()
			 WHERE id = $2 AND deleted_at IS NULL RETURNING *`,
			[Number(newOwnerId), String(groupId)],
		);
		return normalizeGroupRow(rows[0] || null);
	}

	async getGroupsByVisibility({ query = '', visibility = ['open', 'open_invite'], limit = 20, offset = 0 } = {}) {
		const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
		const safeOffset = Math.max(0, Number(offset) || 0);
		const visibilities = (Array.isArray(visibility) ? visibility : [visibility])
			.map((item) => String(item || '').trim())
			.filter(Boolean);
		if (visibilities.length === 0) return [];
		const values = [visibilities];
		const clauses = ['g.deleted_at IS NULL', 'g.visibility = ANY($1::text[])'];
		const normalizedQuery = String(query || '').trim().toLowerCase();
		if (normalizedQuery) {
			values.push(`%${normalizedQuery}%`);
			clauses.push(`(LOWER(g.name) LIKE $${values.length} OR LOWER(g.description) LIKE $${values.length})`);
		}
		values.push(safeLimit, safeOffset);
		const { rows } = await this.pool.query(
			`SELECT g.*, (
				SELECT COUNT(*)::int FROM group_memberships gm
				WHERE gm.group_id = g.id AND gm.status = 'active'
			) AS member_count
			FROM groups g WHERE ${clauses.join(' AND ')}
			ORDER BY g.created_at DESC, g.id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
			values,
		);
		return rows.map(normalizeGroupRow);
	}

	async getUserGroups(userId, { status = 'active', limit = 100, offset = 0 } = {}) {
		const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 200));
		const safeOffset = Math.max(0, Number(offset) || 0);
		const { rows } = await this.pool.query(
			`SELECT g.*, gm.role_id AS membership_role_id, gm.status AS membership_status,
				gm.joined_at AS membership_joined_at, (
					SELECT COUNT(*)::int FROM group_memberships count_gm
					WHERE count_gm.group_id = g.id AND count_gm.status = 'active'
				) AS member_count
			FROM group_memberships gm
			JOIN groups g ON g.id = gm.group_id
			WHERE gm.user_id = $1 AND gm.status = $2 AND g.deleted_at IS NULL
			ORDER BY gm.joined_at DESC NULLS LAST, g.created_at DESC
			LIMIT $3 OFFSET $4`,
			[Number(userId), String(status), safeLimit, safeOffset],
		);
		return rows.map((row) => ({
			...normalizeGroupRow(row),
			membership: normalizeGroupMembershipRow({
				group_id: row.id, user_id: userId, role_id: row.membership_role_id,
				status: row.membership_status, joined_at: row.membership_joined_at,
			}),
		}));
	}

	async createGroupRole(roleData) {
		const now = roleData.createdAt ? toIsoString(roleData.createdAt) : new Date().toISOString();
		const { rows } = await this.pool.query(
			`INSERT INTO group_roles (id, group_id, name, permissions, is_system, sort_order, created_at, updated_at)
			 VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $7) RETURNING *`,
			[
				String(roleData.id), String(roleData.groupId), String(roleData.name || ''),
				JSON.stringify(Array.isArray(roleData.permissions) ? roleData.permissions : []),
				Boolean(roleData.isSystem), Number(roleData.sortOrder) || 0, now,
			],
		);
		return normalizeGroupRoleRow(rows[0] || null);
	}

	async getGroupRoles(groupId) {
		const { rows } = await this.pool.query(
			`SELECT * FROM group_roles WHERE group_id = $1 ORDER BY sort_order ASC, name ASC, id ASC`,
			[String(groupId)],
		);
		return rows.map(normalizeGroupRoleRow);
	}

	async updateGroupRole(roleId, fields) {
		const fieldMap = { name: 'name', permissions: 'permissions', sortOrder: 'sort_order', sort_order: 'sort_order' };
		const sets = [];
		const values = [];
		const assigned = new Set();
		for (const [key, column] of Object.entries(fieldMap)) {
			if (fields[key] === undefined || assigned.has(column)) continue;
			assigned.add(column);
			if (column === 'permissions') values.push(JSON.stringify(Array.isArray(fields[key]) ? fields[key] : []));
			else if (column === 'sort_order') values.push(Number(fields[key]) || 0);
			else values.push(String(fields[key] || ''));
			sets.push(`${column} = $${values.length}${column === 'permissions' ? '::jsonb' : ''}`);
		}
		if (sets.length === 0) return null;
		sets.push('updated_at = NOW()');
		values.push(String(roleId));
		const { rows } = await this.pool.query(
			`UPDATE group_roles SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`, values,
		);
		return normalizeGroupRoleRow(rows[0] || null);
	}

	async deleteGroupRole(roleId) {
		const { rows } = await this.pool.query(`DELETE FROM group_roles WHERE id = $1 RETURNING *`, [String(roleId)]);
		return normalizeGroupRoleRow(rows[0] || null);
	}

	async getGroupMembership(groupId, userId) {
		const { rows } = await this.pool.query(
			`SELECT * FROM group_memberships WHERE group_id = $1 AND user_id = $2 LIMIT 1`,
			[String(groupId), Number(userId)],
		);
		return normalizeGroupMembershipRow(rows[0] || null);
	}

	async getGroupMemberships(groupId, { status = null, limit = 100, offset = 0 } = {}) {
		const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 200));
		const safeOffset = Math.max(0, Number(offset) || 0);
		const values = [String(groupId)];
		let where = 'group_id = $1';
		if (status) { values.push(String(status)); where += ` AND status = $${values.length}`; }
		values.push(safeLimit, safeOffset);
		const { rows } = await this.pool.query(
			`SELECT * FROM group_memberships WHERE ${where}
			 ORDER BY joined_at ASC NULLS LAST, user_id ASC LIMIT $${values.length - 1} OFFSET $${values.length}`,
			values,
		);
		return rows.map(normalizeGroupMembershipRow);
	}

	async createGroupMembership(membershipData) {
		const now = membershipData.updatedAt ? toIsoString(membershipData.updatedAt) : new Date().toISOString();
		const joinedAt = membershipData.joinedAt ? toIsoString(membershipData.joinedAt) : null;
		const { rows } = await this.pool.query(
			`INSERT INTO group_memberships (group_id, user_id, role_id, status, joined_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6)
			 ON CONFLICT (group_id, user_id) DO UPDATE SET role_id = EXCLUDED.role_id, status = EXCLUDED.status,
			 joined_at = EXCLUDED.joined_at, updated_at = EXCLUDED.updated_at RETURNING *`,
			[String(membershipData.groupId), Number(membershipData.userId), membershipData.roleId ?? null,
				String(membershipData.status || 'active'), joinedAt, now],
		);
		return normalizeGroupMembershipRow(rows[0] || null);
	}

	async updateGroupMembership(groupId, userId, fields) {
		const sets = [];
		const values = [];
		if (fields.roleId !== undefined || fields.role_id !== undefined) {
			values.push(fields.roleId ?? fields.role_id ?? null); sets.push(`role_id = $${values.length}`);
		}
		if (fields.status !== undefined) { values.push(String(fields.status)); sets.push(`status = $${values.length}`); }
		if (fields.joinedAt !== undefined || fields.joined_at !== undefined) {
			values.push(toIsoString(fields.joinedAt ?? fields.joined_at)); sets.push(`joined_at = $${values.length}`);
		}
		if (sets.length === 0) return this.getGroupMembership(groupId, userId);
		sets.push('updated_at = NOW()');
		values.push(String(groupId), Number(userId));
		const { rows } = await this.pool.query(
			`UPDATE group_memberships SET ${sets.join(', ')} WHERE group_id = $${values.length - 1} AND user_id = $${values.length} RETURNING *`, values,
		);
		return normalizeGroupMembershipRow(rows[0] || null);
	}

	async createGroupInvite(inviteData) {
		const now = inviteData.createdAt ? toIsoString(inviteData.createdAt) : new Date().toISOString();
		const { rows } = await this.pool.query(
			`INSERT INTO group_invites (id, group_id, inviter_id, invitee_id, status, created_at)
			 VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
			[String(inviteData.id), String(inviteData.groupId), Number(inviteData.inviterId), Number(inviteData.inviteeId),
				String(inviteData.status || 'pending'), now],
		);
		return normalizeGroupInviteRow(rows[0] || null);
	}

	async getGroupInvite(inviteId) {
		const { rows } = await this.pool.query(`SELECT * FROM group_invites WHERE id = $1 LIMIT 1`, [String(inviteId)]);
		return normalizeGroupInviteRow(rows[0] || null);
	}

	async getGroupInvites({ groupId = null, inviteeId = null, status = null, limit = 100, offset = 0 } = {}) {
		const values = [];
		const clauses = [];
		if (groupId != null) { values.push(String(groupId)); clauses.push(`group_id = $${values.length}`); }
		if (inviteeId != null) { values.push(Number(inviteeId)); clauses.push(`invitee_id = $${values.length}`); }
		if (status != null) { values.push(String(status)); clauses.push(`status = $${values.length}`); }
		if (clauses.length === 0) return [];
		values.push(Math.max(1, Math.min(Number(limit) || 100, 200)), Math.max(0, Number(offset) || 0));
		const { rows } = await this.pool.query(
			`SELECT * FROM group_invites WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC
			 LIMIT $${values.length - 1} OFFSET $${values.length}`,
			values,
		);
		return rows.map(normalizeGroupInviteRow);
	}

	async updateGroupInvite(inviteId, fields) {
		const sets = [];
		const values = [];
		if (fields.status !== undefined) { values.push(String(fields.status)); sets.push(`status = $${values.length}`); }
		if (fields.respondedAt !== undefined || fields.responded_at !== undefined) {
			values.push(toIsoString(fields.respondedAt ?? fields.responded_at)); sets.push(`responded_at = $${values.length}`);
		} else if (fields.status && fields.status !== 'pending') { sets.push('responded_at = NOW()'); }
		if (sets.length === 0) return this.getGroupInvite(inviteId);
		values.push(String(inviteId));
		const { rows } = await this.pool.query(
			`UPDATE group_invites SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`, values,
		);
		return normalizeGroupInviteRow(rows[0] || null);
	}

	async createGroupJoinRequest(requestData) {
		const now = requestData.createdAt ? toIsoString(requestData.createdAt) : new Date().toISOString();
		const { rows } = await this.pool.query(
			`INSERT INTO group_join_requests (id, group_id, user_id, status, created_at)
			 VALUES ($1, $2, $3, $4, $5) RETURNING *`,
			[String(requestData.id), String(requestData.groupId), Number(requestData.userId), String(requestData.status || 'pending'), now],
		);
		return normalizeGroupJoinRequestRow(rows[0] || null);
	}

	async getGroupJoinRequest(requestId) {
		const { rows } = await this.pool.query(`SELECT * FROM group_join_requests WHERE id = $1 LIMIT 1`, [String(requestId)]);
		return normalizeGroupJoinRequestRow(rows[0] || null);
	}

	async getGroupJoinRequests({ groupId = null, userId = null, status = null, limit = 100, offset = 0 } = {}) {
		const values = [];
		const clauses = [];
		if (groupId != null) { values.push(String(groupId)); clauses.push(`group_id = $${values.length}`); }
		if (userId != null) { values.push(Number(userId)); clauses.push(`user_id = $${values.length}`); }
		if (status != null) { values.push(String(status)); clauses.push(`status = $${values.length}`); }
		if (clauses.length === 0) return [];
		values.push(Math.max(1, Math.min(Number(limit) || 100, 200)), Math.max(0, Number(offset) || 0));
		const { rows } = await this.pool.query(
			`SELECT * FROM group_join_requests WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC
			 LIMIT $${values.length - 1} OFFSET $${values.length}`,
			values,
		);
		return rows.map(normalizeGroupJoinRequestRow);
	}

	async updateGroupJoinRequest(requestId, fields) {
		const sets = [];
		const values = [];
		if (fields.status !== undefined) { values.push(String(fields.status)); sets.push(`status = $${values.length}`); }
		if (fields.reviewedBy !== undefined || fields.reviewed_by !== undefined) {
			values.push(fields.reviewedBy ?? fields.reviewed_by ?? null); sets.push(`reviewed_by = $${values.length}`);
		}
		if (fields.reviewedAt !== undefined || fields.reviewed_at !== undefined) {
			values.push(toIsoString(fields.reviewedAt ?? fields.reviewed_at)); sets.push(`reviewed_at = $${values.length}`);
		} else if (fields.status && fields.status !== 'pending') { sets.push('reviewed_at = NOW()'); }
		if (sets.length === 0) return this.getGroupJoinRequest(requestId);
		values.push(String(requestId));
		const { rows } = await this.pool.query(
			`UPDATE group_join_requests SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`, values,
		);
		return normalizeGroupJoinRequestRow(rows[0] || null);
	}

	async getGroupPostIds(groupId, { limit = 30, offset = 0, beforeId = null, authorId = null } = {}) {
		const safeLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
		const values = [String(groupId)];
		const clauses = ['group_id = $1'];
		if (authorId != null && authorId !== '' && Number.isInteger(Number(authorId)) && Number(authorId) >= 0) {
			values.push(Number(authorId)); clauses.push(`user_id = $${values.length}`);
		}
		if (Number.isInteger(Number(beforeId)) && Number(beforeId) > 0) {
			values.push(Number(beforeId)); clauses.push(`id < $${values.length}`);
		}
		values.push(safeLimit + 1);
		const limitIndex = values.length;
		let offsetSql = '';
		if (!clauses.some((clause) => clause.startsWith('id <'))) {
			values.push(Math.max(0, Number(offset) || 0)); offsetSql = ` OFFSET $${values.length}`;
		}
		const { rows } = await this.pool.query(
			`SELECT id FROM posts WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT $${limitIndex}${offsetSql}`,
			values,
		);
		const ids = rows.slice(0, safeLimit).map((row) => Number(row.id));
		return { ids, has_more: rows.length > safeLimit, next_cursor: rows.length > safeLimit ? ids.at(-1) || null : null };
	}

	async getGroupAnnouncementPostIds(groupId, params = {}) {
		const safeLimit = Math.max(1, Math.min(Number(params.limit) || 30, 100));
		const values = [String(groupId)];
		const clauses = ['group_id = $1', 'group_announcement = true'];
		if (Number.isInteger(Number(params.beforeId)) && Number(params.beforeId) > 0) {
			values.push(Number(params.beforeId)); clauses.push(`id < $${values.length}`);
		}
		values.push(safeLimit + 1);
		const limitIndex = values.length;
		let offsetSql = '';
		if (!clauses.some((clause) => clause.startsWith('id <'))) {
			values.push(Math.max(0, Number(params.offset) || 0)); offsetSql = ` OFFSET $${values.length}`;
		}
		const { rows } = await this.pool.query(
			`SELECT id FROM posts WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT $${limitIndex}${offsetSql}`,
			values,
		);
		const ids = rows.slice(0, safeLimit).map((row) => Number(row.id));
		return { ids, has_more: rows.length > safeLimit, next_cursor: rows.length > safeLimit ? ids.at(-1) || null : null };
	}

	async searchGroupPostIds(userId, query, { limit = 30, offset = 0, beforeId = null } = {}) {
		const normalizedQuery = String(query || '').trim().toLowerCase();
		if (!normalizedQuery) return { ids: [], has_more: false, next_cursor: null };
		const safeLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
		const values = [Number(userId), `%${normalizedQuery}%`];
		const clauses = ['gm.user_id = $1', "gm.status = 'active'", 'p.group_id = gm.group_id', 'LOWER(p.content) LIKE $2'];
		if (Number.isInteger(Number(beforeId)) && Number(beforeId) > 0) {
			values.push(Number(beforeId)); clauses.push(`p.id < $${values.length}`);
		}
		values.push(safeLimit + 1);
		const limitIndex = values.length;
		let offsetSql = '';
		if (!clauses.some((clause) => clause.startsWith('p.id <'))) {
			values.push(Math.max(0, Number(offset) || 0)); offsetSql = ` OFFSET $${values.length}`;
		}
		const { rows } = await this.pool.query(
			`SELECT p.id FROM posts p JOIN group_memberships gm ON ${clauses.join(' AND ')}
			 ORDER BY p.created_at DESC, p.id DESC LIMIT $${limitIndex}${offsetSql}`,
			values,
		);
		const ids = rows.slice(0, safeLimit).map((row) => Number(row.id));
		return { ids, has_more: rows.length > safeLimit, next_cursor: rows.length > safeLimit ? ids.at(-1) || null : null };
	}

	// ==================== Posts ====================

	async createPost(postData) {
		const now = postData.createdAt ? toIsoString(postData.createdAt) : new Date().toISOString();
		const values = [
			Number(postData.userId),
			String(postData.content || ''),
			postData.attachments ? JSON.stringify(postData.attachments) : null,
			Boolean(postData.mask),
			Boolean(postData.lock),
			Boolean(postData.announcement),
			postData.replyTo ? Number(postData.replyTo) : null,
			postData.repostTo ? Number(postData.repostTo) : null,
			JSON.stringify(normalizePostTags(postData.tags)),
			postData.tagsGeneratedAt ? toIsoString(postData.tagsGeneratedAt) : null,
			postData.groupId ?? postData.group_id ?? null,
			Boolean(postData.groupAnnouncement ?? postData.group_announcement),
			now,
		];
		return this._withTransaction(async (client) => {
			const { rows } = await client.query(
`INSERT INTO posts (user_id, content, attachments, mask, lock, announcement, reply_to, repost_to, tags, tags_generated_at, group_id, group_announcement, created_at)
				 VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13)
			 RETURNING *`,
				values,
			);
			const post = normalizePostRow(rows[0] || null);
			if (post) {
				await this._adjustUserKeywordAffinitiesForTags(client, post.userId, post.tags, 1);
			}
			return post;
		});
	}

	async getPostById(id) {
		if (id == null) return null;
		const { rows } = await this.pool.query(
			'SELECT * FROM posts WHERE id = $1',
			[Number(id)],
		);
		return normalizePostRow(rows[0] || null);
	}

	async getPostsByIds(postIds) {
		const ids = [...new Set((postIds || []).map(Number).filter(Number.isSafeInteger))];
		if (ids.length === 0) return [];
		const { rows } = await this.pool.query(
			'SELECT * FROM posts WHERE id = ANY($1::int[])',
			[ids],
		);
		return rows.map(normalizePostRow);
	}

	async getPostReferencesByIds(postIds, maxDepth = 2) {
		const ids = [...new Set((postIds || []).map(Number)
			.filter((id) => Number.isSafeInteger(id) && id > 0))];
		const normalizedMaxDepth = Math.min(4, Math.max(0, Number(maxDepth) || 0));
		if (ids.length === 0) return [];
		const { rows } = await this.pool.query(
			`WITH RECURSIVE post_references AS (
				SELECT p.id, 0 AS depth, ARRAY[p.id] AS path
				FROM posts p WHERE p.id = ANY($1::int[])
				UNION ALL
				SELECT target.id, refs.depth + 1, refs.path || target.id
				FROM post_references refs
				JOIN LATERAL (
					SELECT reply_to, repost_to FROM posts WHERE id = refs.id LIMIT 1
				) source ON TRUE
				CROSS JOIN LATERAL (VALUES (source.reply_to), (source.repost_to)) AS target(id)
				WHERE refs.depth < $2
					AND target.id IS NOT NULL
					AND NOT target.id = ANY(refs.path)
			), nearest_references AS (
				SELECT DISTINCT ON (id) id, depth
				FROM post_references
				ORDER BY id, depth ASC
			)
			SELECT p.* FROM nearest_references refs
			JOIN LATERAL (SELECT * FROM posts WHERE id = refs.id LIMIT 1) p ON TRUE`,
			[ids, normalizedMaxDepth],
		);
		return rows.map(normalizePostRow);
	}

	async getPostMetricsBatch(postIds, currentUserId = null) {
		const ids = [...new Set((postIds || []).map(Number)
			.filter((id) => Number.isSafeInteger(id) && id > 0))];
		if (ids.length === 0) return [];

		const parsedViewerId = Number(currentUserId);
		const viewerId = Number.isSafeInteger(parsedViewerId) && parsedViewerId > 0
			? parsedViewerId
			: null;

		const metricQueries = [
			`SELECT 'like_count'::text AS kind, post_id, COUNT(*)::int AS value
			 FROM likes WHERE post_id = ANY($1::int[]) GROUP BY post_id`,
			`SELECT 'star_count'::text AS kind, post_id, COUNT(*)::int AS value
			 FROM stars WHERE post_id = ANY($1::int[]) GROUP BY post_id`,
			`SELECT 'repost_count'::text AS kind, post_id, COUNT(*)::int AS value
			 FROM reposts WHERE post_id = ANY($1::int[]) GROUP BY post_id`,
			`SELECT 'reply_count'::text AS kind, reply_to AS post_id, COUNT(*)::int AS value
			 FROM posts WHERE reply_to = ANY($1::int[]) GROUP BY reply_to`,
		];
		if (viewerId != null) {
			metricQueries.push(
				`SELECT 'liked_by_me'::text AS kind, post_id, 1::int AS value
				 FROM likes WHERE user_id = $2 AND post_id = ANY($1::int[])`,
				`SELECT 'starred_by_me'::text AS kind, post_id, 1::int AS value
				 FROM stars WHERE user_id = $2 AND post_id = ANY($1::int[])`,
			);
		}
		const { rows } = await this.pool.query(
			metricQueries.join('\nUNION ALL\n'),
			viewerId == null ? [ids] : [ids, viewerId],
		);
		const likeMap = new Map();
		const starMap = new Map();
		const repostMap = new Map();
		const replyMap = new Map();
		const myLikesSet = new Set();
		const myStarsSet = new Set();
		for (const row of rows || []) {
			const postId = Number(row.post_id);
			if (!Number.isSafeInteger(postId) || postId <= 0) continue;
			if (row.kind === 'like_count') likeMap.set(postId, Math.max(0, Number(row.value) || 0));
			if (row.kind === 'star_count') starMap.set(postId, Math.max(0, Number(row.value) || 0));
			if (row.kind === 'repost_count') repostMap.set(postId, Math.max(0, Number(row.value) || 0));
			if (row.kind === 'reply_count') replyMap.set(postId, Math.max(0, Number(row.value) || 0));
			if (row.kind === 'liked_by_me') myLikesSet.add(postId);
			if (row.kind === 'starred_by_me') myStarsSet.add(postId);
		}

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
		if (fields.tags !== undefined) {
			values.push(JSON.stringify(normalizePostTags(fields.tags)));
			sets.push(`tags = $${values.length}::jsonb`);
		}
		if (fields.tagsGeneratedAt !== undefined) {
			values.push(fields.tagsGeneratedAt ? toIsoString(fields.tagsGeneratedAt) : null);
			sets.push(`tags_generated_at = $${values.length}`);
		}
		if (fields.attachments !== undefined) {
			values.push(fields.attachments ? JSON.stringify(fields.attachments) : null);
			sets.push(`attachments = $${values.length}::jsonb`);
		}
		if (fields.mask !== undefined) {
			values.push(Boolean(fields.mask));
			sets.push(`mask = $${values.length}`);
		}
		if (fields.lock !== undefined) {
			values.push(Boolean(fields.lock));
			sets.push(`lock = $${values.length}`);
		}
		if (sets.length === 0) {
			return this.getPostById(postId);
		}
		return this._withTransaction(async (client) => {
			const existingResult = await client.query(
				'SELECT user_id, tags FROM posts WHERE id = $1 FOR UPDATE',
				[Number(postId)],
			);
			const existing = existingResult.rows[0];
			if (!existing) return null;
			const updateValues = [...values, Number(postId)];
			const { rows } = await client.query(
				`UPDATE posts SET ${sets.join(', ')} WHERE id = $${updateValues.length} RETURNING *`,
				updateValues,
			);
			const updated = normalizePostRow(rows[0] || null);
			if (updated && fields.tags !== undefined) {
				await this._adjustUserKeywordAffinitiesForTags(client, existing.user_id, existing.tags, -1);
				await this._adjustUserKeywordAffinitiesForTags(client, existing.user_id, updated.tags, 1);
			}
			return updated;
		});
	}

	async deletePost(postId, userId) {
		return this._withTransaction(async (client) => {
			const { rows } = await client.query('SELECT user_id FROM posts WHERE id = $1 FOR UPDATE', [Number(postId)]);
			if (!rows[0] || Number(rows[0].user_id) !== Number(userId)) {
				return false;
			}
			await client.query('DELETE FROM likes WHERE post_id = $1', [Number(postId)]);
			await client.query('DELETE FROM stars WHERE post_id = $1', [Number(postId)]);
			await client.query('DELETE FROM reposts WHERE post_id = $1', [Number(postId)]);
			await client.query('DELETE FROM pinned_posts WHERE post_id = $1', [Number(postId)]);
			const result = await client.query('DELETE FROM posts WHERE id = $1', [Number(postId)]);
			return result.rowCount > 0;
		});
	}

	async adminDeletePost(postId) {
		return this._withTransaction(async (client) => {
			await client.query('DELETE FROM likes WHERE post_id = $1', [Number(postId)]);
			await client.query('DELETE FROM stars WHERE post_id = $1', [Number(postId)]);
			await client.query('DELETE FROM reposts WHERE post_id = $1', [Number(postId)]);
			await client.query('DELETE FROM pinned_posts WHERE post_id = $1', [Number(postId)]);
			const result = await client.query('DELETE FROM posts WHERE id = $1', [Number(postId)]);
			return result.rowCount > 0;
		});
	}

	async getRecentPosts(limit = 30) {
		const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 100);
		const { rows } = await this.pool.query(
			`SELECT * FROM posts WHERE group_id IS NULL AND reply_to IS NULL ORDER BY created_at DESC, id DESC LIMIT $1`,
			[safeLimit],
		);
		return rows.map(normalizePostRow);
	}

	async getPostsByUserId(userId, limit = 50, _currentUserId = null) {
		const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
		const { rows } = await this.pool.query(
			`SELECT * FROM posts WHERE user_id = $1 AND group_id IS NULL ORDER BY created_at DESC, id DESC LIMIT $2`,
			[Number(userId), safeLimit],
		);
		return rows.map(normalizePostRow);
	}

	async getTimelinePosts(params = {}) {
		const limit = Math.min(Math.max(Number(params.limit) || 30, 1), 100);
		const posts = await this.getRecentPosts(limit);
		return { posts, hasMore: posts.length === limit };
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
			const ids = [...new Set((followIds || []).map(Number).filter(Number.isSafeInteger))];
			if (ids.length === 0) return { ids: [], has_more: false, next_cursor: null };
			if (normalizedBeforeId != null) {
				query = `SELECT id FROM posts WHERE user_id = ANY($1::int[]) AND group_id IS NULL AND reply_to IS NULL AND id < $2
					ORDER BY created_at DESC, id DESC LIMIT $3`;
				values = [ids, normalizedBeforeId, normalizedLimit + 1];
			} else {
				query = `SELECT id FROM posts WHERE user_id = ANY($1::int[]) AND group_id IS NULL AND reply_to IS NULL
					ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`;
				values = [ids, normalizedLimit + 1, normalizedOffset];
			}
		} else if (tab === 'announce') {
			if (normalizedBeforeId != null) {
				query = `SELECT id FROM posts WHERE group_id IS NULL AND announcement = TRUE AND reply_to IS NULL
					AND id < $1 ORDER BY created_at DESC, id DESC LIMIT $2`;
				values = [normalizedBeforeId, normalizedLimit + 1];
			} else {
				query = `SELECT id FROM posts WHERE group_id IS NULL AND announcement = TRUE AND reply_to IS NULL
					ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2`;
				values = [normalizedLimit + 1, normalizedOffset];
			}
		} else if (normalizedBeforeId != null) {
			query = `SELECT id FROM posts WHERE group_id IS NULL AND reply_to IS NULL AND id < $1 ORDER BY created_at DESC, id DESC LIMIT $2`;
			values = [normalizedBeforeId, normalizedLimit + 1];
		} else {
			query = `SELECT id FROM posts WHERE group_id IS NULL AND reply_to IS NULL ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2`;
			values = [normalizedLimit + 1, normalizedOffset];
		}
		const { rows } = await this.pool.query(query, values);
		const ids = rows.slice(0, normalizedLimit).map((row) => Number(row.id));
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
			const candidateClauses = ['p.group_id IS NULL', 'p.reply_to IS NULL'];
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
				const keywordViewerParam = values.length;
				values.push(normalizedViewerId);
				const directViewerParam = values.length;
				values.push(normalizedViewerId);
				const secondDegreeViewerParam = values.length;
				values.push(normalizedViewerId);
				const secondDegreeExcludeParam = values.length;
				personalScoreCtes.push(
					`viewer_keyword_profile AS (
						SELECT keyword, score
						FROM user_keyword_affinities
						WHERE user_id = $${keywordViewerParam}
						ORDER BY score DESC, keyword ASC
						LIMIT 80
					), viewer_keyword_affinity AS (
						SELECT c.id AS post_id,
							SUM(profile.score * CASE
								WHEN profile.keyword = post_tag.keyword THEN 1::numeric
								ELSE LEAST(char_length(profile.keyword), char_length(post_tag.keyword))::numeric
									/ GREATEST(char_length(profile.keyword), char_length(post_tag.keyword))::numeric
							END)::numeric AS score
						FROM candidates c
						CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(c.tags, '[]'::jsonb)) AS post_tag(keyword)
						CROSS JOIN viewer_keyword_profile profile
						WHERE profile.keyword = post_tag.keyword
							OR (
								char_length(profile.keyword) >= 3
								AND char_length(post_tag.keyword) >= 3
								AND (
									position(profile.keyword in post_tag.keyword) > 0
									OR position(post_tag.keyword in profile.keyword) > 0
								)
							)
						GROUP BY c.id
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
					SELECT p.id, p.user_id, p.created_at, p.tags
					FROM posts p
				WHERE ${candidateClauses.join(' AND ')}
				ORDER BY p.created_at DESC, p.id DESC
				LIMIT $${candidateLimitParam} OFFSET $${candidateOffsetParam}
			), candidates AS (
					SELECT id, user_id, created_at, tags
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
					48::DECIMAL / (
						1::DECIMAL + GREATEST(
							0::DECIMAL,
							EXTRACT(EPOCH FROM (NOW() - c.created_at))::DECIMAL / 3600::DECIMAL
						) / 6::DECIMAL
					)
					+ LEAST(
						22::DECIMAL,
								/* Keep simple like and star scores below the repost score. */
								COALESCE(l.count, 0)::DECIMAL * 2::DECIMAL / (COALESCE(l.count, 0)::DECIMAL + 4::DECIMAL)
								+ COALESCE(s.count, 0)::DECIMAL * 4::DECIMAL / (COALESCE(s.count, 0)::DECIMAL + 2::DECIMAL)
								+ COALESCE(r.count, 0)::DECIMAL * 10::DECIMAL / (COALESCE(r.count, 0)::DECIMAL + 2::DECIMAL)
					)
					${normalizedViewerId != null ? `+ CASE
						WHEN df.user_id IS NOT NULL THEN 24::DECIMAL
						WHEN sdf.user_id IS NOT NULL THEN 10::DECIMAL
						ELSE 0::DECIMAL
						END
						+ LEAST(30::DECIMAL, COALESCE(vka.score, 0)::DECIMAL * 2::DECIMAL)` : ''} AS score
				FROM candidates c
				LEFT JOIN like_counts l ON l.post_id = c.id
				LEFT JOIN star_counts s ON s.post_id = c.id
				LEFT JOIN repost_counts r ON r.post_id = c.id
					${normalizedViewerId != null ? `LEFT JOIN viewer_keyword_affinity vka ON vka.post_id = c.id
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
			WHERE s.score >= stats.average_score * 0.75::DECIMAL`,
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

	async getProfilePostIds({ userId, subType = 'all', limit = 30, offset = 0, beforeId = null } = {}) {
		const normalizedLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
		const normalizedOffset = Math.max(0, Number(offset) || 0);
		const normalizedBeforeId = Number.isInteger(Number(beforeId)) && Number(beforeId) > 0
			? Number(beforeId)
			: null;
		const values = [Number(userId)];
		const clauses = ['user_id = $1', 'group_id IS NULL'];
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
		const ids = rows.slice(0, normalizedLimit).map((row) => Number(row.id));
		return {
			ids,
			has_more: rows.length > normalizedLimit,
			next_cursor: rows.length > normalizedLimit && ids.length > 0 ? ids[ids.length - 1] : null,
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
		const pattern = `%${q.toLowerCase()}%`;
		const { rows } = normalizedBeforeId != null
			? await this.pool.query(
				`SELECT id FROM posts WHERE group_id IS NULL AND LOWER(content) LIKE $1 AND id < $2
					 ORDER BY created_at DESC, id DESC LIMIT $3`,
				[pattern, normalizedBeforeId, normalizedLimit + 1],
			)
			: await this.pool.query(
				`SELECT id FROM posts WHERE group_id IS NULL AND LOWER(content) LIKE $1
					 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
				[pattern, normalizedLimit + 1, normalizedOffset],
			);
		const ids = rows.slice(0, normalizedLimit).map((row) => Number(row.id));
		return {
			ids,
			has_more: rows.length > normalizedLimit,
			next_cursor: rows.length > normalizedLimit && ids.length > 0 ? ids[ids.length - 1] : null,
		};
	}

	async searchPosts(query, limit = 20) {
		const q = String(query || '').trim();
		if (!q) return [];
		const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
		const { rows } = await this.pool.query(
`SELECT * FROM posts 
				 WHERE group_id IS NULL AND LOWER(content) LIKE $1
			 ORDER BY created_at DESC, id DESC
			 LIMIT $2`,
			[`%${q.toLowerCase()}%`, safeLimit],
		);
		return rows.map(normalizePostRow);
	}

	async getReplyPostIds(parentPostId, limit = 50, offset = 0) {
		const normalizedLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
		const normalizedOffset = Math.max(0, Number(offset) || 0);
		const { rows } = await this.pool.query(
			`SELECT id FROM posts WHERE reply_to = $1
			 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
			[Number(parentPostId), normalizedLimit + 1, normalizedOffset],
		);
		return {
			ids: rows.slice(0, normalizedLimit).map((row) => Number(row.id)),
			has_more: rows.length > normalizedLimit,
		};
	}

	async getReplyCount(postId) {
		const { rows } = await this.pool.query(
			'SELECT COUNT(*)::int AS count FROM posts WHERE reply_to = $1',
			[Number(postId)],
		);
		return Number(rows[0]?.count || 0);
	}

	async getThreadReplyPostIds(parentPostId, limit = 50, offset = 0) {
		const normalizedLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
		const normalizedOffset = Math.max(0, Number(offset) || 0);
		const { rows } = await this.pool.query(
			`WITH RECURSIVE reply_tree AS (
				SELECT id, reply_to, 0 AS depth, ARRAY[id] AS path
				FROM posts
				WHERE reply_to = $1
				UNION ALL
				SELECT child.id, child.reply_to, tree.depth + 1, tree.path || child.id
				FROM posts child
				JOIN reply_tree tree ON child.reply_to = tree.id
				WHERE tree.depth < 10 AND NOT child.id = ANY(tree.path)
			)
			SELECT id FROM reply_tree
			ORDER BY path
			LIMIT $2 OFFSET $3`,
			[Number(parentPostId), normalizedLimit + 1, normalizedOffset],
		);
		return {
			ids: rows.slice(0, normalizedLimit).map((row) => Number(row.id)),
			has_more: rows.length > normalizedLimit,
		};
	}

	async getPostDetail(id, currentUserId = null) {
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
			[Number(id)],
		);
		const detail = rows[0];
		if (!detail) return null;
		const [metric] = await this.getPostMetricsBatch([Number(id)], currentUserId);

		const normalized = normalizePostRow(detail);
		return {
			...normalized,
			author: detail.author_id == null
				? null
				: { id: Number(detail.author_id), name: detail.author_name || '', scid: detail.author_scid || null },
			like_count: Number(metric?.like_count || 0),
			star_count: Number(metric?.star_count || 0),
			liked_by_me: Boolean(metric?.liked_by_me),
			starred_by_me: Boolean(metric?.starred_by_me),
			parent_post: detail.parent_id == null
				? null
				: {
					id: Number(detail.parent_id),
					content: detail.parent_content ? String(detail.parent_content).substring(0, 100) : '',
					author: detail.parent_author_id == null
						? null
						: { id: Number(detail.parent_author_id), name: detail.parent_author_name || '' },
				},
		};
	}

	async getTrendingPosts(limit = 20) {
		const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
		const { rows } = await this.pool.query(
			`SELECT p.*, 
				(COALESCE(l.like_count, 0) + COALESCE(s.star_count, 0) * 2 + COALESCE(r.repost_count, 0) * 3) as score
			 FROM posts p
			 LEFT JOIN (SELECT post_id, COUNT(*)::int as like_count FROM likes GROUP BY post_id) l ON l.post_id = p.id
			 LEFT JOIN (SELECT post_id, COUNT(*)::int as star_count FROM stars GROUP BY post_id) s ON s.post_id = p.id
			 LEFT JOIN (SELECT post_id, COUNT(*)::int as repost_count FROM reposts GROUP BY post_id) r ON r.post_id = p.id
			 ORDER BY score DESC, p.created_at DESC
			 LIMIT $1`,
			[safeLimit],
		);
		return rows.map(normalizePostRow);
	}

	async getTrendingHashtags(limit = 10) {
		const normalizedLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
		const { rows } = await this.pool.query(
			'SELECT content, tags FROM posts WHERE group_id IS NULL ORDER BY created_at DESC LIMIT 500',
		);
		const counts = new Map();
		for (const row of rows) {
			const matches = (row.content || '').match(/#([^<>/@#\s]+)/g) || [];
			const uniqueTags = new Set([
				...matches.map((match) => match.slice(1).toLowerCase()),
				...normalizePostTags(row.tags),
			]);
			for (const tag of uniqueTags) {
				counts.set(tag, (counts.get(tag) || 0) + 1);
			}
		}
		return Array.from(counts.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, normalizedLimit)
			.map(([tag_name, occurrence_count]) => ({ tag_name, occurrence_count }));
	}

	async getPostCount(userId) {
		const { rows } = await this.pool.query(
			'SELECT COUNT(*)::int AS count FROM posts WHERE user_id = $1',
			[Number(userId)],
		);
		return Number(rows[0]?.count || 0);
	}

	async getMediaCount(userId) {
		const { rows } = await this.pool.query(
			`SELECT COUNT(*)::int AS count FROM posts
			 WHERE user_id = $1
			   AND jsonb_typeof(attachments) = 'array'
			   AND jsonb_array_length(attachments) > 0`,
			[Number(userId)],
		);
		return Number(rows[0]?.count || 0);
	}

	async getMediaPosts(userId, limit = 15, offset = 0) {
		const normalizedLimit = Math.max(1, Math.min(Number(limit) || 15, 100));
		const normalizedOffset = Math.max(0, Number(offset) || 0);
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
			[Number(userId), normalizedLimit, normalizedOffset],
		);
		return rows.map((row) => ({
			post_id: Number(row.post_id),
			file_id: row.file_id,
			file_type: row.file_type || 'file',
			type: row.file_type || 'file',
		}));
	}

	// ==================== Reactions ====================

	async _adjustUserKeywordAffinitiesForTags(client, userId, tags, delta) {
		const normalizedDelta = Number(delta);
		const normalizedTags = normalizePostTags(tags);
		if (!Number.isFinite(normalizedDelta) || normalizedDelta === 0 || normalizedTags.length === 0) return;
		await client.query(
			`INSERT INTO user_keyword_affinities (user_id, keyword, score, updated_at)
			 SELECT $1, keyword, $3::numeric, NOW() FROM unnest($2::text[]) AS keyword
			 ON CONFLICT (user_id, keyword) DO UPDATE
			 SET score = GREATEST(0, user_keyword_affinities.score + EXCLUDED.score),
				 updated_at = NOW()`,
			[Number(userId), normalizedTags, normalizedDelta],
		);
		await client.query(
			'DELETE FROM user_keyword_affinities WHERE user_id = $1 AND score <= 0',
			[Number(userId)],
		);
	}

	async _adjustUserKeywordAffinities(client, userId, postId, delta) {
		const { rows } = await client.query(
			'SELECT tags FROM posts WHERE id = $1 LIMIT 1',
			[Number(postId)],
		);
		await this._adjustUserKeywordAffinitiesForTags(client, userId, rows[0]?.tags, delta);
	}

	async toggleLike(userId, postId) {
		return this._withTransaction(async (client) => {
			const existing = await client.query(
				'SELECT 1 FROM likes WHERE user_id = $1 AND post_id = $2',
				[Number(userId), Number(postId)],
			);
				if (existing.rows.length > 0) {
					await client.query(
						'DELETE FROM likes WHERE user_id = $1 AND post_id = $2',
						[Number(userId), Number(postId)],
					);
					await this._adjustUserKeywordAffinities(client, userId, postId, -1);
				} else {
				const now = new Date().toISOString();
					await client.query(
						'INSERT INTO likes (user_id, post_id, created_at) VALUES ($1, $2, $3)',
						[Number(userId), Number(postId), now],
					);
					await this._adjustUserKeywordAffinities(client, userId, postId, 1);
				}
			const countResult = await client.query(
				'SELECT COUNT(*)::int AS count FROM likes WHERE post_id = $1',
				[Number(postId)],
			);
			return {
				liked: existing.rows.length === 0,
				count: Number(countResult.rows[0]?.count || 0),
			};
		});
	}

	async getLikeCount(postId) {
		const { rows } = await this.pool.query(
			'SELECT COUNT(*)::int as count FROM likes WHERE post_id = $1',
			[Number(postId)],
		);
		return Number(rows[0]?.count || 0);
	}

	async hasUserLikedPost(userId, postId) {
		const { rows } = await this.pool.query(
			'SELECT 1 FROM likes WHERE user_id = $1 AND post_id = $2 LIMIT 1',
			[Number(userId), Number(postId)],
		);
		return rows.length > 0;
	}

	async getLikeIds(userId) {
		const { rows } = await this.pool.query(
			'SELECT post_id FROM likes WHERE user_id = $1 ORDER BY created_at DESC',
			[Number(userId)],
		);
		return rows.map((row) => Number(row.post_id));
	}

	async toggleStar(userId, postId) {
		return this._withTransaction(async (client) => {
			const existing = await client.query(
				'SELECT 1 FROM stars WHERE user_id = $1 AND post_id = $2',
				[Number(userId), Number(postId)],
			);
				if (existing.rows.length > 0) {
					await client.query(
						'DELETE FROM stars WHERE user_id = $1 AND post_id = $2',
						[Number(userId), Number(postId)],
					);
					await this._adjustUserKeywordAffinities(client, userId, postId, -3);
				} else {
				const now = new Date().toISOString();
					await client.query(
						'INSERT INTO stars (user_id, post_id, created_at) VALUES ($1, $2, $3)',
						[Number(userId), Number(postId), now],
					);
					await this._adjustUserKeywordAffinities(client, userId, postId, 3);
				}
			const countResult = await client.query(
				'SELECT COUNT(*)::int AS count FROM stars WHERE post_id = $1',
				[Number(postId)],
			);
			return {
				starred: existing.rows.length === 0,
				count: Number(countResult.rows[0]?.count || 0),
			};
		});
	}

	async getStarCount(postId) {
		const { rows } = await this.pool.query(
			'SELECT COUNT(*)::int as count FROM stars WHERE post_id = $1',
			[Number(postId)],
		);
		return Number(rows[0]?.count || 0);
	}

	async hasUserStarredPost(userId, postId) {
		const { rows } = await this.pool.query(
			'SELECT 1 FROM stars WHERE user_id = $1 AND post_id = $2 LIMIT 1',
			[Number(userId), Number(postId)],
		);
		return rows.length > 0;
	}

	async getStarIds(userId) {
		const { rows } = await this.pool.query(
			'SELECT post_id FROM stars WHERE user_id = $1 ORDER BY created_at DESC',
			[Number(userId)],
		);
		return rows.map((row) => Number(row.post_id));
	}

	async togglePin(userId, postId) {
		return this._withTransaction(async (client) => {
			const post = await client.query(
				'SELECT user_id FROM posts WHERE id = $1',
				[Number(postId)],
			);
			if (!post.rows[0] || Number(post.rows[0].user_id) !== Number(userId)) {
				throw new Error('Cannot pin a post you do not own');
			}

			const existing = await client.query(
				'SELECT 1 FROM pinned_posts WHERE user_id = $1 AND post_id = $2',
				[Number(userId), Number(postId)],
			);
			if (existing.rows.length > 0) {
				await client.query(
					'DELETE FROM pinned_posts WHERE user_id = $1 AND post_id = $2',
					[Number(userId), Number(postId)],
				);
				return { pinned: false };
			}
			const now = new Date().toISOString();
			await client.query(
				'INSERT INTO pinned_posts (user_id, post_id, created_at) VALUES ($1, $2, $3)',
				[Number(userId), Number(postId), now],
			);
			return { pinned: true };
		});
	}

	async getPinnedPosts(userId) {
		const { rows } = await this.pool.query(
			`SELECT p.* FROM posts p
			 JOIN pinned_posts pp ON pp.post_id = p.id
			 WHERE pp.user_id = $1
			 ORDER BY pp.created_at DESC`,
			[Number(userId)],
		);
		return rows.map(normalizePostRow);
	}

	async getPinnedPostId(userId) {
		const { rows } = await this.pool.query(
			`SELECT post_id FROM pinned_posts
			 WHERE user_id = $1
			 ORDER BY created_at DESC
			 LIMIT 1`,
			[Number(userId)],
		);
		return rows.length > 0 ? Number(rows[0].post_id) : null;
	}

	async repostPost(userId, postId) {
		return this._withTransaction(async (client) => {
			const original = await client.query('SELECT * FROM posts WHERE id = $1', [Number(postId)]);
			if (!original.rows[0]) throw new Error('Post not found');

			const existing = await client.query(
				'SELECT 1 FROM reposts WHERE user_id = $1 AND post_id = $2',
				[Number(userId), Number(postId)],
			);
			if (existing.rows.length > 0) throw new Error('Already reposted');

			const now = new Date().toISOString();
			await client.query(
				'INSERT INTO reposts (user_id, post_id, created_at) VALUES ($1, $2, $3)',
				[Number(userId), Number(postId), now],
			);

			const origRow = original.rows[0];
			const { rows: created } = await client.query(
				`INSERT INTO posts (user_id, content, attachments, mask, lock, repost_to, created_at)
				 VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
				 RETURNING *`,
				[
					Number(userId),
					origRow.content,
					origRow.attachments ? JSON.stringify(origRow.attachments) : null,
					origRow.mask,
					origRow.lock,
					Number(postId),
					now,
				],
			);
			return normalizePostRow(created[0]);
		});
	}

	async getReposts(userId) {
		const { rows } = await this.pool.query(
			`SELECT p.* FROM posts p
			 JOIN reposts r ON r.post_id = p.repost_to
			 WHERE r.user_id = $1
			 ORDER BY r.created_at DESC`,
			[Number(userId)],
		);
		return rows.map(normalizePostRow);
	}

	async getRepostsOfPost(postId, limit = 50) {
		const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
		const { rows } = await this.pool.query(
			`SELECT u.id as user_id, u.name, u.handle FROM reposts r
			 JOIN users u ON u.id = r.user_id
			 WHERE r.post_id = $1
			 ORDER BY r.created_at DESC
			 LIMIT $2`,
			[Number(postId), safeLimit],
		);
		return rows.map((r) => ({ user_id: Number(r.user_id), name: r.name, handle: r.handle }));
	}

	async getRepostCount(postId) {
		const { rows } = await this.pool.query(
			'SELECT COUNT(*)::int as count FROM reposts WHERE post_id = $1',
			[Number(postId)],
		);
		return Number(rows[0]?.count || 0);
	}

	// ==================== Direct Messages ====================

	async getDmList(userId) {
		const { rows } = await this.pool.query(
			'SELECT * FROM dm_channels WHERE $1 = ANY(participants)',
			[Number(userId)],
		);
		return rows.map((r) => ({
			id: r.id,
			participants: (r.participants || []).map(Number),
			created_at: toIsoString(r.created_at),
		}));
	}

	async getOrCreateDmChannel(userId1, userId2) {
		const u1 = Math.min(Number(userId1), Number(userId2));
		const u2 = Math.max(Number(userId1), Number(userId2));
		const channelId = `${u1}:${u2}`;
		const now = new Date().toISOString();

		const { rows } = await this.pool.query(
			`INSERT INTO dm_channels (id, participants, created_at)
			 VALUES ($1, $2, $3)
			 ON CONFLICT (id) DO NOTHING
			 RETURNING *`,
			[channelId, [u1, u2], now],
		);

		if (rows.length > 0) {
			return {
				id: rows[0].id,
				participants: (rows[0].participants || []).map(Number),
				created_at: toIsoString(rows[0].created_at),
			};
		}

		const existing = await this.pool.query('SELECT * FROM dm_channels WHERE id = $1', [channelId]);
		return existing.rows[0] ? {
			id: existing.rows[0].id,
			participants: (existing.rows[0].participants || []).map(Number),
			created_at: toIsoString(existing.rows[0].created_at),
		} : null;
	}

	async getDmMessages(channelId, limit = 50, offset = 0) {
		const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
		const safeOffset = Math.max(Number(offset) || 0, 0);
		const { rows } = await this.pool.query(
			`SELECT * FROM dm_messages
			 WHERE channel_id = $1
			 ORDER BY sent_at DESC
			 LIMIT $2 OFFSET $3`,
			[String(channelId), safeLimit, safeOffset],
		);
		return rows.map((r) => ({
			id: Number(r.id),
			channel_id: r.channel_id,
			sender_id: Number(r.sender_id),
			content: r.content,
			sent_at: toIsoString(r.sent_at),
			read_at: toIsoString(r.read_at),
		}));
	}

	async sendDmMessage(channelId, senderId, content) {
		const now = new Date().toISOString();
		const { rows } = await this.pool.query(
			`INSERT INTO dm_messages (channel_id, sender_id, content, sent_at)
			 VALUES ($1, $2, $3, $4)
			 RETURNING *`,
			[String(channelId), Number(senderId), String(content || ''), now],
		);
		return rows[0] ? {
			id: Number(rows[0].id),
			channel_id: rows[0].channel_id,
			sender_id: Number(rows[0].sender_id),
			content: rows[0].content,
			sent_at: toIsoString(rows[0].sent_at),
			read_at: toIsoString(rows[0].read_at),
		} : null;
	}

	async markDmMessagesAsRead(channelId, userId) {
		const now = new Date().toISOString();
		await this.pool.query(
			`UPDATE dm_messages SET read_at = $3
			 WHERE channel_id = $1 AND sender_id != $2 AND read_at IS NULL`,
			[String(channelId), Number(userId), now],
		);
	}

	async getUnreadDmCount(userId) {
		const { rows } = await this.pool.query(
			`SELECT COUNT(*)::int as count FROM dm_messages m
			 JOIN dm_channels c ON c.id = m.channel_id
			 WHERE $1 = ANY(c.participants)
			   AND m.sender_id != $1
			   AND m.read_at IS NULL`,
			[Number(userId)],
		);
		return Number(rows[0]?.count || 0);
	}

	async getGroupDmsForUser(userId) {
		const { rows } = await this.pool.query(
			`SELECT * FROM group_dms WHERE $1::INTEGER = ANY(member) ORDER BY time DESC`,
			[Number(userId)],
		);
		return rows.map((row) => normalizeGroupDmRow(row, Number(userId)));
	}

	async getGroupDmVisibilityDataForUser(userId) {
		const { rows } = await this.pool.query(
			`SELECT id, member, unread FROM group_dms WHERE $1::INTEGER = ANY(member)`,
			[Number(userId)],
		);
		return rows.map((row) => ({
			id: String(row.id),
			member: (row.member || []).map(Number),
			unread: typeof row.unread === 'object' && row.unread !== null ? row.unread : parseJsonSafe(row.unread, {}),
		}));
	}

	async getGroupDm(dmId) {
		if (!dmId) return null;
		const { rows } = await this.pool.query(
			'SELECT * FROM group_dms WHERE id = $1 LIMIT 1',
			[String(dmId)],
		);
		return normalizeGroupDmRow(rows[0] || null);
	}

	async createGroupDm(dmData) {
		const hostId = Number(dmData.hostId);
		const member = Array.from(new Set((dmData.member || [hostId]).map(Number).filter(Number.isInteger)));
		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		const title = String(dmData.title || '');

		const { rows } = await this.pool.query(
			`INSERT INTO group_dms (id, host_id, title, member, post, unread, time, created_at)
			 VALUES ($1, $2, $3, $4::int[], '[]'::jsonb, '{}'::jsonb, $5, $5)
			 RETURNING *`,
			[id, hostId, title, member, now],
		);
		return normalizeGroupDmRow(rows[0], hostId);
	}

	async updateGroupDm(dmId, updates) {
		const sets = [];
		const values = [];
		let i = 1;

		if (updates.title !== undefined) {
			sets.push(`title = $${i++}`);
			values.push(String(updates.title));
		}
		if (updates.member !== undefined) {
			const memberSet = Array.from(new Set(updates.member.map(Number).filter(Number.isInteger)));
			sets.push(`member = $${i++}::int[]`);
			values.push(memberSet);
		}
		if (updates.host_id !== undefined || updates.hostId !== undefined) {
			sets.push(`host_id = $${i++}`);
			values.push(Number(updates.host_id ?? updates.hostId));
		}
		if (updates.post !== undefined) {
			sets.push(`post = $${i++}::jsonb`);
			values.push(JSON.stringify(updates.post));
		}
		if (updates.unread !== undefined) {
			sets.push(`unread = $${i++}::jsonb`);
			values.push(JSON.stringify(updates.unread));
		}
		if (updates.time !== undefined) {
			sets.push(`time = $${i++}`);
			values.push(toIsoString(updates.time));
		}

		if (sets.length === 0) {
			return this.getGroupDm(dmId);
		}

		values.push(String(dmId));
		const { rows } = await this.pool.query(
			`UPDATE group_dms SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
			values,
		);
		if (!rows[0]) return null;
		return normalizeGroupDmRow(rows[0]);
	}

	async appendToGroupDm(dmId, message, senderId = null) {
		return this._withTransaction(async (client) => {
			const { rows: existingRows } = await client.query(
				'SELECT * FROM group_dms WHERE id = $1 FOR UPDATE',
				[String(dmId)],
			);
			const row = existingRows[0];
			if (!row) return null;

			const time = message.time ? toIsoString(message.time) : new Date().toISOString();
			const posts = Array.isArray(row.post) ? row.post : parseJsonSafe(row.post, []);
			posts.push(message);

			const unread = { ...(typeof row.unread === 'object' && row.unread !== null ? row.unread : parseJsonSafe(row.unread, {})) };
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
				 SET post = $1::jsonb,
				     time = $2,
				     unread = $3::jsonb
				 WHERE id = $4
				 RETURNING *`,
				[JSON.stringify(posts), time, JSON.stringify(unread), String(dmId)],
			);
			return normalizeGroupDmRow(rows[0], senderId);
		});
	}

	async markGroupDmRead(dmId, userId) {
		return this._withTransaction(async (client) => {
			const { rows } = await client.query('SELECT unread FROM group_dms WHERE id = $1 FOR UPDATE', [String(dmId)]);
			if (!rows[0]) return;
			const unread = { ...(typeof rows[0].unread === 'object' && rows[0].unread !== null ? rows[0].unread : parseJsonSafe(rows[0].unread, {})) };
			unread[String(userId)] = 0;
			await client.query('UPDATE group_dms SET unread = $2::jsonb WHERE id = $1', [String(dmId), JSON.stringify(unread)]);
		});
	}

	async getGroupDmUnreadCounts(userId) {
		const { rows } = await this.pool.query(
			'SELECT id, member, unread FROM group_dms WHERE $1 = ANY(member)',
			[Number(userId)],
		);
		const counts = [];
		for (const r of rows) {
			const unread = typeof r.unread === 'object' && r.unread !== null ? r.unread : parseJsonSafe(r.unread, {});
			counts.push({ dm_id: r.id, unread_count: Number(unread[String(userId)] || 0) });
		}
		return counts;
	}

	async getGroupDmUnreadTotal(userId) {
		const { rows } = await this.pool.query(
			'SELECT member, unread FROM group_dms WHERE $1 = ANY(member)',
			[Number(userId)],
		);
		let total = 0;
		for (const r of rows) {
			const unread = typeof r.unread === 'object' && r.unread !== null ? r.unread : parseJsonSafe(r.unread, {});
			total += Number(unread[String(userId)] || 0);
		}
		return total;
	}

	async deleteGroupDm(dmId) {
		const { rowCount } = await this.pool.query('DELETE FROM group_dms WHERE id = $1', [String(dmId)]);
		return rowCount > 0;
	}

	async leaveGroupDm(dmId, userId) {
		return this._withTransaction(async (client) => {
			const { rows } = await client.query('SELECT member, unread FROM group_dms WHERE id = $1 FOR UPDATE', [String(dmId)]);
			if (!rows[0]) return false;

			const members = (rows[0].member || []).map(Number).filter((id) => id !== Number(userId));
			const unread = { ...(typeof rows[0].unread === 'object' && rows[0].unread !== null ? rows[0].unread : parseJsonSafe(rows[0].unread, {})) };
			delete unread[String(userId)];

			await client.query(
				'UPDATE group_dms SET member = $2::int[], unread = $3::jsonb WHERE id = $1',
				[String(dmId), members, JSON.stringify(unread)],
			);
			return true;
		});
	}

	async findGroupDmByMembers(memberIds) {
		const target = Array.from(new Set(memberIds.map(Number).filter(Number.isInteger))).sort((a, b) => a - b);
		if (target.length === 0) return null;
		const { rows } = await this.pool.query(
			`SELECT * FROM group_dms
			 WHERE cardinality(member) = $1
			   AND member @> $2::int[] AND member <@ $2::int[]`,
			[target.length, target],
		);
		if (!rows[0]) return null;
		return normalizeGroupDmRow(rows[0]);
	}

	async getDmPublicKeys(userIds) {
		const ids = Array.from(
			new Set((userIds || []).map(Number).filter((id) => Number.isInteger(id) && id >= 0)),
		);
		if (ids.length === 0) return [];
		const { rows } = await this.pool.query(
			'SELECT user_id, public_key FROM dm_e2e_keys WHERE user_id = ANY($1::int[])',
			[ids],
		);
		return rows.map((row) => ({ user_id: Number(row.user_id), public_key: String(row.public_key) }));
	}

	async setDmPublicKey(userId, publicKey) {
		const now = new Date().toISOString();
		await this.pool.query(
			`INSERT INTO dm_e2e_keys (user_id, public_key, created_at, updated_at)
			 VALUES ($1, $2, $3, $3)
			 ON CONFLICT (user_id)
			 DO UPDATE SET public_key = EXCLUDED.public_key, updated_at = EXCLUDED.updated_at`,
			[Number(userId), String(publicKey), now],
		);
	}

	// ==================== Follows ====================

	async toggleFollow(followerId, followingId) {
		const u1 = Number(followerId);
		const u2 = Number(followingId);
		if (u1 === u2) {
			throw new Error('Cannot follow yourself');
		}

		return this._withTransaction(async (client) => {
			const existing = await client.query(
				'SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2',
				[u1, u2],
			);
			if (existing.rows.length > 0) {
				await client.query(
					'DELETE FROM follows WHERE follower_id = $1 AND following_id = $2',
					[u1, u2],
				);
				return { following: false };
			}
			const now = new Date().toISOString();
			await client.query(
				'INSERT INTO follows (follower_id, following_id, created_at) VALUES ($1, $2, $3)',
				[u1, u2, now],
			);
			return { following: true };
		});
	}

	async isFollowing(followerId, followingId) {
		const { rows } = await this.pool.query(
			'SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2 LIMIT 1',
			[Number(followerId), Number(followingId)],
		);
		return rows.length > 0;
	}

	async getFollowing(userId, limit = 100) {
		const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
		const { rows } = await this.pool.query(
			`SELECT u.id, u.name, u.scid, u.handle, u.icon_data FROM follows f
			 JOIN users u ON u.id = f.following_id
			 WHERE f.follower_id = $1
			 ORDER BY f.created_at DESC
			 LIMIT $2`,
			[Number(userId), safeLimit],
		);
		return rows.map((r) => ({
			id: Number(r.id),
			name: r.name,
			scid: r.scid || null,
			handle: r.handle,
			icon_data: r.icon_data || null,
		}));
	}

	async getFollowers(userId, limit = 100) {
		const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
		const { rows } = await this.pool.query(
			`SELECT u.id, u.name, u.scid, u.handle, u.icon_data FROM follows f
			 JOIN users u ON u.id = f.follower_id
			 WHERE f.following_id = $1
			 ORDER BY f.created_at DESC
			 LIMIT $2`,
			[Number(userId), safeLimit],
		);
		return rows.map((r) => ({
			id: Number(r.id),
			name: r.name,
			scid: r.scid || null,
			handle: r.handle,
			icon_data: r.icon_data || null,
		}));
	}

	async getFollowIds(userId) {
		const { rows } = await this.pool.query(
			`SELECT following_id FROM follows
			 WHERE follower_id = $1
			 ORDER BY created_at DESC, following_id ASC`,
			[Number(userId)],
		);
		return rows.map((row) => Number(row.following_id));
	}

	async getFollowRelationshipSnapshot(userId, candidateUserIds) {
		const normalizedUserId = Number(userId);
		const ids = [...new Set((candidateUserIds || [])
			.map(Number)
			.filter((id) => Number.isInteger(id) && id !== normalizedUserId))].slice(0, 500);
		if (!Number.isSafeInteger(normalizedUserId) || ids.length === 0) {
			return { followingIds: [], followerIds: [] };
		}

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
			[Number(userId)],
		);
		return Number(rows[0]?.count || 0);
	}

	async getFollowerCount(userId) {
		const { rows } = await this.pool.query(
			'SELECT COUNT(*)::int AS count FROM follows WHERE following_id = $1',
			[Number(userId)],
		);
		return Number(rows[0]?.count || 0);
	}

	// ==================== Notifications ====================

	async createNotification(notificationData) {
		const target = normalizeTarget(notificationData.target, {
			postId: notificationData.postId,
			open: notificationData.open,
		});
		const now = notificationData.createdAt ? toIsoString(notificationData.createdAt) : new Date().toISOString();
		const values = [
			Number(notificationData.userId),
			String(notificationData.type),
			notificationData.fromUserId != null ? Number(notificationData.fromUserId) : null,
			target?.kind === 'post' ? Number(target.id) : (notificationData.postId != null ? Number(notificationData.postId) : null),
			target ? JSON.stringify(target) : null,
			typeof notificationData.message === 'string' ? notificationData.message : null,
			now,
		];
		const { rows } = await this.pool.query(
			`INSERT INTO notifications
				 (user_id, type, from_user_id, post_id, target, message, read, clicked, created_at)
				 VALUES ($1, $2, $3, $4, $5::jsonb, $6, false, false, $7)
			 RETURNING *`,
			values,
		);
		const row = rows[0];
		if (!row) return null;
		return {
			id: Number(row.id),
			userId: Number(row.user_id),
			user_id: Number(row.user_id),
			type: row.type,
			fromUserId: row.from_user_id != null ? Number(row.from_user_id) : null,
			from_user_id: row.from_user_id != null ? Number(row.from_user_id) : null,
			postId: row.post_id != null ? Number(row.post_id) : null,
			post_id: row.post_id != null ? Number(row.post_id) : null,
			target: parseJsonSafe(row.target, null),
			message: row.message || null,
			read: Boolean(row.read),
			clicked: Boolean(row.clicked),
			createdAt: toIsoString(row.created_at),
			created_at: toIsoString(row.created_at),
		};
	}

	async getNotifications(userId, limit = 50, offset = 0) {
		const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
		const safeOffset = Math.max(Number(offset) || 0, 0);
		const { rows } = await this.pool.query(
			`SELECT * FROM notifications 
			 WHERE user_id = $1 
			 ORDER BY created_at DESC, id DESC
			 LIMIT $2 OFFSET $3`,
			[Number(userId), safeLimit, safeOffset],
		);
		return rows.map((r) => ({
			id: Number(r.id),
			userId: Number(r.user_id),
			user_id: Number(r.user_id),
			type: r.type,
			fromUserId: r.from_user_id != null ? Number(r.from_user_id) : null,
			from_user_id: r.from_user_id != null ? Number(r.from_user_id) : null,
			postId: r.post_id != null ? Number(r.post_id) : null,
			post_id: r.post_id != null ? Number(r.post_id) : null,
			target: parseJsonSafe(r.target, null),
			message: r.message || null,
			read: Boolean(r.read),
			clicked: Boolean(r.clicked),
			createdAt: toIsoString(r.created_at),
			created_at: toIsoString(r.created_at),
		}));
	}

	async markNotificationAsRead(notificationId) {
		await this.pool.query(
			'UPDATE notifications SET read = true WHERE id = $1',
			[Number(notificationId)],
		);
		return { success: true };
	}

	async markNotificationAsClicked(notificationId) {
		await this.pool.query(
			'UPDATE notifications SET clicked = true WHERE id = $1',
			[Number(notificationId)],
		);
		return { success: true };
	}

	async getNotificationById(notificationId) {
		const { rows } = await this.pool.query(
			'SELECT * FROM notifications WHERE id = $1',
			[Number(notificationId)],
		);
		const r = rows[0];
		if (!r) return null;
		return {
			id: Number(r.id),
			userId: Number(r.user_id),
			user_id: Number(r.user_id),
			type: r.type,
			fromUserId: r.from_user_id != null ? Number(r.from_user_id) : null,
			from_user_id: r.from_user_id != null ? Number(r.from_user_id) : null,
			postId: r.post_id != null ? Number(r.post_id) : null,
			post_id: r.post_id != null ? Number(r.post_id) : null,
			target: parseJsonSafe(r.target, null),
			message: r.message || null,
			read: Boolean(r.read),
			clicked: Boolean(r.clicked),
			createdAt: toIsoString(r.created_at),
			created_at: toIsoString(r.created_at),
		};
	}

	async markAllNotificationsAsRead(userId) {
		await this.pool.query(
			'UPDATE notifications SET read = true WHERE user_id = $1 AND read = false',
			[Number(userId)],
		);
		return { success: true };
	}

	async markAllNotificationsAsClicked(userId) {
		await this.pool.query(
			'UPDATE notifications SET read = true, clicked = true WHERE user_id = $1 AND (read = false OR clicked = false)',
			[Number(userId)],
		);
		return { success: true };
	}

	async deleteNotification(notificationId) {
		const { rowCount } = await this.pool.query(
			'DELETE FROM notifications WHERE id = $1',
			[Number(notificationId)],
		);
		return rowCount > 0;
	}

	async getUnreadNotificationCount(userId) {
		const { rows } = await this.pool.query(
			'SELECT COUNT(*)::int as count FROM notifications WHERE user_id = $1 AND read = false',
			[Number(userId)],
		);
		return Number(rows[0]?.count || 0);
	}

	// ==================== Moderation Reports ====================

	async createModerationReport(reportData) {
		const now = reportData.createdAt ? toIsoString(reportData.createdAt) : new Date().toISOString();
		const assignmentType = ['freeze_appeal', 'verification_application'].includes(reportData.assignmentType)
			? reportData.assignmentType
			: 'report';
		const { rows } = await this.pool.query(
			`INSERT INTO moderation_reports
				(reporter_user_id, target_kind, target_id, description, target_snapshot, assignment_type, status, excluded_admin_ids, created_at)
			 VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'pending', '[]'::jsonb, $7)
			 RETURNING *`,
			[
				Number(reportData.reporterUserId),
				String(reportData.targetKind),
				String(reportData.targetId),
				String(reportData.description || ''),
				JSON.stringify(reportData.targetSnapshot || {}),
				assignmentType,
				now,
			],
		);
		return normalizeModerationReportRow(rows[0]);
	}

	async getOpenModerationAppealByUserId(userId) {
		const { rows } = await this.pool.query(
			`SELECT * FROM moderation_reports
			 WHERE reporter_user_id = $1 AND assignment_type = 'freeze_appeal' AND status <> 'resolved'
			 ORDER BY created_at DESC LIMIT 1`,
			[Number(userId)],
		);
		return normalizeModerationReportRow(rows[0]);
	}

	async getOpenModerationVerificationByUserId(userId) {
		const { rows } = await this.pool.query(
			`SELECT * FROM moderation_reports
			 WHERE reporter_user_id = $1 AND assignment_type = 'verification_application' AND status <> 'resolved'
			 ORDER BY created_at DESC LIMIT 1`,
			[Number(userId)],
		);
		return normalizeModerationReportRow(rows[0]);
	}

	async getModerationReportById(reportId) {
		const { rows } = await this.pool.query(
			'SELECT * FROM moderation_reports WHERE id = $1 LIMIT 1',
			[Number(reportId)],
		);
		return normalizeModerationReportRow(rows[0]);
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
			[Number(adminId), status || null, limit, offset],
		);
		return rows.map(normalizeModerationReportRow);
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
		return this._withTransaction(async (client) => {
			const existingRes = await client.query('SELECT * FROM moderation_reports WHERE id = $1 FOR UPDATE', [Number(reportId)]);
			const existing = existingRes.rows[0];
			if (!existing || existing.status === 'resolved') return null;

			if (Object.prototype.hasOwnProperty.call(assignment, 'expectedAdminId') &&
				existing.assigned_admin_id !== null &&
				Number(existing.assigned_admin_id) !== Number(assignment.expectedAdminId)) {
				return null;
			}

			const rawExistingExcluded = Array.isArray(existing.excluded_admin_ids) ? existing.excluded_admin_ids : parseJsonSafe(existing.excluded_admin_ids, []);
			const excluded = [...new Set((Array.isArray(assignment.excludedAdminIds) ? assignment.excludedAdminIds : rawExistingExcluded)
				.map(Number)
				.filter(Number.isInteger))];
			const assignedAt = assignment.assignedAt ? toIsoString(assignment.assignedAt) : new Date().toISOString();

			const { rows } = await client.query(
				`UPDATE moderation_reports
				 SET status = 'assigned', assigned_admin_id = $2,
					 assigned_at = $3,
					 excluded_admin_ids = $4::jsonb
				 WHERE id = $1
				 RETURNING *`,
				[Number(reportId), Number(assignment.adminId), assignedAt, JSON.stringify(excluded)],
			);
			return normalizeModerationReportRow(rows[0]);
		});
	}

	async getOverdueModerationReports(cutoff) {
		const cutoffIso = toIsoString(cutoff);
		const { rows } = await this.pool.query(
			`SELECT * FROM moderation_reports
			 WHERE status = 'assigned' AND assigned_at IS NOT NULL AND assigned_at <= $1::timestamptz
			 ORDER BY assigned_at ASC`,
			[cutoffIso],
		);
		return rows.map(normalizeModerationReportRow);
	}

	async getUnassignedModerationReports(limit = 100) {
		const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 100));
		const { rows } = await this.pool.query(
			`SELECT * FROM moderation_reports
			 WHERE status = 'pending'
			 ORDER BY created_at ASC, id ASC LIMIT $1`,
			[safeLimit],
		);
		return rows.map(normalizeModerationReportRow);
	}

	async resolveModerationReport(reportId, adminId, resolution) {
		const now = new Date().toISOString();
		const { rows } = await this.pool.query(
			`UPDATE moderation_reports
			 SET status = 'resolved', resolution = $3::jsonb, resolved_at = $4
			 WHERE id = $1 AND assigned_admin_id = $2 AND status = 'assigned'
			 RETURNING *`,
			[Number(reportId), Number(adminId), JSON.stringify(resolution || {}), now],
		);
		return normalizeModerationReportRow(rows[0]);
	}

	async deleteModerationReport(reportId) {
		const result = await this.pool.query(
			'DELETE FROM moderation_reports WHERE id = $1',
			[Number(reportId)],
		);
		return result.rowCount > 0;
	}

	// ==================== Push Subscriptions ====================

	async upsertPushSubscription(userId, subscription) {
		const now = new Date().toISOString();
		const expTime = subscription.expirationTime ? new Date(Number(subscription.expirationTime)).toISOString() : null;
		const { rows } = await this.pool.query(
			`INSERT INTO push_subscriptions
				(user_id, endpoint, expiration_time, p256dh, auth, session_token, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
			 ON CONFLICT (user_id, endpoint)
			 DO UPDATE SET
				expiration_time = EXCLUDED.expiration_time,
				p256dh = EXCLUDED.p256dh,
				auth = EXCLUDED.auth,
				session_token = COALESCE(EXCLUDED.session_token, push_subscriptions.session_token),
				updated_at = EXCLUDED.updated_at
			 RETURNING *`,
			[
				Number(userId),
				String(subscription.endpoint),
				expTime,
				String(subscription.keys?.p256dh || ''),
				String(subscription.keys?.auth || ''),
				subscription.sessionToken ? String(subscription.sessionToken) : null,
				now,
			],
		);
		const r = rows[0];
		if (!r) return null;
		return {
			userId: Number(r.user_id),
			endpoint: r.endpoint,
			expirationTime: r.expiration_time ? new Date(r.expiration_time).getTime() : null,
			keys: { p256dh: r.p256dh, auth: r.auth },
			sessionToken: r.session_token || null,
		};
	}

	async getPushSubscriptions(userId) {
		const { rows } = await this.pool.query(
			`SELECT endpoint, expiration_time, p256dh, auth, session_token
			 FROM push_subscriptions
			 WHERE user_id = $1`,
			[Number(userId)],
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
			[Number(userId), String(endpoint)],
		);
		return result.rowCount > 0;
	}

	// ==================== User Account State & Batch Profile Data ====================

	async getUserAccountState(userId) {
		const { rows } = await this.pool.query(
			`SELECT
				COALESCE((
					SELECT array_agg(following_id ORDER BY created_at DESC, following_id ASC)
					FROM follows WHERE follower_id = $1
				), ARRAY[]::INTEGER[]) AS follow_ids,
				COALESCE((
					SELECT array_agg(post_id ORDER BY created_at DESC)
					FROM likes WHERE user_id = $1
				), ARRAY[]::INTEGER[]) AS like_ids,
				COALESCE((
					SELECT array_agg(post_id ORDER BY created_at DESC)
					FROM stars WHERE user_id = $1
				), ARRAY[]::INTEGER[]) AS star_ids,
				(
					SELECT post_id FROM pinned_posts WHERE user_id = $1
					ORDER BY created_at DESC LIMIT 1
				) AS pinned_post_id`,
			[Number(userId)],
		);
		const normalizeIds = (values) => (Array.isArray(values) ? values : [])
			.map(Number)
			.filter((id) => Number.isSafeInteger(id) && id > 0);
		const state = rows[0] || {};
		return {
			follow: normalizeIds(state.follow_ids),
			like: normalizeIds(state.like_ids),
			star: normalizeIds(state.star_ids),
			pin: state.pinned_post_id != null && Number.isSafeInteger(Number(state.pinned_post_id))
				? Number(state.pinned_post_id)
				: null,
		};
	}

	async getUserBootstrapData(userId, notificationLimit = 200) {
		const normalizedLimit = Math.min(Math.max(Number(notificationLimit) || 200, 1), 200);
		const { rows } = await this.pool.query(
			`WITH notification_rows AS MATERIALIZED (
				SELECT * FROM notifications
				WHERE user_id = $1
				ORDER BY created_at DESC, id DESC
				LIMIT $2
			), notification_users AS MATERIALIZED (
				SELECT DISTINCT u.*
				FROM users u
				JOIN notification_rows n ON n.from_user_id = u.id
			), notification_posts AS MATERIALIZED (
				SELECT DISTINCT p.id, p.content
				FROM posts p
				JOIN notification_rows n ON n.post_id = p.id
			)
			SELECT
				COALESCE((
					SELECT array_agg(following_id ORDER BY created_at DESC, following_id ASC)
					FROM follows WHERE follower_id = $1
				), ARRAY[]::INTEGER[]) AS follow_ids,
				COALESCE((
					SELECT array_agg(post_id ORDER BY created_at DESC)
					FROM likes WHERE user_id = $1
				), ARRAY[]::INTEGER[]) AS like_ids,
				COALESCE((
					SELECT array_agg(post_id ORDER BY created_at DESC)
					FROM stars WHERE user_id = $1
				), ARRAY[]::INTEGER[]) AS star_ids,
				(
					SELECT post_id FROM pinned_posts WHERE user_id = $1
					ORDER BY created_at DESC LIMIT 1
				) AS pinned_post_id,
				(SELECT COUNT(*)::int FROM notifications WHERE user_id = $1 AND read = false)
					AS unread_notification_count,
				COALESCE((SELECT jsonb_agg(to_jsonb(n) ORDER BY n.created_at DESC, n.id DESC) FROM notification_rows n), '[]'::jsonb)
					AS notifications,
				COALESCE((SELECT jsonb_agg(to_jsonb(u)) FROM notification_users u), '[]'::jsonb)
					AS notification_users,
				COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM notification_posts p), '[]'::jsonb)
					AS notification_posts`,
			[Number(userId), normalizedLimit],
		);
		const normalizeIds = (values) => (Array.isArray(values) ? values : [])
			.map(Number)
			.filter((id) => Number.isSafeInteger(id) && id > 0);
		const result = rows[0] || {};
		const rawNotifs = Array.isArray(result.notifications) ? result.notifications : parseJsonSafe(result.notifications, []);
		const rawUsers = Array.isArray(result.notification_users) ? result.notification_users : parseJsonSafe(result.notification_users, []);
		const rawPosts = Array.isArray(result.notification_posts) ? result.notification_posts : parseJsonSafe(result.notification_posts, []);

		return {
			follow: normalizeIds(result.follow_ids),
			like: normalizeIds(result.like_ids),
			star: normalizeIds(result.star_ids),
			pin: result.pinned_post_id != null && Number.isSafeInteger(Number(result.pinned_post_id))
				? Number(result.pinned_post_id)
				: null,
			unreadCount: Math.max(0, Number(result.unread_notification_count) || 0),
			notifications: rawNotifs.map((r) => ({
				id: Number(r.id),
				userId: Number(r.user_id),
				user_id: Number(r.user_id),
				type: r.type,
				fromUserId: r.from_user_id != null ? Number(r.from_user_id) : null,
				from_user_id: r.from_user_id != null ? Number(r.from_user_id) : null,
				postId: r.post_id != null ? Number(r.post_id) : null,
				post_id: r.post_id != null ? Number(r.post_id) : null,
				target: parseJsonSafe(r.target, null),
				message: r.message || null,
				read: Boolean(r.read),
				clicked: Boolean(r.clicked),
				createdAt: toIsoString(r.created_at),
				created_at: toIsoString(r.created_at),
			})),
			notificationUsers: rawUsers.map(normalizeUserRow).filter(Boolean),
			notificationPosts: rawPosts.filter(Boolean),
		};
	}

	async getPublicProfileStats(userId) {
		const { rows } = await this.pool.query(
			`SELECT
				(SELECT COUNT(*)::int FROM follows WHERE follower_id = $1) AS following_count,
				(SELECT COUNT(*)::int FROM follows WHERE following_id = $1) AS follower_count,
				(SELECT COUNT(*)::int FROM posts WHERE user_id = $1) AS post_count,
				(SELECT COUNT(*)::int FROM posts
					WHERE user_id = $1
						AND jsonb_typeof(attachments) = 'array'
						AND jsonb_array_length(attachments) > 0) AS media_count,
				(SELECT post_id FROM pinned_posts
					WHERE user_id = $1
					ORDER BY created_at DESC LIMIT 1) AS pinned_post_id`,
			[Number(userId)],
		);
		const stats = rows[0] || {};
		return {
			followingCount: Math.max(0, Number(stats.following_count) || 0),
			followerCount: Math.max(0, Number(stats.follower_count) || 0),
			postCount: Math.max(0, Number(stats.post_count) || 0),
			mediaCount: Math.max(0, Number(stats.media_count) || 0),
			pinnedPostId: stats.pinned_post_id == null ? null : Number(stats.pinned_post_id),
		};
	}

	// ==================== Rankings ====================

	async getRanking(type, limit = 50) {
		const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
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
					SELECT p.user_id, COUNT(*)::int AS like_count
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
					SELECT p.user_id, COUNT(*)::int AS star_count
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
		const { rows } = await this.pool.query(query, [safeLimit]);
		return rows.map((r) => ({
			user_id: Number(r.user_id),
			name: r.name,
			scid: r.scid || null,
			icon_data: r.icon_data || null,
			...(r.follower_count !== undefined ? { follower_count: Number(r.follower_count) } : {}),
			...(r.post_count !== undefined ? { post_count: Number(r.post_count) } : {}),
			...(r.like_count !== undefined ? { like_count: Number(r.like_count) } : {}),
			...(r.star_count !== undefined ? { star_count: Number(r.star_count) } : {}),
		}));
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
					SELECT p.user_id, COUNT(*)::int AS like_count
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
					SELECT p.user_id, COUNT(*)::int AS star_count
					FROM stars s
					JOIN posts p ON p.id = s.post_id
					GROUP BY p.user_id
				) s ON s.user_id = u.id
				GROUP BY u.id, s.star_count
			) t WHERE id = $1`;
		} else {
			throw new Error('Invalid ranking type');
		}
		const { rows } = await this.pool.query(query, [Number(userId)]);
		const metricField = type === 'followers' ? 'follower_count' : (type === 'posts' ? 'post_count' : (type === 'likes' ? 'like_count' : 'star_count'));
		return rows[0] ? {
			rank: Number(rows[0].rank),
			[metricField]: Number(rows[0][metricField] || 0),
		} : { rank: null, [metricField]: 0 };
	}

	// ==================== Logs ====================

	async addLog(entry) {
		const now = new Date().toISOString();
		const { rows } = await this.pool.query(
			`INSERT INTO logs (scratch_id, nyaitter_id, masked_ip_uuid, log_time)
			 VALUES ($1, $2, $3, $4)
			 RETURNING id`,
			[entry.scratch_id || '', entry.nyaitter_id != null ? Number(entry.nyaitter_id) : null, entry.masked_ip_uuid || '', now],
		);
		return rows[0] ? { id: Number(rows[0].id) } : { success: true };
	}

	async getLogs(limit = 20, offset = 0) {
		const normalizedLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
		const normalizedOffset = Math.max(0, Number(offset) || 0);
		const { rows } = await this.pool.query(
			`SELECT * FROM logs
			 ORDER BY log_time DESC, id DESC
			 LIMIT $1 OFFSET $2`,
			[normalizedLimit, normalizedOffset],
		);
		return rows.map((r) => ({
			id: Number(r.id),
			scratch_id: r.scratch_id,
			nyaitter_id: r.nyaitter_id != null ? Number(r.nyaitter_id) : null,
			masked_ip_uuid: r.masked_ip_uuid,
			log_time: toIsoString(r.log_time),
		}));
	}
}

module.exports = PostgresAdapter;
