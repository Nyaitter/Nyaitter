function json(data, status = 200, headers = {}) {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': 'no-store',
			...headers,
		},
	});
}

function badRequest(message = 'Bad Request') {
	return json({ error: message }, 400);
}

function unauthorized(message = 'Unauthorized') {
	return json({ error: message }, 401);
}

function notFound(message = 'Not Found') {
	return json({ error: message }, 404);
}

function internalError(error) {
	console.error('[d1-proxy] Internal Error:', error);
	// D1/SQLiteの詳細や内部実装を呼び出し元へ露出しない。
	return json({ error: 'Internal Server Error' }, 500);
}

function formatNyaitterId(id) {
	const num = Number(id);
	if (!Number.isSafeInteger(num) || num < 0) return '#0000';
	return `#${String(num).padStart(4, '0')}`;
}

async function secureTokenEqual(provided, expected) {
	const enc = new TextEncoder();
	const [a, b] = await Promise.all([
		crypto.subtle.digest('SHA-256', enc.encode(String(provided))),
		crypto.subtle.digest('SHA-256', enc.encode(String(expected))),
	]);
	const aBytes = new Uint8Array(a);
	const bBytes = new Uint8Array(b);
	let diff = 0;
	for (let i = 0; i < aBytes.length; i += 1) {
		diff |= aBytes[i] ^ bBytes[i];
	}
	return diff === 0;
}

// Fail-closed: when AUTH_TOKEN is not configured the proxy must refuse all
// requests. A token that was never set must never be treated as "no auth".
async function requireAuth(request, env) {
	const expected = env.AUTH_TOKEN;
	if (!expected) {
		return false;
	}
	const authHeader = request.headers.get('Authorization') || '';
	const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
	if (!token) {
		return false;
	}
	return secureTokenEqual(token, expected);
}

function parseJsonSafe(value, fallback = null) {
	if (!value) return fallback;
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value);
	} catch (_) {
		return fallback;
	}
}

function normalizeBlockUserId(value) {
	if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
		return null;
	}
	const id = Number(value);
	return Number.isInteger(id) && id >= 0 ? id : null;
}

function normalizeBlockList(value, ownerUserId = null) {
	const ownerId = normalizeBlockUserId(ownerUserId);
	if (!Array.isArray(value)) return [];
	return [...new Set(value
		.map(normalizeBlockUserId)
		.filter((id) => id !== null && id !== ownerId))]
		.sort((left, right) => left - right);
}

function normalizeUserRow(row) {
	if (!row) return null;
	return {
		id: row.id,
		scid: row.scid || null,
		name: row.name || '',
		handle: row.handle || formatNyaitterId(row.id),
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
		block: normalizeBlockList(parseJsonSafe(row.block, []), row.id),
		created_at: row.created_at,
	};
}

function normalizePostRow(row) {
	if (!row) return null;
	return {
		id: row.id,
		userId: row.user_id,
		user_id: row.user_id,
		content: row.content || '',
		attachments: parseJsonSafe(row.attachments, []),
		mask: Boolean(row.mask),
		lock: Boolean(row.lock),
		announcement: Boolean(row.announcement),
		replyTo: row.reply_to || null,
		reply_to: row.reply_to || null,
		repostTo: row.repost_to || null,
		repost_to: row.repost_to || null,
		createdAt: row.created_at,
		created_at: row.created_at,
	};
}

function normalizeGroupDmRow(row, viewerId = null) {
	if (!row) return null;
	const member = parseJsonSafe(row.member, []);
	const unread = parseJsonSafe(row.unread, {});
	const post = parseJsonSafe(row.post, []);
	const res = {
		id: row.id,
		host_id: row.host_id,
		title: row.title || '',
		member: Array.isArray(member) ? member.map(Number) : [],
		unread,
		post: Array.isArray(post) ? post : [],
		time: row.time,
		created_at: row.created_at,
	};
	if (viewerId != null) {
		res.unread_count = Number(unread[viewerId] ?? unread[String(viewerId)] ?? 0);
	}
	return res;
}

export default {
	async fetch(request, env, ctx) {
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: {
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
					'Access-Control-Allow-Headers': 'Content-Type, Authorization',
				},
			});
		}

		if (!(await requireAuth(request, env))) {
			return unauthorized('Authentication required');
		}

		const db = env.DB;
		if (!db) {
			return internalError(new Error('D1 binding DB is not configured'));
		}

		const url = new URL(request.url);
		const pathname = url.pathname;
		const method = request.method;

		try {

			if (method === 'POST' && pathname === '/sessions') {
				const body = await request.json();
				const userId = Number(body.userId);
				const token = body.token || crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
				const sessionId = body.sessionId || crypto.randomUUID();
				const expiresAt = body.expiresAt || new Date(Date.now() + 30 * 86400000).toISOString();
				const ipHash = body.ipHash || null;
				const ipMasked = body.ipMasked || '不明なIPアドレス';
				const userAgent = body.userAgent || '不明な端末';
				const createdAt = new Date().toISOString();

				await db.prepare(
					`INSERT INTO sessions (session_id, token, user_id, ip_hash, ip_masked, user_agent, expires_at, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
				).bind(sessionId, token, userId, ipHash, ipMasked, userAgent, expiresAt, createdAt).run();

				return json({
					session_id: sessionId,
					token,
					user_id: userId,
					ip_hash: ipHash,
					ip_masked: ipMasked,
					user_agent: userAgent,
					expires_at: expiresAt,
					created_at: createdAt,
				});
			}

			if (method === 'GET' && pathname.startsWith('/sessions/token/')) {
				const token = decodeURIComponent(pathname.slice('/sessions/token/'.length));
				const now = new Date().toISOString();
				const row = await db.prepare(
					`SELECT * FROM sessions WHERE token = ? AND expires_at > ? LIMIT 1`
				).bind(token, now).first();

				if (!row) {
					// Clean up expired sessions asynchronously
					ctx?.waitUntil?.(db.prepare('DELETE FROM sessions WHERE token = ? AND expires_at <= ?').bind(token, now).run());
					return json(null);
				}
				return json(row);
			}

			if (method === 'POST' && pathname === '/sessions/invalidate') {
				const body = await request.json();
				const token = String(body.token || '');
				const res = await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
				return json({ success: res.meta.changes > 0 });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/sessions$/)) {
				const userId = Number(pathname.split('/')[2]);
				const now = new Date().toISOString();
				const { results } = await db.prepare(
					`SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC`
				).bind(userId, now).all();
				return json(results || []);
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/sessions\/invalidate-all$/)) {
				const userId = Number(pathname.split('/')[2]);
				const res = await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
				return json({ count: res.meta.changes });
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/sessions\/invalidate-ip$/)) {
				const userId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const ipHash = String(body.ipHash || '');
				const res = await db.prepare('DELETE FROM sessions WHERE user_id = ? AND ip_hash = ?').bind(userId, ipHash).run();
				return json({ count: res.meta.changes });
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/trusted-ips$/)) {
				const userId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const ipHash = String(body.ipHash);
				const ipMasked = String(body.ipMasked || '不明なIPアドレス');
				const now = new Date().toISOString();

				await db.prepare(
					`INSERT INTO trusted_login_ips (user_id, ip_hash, ip_masked, created_at, last_used_at)
					 VALUES (?, ?, ?, ?, ?)
					 ON CONFLICT(user_id, ip_hash) DO UPDATE SET ip_masked = excluded.ip_masked, last_used_at = excluded.last_used_at`
				).bind(userId, ipHash, ipMasked, now, now).run();

				return json({ userId, ipHash, ipMasked, createdAt: now, lastUsedAt: now });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/trusted-ips\/count$/)) {
				const userId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT COUNT(*) as count FROM trusted_login_ips WHERE user_id = ?').bind(userId).first();
				return json({ count: Number(row?.count || 0) });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/trusted-ips\/([^/]+)$/)) {
				const parts = pathname.split('/');
				const userId = Number(parts[2]);
				const ipHash = decodeURIComponent(parts[4]);
				const row = await db.prepare('SELECT * FROM trusted_login_ips WHERE user_id = ? AND ip_hash = ?').bind(userId, ipHash).first();
				if (!row) return json(null);
				return json({ userId: row.user_id, ipHash: row.ip_hash, ipMasked: row.ip_masked, createdAt: row.created_at, lastUsedAt: row.last_used_at });
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/trusted-ips\/([^/]+)\/revoke$/)) {
				const parts = pathname.split('/');
				const userId = Number(parts[2]);
				const ipHash = decodeURIComponent(parts[4]);
				const res = await db.prepare('DELETE FROM trusted_login_ips WHERE user_id = ? AND ip_hash = ?').bind(userId, ipHash).run();
				return json({ success: res.meta.changes > 0 });
			}

			if (method === 'POST' && pathname === '/login-approvals') {
				const body = await request.json();
				const id = body.id || crypto.randomUUID();
				const userId = Number(body.userId);
				const ipHash = body.ipHash || null;
				const ipMasked = body.ipMasked || '不明なIPアドレス';
				const userAgent = body.userAgent || '不明な端末';
				const pollTokenHash = String(body.pollTokenHash);
				const expiresAt = body.expiresAt || new Date(Date.now() + 10 * 60000).toISOString();
				const createdAt = new Date().toISOString();

				await db.prepare(
					`INSERT INTO login_approvals (id, user_id, ip_hash, ip_masked, user_agent, poll_token_hash, status, expires_at, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
				).bind(id, userId, ipHash, ipMasked, userAgent, pollTokenHash, expiresAt, createdAt).run();

				return json({ id, userId, ipHash, ipMasked, userAgent, pollTokenHash, status: 'pending', expiresAt, createdAt });
			}

			if (method === 'GET' && pathname.match(/^\/login-approvals\/([^/]+)$/)) {
				const id = decodeURIComponent(pathname.split('/')[2]);
				const now = new Date().toISOString();
				await db.prepare("UPDATE login_approvals SET status = 'expired' WHERE id = ? AND status = 'pending' AND expires_at <= ?").bind(id, now).run();
				const row = await db.prepare('SELECT * FROM login_approvals WHERE id = ?').bind(id).first();
				return json(row || null);
			}

			if (method === 'POST' && pathname.match(/^\/login-approvals\/([^/]+)\/poll$/)) {
				const id = decodeURIComponent(pathname.split('/')[2]);
				const body = await request.json();
				const now = new Date().toISOString();
				await db.prepare("UPDATE login_approvals SET status = 'expired' WHERE id = ? AND status = 'pending' AND expires_at <= ?").bind(id, now).run();
				const row = await db.prepare('SELECT * FROM login_approvals WHERE id = ? AND poll_token_hash = ?').bind(id, String(body.pollTokenHash)).first();
				return json(row || null);
			}

			if (method === 'POST' && pathname.match(/^\/login-approvals\/([^/]+)\/decision$/)) {
				const id = decodeURIComponent(pathname.split('/')[2]);
				const body = await request.json();
				const userId = Number(body.userId);
				const decision = body.decision === 'approve' ? 'approved' : 'denied';
				const now = new Date().toISOString();

				const res = await db.prepare(
					`UPDATE login_approvals SET status = ?, decided_at = ?
					 WHERE id = ? AND user_id = ? AND status = 'pending' AND expires_at > ?`
				).bind(decision, now, id, userId, now).run();

				if (res.meta.changes > 0) {
					const row = await db.prepare('SELECT * FROM login_approvals WHERE id = ?').bind(id).first();
					return json(row);
				}
				const existing = await db.prepare('SELECT * FROM login_approvals WHERE id = ?').bind(id).first();
				return json(existing && Number(existing.user_id) === userId ? existing : null);
			}

			if (method === 'POST' && pathname.match(/^\/login-approvals\/([^/]+)\/consume$/)) {
				const id = decodeURIComponent(pathname.split('/')[2]);
				const body = await request.json();
				const now = new Date().toISOString();

				await db.prepare(
					`UPDATE login_approvals SET status = 'consumed', consumed_at = ?
					 WHERE id = ? AND poll_token_hash = ? AND status = 'approved' AND expires_at > ?`
				).bind(now, id, String(body.pollTokenHash), now).run();

				const row = await db.prepare('SELECT * FROM login_approvals WHERE id = ?').bind(id).first();
				return json(row || null);
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/bot-tokens$/)) {
				const userId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const tokenId = String(body.tokenId);
				const tokenHash = String(body.tokenHash);
				const name = String(body.name || '');
				const createdAt = new Date().toISOString();

				await db.prepare(
					`INSERT INTO bot_tokens (token_id, token_hash, user_id, name, created_at)
					 VALUES (?, ?, ?, ?, ?)`
				).bind(tokenId, tokenHash, userId, name, createdAt).run();

				return json({ tokenId, tokenHash, userId, name, createdAt, lastUsedAt: null });
			}

			if (method === 'GET' && pathname.startsWith('/bot-tokens/')) {
				const tokenId = decodeURIComponent(pathname.slice('/bot-tokens/'.length));
				const row = await db.prepare('SELECT * FROM bot_tokens WHERE token_id = ?').bind(tokenId).first();
				return json(row ? { tokenId: row.token_id, tokenHash: row.token_hash, userId: row.user_id, name: row.name, createdAt: row.created_at, lastUsedAt: row.last_used_at } : null);
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/bot-tokens$/)) {
				const userId = Number(pathname.split('/')[2]);
				const { results } = await db.prepare('SELECT * FROM bot_tokens WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all();
				return json((results || []).map((r) => ({ tokenId: r.token_id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at })));
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/bot-tokens\/([^/]+)\/revoke$/)) {
				const parts = pathname.split('/');
				const userId = Number(parts[2]);
				const tokenId = decodeURIComponent(parts[4]);
				const res = await db.prepare('DELETE FROM bot_tokens WHERE user_id = ? AND token_id = ?').bind(userId, tokenId).run();
				return json({ success: res.meta.changes > 0 });
			}

			if (method === 'POST' && pathname.match(/^\/bot-tokens\/([^/]+)\/last-used$/)) {
				const tokenId = decodeURIComponent(pathname.split('/')[2]);
				const now = new Date().toISOString();
				await db.prepare('UPDATE bot_tokens SET last_used_at = ? WHERE token_id = ?').bind(now, tokenId).run();
				return json({ success: true });
			}

			if (method === 'GET' && pathname.startsWith('/users/scid/')) {
				const scid = decodeURIComponent(pathname.slice('/users/scid/'.length));
				const row = await db.prepare('SELECT * FROM users WHERE LOWER(scid) = LOWER(?) LIMIT 1').bind(scid).first();
				return json(normalizeUserRow(row));
			}

			if (method === 'GET' && pathname.startsWith('/users/address/')) {
				const address = decodeURIComponent(pathname.slice('/users/address/'.length));
				const row = await db.prepare('SELECT * FROM users WHERE nyaitter_address = ? LIMIT 1').bind(address).first();
				return json(normalizeUserRow(row));
			}

			if (method === 'POST' && pathname === '/users/external') {
				const body = await request.json();
				const providerDomain = body.providerDomain;
				const externalId = String(body.externalId);
				const profile = body.profile || {};
				const address = `#${externalId}@${providerDomain}`;

				let row = await db.prepare('SELECT * FROM users WHERE nyaitter_address = ? LIMIT 1').bind(address).first();
				if (row) return json(normalizeUserRow(row));

				const handle = formatNyaitterId(externalId);
				const countRow = await db.prepare('SELECT COUNT(*) as count FROM users').first();
				const count = Number(countRow?.count || 0);
				const digits = Math.max(4, String(Math.max(count, 1)).length);
				const id = Math.floor(Math.random() * (10 ** digits));
				const now = new Date().toISOString();

				await db.prepare(
						`INSERT INTO users (id, scid, name, handle, nyaitter_address, auth_provider, provider_domain, external_id, external_profile, block, bio, header_image, icon_data, created_at)
						 VALUES (?, ?, ?, ?, ?, 'nyaitter', ?, ?, ?, ?, ?, ?, ?, ?)`
					).bind(
						id, null, profile.name || handle, handle, address, providerDomain, externalId,
						JSON.stringify(profile.external_profile || profile),
						JSON.stringify(normalizeBlockList(profile.block, id)),
						profile.bio || profile.me || '', profile.header_image || null,
						profile.icon_data || null, now
					).run();

				const created = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
				return json(normalizeUserRow(created));
			}

			if (method === 'POST' && pathname === '/users') {
				const userData = await request.json();
				const provider = userData.auth_provider || 'local';

				for (let attempt = 0; attempt < 20; attempt += 1) {
					const countRow = await db.prepare('SELECT COUNT(*) as count FROM users').first();
					const count = Number(countRow?.count || 0);
					const digits = Math.max(4, String(Math.max(count, 1)).length);
					const id = Math.floor(Math.random() * (10 ** digits));
					const handle = provider === 'nyaitter' && userData.external_id != null
						? formatNyaitterId(userData.external_id)
						: formatNyaitterId(id);
					const address = userData.nyaitter_address || null;
					const now = new Date().toISOString();

					try {
						await db.prepare(
							`INSERT INTO users (id, scid, name, handle, nyaitter_address, auth_provider, provider_domain, external_id, external_profile, uuid, settings, block, bio, header_image, icon_data, created_at)
							 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
						).bind(
							id, userData.scid || null, userData.name || userData.scid || handle, handle, address,
							provider, userData.provider_domain || null, userData.external_id || null,
							userData.external_profile ? JSON.stringify(userData.external_profile) : null,
							userData.uuid || null, userData.settings ? JSON.stringify(userData.settings) : '{}',
							JSON.stringify(normalizeBlockList(userData.block, id)),
							userData.bio || userData.me || '', userData.header_image || null,
							userData.icon_data || null, now
						).run();

						const created = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
						return json(normalizeUserRow(created));
					} catch (err) {
						if (String(err).includes('UNIQUE') || String(err).includes('PRIMARY KEY')) continue;
						throw err;
					}
				}
				return badRequest('Could not allocate unique Nyaitter ID');
			}

			if (method === 'GET' && pathname === '/users/search') {
				const q = url.searchParams.get('q') || '';
				const limit = Math.min(Number(url.searchParams.get('limit') || 20), 100);
				const queryPattern = `%${q.toLowerCase()}%`;
				const digits = q.replace(/^#/, '').replace(/\D/g, '');

				const { results } = await db.prepare(
					`SELECT id, name, scid, handle, nyaitter_address, auth_provider, provider_domain, external_id, icon_data
					 FROM users
					 WHERE LOWER(COALESCE(scid, '')) LIKE ?
					    OR LOWER(COALESCE(name, '')) LIKE ?
					    OR LOWER(COALESCE(handle, '')) LIKE ?
					    OR CAST(id AS TEXT) LIKE ?
					 ORDER BY id DESC LIMIT ?`
				).bind(queryPattern, queryPattern, queryPattern, digits ? `%${digits}%` : queryPattern, limit).all();

				return json((results || []).map(normalizeUserRow));
			}

			if (method === 'POST' && pathname === '/users/batch') {
				const body = await request.json();
				const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isSafeInteger) : [];
				if (ids.length === 0) return json([]);

				const placeholders = ids.map(() => '?').join(', ');
				const { results } = await db.prepare(
					`SELECT * FROM users WHERE id IN (${placeholders})`
				).bind(...ids).all();

				return json((results || []).map(normalizeUserRow));
			}

			if (method === 'GET' && pathname === '/users') {
				const { results } = await db.prepare('SELECT * FROM users ORDER BY id ASC').all();
				return json((results || []).map(normalizeUserRow));
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/status$/)) {
				const userId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT shadow FROM users WHERE id = ?').bind(userId).first();
				return json(row ? { shadow: Boolean(row.shadow) } : null);
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/status$/)) {
				const userId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const shadow = Boolean(body.shadow);
				await db.prepare('UPDATE users SET shadow = ? WHERE id = ?').bind(shadow ? 1 : 0, userId).run();
				return json({ shadow });
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/profile$/)) {
				const userId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const sets = [];
				const values = [];

				if (body.name !== undefined) { sets.push('name = ?'); values.push(body.name); }
				if (body.bio !== undefined) { sets.push('bio = ?'); values.push(body.bio); }
				else if (body.me !== undefined) { sets.push('bio = ?'); values.push(body.me); }
				if (body.header_image !== undefined) { sets.push('header_image = ?'); values.push(body.header_image); }
				if (body.icon_data !== undefined) { sets.push('icon_data = ?'); values.push(body.icon_data); }
				if (body.settings !== undefined) { sets.push('settings = ?'); values.push(JSON.stringify(body.settings || {})); }
				if (body.block !== undefined) { sets.push('block = ?'); values.push(JSON.stringify(normalizeBlockList(body.block, userId))); }
				if (body.verify !== undefined) { sets.push('verify = ?'); values.push(body.verify ? 1 : 0); }
				if (body.freeze !== undefined) { sets.push('freeze = ?'); values.push(body.freeze || null); }
				if (body.admin !== undefined) { sets.push('admin = ?'); values.push(body.admin ? 1 : 0); }
				if (body.shadow !== undefined) { sets.push('shadow = ?'); values.push(body.shadow ? 1 : 0); }

				if (sets.length > 0) {
					values.push(userId);
					await db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
				}
				const row = await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
				return json(normalizeUserRow(row));
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)$/)) {
				const userId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
				return json(normalizeUserRow(row));
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/follow$/)) {
				const followingId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const followerId = Number(body.followerId);

				const existing = await db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?').bind(followerId, followingId).first();
				if (existing) {
					await db.prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?').bind(followerId, followingId).run();
					return json({ following: false });
				}
				const now = new Date().toISOString();
				await db.prepare('INSERT INTO follows (follower_id, following_id, created_at) VALUES (?, ?, ?)').bind(followerId, followingId, now).run();
				return json({ following: true });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/is-following$/)) {
				const followingId = Number(pathname.split('/')[2]);
				const followerId = Number(url.searchParams.get('followerId'));
				const existing = await db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?').bind(followerId, followingId).first();
				return json({ following: Boolean(existing) });
			}

			if (method === 'POST' && pathname === '/users/follow-relationships') {
				const body = await request.json();
				const userId = Number(body?.userId);
				const candidateIds = [...new Set((Array.isArray(body?.candidateIds) ? body.candidateIds : [])
					.map(Number)
					.filter((id) => Number.isSafeInteger(id) && id >= 0 && id !== userId))].slice(0, 500);
				if (!Number.isSafeInteger(userId) || userId < 0 || candidateIds.length === 0) {
					return json({ following_ids: [], follower_ids: [] });
				}
				const placeholders = candidateIds.map(() => '?').join(', ');
				const { results } = await db.prepare(
					`SELECT following_id AS user_id, 'following' AS direction
					 FROM follows
					 WHERE follower_id = ? AND following_id IN (${placeholders})
					 UNION ALL
					 SELECT follower_id AS user_id, 'follower' AS direction
					 FROM follows
					 WHERE following_id = ? AND follower_id IN (${placeholders})`
				).bind(userId, ...candidateIds, userId, ...candidateIds).all();
				const following_ids = [];
				const follower_ids = [];
				for (const row of results || []) {
					if (row.direction === 'following') following_ids.push(Number(row.user_id));
					if (row.direction === 'follower') follower_ids.push(Number(row.user_id));
				}
				return json({ following_ids, follower_ids });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/following$/)) {
				const userId = Number(pathname.split('/')[2]);
				const limit = Math.min(Number(url.searchParams.get('limit') || 100), 500);
				const { results } = await db.prepare(
					`SELECT u.id, u.name, u.scid, u.handle, u.icon_data
					 FROM follows f JOIN users u ON u.id = f.following_id
					 WHERE f.follower_id = ? ORDER BY f.created_at DESC LIMIT ?`
				).bind(userId, limit).all();
				return json(results || []);
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/followers$/)) {
				const userId = Number(pathname.split('/')[2]);
				const limit = Math.min(Number(url.searchParams.get('limit') || 100), 500);
				const { results } = await db.prepare(
					`SELECT u.id, u.name, u.scid, u.handle, u.icon_data
					 FROM follows f JOIN users u ON u.id = f.follower_id
					 WHERE f.following_id = ? ORDER BY f.created_at DESC LIMIT ?`
				).bind(userId, limit).all();
				return json(results || []);
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/following\/count$/)) {
				const userId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT COUNT(*) as count FROM follows WHERE follower_id = ?').bind(userId).first();
				return json({ count: Number(row?.count || 0) });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/followers\/count$/)) {
				const userId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT COUNT(*) as count FROM follows WHERE following_id = ?').bind(userId).first();
				return json({ count: Number(row?.count || 0) });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/following\/ids$/)) {
				const userId = Number(pathname.split('/')[2]);
				const { results } = await db.prepare('SELECT following_id FROM follows WHERE follower_id = ?').bind(userId).all();
				return json((results || []).map((r) => r.following_id));
			}

			if (method === 'POST' && pathname === '/posts') {
				const postData = await request.json();
				const userId = Number(postData.userId);
				const content = postData.content || '';
				const attachments = postData.attachments ? JSON.stringify(postData.attachments) : null;
				const mask = postData.mask ? 1 : 0;
					const lock = postData.lock ? 1 : 0;
					const announcement = postData.announcement ? 1 : 0;
					const replyTo = postData.replyTo ? Number(postData.replyTo) : null;
				const repostTo = postData.repostTo ? Number(postData.repostTo) : null;
				const now = new Date().toISOString();

				const res = await db.prepare(
						`INSERT INTO posts (user_id, content, attachments, mask, lock, announcement, reply_to, repost_to, created_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
					).bind(userId, content, attachments, mask, lock, announcement, replyTo, repostTo, now).run();

				const created = await db.prepare('SELECT * FROM posts WHERE id = ?').bind(res.meta.last_row_id).first();
				return json(normalizePostRow(created));
			}

			if (method === 'POST' && pathname === '/posts/batch') {
				const body = await request.json();
				const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isSafeInteger) : [];
				if (ids.length === 0) return json([]);

				const placeholders = ids.map(() => '?').join(', ');
				const { results } = await db.prepare(`SELECT * FROM posts WHERE id IN (${placeholders})`).bind(...ids).all();
				return json((results || []).map(normalizePostRow));
			}

			if (method === 'POST' && pathname === '/posts/metrics/batch') {
				const body = await request.json();
				const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isSafeInteger) : [];
				const currentUserId = body.currentUserId != null ? Number(body.currentUserId) : null;
				if (ids.length === 0) return json([]);

				const placeholders = ids.map(() => '?').join(', ');
				const [likeRes, starRes, repostRes, replyRes, myLikesRes, myStarsRes] = await Promise.all([
					db.prepare(`SELECT post_id, COUNT(*) as count FROM likes WHERE post_id IN (${placeholders}) GROUP BY post_id`).bind(...ids).all(),
					db.prepare(`SELECT post_id, COUNT(*) as count FROM stars WHERE post_id IN (${placeholders}) GROUP BY post_id`).bind(...ids).all(),
					db.prepare(`SELECT post_id, COUNT(*) as count FROM reposts WHERE post_id IN (${placeholders}) GROUP BY post_id`).bind(...ids).all(),
					db.prepare(`SELECT reply_to as post_id, COUNT(*) as count FROM posts WHERE reply_to IN (${placeholders}) GROUP BY reply_to`).bind(...ids).all(),
					currentUserId ? db.prepare(`SELECT post_id FROM likes WHERE user_id = ? AND post_id IN (${placeholders})`).bind(currentUserId, ...ids).all() : { results: [] },
					currentUserId ? db.prepare(`SELECT post_id FROM stars WHERE user_id = ? AND post_id IN (${placeholders})`).bind(currentUserId, ...ids).all() : { results: [] },
				]);

				const likeMap = new Map((likeRes.results || []).map((r) => [r.post_id, Number(r.count)]));
				const starMap = new Map((starRes.results || []).map((r) => [r.post_id, Number(r.count)]));
				const repostMap = new Map((repostRes.results || []).map((r) => [r.post_id, Number(r.count)]));
				const replyMap = new Map((replyRes.results || []).map((r) => [r.post_id, Number(r.count)]));
				const myLikesSet = new Set((myLikesRes.results || []).map((r) => r.post_id));
				const myStarsSet = new Set((myStarsRes.results || []).map((r) => r.post_id));

				const metrics = ids.map((id) => ({
					post_id: id,
					like_count: likeMap.get(id) || 0,
					star_count: starMap.get(id) || 0,
					repost_count: repostMap.get(id) || 0,
					reply_count: replyMap.get(id) || 0,
					liked_by_me: myLikesSet.has(id),
					starred_by_me: myStarsSet.has(id),
				}));
				return json(metrics);
			}

			if (method === 'POST' && pathname.match(/^\/posts\/(\d+)$/)) {
				const postId = Number(pathname.split('/')[2]);
				const fields = await request.json();
				const sets = [];
				const values = [];

				if (fields.content !== undefined) { sets.push('content = ?'); values.push(fields.content); }
				if (fields.attachments !== undefined) { sets.push('attachments = ?'); values.push(fields.attachments ? JSON.stringify(fields.attachments) : null); }
				if (fields.mask !== undefined) { sets.push('mask = ?'); values.push(fields.mask ? 1 : 0); }
				if (fields.lock !== undefined) { sets.push('lock = ?'); values.push(fields.lock ? 1 : 0); }

				if (sets.length > 0) {
					values.push(postId);
					await db.prepare(`UPDATE posts SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
				}
				const row = await db.prepare('SELECT * FROM posts WHERE id = ?').bind(postId).first();
				return json(normalizePostRow(row));
			}

			if (method === 'POST' && pathname.match(/^\/posts\/(\d+)\/delete$/)) {
				const postId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const userId = Number(body.userId);

				const post = await db.prepare('SELECT user_id FROM posts WHERE id = ?').bind(postId).first();
				if (!post || Number(post.user_id) !== userId) {
					return json({ success: false });
				}
				await db.prepare('DELETE FROM likes WHERE post_id = ?').bind(postId).run();
				await db.prepare('DELETE FROM stars WHERE post_id = ?').bind(postId).run();
				await db.prepare('DELETE FROM reposts WHERE post_id = ?').bind(postId).run();
				await db.prepare('DELETE FROM pinned_posts WHERE post_id = ?').bind(postId).run();
				await db.prepare('DELETE FROM posts WHERE id = ?').bind(postId).run();
				return json({ success: true });
			}

			if (method === 'POST' && pathname.match(/^\/posts\/(\d+)\/admin-delete$/)) {
				const postId = Number(pathname.split('/')[2]);
				await db.prepare('DELETE FROM likes WHERE post_id = ?').bind(postId).run();
				await db.prepare('DELETE FROM stars WHERE post_id = ?').bind(postId).run();
				await db.prepare('DELETE FROM reposts WHERE post_id = ?').bind(postId).run();
				await db.prepare('DELETE FROM pinned_posts WHERE post_id = ?').bind(postId).run();
				await db.prepare('DELETE FROM posts WHERE id = ?').bind(postId).run();
				return json({ success: true });
			}

			if (method === 'GET' && pathname === '/posts/recent') {
				const limit = Math.min(Number(url.searchParams.get('limit') || 30), 100);
				const { results } = await db.prepare('SELECT * FROM posts WHERE reply_to IS NULL ORDER BY created_at DESC, id DESC LIMIT ?').bind(limit).all();
				return json((results || []).map(normalizePostRow));
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/posts$/)) {
				const userId = Number(pathname.split('/')[2]);
				const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100);
				const { results } = await db.prepare('SELECT * FROM posts WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').bind(userId, limit).all();
				return json((results || []).map(normalizePostRow));
			}

			if (method === 'POST' && pathname === '/posts/timeline/ids') {
				const body = await request.json();
				const tab = body.tab || 'foryou';
				const followIds = Array.isArray(body.followIds) ? body.followIds.map(Number).filter(Number.isSafeInteger) : [];
				const limit = Math.min(Number(body.limit || 30), 100);
				const beforeId = Number.isSafeInteger(Number(body.beforeId)) && Number(body.beforeId) > 0
					? Number(body.beforeId)
					: null;
				const offset = beforeId == null ? Number(body.offset || 0) : 0;

				let results = [];
				if (tab === 'following') {
					if (followIds.length === 0) return json({ ids: [], has_more: false });
					const placeholders = followIds.map(() => '?').join(', ');
					const queryRes = beforeId != null
						? await db.prepare(
							`SELECT id FROM posts WHERE user_id IN (${placeholders}) AND reply_to IS NULL AND id < ? ORDER BY created_at DESC, id DESC LIMIT ?`
						).bind(...followIds, beforeId, limit + 1).all()
						: await db.prepare(
							`SELECT id FROM posts WHERE user_id IN (${placeholders}) AND reply_to IS NULL ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
						).bind(...followIds, limit + 1, offset).all();
					results = queryRes.results || [];
				} else if (tab === 'announce') {
					const queryRes = beforeId != null
						? await db.prepare(
							`SELECT id FROM posts WHERE announcement = 1 AND reply_to IS NULL AND id < ? ORDER BY created_at DESC, id DESC LIMIT ?`
						).bind(beforeId, limit + 1).all()
						: await db.prepare(
							`SELECT id FROM posts WHERE announcement = 1 AND reply_to IS NULL ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
						).bind(limit + 1, offset).all();
					results = queryRes.results || [];
				} else {
					const queryRes = beforeId != null
						? await db.prepare(
							`SELECT id FROM posts WHERE reply_to IS NULL AND id < ? ORDER BY created_at DESC, id DESC LIMIT ?`
						).bind(beforeId, limit + 1).all()
						: await db.prepare(
							`SELECT id FROM posts WHERE reply_to IS NULL ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
						).bind(limit + 1, offset).all();
					results = queryRes.results || [];
				}

				const ids = results.slice(0, limit).map((r) => r.id);
				return json({
					ids,
					has_more: results.length > limit,
					next_cursor: results.length > limit && ids.length > 0 ? ids[ids.length - 1] : null,
				});
			}

				if (method === 'GET' && pathname === '/posts/recommended/ids') {
					const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 30), 1), 100);
					const beforeId = Number.isSafeInteger(Number(url.searchParams.get('beforeId'))) && Number(url.searchParams.get('beforeId')) > 0
						? Number(url.searchParams.get('beforeId'))
						: null;
					const offset = beforeId == null ? Math.max(Number(url.searchParams.get('offset') || 0), 0) : 0;
					const viewerIdParam = url.searchParams.get('viewerId');
					const viewerId = viewerIdParam !== null && Number.isSafeInteger(Number(viewerIdParam))
						? Number(viewerIdParam)
						: null;
					const candidateLimit = Math.min(1000, Math.max(500, offset + limit + 1));
					const candidateWhere = beforeId != null ? 'p.reply_to IS NULL AND p.id < ?' : 'p.reply_to IS NULL';
					const candidateBindings = beforeId != null ? [beforeId, candidateLimit] : [candidateLimit];
					const commonCtes = `WITH candidates AS (
						SELECT p.id, p.user_id, p.created_at
						FROM posts p
						WHERE ${candidateWhere}
						ORDER BY p.created_at DESC, p.id DESC
						LIMIT ?
					), like_counts AS (
						SELECT l.post_id, COUNT(*) AS count
						FROM likes l JOIN candidates c ON c.id = l.post_id
						GROUP BY l.post_id
					), star_counts AS (
						SELECT s.post_id, COUNT(*) AS count
						FROM stars s JOIN candidates c ON c.id = s.post_id
						GROUP BY s.post_id
					), repost_counts AS (
						SELECT r.post_id, COUNT(*) AS count
						FROM reposts r JOIN candidates c ON c.id = r.post_id
						GROUP BY r.post_id
					)`;
					const engagementScore = `MIN(22.0,
						COALESCE(l.count, 0) * 4.0 / (COALESCE(l.count, 0) + 4.0)
						+ COALESCE(s.count, 0) * 8.0 / (COALESCE(s.count, 0) + 2.0)
						+ COALESCE(r.count, 0) * 10.0 / (COALESCE(r.count, 0) + 2.0))`;
					const recencyScore = `48.0 / (1.0 + MAX(0.0, (julianday('now') - julianday(c.created_at)) * 24.0) / 6.0)`;
					const query = viewerId == null
						? `${commonCtes}, scored AS (
							SELECT c.id, c.created_at, ${recencyScore} + ${engagementScore} AS score
							FROM candidates c
							LEFT JOIN like_counts l ON l.post_id = c.id
							LEFT JOIN star_counts s ON s.post_id = c.id
							LEFT JOIN repost_counts r ON r.post_id = c.id
						)
						SELECT id FROM scored ORDER BY score DESC, created_at DESC, id DESC LIMIT ? OFFSET ?`
						: `${commonCtes}, viewer_like_affinity AS (
							SELECT p.user_id, COUNT(*) AS count
							FROM likes l JOIN posts p ON p.id = l.post_id
							WHERE l.user_id = ?
							GROUP BY p.user_id
						), viewer_star_affinity AS (
							SELECT p.user_id, COUNT(*) AS count
							FROM stars s JOIN posts p ON p.id = s.post_id
							WHERE s.user_id = ?
							GROUP BY p.user_id
						), direct_follows AS (
							SELECT following_id AS user_id FROM follows WHERE follower_id = ?
						), second_degree_follows AS (
							SELECT DISTINCT f2.following_id AS user_id
							FROM follows f1 JOIN follows f2 ON f2.follower_id = f1.following_id
							WHERE f1.follower_id = ? AND f2.following_id <> ?
						), scored AS (
							SELECT c.id, c.created_at,
								${recencyScore} + ${engagementScore}
								+ CASE WHEN df.user_id IS NOT NULL THEN 24.0 WHEN sdf.user_id IS NOT NULL THEN 10.0 ELSE 0.0 END
								+ MIN(20.0, COALESCE(vla.count, 0) * 4.0)
								+ MIN(32.0, COALESCE(vsa.count, 0) * 8.0) AS score
							FROM candidates c
							LEFT JOIN like_counts l ON l.post_id = c.id
							LEFT JOIN star_counts s ON s.post_id = c.id
							LEFT JOIN repost_counts r ON r.post_id = c.id
							LEFT JOIN viewer_like_affinity vla ON vla.user_id = c.user_id
							LEFT JOIN viewer_star_affinity vsa ON vsa.user_id = c.user_id
							LEFT JOIN direct_follows df ON df.user_id = c.user_id
							LEFT JOIN second_degree_follows sdf ON sdf.user_id = c.user_id
						)
						SELECT id FROM scored ORDER BY score DESC, created_at DESC, id DESC LIMIT ? OFFSET ?`;
					const bindings = viewerId == null
						? [...candidateBindings, limit + 1, offset]
						: [...candidateBindings, viewerId, viewerId, viewerId, viewerId, viewerId, limit + 1, offset];
					const { results } = await db.prepare(query).bind(...bindings).all();
					const rows = results || [];
					const ids = rows.slice(0, limit).map((r) => r.id);
					return json({
						ids,
						has_more: rows.length > limit,
						next_cursor: null,
						use_offset_pagination: true,
					});
				}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/post-ids$/)) {
				const userId = Number(pathname.split('/')[2]);
				const subType = url.searchParams.get('subType') || 'all';
				const limit = Math.min(Number(url.searchParams.get('limit') || 30), 100);
				const beforeId = Number.isSafeInteger(Number(url.searchParams.get('beforeId'))) && Number(url.searchParams.get('beforeId')) > 0
					? Number(url.searchParams.get('beforeId'))
					: null;
				const offset = beforeId == null ? Number(url.searchParams.get('offset') || 0) : 0;

				let sql = 'SELECT id FROM posts WHERE user_id = ?';
				const bindings = [userId];
				if (subType === 'posts_only') sql += ' AND reply_to IS NULL';
				if (subType === 'replies_only') sql += ' AND reply_to IS NOT NULL';
				if (beforeId != null) {
					sql += ' AND id < ?';
					bindings.push(beforeId);
				}
				sql += beforeId != null
					? ' ORDER BY created_at DESC, id DESC LIMIT ?'
					: ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?';
				bindings.push(limit + 1);
				if (beforeId == null) bindings.push(offset);

				const { results } = await db.prepare(sql).bind(...bindings).all();
				const rows = results || [];
				const ids = rows.slice(0, limit).map((r) => r.id);
				return json({
					ids,
					has_more: rows.length > limit,
					next_cursor: rows.length > limit && ids.length > 0 ? ids[ids.length - 1] : null,
				});
			}

			if (method === 'GET' && pathname === '/posts/search/ids') {
				const q = url.searchParams.get('q') || '';
				const limit = Math.min(Number(url.searchParams.get('limit') || 30), 100);
				const beforeId = Number.isSafeInteger(Number(url.searchParams.get('beforeId'))) && Number(url.searchParams.get('beforeId')) > 0
					? Number(url.searchParams.get('beforeId'))
					: null;
				const offset = beforeId == null ? Number(url.searchParams.get('offset') || 0) : 0;
				if (!q.trim()) return json({ ids: [], has_more: false, next_cursor: null });

				const { results } = beforeId != null
					? await db.prepare(
						'SELECT id FROM posts WHERE LOWER(content) LIKE ? AND id < ? ORDER BY created_at DESC, id DESC LIMIT ?'
					).bind(`%${q.toLowerCase()}%`, beforeId, limit + 1).all()
					: await db.prepare(
						'SELECT id FROM posts WHERE LOWER(content) LIKE ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?'
					).bind(`%${q.toLowerCase()}%`, limit + 1, offset).all();

				const rows = results || [];
				const ids = rows.slice(0, limit).map((r) => r.id);
				return json({
					ids,
					has_more: rows.length > limit,
					next_cursor: rows.length > limit && ids.length > 0 ? ids[ids.length - 1] : null,
				});
			}

			if (method === 'GET' && pathname === '/posts/search') {
				const q = url.searchParams.get('q') || '';
				const limit = Math.min(Number(url.searchParams.get('limit') || 20), 100);
				const { results } = await db.prepare(
					'SELECT * FROM posts WHERE LOWER(content) LIKE ? ORDER BY created_at DESC, id DESC LIMIT ?'
				).bind(`%${q.toLowerCase()}%`, limit).all();
				return json((results || []).map(normalizePostRow));
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/reply-ids$/)) {
				const parentPostId = Number(pathname.split('/')[2]);
				const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100);
				const offset = Number(url.searchParams.get('offset') || 0);

				const { results } = await db.prepare(
					'SELECT id FROM posts WHERE reply_to = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?'
				).bind(parentPostId, limit + 1, offset).all();

				const rows = results || [];
				return json({
					ids: rows.slice(0, limit).map((r) => r.id),
					has_more: rows.length > limit,
				});
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/thread-reply-ids$/)) {
				const parentPostId = Number(pathname.split('/')[2]);
				const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100);
				const offset = Number(url.searchParams.get('offset') || 0);

				const { results } = await db.prepare(
					`WITH RECURSIVE reply_tree(id, reply_to, depth) AS (
						SELECT id, reply_to, 0 FROM posts WHERE reply_to = ?
						UNION ALL
						SELECT p.id, p.reply_to, rt.depth + 1 FROM posts p
						JOIN reply_tree rt ON p.reply_to = rt.id
						WHERE rt.depth < 10
					)
					SELECT id FROM reply_tree LIMIT ? OFFSET ?`
				).bind(parentPostId, limit + 1, offset).all();

				const rows = results || [];
				return json({
					ids: rows.slice(0, limit).map((r) => r.id),
					has_more: rows.length > limit,
				});
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/detail$/)) {
				const postId = Number(pathname.split('/')[2]);
				const currentUserId = url.searchParams.get('currentUserId') ? Number(url.searchParams.get('currentUserId')) : null;

				const post = await db.prepare('SELECT * FROM posts WHERE id = ?').bind(postId).first();
				if (!post) return json(null);

				const author = await db.prepare('SELECT id, name, scid FROM users WHERE id = ?').bind(post.user_id).first();
				const likeCountRow = await db.prepare('SELECT COUNT(*) as count FROM likes WHERE post_id = ?').bind(postId).first();
				const starCountRow = await db.prepare('SELECT COUNT(*) as count FROM stars WHERE post_id = ?').bind(postId).first();

				let likedByMe = false;
				let starredByMe = false;
				if (currentUserId) {
					const l = await db.prepare('SELECT 1 FROM likes WHERE user_id = ? AND post_id = ?').bind(currentUserId, postId).first();
					const s = await db.prepare('SELECT 1 FROM stars WHERE user_id = ? AND post_id = ?').bind(currentUserId, postId).first();
					likedByMe = Boolean(l);
					starredByMe = Boolean(s);
				}

				let parentPost = null;
				if (post.reply_to) {
					const parent = await db.prepare('SELECT id, user_id, content FROM posts WHERE id = ?').bind(post.reply_to).first();
					if (parent) {
						const parentAuthor = await db.prepare('SELECT id, name FROM users WHERE id = ?').bind(parent.user_id).first();
						parentPost = {
							id: parent.id,
							content: parent.content ? parent.content.substring(0, 100) : '',
							author: parentAuthor ? { id: parentAuthor.id, name: parentAuthor.name } : null,
						};
					}
				}

				return json({
					...normalizePostRow(post),
					author: author ? { id: author.id, name: author.name, scid: author.scid } : null,
					like_count: Number(likeCountRow?.count || 0),
					star_count: Number(starCountRow?.count || 0),
					liked_by_me: likedByMe,
					starred_by_me: starredByMe,
					parent_post: parentPost,
				});
			}

			if (method === 'GET' && pathname === '/posts/trending') {
				const limit = Math.min(Number(url.searchParams.get('limit') || 20), 100);
				const { results } = await db.prepare(
					`SELECT p.*,
					   (COALESCE((SELECT COUNT(*) FROM likes WHERE post_id = p.id), 0) +
					    COALESCE((SELECT COUNT(*) FROM stars WHERE post_id = p.id), 0) * 2 +
					    COALESCE((SELECT COUNT(*) FROM reposts WHERE post_id = p.id), 0) * 3) as score
					 FROM posts p
					 ORDER BY score DESC, p.created_at DESC
					 LIMIT ?`
				).bind(limit).all();
				return json((results || []).map(normalizePostRow));
			}

			if (method === 'GET' && pathname === '/posts/trending-hashtags') {
				const limit = Math.min(Number(url.searchParams.get('limit') || 10), 50);
				const { results } = await db.prepare('SELECT content FROM posts ORDER BY created_at DESC LIMIT 500').all();
				const counts = new Map();
				for (const row of results || []) {
					const matches = (row.content || '').match(/#([^<>/@#\s]+)/g) || [];
					const uniqueTags = new Set(matches.map((match) => match.slice(1).toLowerCase()));
					for (const tag of uniqueTags) {
						counts.set(tag, (counts.get(tag) || 0) + 1);
					}
				}
				const sorted = Array.from(counts.entries())
					.sort((a, b) => b[1] - a[1])
					.slice(0, limit)
					.map(([tag_name, occurrence_count]) => ({ tag_name, occurrence_count }));
				return json(sorted);
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/posts\/count$/)) {
				const userId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT COUNT(*) as count FROM posts WHERE user_id = ?').bind(userId).first();
				return json({ count: Number(row?.count || 0) });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/media\/count$/)) {
				const userId = Number(pathname.split('/')[2]);
				const row = await db.prepare(
					`SELECT COUNT(*) AS count FROM posts
					 WHERE user_id = ?
					   AND json_valid(attachments)
					   AND json_type(attachments) = 'array'
					   AND json_array_length(attachments) > 0`
				).bind(userId).first();
				return json({ count: Number(row?.count || 0) });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/media$/)) {
				const userId = Number(pathname.split('/')[2]);
				const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 15), 1), 100);
				const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);

				// JSON配列をD1側で添付単位に展開してページングする。全投稿・全添付を
				// Workerへ読み込んでからsliceするより、転送量とメモリ使用量を抑えられる。
				const { results } = await db.prepare(
					`SELECT p.id AS post_id,
						json_extract(attachment.value, '$.id') AS file_id,
						COALESCE(json_extract(attachment.value, '$.type'), 'file') AS file_type
					 FROM posts p
					 CROSS JOIN json_each(p.attachments) AS attachment
					 WHERE p.user_id = ?
					   AND json_valid(p.attachments)
					   AND json_type(p.attachments) = 'array'
					 ORDER BY p.created_at DESC, p.id DESC, CAST(attachment.key AS INTEGER) ASC
					 LIMIT ? OFFSET ?`
				).bind(userId, limit, offset).all();
				return json((results || []).map((row) => ({
					post_id: Number(row.post_id),
					file_id: row.file_id,
					file_type: row.file_type || 'file',
					type: row.file_type || 'file',
				})));
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/replies\/count$/)) {
				const postId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT COUNT(*) as count FROM posts WHERE reply_to = ?').bind(postId).first();
				return json({ count: Number(row?.count || 0) });
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)$/)) {
				const postId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT * FROM posts WHERE id = ?').bind(postId).first();
				return json(normalizePostRow(row));
			}

			if (method === 'POST' && pathname.match(/^\/posts\/(\d+)\/like$/)) {
				const postId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const userId = Number(body.userId);

				const existing = await db.prepare('SELECT 1 FROM likes WHERE user_id = ? AND post_id = ?').bind(userId, postId).first();
				if (existing) {
					await db.prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?').bind(userId, postId).run();
				} else {
					const now = new Date().toISOString();
					await db.prepare('INSERT INTO likes (user_id, post_id, created_at) VALUES (?, ?, ?)').bind(userId, postId, now).run();
				}
				const countRow = await db.prepare('SELECT COUNT(*) as count FROM likes WHERE post_id = ?').bind(postId).first();
				return json({ liked: !existing, count: Number(countRow?.count || 0) });
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/likes\/count$/)) {
				const postId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT COUNT(*) as count FROM likes WHERE post_id = ?').bind(postId).first();
				return json({ count: Number(row?.count || 0) });
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/likes\/check$/)) {
				const postId = Number(pathname.split('/')[2]);
				const userId = Number(url.searchParams.get('userId'));
				const row = await db.prepare('SELECT 1 FROM likes WHERE user_id = ? AND post_id = ?').bind(userId, postId).first();
				return json({ liked: Boolean(row) });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/likes\/ids$/)) {
				const userId = Number(pathname.split('/')[2]);
				const { results } = await db.prepare('SELECT post_id FROM likes WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all();
				return json((results || []).map((r) => r.post_id));
			}

			if (method === 'POST' && pathname.match(/^\/posts\/(\d+)\/star$/)) {
				const postId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const userId = Number(body.userId);

				const existing = await db.prepare('SELECT 1 FROM stars WHERE user_id = ? AND post_id = ?').bind(userId, postId).first();
				if (existing) {
					await db.prepare('DELETE FROM stars WHERE user_id = ? AND post_id = ?').bind(userId, postId).run();
				} else {
					const now = new Date().toISOString();
					await db.prepare('INSERT INTO stars (user_id, post_id, created_at) VALUES (?, ?, ?)').bind(userId, postId, now).run();
				}
				const countRow = await db.prepare('SELECT COUNT(*) as count FROM stars WHERE post_id = ?').bind(postId).first();
				return json({ starred: !existing, count: Number(countRow?.count || 0) });
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/stars\/count$/)) {
				const postId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT COUNT(*) as count FROM stars WHERE post_id = ?').bind(postId).first();
				return json({ count: Number(row?.count || 0) });
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/stars\/check$/)) {
				const postId = Number(pathname.split('/')[2]);
				const userId = Number(url.searchParams.get('userId'));
				const row = await db.prepare('SELECT 1 FROM stars WHERE user_id = ? AND post_id = ?').bind(userId, postId).first();
				return json({ starred: Boolean(row) });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/stars\/ids$/)) {
				const userId = Number(pathname.split('/')[2]);
				const { results } = await db.prepare('SELECT post_id FROM stars WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all();
				return json((results || []).map((r) => r.post_id));
			}

			if (method === 'POST' && pathname.match(/^\/posts\/(\d+)\/pin$/)) {
				const postId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const userId = Number(body.userId);

				const post = await db.prepare('SELECT user_id FROM posts WHERE id = ?').bind(postId).first();
				if (!post || Number(post.user_id) !== userId) {
					return badRequest('Cannot pin a post you do not own');
				}

				const existing = await db.prepare('SELECT 1 FROM pinned_posts WHERE user_id = ? AND post_id = ?').bind(userId, postId).first();
				if (existing) {
					await db.prepare('DELETE FROM pinned_posts WHERE user_id = ? AND post_id = ?').bind(userId, postId).run();
					return json({ pinned: false });
				}
				const now = new Date().toISOString();
				await db.prepare('INSERT INTO pinned_posts (user_id, post_id, created_at) VALUES (?, ?, ?)').bind(userId, postId, now).run();
				return json({ pinned: true });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/pinned$/)) {
				const userId = Number(pathname.split('/')[2]);
				const { results } = await db.prepare(
					`SELECT p.* FROM posts p JOIN pinned_posts pp ON pp.post_id = p.id
					 WHERE pp.user_id = ? ORDER BY pp.created_at DESC`
				).bind(userId).all();
				return json((results || []).map(normalizePostRow));
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/pinned\/id$/)) {
				const userId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT post_id FROM pinned_posts WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').bind(userId).first();
				return json({ postId: row?.post_id || null });
			}

			if (method === 'POST' && pathname.match(/^\/posts\/(\d+)\/repost$/)) {
				const postId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const userId = Number(body.userId);

				const original = await db.prepare('SELECT * FROM posts WHERE id = ?').bind(postId).first();
				if (!original) return notFound('Post not found');

				const existing = await db.prepare('SELECT 1 FROM reposts WHERE user_id = ? AND post_id = ?').bind(userId, postId).first();
				if (existing) return badRequest('Already reposted');

				const now = new Date().toISOString();
				await db.prepare('INSERT INTO reposts (user_id, post_id, created_at) VALUES (?, ?, ?)').bind(userId, postId, now).run();

				const res = await db.prepare(
					`INSERT INTO posts (user_id, content, attachments, mask, lock, repost_to, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`
				).bind(userId, original.content, original.attachments, original.mask, original.lock, postId, now).run();

				const created = await db.prepare('SELECT * FROM posts WHERE id = ?').bind(res.meta.last_row_id).first();
				return json(normalizePostRow(created));
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/reposts$/)) {
				const userId = Number(pathname.split('/')[2]);
				const { results } = await db.prepare(
					`SELECT p.* FROM posts p JOIN reposts r ON r.post_id = p.repost_to
					 WHERE r.user_id = ? ORDER BY r.created_at DESC`
				).bind(userId).all();
				return json((results || []).map(normalizePostRow));
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/reposts$/)) {
				const postId = Number(pathname.split('/')[2]);
				const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100);
				const { results } = await db.prepare(
					`SELECT u.id as user_id, u.name, u.handle FROM reposts r
					 JOIN users u ON u.id = r.user_id WHERE r.post_id = ? ORDER BY r.created_at DESC LIMIT ?`
				).bind(postId, limit).all();
				return json(results || []);
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/reposts\/count$/)) {
				const postId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT COUNT(*) as count FROM reposts WHERE post_id = ?').bind(postId).first();
				return json({ count: Number(row?.count || 0) });
			}

			if (method === 'GET' && pathname === '/dm/list') {
				const userId = Number(url.searchParams.get('userId'));
				const { results } = await db.prepare('SELECT * FROM dm_channels').all();
				const matched = (results || []).filter((r) => {
					const parts = parseJsonSafe(r.participants, []);
					return Array.isArray(parts) && parts.includes(userId);
				});
				return json(matched);
			}

			if (method === 'POST' && pathname === '/dm/channel') {
				const body = await request.json();
				const u1 = Math.min(Number(body.userId1), Number(body.userId2));
				const u2 = Math.max(Number(body.userId1), Number(body.userId2));
				const channelId = `${u1}:${u2}`;

				const existing = await db.prepare('SELECT * FROM dm_channels WHERE id = ?').bind(channelId).first();
				if (existing) return json(existing);

				const now = new Date().toISOString();
				await db.prepare('INSERT INTO dm_channels (id, participants, created_at) VALUES (?, ?, ?)').bind(channelId, JSON.stringify([u1, u2]), now).run();
				return json({ id: channelId, participants: [u1, u2], created_at: now });
			}

			if (method === 'GET' && pathname.startsWith('/dm/messages/')) {
				const channelId = decodeURIComponent(pathname.slice('/dm/messages/'.length));
				const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100);
				const offset = Number(url.searchParams.get('offset') || 0);

				const { results } = await db.prepare('SELECT * FROM dm_messages WHERE channel_id = ? ORDER BY sent_at DESC LIMIT ? OFFSET ?').bind(channelId, limit, offset).all();
				return json(results || []);
			}

			if (method === 'POST' && pathname === '/dm/messages') {
				const body = await request.json();
				const channelId = String(body.channelId);
				const senderId = Number(body.senderId);
				const content = String(body.content || '');
				const now = new Date().toISOString();

				const res = await db.prepare('INSERT INTO dm_messages (channel_id, sender_id, content, sent_at) VALUES (?, ?, ?, ?)').bind(channelId, senderId, content, now).run();
				const row = await db.prepare('SELECT * FROM dm_messages WHERE id = ?').bind(res.meta.last_row_id).first();
				return json(row);
			}

			if (method === 'POST' && pathname === '/dm/read') {
				const body = await request.json();
				const channelId = String(body.channelId);
				const userId = Number(body.userId);
				const now = new Date().toISOString();
				await db.prepare('UPDATE dm_messages SET read_at = ? WHERE channel_id = ? AND sender_id != ? AND read_at IS NULL').bind(now, channelId, userId).run();
				return json({ success: true });
			}

			if (method === 'GET' && pathname === '/dm/unread') {
				const userId = Number(url.searchParams.get('userId'));
				const { results } = await db.prepare(
					`SELECT m.id FROM dm_messages m
					 JOIN dm_channels c ON c.id = m.channel_id
					 WHERE m.sender_id != ? AND m.read_at IS NULL`
				).bind(userId).all();
				return json({ count: (results || []).length });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/group-dms$/)) {
				const userId = Number(pathname.split('/')[2]);
				const { results } = await db.prepare('SELECT * FROM group_dms ORDER BY time DESC').all();
				const filtered = (results || []).filter((r) => {
					const members = parseJsonSafe(r.member, []);
					return Array.isArray(members) && members.map(Number).includes(userId);
				});
				return json(filtered.map((r) => normalizeGroupDmRow(r, userId)));
			}

			if (method === 'GET' && pathname.match(/^\/group-dms\/([^/]+)$/)) {
				const dmId = decodeURIComponent(pathname.split('/')[2]);
				const row = await db.prepare('SELECT * FROM group_dms WHERE id = ?').bind(dmId).first();
				return json(normalizeGroupDmRow(row));
			}

			if (method === 'POST' && pathname === '/group-dms') {
				const body = await request.json();
				const id = crypto.randomUUID();
				const hostId = Number(body.hostId);
				const member = Array.isArray(body.member) ? body.member.map(Number) : [hostId];
				const title = String(body.title || '');
				const now = new Date().toISOString();

				await db.prepare(
					`INSERT INTO group_dms (id, host_id, title, member, post, unread, time, created_at)
					 VALUES (?, ?, ?, ?, '[]', '{}', ?, ?)`
				).bind(id, hostId, title, JSON.stringify(member), now, now).run();

				const row = await db.prepare('SELECT * FROM group_dms WHERE id = ?').bind(id).first();
				return json(normalizeGroupDmRow(row, hostId));
			}

			if (method === 'POST' && pathname.match(/^\/group-dms\/([^/]+)\/update$/)) {
				const dmId = decodeURIComponent(pathname.split('/')[2]);
				const updates = await request.json();
				const sets = [];
				const values = [];

				if (updates.title !== undefined) { sets.push('title = ?'); values.push(updates.title); }
				if (updates.host_id !== undefined || updates.hostId !== undefined) { sets.push('host_id = ?'); values.push(Number(updates.host_id ?? updates.hostId)); }
				if (updates.member !== undefined) { sets.push('member = ?'); values.push(JSON.stringify(updates.member.map(Number))); }
				if (updates.post !== undefined) { sets.push('post = ?'); values.push(JSON.stringify(updates.post)); }
				if (updates.unread !== undefined) { sets.push('unread = ?'); values.push(JSON.stringify(updates.unread)); }
				if (updates.time !== undefined) { sets.push('time = ?'); values.push(updates.time); }

				if (sets.length > 0) {
					values.push(dmId);
					await db.prepare(`UPDATE group_dms SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
				}
				const row = await db.prepare('SELECT * FROM group_dms WHERE id = ?').bind(dmId).first();
				return json(normalizeGroupDmRow(row));
			}

			if (method === 'POST' && pathname.match(/^\/group-dms\/([^/]+)\/messages$/)) {
				const dmId = decodeURIComponent(pathname.split('/')[2]);
				const body = await request.json();
				const message = body.message;
				const senderId = body.senderId != null ? Number(body.senderId) : null;

				const row = await db.prepare('SELECT * FROM group_dms WHERE id = ?').bind(dmId).first();
				if (!row) return notFound('Group DM not found');

				const posts = parseJsonSafe(row.post, []);
				posts.push(message);
				const unread = parseJsonSafe(row.unread, {});
				const members = parseJsonSafe(row.member, []);

				if (senderId != null) {
					for (const m of members) {
						if (Number(m) !== senderId) {
							const k = String(m);
							unread[k] = Number(unread[k] || 0) + 1;
						}
					}
				}

				const time = message.time || new Date().toISOString();
				await db.prepare('UPDATE group_dms SET post = ?, unread = ?, time = ? WHERE id = ?').bind(JSON.stringify(posts), JSON.stringify(unread), time, dmId).run();

				const updated = await db.prepare('SELECT * FROM group_dms WHERE id = ?').bind(dmId).first();
				return json(normalizeGroupDmRow(updated, senderId));
			}

			if (method === 'POST' && pathname.match(/^\/group-dms\/([^/]+)\/read$/)) {
				const dmId = decodeURIComponent(pathname.split('/')[2]);
				const body = await request.json();
				const userId = Number(body.userId);

				const row = await db.prepare('SELECT unread FROM group_dms WHERE id = ?').bind(dmId).first();
				if (row) {
					const unread = parseJsonSafe(row.unread, {});
					unread[String(userId)] = 0;
					await db.prepare('UPDATE group_dms SET unread = ? WHERE id = ?').bind(JSON.stringify(unread), dmId).run();
				}
				return json({ success: true });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/group-dms\/unread-counts$/)) {
				const userId = Number(pathname.split('/')[2]);
				const { results } = await db.prepare('SELECT id, member, unread FROM group_dms').all();
				const counts = [];
				for (const r of results || []) {
					const members = parseJsonSafe(r.member, []);
					if (Array.isArray(members) && members.map(Number).includes(userId)) {
						const unread = parseJsonSafe(r.unread, {});
						counts.push({ dm_id: r.id, unread_count: Number(unread[String(userId)] || 0) });
					}
				}
				return json(counts);
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/group-dms\/unread-total$/)) {
				const userId = Number(pathname.split('/')[2]);
				const { results } = await db.prepare('SELECT member, unread FROM group_dms').all();
				let total = 0;
				for (const r of results || []) {
					const members = parseJsonSafe(r.member, []);
					if (Array.isArray(members) && members.map(Number).includes(userId)) {
						const unread = parseJsonSafe(r.unread, {});
						total += Number(unread[String(userId)] || 0);
					}
				}
				return json({ total });
			}

			if (method === 'POST' && pathname.match(/^\/group-dms\/([^/]+)\/delete$/)) {
				const dmId = decodeURIComponent(pathname.split('/')[2]);
				const res = await db.prepare('DELETE FROM group_dms WHERE id = ?').bind(dmId).run();
				return json({ success: res.meta.changes > 0 });
			}

			if (method === 'POST' && pathname.match(/^\/group-dms\/([^/]+)\/leave$/)) {
				const dmId = decodeURIComponent(pathname.split('/')[2]);
				const body = await request.json();
				const userId = Number(body.userId);

				const row = await db.prepare('SELECT member, unread FROM group_dms WHERE id = ?').bind(dmId).first();
				if (!row) return json({ success: false });

				const members = parseJsonSafe(row.member, []).filter((id) => Number(id) !== userId);
				const unread = parseJsonSafe(row.unread, {});
				delete unread[String(userId)];

				await db.prepare('UPDATE group_dms SET member = ?, unread = ? WHERE id = ?').bind(JSON.stringify(members), JSON.stringify(unread), dmId).run();
				return json({ success: true });
			}

			if (method === 'POST' && pathname === '/group-dms/find-by-members') {
				const body = await request.json();
				const target = Array.from(new Set(body.memberIds.map(Number))).sort((a, b) => a - b);
				const { results } = await db.prepare('SELECT * FROM group_dms').all();

				for (const r of results || []) {
					const current = Array.from(new Set(parseJsonSafe(r.member, []).map(Number))).sort((a, b) => a - b);
					if (target.length === current.length && target.every((v, i) => v === current[i])) {
						return json(normalizeGroupDmRow(r));
					}
				}
				return json(null);
			}

			// DM E2E暗号化用の公開鍵
			if (method === 'GET' && pathname === '/dm-e2e-keys') {
				const raw = String(url.searchParams.get('user_ids') || '');
				const ids = raw.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n >= 0);
				if (ids.length === 0) return json([]);
				const placeholders = ids.map(() => '?').join(',');
				const { results } = await db.prepare(
					`SELECT user_id, public_key FROM dm_e2e_keys WHERE user_id IN (${placeholders})`
				).bind(...ids).all();
				return json((results || []).map((r) => ({
					user_id: Number(r.user_id),
					public_key: String(r.public_key),
				})));
			}

			if (method === 'POST' && pathname === '/dm-e2e-keys') {
				const body = await request.json();
				const userId = Number(body.userId);
				const publicKey = String(body.publicKey || '');
				if (!Number.isInteger(userId) || userId < 0 || !publicKey) {
					return badRequest('userId and publicKey are required');
				}
				const now = new Date().toISOString();
				await db.prepare(
					`INSERT INTO dm_e2e_keys (user_id, public_key, created_at, updated_at)
					 VALUES (?, ?, ?, ?)
					 ON CONFLICT (user_id) DO UPDATE SET public_key = excluded.public_key, updated_at = excluded.updated_at`
				).bind(userId, publicKey, now, now).run();
				return json({ success: true });
			}

			if (method === 'POST' && pathname === '/notifications') {
				const body = await request.json();
				const userId = Number(body.userId);
				const type = String(body.type);
				const fromUserId = body.fromUserId != null ? Number(body.fromUserId) : null;
				const postId = body.postId != null ? Number(body.postId) : (body.target?.kind === 'post' ? Number(body.target.id) : null);
				const target = body.target ? JSON.stringify(body.target) : null;
				const now = new Date().toISOString();

				const res = await db.prepare(
					`INSERT INTO notifications (user_id, type, from_user_id, post_id, target, read, clicked, created_at)
					 VALUES (?, ?, ?, ?, ?, 0, 0, ?)`
				).bind(userId, type, fromUserId, postId, target, now).run();

				const row = await db.prepare('SELECT * FROM notifications WHERE id = ?').bind(res.meta.last_row_id).first();
				return json(row ? { ...row, target: parseJsonSafe(row.target, null), read: Boolean(row.read), clicked: Boolean(row.clicked) } : null);
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/notifications$/)) {
				const userId = Number(pathname.split('/')[2]);
				const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
				const offset = Number(url.searchParams.get('offset') || 0);

				const { results } = await db.prepare(
					'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?'
				).bind(userId, limit, offset).all();

				return json((results || []).map((r) => ({
					...r,
					target: parseJsonSafe(r.target, null),
					read: Boolean(r.read),
					clicked: Boolean(r.clicked),
				})));
			}

			if (method === 'POST' && pathname.match(/^\/notifications\/(\d+)\/read$/)) {
				const id = Number(pathname.split('/')[2]);
				await db.prepare('UPDATE notifications SET read = 1 WHERE id = ?').bind(id).run();
				return json({ success: true });
			}

			if (method === 'POST' && pathname.match(/^\/notifications\/(\d+)\/click$/)) {
				const id = Number(pathname.split('/')[2]);
				await db.prepare('UPDATE notifications SET clicked = 1 WHERE id = ?').bind(id).run();
				return json({ success: true });
			}

			if (method === 'GET' && pathname.match(/^\/notifications\/(\d+)$/)) {
				const id = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT * FROM notifications WHERE id = ?').bind(id).first();
				return json(row ? { ...row, target: parseJsonSafe(row.target, null), read: Boolean(row.read), clicked: Boolean(row.clicked) } : null);
			}

			if (method === 'POST' && pathname.match(/^\/notifications\/(\d+)\/delete$/)) {
				const id = Number(pathname.split('/')[2]);
				const res = await db.prepare('DELETE FROM notifications WHERE id = ?').bind(id).run();
				return json({ success: res.meta.changes > 0 });
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/notifications\/read-all$/)) {
				const userId = Number(pathname.split('/')[2]);
				await db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0').bind(userId).run();
				return json({ success: true });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/notifications\/unread-count$/)) {
				const userId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND read = 0').bind(userId).first();
				return json({ count: Number(row?.count || 0) });
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/push-subscriptions$/)) {
				const userId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const endpoint = String(body.endpoint);
				const expirationTime = body.expirationTime != null ? Number(body.expirationTime) : null;
				const p256dh = String(body.keys?.p256dh || '');
				const auth = String(body.keys?.auth || '');
				const sessionToken = body.sessionToken != null ? String(body.sessionToken) : null;
				const now = new Date().toISOString();

				await db.prepare(
					`INSERT INTO push_subscriptions (user_id, endpoint, expiration_time, p256dh, auth, session_token, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(user_id, endpoint) DO UPDATE SET
					   expiration_time = excluded.expiration_time,
					   p256dh = excluded.p256dh,
					   auth = excluded.auth,
					   session_token = COALESCE(excluded.session_token, push_subscriptions.session_token),
					   updated_at = excluded.updated_at`
				).bind(userId, endpoint, expirationTime, p256dh, auth, sessionToken, now, now).run();

				return json({ userId, endpoint, expirationTime, keys: { p256dh, auth }, sessionToken });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/push-subscriptions$/)) {
				const userId = Number(pathname.split('/')[2]);
				const { results } = await db.prepare('SELECT endpoint, expiration_time, p256dh, auth, session_token FROM push_subscriptions WHERE user_id = ?').bind(userId).all();
				return json((results || []).map((r) => ({
					endpoint: r.endpoint,
					expirationTime: r.expiration_time ? Number(r.expiration_time) : null,
					keys: { p256dh: r.p256dh, auth: r.auth },
					sessionToken: r.session_token || null,
				})));
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/push-subscriptions\/delete$/)) {
				const userId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const endpoint = String(body.endpoint);
				const res = await db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').bind(userId, endpoint).run();
				return json({ success: res.meta.changes > 0 });
			}

			if (method === 'GET' && pathname.startsWith('/ranking/')) {
				const type = decodeURIComponent(pathname.slice('/ranking/'.length));
				const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100);

				let sql = '';
				if (type === 'followers') {
					sql = `SELECT u.id AS user_id, u.name, u.scid, u.icon_data,
						   COUNT(f.follower_id) AS follower_count
						   FROM users u LEFT JOIN follows f ON f.following_id = u.id
						   GROUP BY u.id ORDER BY follower_count DESC, u.id ASC LIMIT ?`;
				} else if (type === 'posts') {
					sql = `SELECT u.id AS user_id, u.name, u.scid, u.icon_data,
						   COUNT(p.id) AS post_count
						   FROM users u LEFT JOIN posts p ON p.user_id = u.id
						   GROUP BY u.id ORDER BY post_count DESC, u.id ASC LIMIT ?`;
				} else if (type === 'likes') {
					sql = `SELECT u.id AS user_id, u.name, u.scid, u.icon_data,
						   COUNT(l.user_id) AS like_count
						   FROM users u
						   LEFT JOIN posts p ON p.user_id = u.id
						   LEFT JOIN likes l ON l.post_id = p.id
						   GROUP BY u.id ORDER BY like_count DESC, u.id ASC LIMIT ?`;
				} else if (type === 'stars') {
					sql = `SELECT u.id AS user_id, u.name, u.scid, u.icon_data,
						   COUNT(s.user_id) AS star_count
						   FROM users u
						   LEFT JOIN posts p ON p.user_id = u.id
						   LEFT JOIN stars s ON s.post_id = p.id
						   GROUP BY u.id ORDER BY star_count DESC, u.id ASC LIMIT ?`;
				} else {
					return badRequest('Invalid ranking type');
				}

				const { results } = await db.prepare(sql).bind(limit).all();
				return json(results || []);
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/ranking\/([^/]+)$/)) {
				const parts = pathname.split('/');
				const userId = Number(parts[2]);
				const type = decodeURIComponent(parts[4]);

				let sql = '';
				const metricField = type === 'followers' ? 'follower_count' : (type === 'posts' ? 'post_count' : (type === 'likes' ? 'like_count' : 'star_count'));

				if (type === 'followers') {
					sql = `SELECT rank, follower_count FROM (
						   SELECT u.id, COUNT(f.follower_id) AS follower_count,
						     ROW_NUMBER() OVER (ORDER BY COUNT(f.follower_id) DESC, u.id ASC) AS rank
						   FROM users u LEFT JOIN follows f ON f.following_id = u.id GROUP BY u.id
					) WHERE id = ?`;
				} else if (type === 'posts') {
					sql = `SELECT rank, post_count FROM (
						   SELECT u.id, COUNT(p.id) AS post_count,
						     ROW_NUMBER() OVER (ORDER BY COUNT(p.id) DESC, u.id ASC) AS rank
						   FROM users u LEFT JOIN posts p ON p.user_id = u.id GROUP BY u.id
					) WHERE id = ?`;
				} else if (type === 'likes') {
					sql = `SELECT rank, like_count FROM (
						   SELECT u.id, COUNT(l.user_id) AS like_count,
						     ROW_NUMBER() OVER (ORDER BY COUNT(l.user_id) DESC, u.id ASC) AS rank
						   FROM users u
						   LEFT JOIN posts p ON p.user_id = u.id
						   LEFT JOIN likes l ON l.post_id = p.id
						   GROUP BY u.id
					) WHERE id = ?`;
				} else if (type === 'stars') {
					sql = `SELECT rank, star_count FROM (
						   SELECT u.id, COUNT(s.user_id) AS star_count,
						     ROW_NUMBER() OVER (ORDER BY COUNT(s.user_id) DESC, u.id ASC) AS rank
						   FROM users u
						   LEFT JOIN posts p ON p.user_id = u.id
						   LEFT JOIN stars s ON s.post_id = p.id
						   GROUP BY u.id
					) WHERE id = ?`;
				} else {
					return badRequest('Invalid ranking type');
				}

				const row = await db.prepare(sql).bind(userId).first();
				return json(row || { rank: null, [metricField]: 0 });
			}

			if (method === 'POST' && pathname === '/logs') {
				const body = await request.json();
				const scratchId = body.scratch_id || '';
				const nyaitterId = body.nyaitter_id != null ? Number(body.nyaitter_id) : null;
				const maskedIpUuid = body.masked_ip_uuid || '';
				const logTime = new Date().toISOString();

				await db.prepare('INSERT INTO logs (scratch_id, nyaitter_id, masked_ip_uuid, log_time) VALUES (?, ?, ?, ?)').bind(scratchId, nyaitterId, maskedIpUuid, logTime).run();
				return json({ success: true });
			}

			if (method === 'GET' && pathname === '/logs') {
				const limit = Math.min(Number(url.searchParams.get('limit') || 20), 100);
				const offset = Number(url.searchParams.get('offset') || 0);
				const { results } = await db.prepare('SELECT * FROM logs ORDER BY log_time DESC LIMIT ? OFFSET ?').bind(limit, offset).all();
				return json(results || []);
			}

			return notFound(`Path ${method} ${pathname} not handled`);
		} catch (error) {
			return internalError(error);
		}
	},
};
