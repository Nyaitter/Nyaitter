const express = require('express');
const { optionalAuth, requireAuth, requireAuthAllowFrozen } = require('../middleware/auth');
const crypto = require('crypto');
const config = require('../config');
const { isWithinRange, describeIntegerRange } = require('../utils/settingFormats');
const {
	serializeUser,
	serializeUserBrief,
	attachGroupBadgesToUsers,
	invalidateUserBriefCache,
	updateUserBriefCache,
	serializePublicProfile,
	serializePostsByIds,
	serializePostsBatch,
} = require('../utils/serialize');
const timelineCacheManager = require('../utils/TimelineCacheManager');
const { getPublicUrl, getUserNyaitterId } = require('../utils/nyaitterAddress');
const {
	createPostVisibilityContext,
	filterViewablePosts,
} = require('../utils/postVisibility');
const { hasBlockRelationship } = require('../utils/blockRelationship');
const { normalizeBlockList } = require('../utils/blockList');
const { ScratchIconService } = require('../services/ScratchIconService');
const { listOwnedImposters } = require('../services/ImposterService');
const { assertAuthenticatedUserAccess } = require('../services/auth/PostAsUserService');
const {
	createNotificationIfAllowed,
} = require('../services/NotificationDeliveryService');
const { getRecommendedUsers } = require('../services/UserRecommendationService');

const api = require("../utils/ApiRegistry");
const router = api.createRouter({
	tag: "users",
	basePath: "/users",
	description: "ユーザー・プロフィール・フォロー API",
});
const { createRateLimiter } = require('../middleware/rateLimit');
const profileUpdateLimiter = createRateLimiter(config.rateLimit.profileUpdate);
const accountOperationLimiter = createRateLimiter(config.rateLimit.profileUpdate);
const searchLimiter = createRateLimiter(config.rateLimit.profileUpdate);
const accountDeletionConfirmations = new Map();
const reputation = require('../services/ReputationService');
const { containsProtectedStatus } = require('../utils/protectedStatus');
const { actualRanks, displayRanks, displayOptions, validateDisplaySettings, ownDisplaySettings } = require('../utils/rankDisplay');

router.get({path:'/me/status',summary:'自分の利用状態',auth:'required'},requireAuthAllowFrozen,async(req,res)=>{
	try {
		const db = getDbAdapter(req);
		const [status, user] = await Promise.all([reputation.getStatus(db, req.user.id), db.getUserById(req.user.id)]);
		const actual = { trust: status.trust.rank };
		res.set('Cache-Control','no-store');
		return res.json({ ...status, display_ranks: displayRanks(actual, user?.settings?.display_ranks), display_rank_options: displayOptions(actual), display_settings: ownDisplaySettings(user?.settings, actual) });
	}
	catch(error) { console.error('[users] status:',error.message); return res.status(503).json({error:'利用状態を取得できませんでした'}); }
});

router.post({path:'/:userId/trust-moderation',summary:'管理者による利用制限の指定・取消',auth:'admin'},requireAuth,async(req,res)=>{
	if (!req.user.admin) return res.status(403).json({error:'管理者権限が必要です'});
	const id=Number(req.params.userId); const reason=String(req.body?.reason || '').trim();
	if (!Number.isSafeInteger(id) || id<=0 || typeof req.body?.banned!=='boolean' || reason.length<10) return res.status(400).json({error:'対象と判断理由を指定してください'});
	try {
		if (id===Number(req.user.id)) return res.status(403).json({error:'自分自身の利用制限は変更できません'});
	const db=getDbAdapter(req); const target=await db.getUserById(id); if (!target) return res.status(404).json({error:'User not found'});
	if (target.admin===true) return res.status(403).json({error:'他の管理者の利用制限は変更できません'});
		await require('../services/ModLogService').operation(db, 'admin', req.user.id, req.body.banned ? 'trust_ban' : 'trust_unban', 'user', id, async () => {
			await db.replaceReputationEvents(`manual-ban:${id}`,req.body.banned?[reputation.event('ban',id,'ban',1,0,undefined,{adminId:req.user.id,reason})]:[]);
			return true;
		}, 'failure');
		return res.json({success:true});
	} catch(error) { return res.status(500).json({error:'利用制限を更新できませんでした'}); }
});

router.post({path:'/:userId/note-outcome-retract',summary:'管理者による削除済みノート実績の取消',auth:'admin'},requireAuth,async(req,res)=>{
	if (!req.user.admin) return res.status(403).json({error:'管理者権限が必要です'});
	const userId=Number(req.params.userId);const noteId=Number(req.body?.noteId);const reason=String(req.body?.reason || '').trim();
	if (![userId,noteId].every(id=>Number.isSafeInteger(id)&&id>0) || reason.length<10) return res.status(400).json({error:'対象と取消理由を指定してください'});
	try {
		const db=getDbAdapter(req);if (await db.getNote(noteId)) return res.status(409).json({error:'残っているノートは再判定または管理者削除を利用してください'});
		const scope=`note:${noteId}`;const evidence=await db.getReputationEvidence(userId,scope);
		if (!evidence.some(e=>e.scope===scope)) return res.status(404).json({error:'対象実績が見つかりません'});
		await require('../services/ModLogService').operation(db, 'admin', req.user.id, 'note_outcome_retract', 'note', noteId, async () => {
			await db.replaceReputationEvents(scope,[]);
			await db.replaceReputationEvents(`note-retraction:${noteId}`,[reputation.event('audit',userId,'trust',0,0,undefined,{adminId:req.user.id,reason})]);
			return true;
		}, 'failure');
		return res.json({success:true});
	} catch(error) { return res.status(500).json({error:'ノート実績を取り消せませんでした'}); }
});
const ACCOUNT_CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const MAX_ACCOUNT_CONFIRMATIONS = 1000;

function requireInteractiveSession(req, res, next) {
	if (req.user?.tokenType !== 'session' || !req.user?.sessionTokenHash) {
		return res.status(403).json({ error: 'ログイン済み端末のセッションが必要です。' });
	}
	return next();
}

function getAccountConfirmationKey(token) {
	return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function discardExpiredAccountConfirmations(now = Date.now()) {
	for (const [key, value] of accountDeletionConfirmations) {
		if (!value || value.expiresAt <= now) accountDeletionConfirmations.delete(key);
	}
	while (accountDeletionConfirmations.size > MAX_ACCOUNT_CONFIRMATIONS) {
		const oldestKey = accountDeletionConfirmations.keys().next().value;
		if (oldestKey === undefined) break;
		accountDeletionConfirmations.delete(oldestKey);
	}
}

const accountConfirmationPruner = setInterval(discardExpiredAccountConfirmations, 60000);
accountConfirmationPruner.unref();

async function deleteStoredAccountAttachments(storage, keys) {
	if (!storage || !Array.isArray(keys) || keys.length === 0) return;
	try {
		if (typeof storage.deleteMany === 'function') await storage.deleteMany(keys);
		else if (typeof storage.delete === 'function') await Promise.all(keys.map((key) => storage.delete(key)));
	} catch (error) {
		console.warn('[users] account attachment deletion failed:', error.message);
	}
}

async function deleteOwnedImposterAccounts(req, db, storage, parentId) {
	const imposters = await listOwnedImposters(db, parentId);
	for (const imposter of imposters) {
		const started = await db.beginAccountOperation(imposter.id, 'deleting');
		if (!started) throw new Error(`Imposter account operation could not be started: ${imposter.id}`);
		try {
			req.app.locals.realtime?.closeUser?.(imposter.id, 1012, 'Parent account deletion');
			const attachmentKeys = await db.getAccountAttachmentKeys(imposter.id);
			await db.invalidateAllSessions(imposter.id);
			const deleted = await db.deleteAccount(imposter.id);
			if (!deleted) throw new Error(`Imposter account deletion did not complete: ${imposter.id}`);
			invalidateUserBriefCache(imposter.id);
			timelineCacheManager.clear();
			await deleteStoredAccountAttachments(storage, attachmentKeys);
		} catch (error) {
			await db.finishAccountOperation(imposter.id, 'deleting').catch(() => {});
			throw error;
		}
	}
}

function getDbAdapter(req) {
	return req.app.locals.dbAdapter;
}

function getStorageAdapter(req) {
	return req.app.locals.storageAdapter;
}


function validateProfileText(value, label, range) {
	if (value === undefined) return null;
	if (typeof value !== 'string') return `${label} must be a string`;
	if (!isWithinRange(value.length, range)) {
		return `${label} must be ${describeIntegerRange(range)} characters`;
	}
	return null;
}

function getScratchIconService(req) {
	if (!req.app.locals.scratchIconService) {
		req.app.locals.scratchIconService = new ScratchIconService();
	}
	return req.app.locals.scratchIconService;
}

// アイコン画像を実際に配信しているScratch CDNのみを許可し、任意サイトへの
const ALLOWED_ICON_REDIRECT_HOSTS = new Set([
	'uploads.scratch.mit.edu',
	'cdn2.scratch.mit.edu',
]);

function isAllowedIconRedirectUrl(value) {
	let candidate = String(value || '');
	if (candidate.startsWith('//')) {
		candidate = `https:${candidate}`;
	}
	if (candidate.startsWith('/')) {
		return !candidate.startsWith('//') && !/[\u0000-\u001F\u007F]/.test(candidate);
	}
	try {
		const url = new URL(candidate);
		return url.protocol === 'https:' && ALLOWED_ICON_REDIRECT_HOSTS.has(url.hostname.toLowerCase());
	} catch (_) {
		return false;
	}
}

async function sendScratchFallbackIcon(req, res, scid) {
	let entry;
	try {
		entry = await getScratchIconService(req).getSourceIcon(
			scid,
			getScratchUserIconUrl,
		);
	} catch (error) {
		console.warn(`[users/icon] Scratch icon fetch error for ${scid}:`, error.message);
		return false;
	}
	if (!entry) return false;

	res.setHeader('Cache-Control', 'public, max-age=21600, stale-while-revalidate=86400');
	res.setHeader('Content-Type', entry.contentType);
	res.setHeader('ETag', entry.etag);
	if (req.headers['if-none-match'] === entry.etag) {
		res.status(304).end();
	} else {
		res.send(entry.buffer);
	}
	return true;
}

// Icons are displayed at <= ~170 CSS px everywhere in the UI, but users can
// upload multi-megapixel originals. Serve a variant capped at 512px (enough
// for high-DPR profile headers) generated on demand and cached in memory;
// the stored original is never modified. Animated GIFs and SVGs pass
// through untouched so animation/vectors keep working exactly as before.
const ICON_MAX_DIMENSION = 512;
const ICON_CACHE_LIMIT = 24 * 1024 * 1024;
const iconVariantCache = new Map();
let iconVariantCacheBytes = 0;

function iconCacheGet(key) {
	const entry = iconVariantCache.get(key);
	if (entry) {
		iconVariantCache.delete(key);
		iconVariantCache.set(key, entry);
	}
	return entry;
}

function iconCacheSet(key, entry) {
	const existing = iconVariantCache.get(key);
	if (existing) iconVariantCacheBytes -= existing.buffer.length;
	iconVariantCache.set(key, entry);
	iconVariantCacheBytes += entry.buffer.length;
	while (iconVariantCacheBytes > ICON_CACHE_LIMIT && iconVariantCache.size > 1) {
		const oldestKey = iconVariantCache.keys().next().value;
		const oldest = iconVariantCache.get(oldestKey);
		iconVariantCache.delete(oldestKey);
		if (oldest) iconVariantCacheBytes -= oldest.buffer.length;
	}
}

async function buildIconVariant(buffer, contentType) {
	const sharp = require('sharp');
	const metadata = await sharp(buffer).metadata();
	const width = metadata.width || 0;
	const height = metadata.height || 0;
	if (!width || !height) return null;
	if (width <= ICON_MAX_DIMENSION && height <= ICON_MAX_DIMENSION) return null;
	if ((metadata.pages || 1) > 1) return null; // animated: keep original
	let pipeline = sharp(buffer).resize({
		width: ICON_MAX_DIMENSION,
		height: ICON_MAX_DIMENSION,
		fit: 'inside',
		withoutEnlargement: true,
	});
	if (contentType === 'image/jpeg') pipeline = pipeline.jpeg({ quality: 85 });
	else if (contentType === 'image/webp') pipeline = pipeline.webp({ quality: 85 });
	else if (contentType === 'image/avif') pipeline = pipeline.avif({ quality: 70 });
	else if (contentType === 'image/png') pipeline = pipeline.png();
	else return null;
	const resized = await pipeline.toBuffer();
	return resized.length < buffer.length ? resized : null;
}

async function sendStoredIcon(req, res, fileId) {
	const storage = getStorageAdapter(req);
	if (!storage || typeof storage.read !== 'function') return false;
	try {
		const file = await storage.read(fileId);
		const contentType = String(file?.contentType || '').split(';', 1)[0].trim().toLowerCase();
		const buffer = Buffer.isBuffer(file?.buffer) ? file.buffer : Buffer.from(file?.buffer || '');
		if (!contentType.startsWith('image/') || buffer.length === 0) return false;
		const sourceHash = require('crypto').createHash('sha256').update(buffer).digest('hex').slice(0, 24);
		let outgoing = buffer;
		if (contentType !== 'image/gif' && contentType !== 'image/svg+xml') {
			const cacheKey = `${fileId}|${sourceHash}`;
			const cached = iconCacheGet(cacheKey);
			if (cached) {
				outgoing = cached.buffer;
			} else {
				try {
					const variant = await buildIconVariant(buffer, contentType);
					if (variant) outgoing = variant;
				} catch (error) {
					console.warn('[users/icon] resize failed, serving original:', error.message);
				}
				iconCacheSet(cacheKey, { buffer: outgoing });
			}
		}
		const etag = `"icon-${require('crypto').createHash('sha256').update(outgoing).digest('hex').slice(0, 24)}"`;
		res.setHeader('Cache-Control', 'public, max-age=21600, stale-while-revalidate=86400');
		res.setHeader('Content-Type', contentType);
		res.setHeader('ETag', etag);
		if (req.headers['if-none-match'] === etag) {
			res.status(304).end();
			return true;
		}
		res.send(outgoing);
		return true;
	} catch (error) {
		console.warn('[users/icon] stored icon read failed:', error.message);
		return false;
	}
}

function serializeUserCard(user, publicUrl, { includeSearchExclusion = false } = {}) {
	return {
		...serializeUserBrief(user, publicUrl, { includeSearchExclusion }),
		me: user.me || user.bio || '',
		header_image: user.header_image || null,
		created_at: user.created_at || user.createdAt || null,
	};
}

function isProfileSectionVisible(user, viewerId, section, viewerUser = null) {
	if (viewerId != null && Number(viewerId) === Number(user?.id)) return true;
	if (viewerId != null && user) {
		const userBlocksViewer = normalizeBlockList(user.block, user.id).includes(Number(viewerId));
		const viewerBlocksUser = viewerUser ? normalizeBlockList(viewerUser.block, viewerUser.id).includes(Number(user.id)) : false;
		if (userBlocksViewer || viewerBlocksUser) return false;
	}
	const settings = user?.settings || {};
	const settingBySection = {
		likes: 'show_like',
		stars: 'show_star',
		following: 'show_follow',
		followers: 'show_follower',
	};
	const setting = settingBySection[section];
	return setting === 'show_follower' ? settings[setting] !== false : Boolean(settings[setting]);
}

function sendPrivateProfileSection(res, section) {
	return res.status(403).json({
		error: 'このプロフィール項目は非公開です',
		visibility: 'private',
		section,
	});
}

async function getScratchUserIconUrl(scid) {
	if (!scid) return 'https://uploads.scratch.mit.edu/get_image/user/0_60x60.png';
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 5000);
	try {
		const res = await fetch(
			`https://api.scratch.mit.edu/users/${encodeURIComponent(scid)}`,
			{
				headers: { Accept: 'application/json' },
				signal: controller.signal,
			},
		);
		if (res.ok) {
			const data = await res.json();
			if (data && data.profile && data.profile.images) {
				const imgUrl =
					data.profile.images['90x90'] ||
					data.profile.images['60x60'] ||
					data.profile.images['50x50'] ||
					data.profile.images['32x32'];
				if (imgUrl) return imgUrl;
			}
		}
	} catch (err) {
		console.warn(`[users/icon] Scratch API fetch error for ${scid}:`, err.message);
	} finally {
		clearTimeout(timeout);
	}
	return `https://uploads.scratch.mit.edu/get_image/user/${encodeURIComponent(scid)}_60x60.png`;
}

async function handleUserIcon(req, res) {
	const db = getDbAdapter(req);
	const userId = parseInt(req.params.userId, 10);
	if (!Number.isInteger(userId) || userId <= 0) {
		return res.redirect(302, '/emoji/neko.svg');
	}

	try {
		const user = await db.getUserById(userId);

		if (user && user.icon_data && user.icon_data.trim() !== '') {
			const iconData = user.icon_data.trim();

			// R2/D1・ローカルストレージに保存されたアイコンはキーだけをDBへ保存する。
			// キーを相対リダイレクトすると現在の /server/api/users/... 配下として解決されるため、
			if (!/^(?:https?:)?\/\//i.test(iconData) && !iconData.startsWith('/')) {
				if (await sendStoredIcon(req, res, iconData)) return;
				const storage = getStorageAdapter(req);
				if (storage && typeof storage.getPublicUrl === 'function') {
					try {
						const publicUrl = await storage.getPublicUrl(iconData);
						if (typeof publicUrl === 'string' && publicUrl && isAllowedIconRedirectUrl(publicUrl)) {
							return res.redirect(302, publicUrl);
						}
					} catch (error) {
						console.warn('[users/icon] stored icon URL resolution failed:', error.message);
					}
				}

				// ユーザーファイルの公開URLを設定していない場合でも、Push通知が
				// このAPIを読み込めるよう、保存済み画像を直接返す。
				if (await sendStoredIcon(req, res, iconData)) return;
				return res.redirect(302, '/emoji/neko.svg');
			}

			// 同一オリジン相対パス、または許可済みScratch CDNのURLだけをリダイレクトする。
			// それ以外はフォールバック画像へ倒す。
			if (isAllowedIconRedirectUrl(iconData)) {
				return res.redirect(302, iconData);
			}
			return res.redirect(302, '/emoji/neko.svg');
		}

		if (user && user.scid != null && String(user.scid).trim() !== '') {
			if (await sendScratchFallbackIcon(req, res, String(user.scid).trim())) return;
			res.setHeader('Cache-Control', 'public, max-age=60');
			return res.redirect(302, '/emoji/neko.svg');
		}
	} catch (err) {
		console.error('[users] icon route error:', err);
	}

	return res.redirect(302, '/emoji/neko.svg');
}

async function getAllActiveUserGroups(db, userId) {
	const groups = [];
	const limit = 200;
	for (let offset = 0; ; offset += limit) {
		const page = await db.getUserGroups(userId, { status: 'active', limit, offset });
		groups.push(...page);
		if (page.length < limit) return groups;
	}
}

router.get({
	path: '/:userId/icon',
	summary: 'ユーザーアバターアイコン画像の取得',
	auth: 'none',
}, handleUserIcon);

router.get({
	path: '/search',
	summary: 'ユーザー検索',
	auth: 'optional',
}, optionalAuth, searchLimiter, async (req, res) => {
	const db = getDbAdapter(req);
	const query = req.query.q || '';
	const requestedLimit = parseInt(req.query.limit, 10);
	const pageSize = config.limits.userSearchPageSize;
	const minimum = pageSize.min === null ? 1 : pageSize.min;
	const maximum = pageSize.max;
	let limit = Number.isInteger(requestedLimit) && requestedLimit > 0
		? requestedLimit
		: config.limits.userSearchDefaultLimit;
	limit = Math.max(limit, minimum);
	if (maximum !== null) limit = Math.min(limit, maximum);
	const rawCursor = typeof req.query.cursor === 'string' ? req.query.cursor.trim() : null;
	const offset = !rawCursor ? Math.max(parseInt(req.query.offset, 10) || 0, 0) : 0;

	if (query.trim().length === 0) {
		return res.json({ users: [], offset: 0, has_more: false, next_cursor: null });
	}

	try {
		const result = await db.searchUsers(query, limit, offset, { cursor: rawCursor, withNextCursor: true });
		const users = Array.isArray(result) ? result : (result?.users || []);
		const hasMore = Array.isArray(result) ? users.length > limit : !!result?.has_more;
		const nextCursor = result?.next_cursor || null;
		const slice = Array.isArray(result) ? users.slice(0, limit) : users;
		await attachGroupBadgesToUsers(db, slice);
		res.json({
			users: slice.map((user) => serializeUserCard(user, getPublicUrl(req), {
				includeSearchExclusion: Boolean(req.user?.admin),
			})),
			offset,
			has_more: hasMore,
			next_cursor: nextCursor,
		});
	} catch (err) {
		console.error('[users] search error:', err);
		res.status(500).json({ error: 'ユーザー検索に失敗しました' });
	}
});

router.get({
	path: '/recommended',
	summary: 'おすすめユーザー一覧の取得',
	auth: 'optional',
}, optionalAuth, searchLimiter, async (req, res) => {
	const db = getDbAdapter(req);
	const viewerId = req.user ? req.user.id : null;
	res.setHeader('Cache-Control', 'private, no-store');

	try {
		const selected = await getRecommendedUsers(db, viewerId, 3);
		await attachGroupBadgesToUsers(db, selected);
		res.json({ users: selected.map((user) => serializeUserCard(user, getPublicUrl(req), {
			includeSearchExclusion: Boolean(req.user?.admin),
		})) });
	} catch (err) {
		console.error('[users] recommended error:', err);
		res.status(500).json({ error: 'おすすめユーザー取得に失敗しました' });
	}
});

router.get({
	path: '/logs',
	summary: 'ログイン履歴・アクセスログの取得',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);

	if (!req.user.admin) {
		return res.status(403).json({ error: 'Admin access required' });
	}

	const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
	const offset = parseInt(req.query.offset, 10) || 0;

	try {
		const logs = await db.getLogs(limit, offset);
		res.json({ logs });
	} catch (err) {
		console.error('[users] logs error:', err);
		res.status(500).json({ error: 'ログ取得に失敗しました' });
	}
});


router.get({
	path: '/:userId',
	summary: 'ユーザープロフィール詳細の取得',
	auth: 'optional',
}, optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = parseInt(req.params.userId, 10);

	if (!Number.isInteger(userId) || userId < 0) {
		return res.status(400).json({ error: 'Invalid user id' });
	}

	try {
		const user = await db.getUserById(userId);
		if (!user) {
			return res.status(404).json({ error: 'User not found' });
		}

		const viewerId = req.user ? req.user.id : null;
		let groups = [];
		let targetGroups = null;

		if (viewerId != null) {
			if (viewerId === userId) {
				targetGroups = await getAllActiveUserGroups(db, userId);
				groups = targetGroups.map((group) => ({
					id: String(group.id),
					name: group.name || '',
					description: group.description || '',
					icon_data: group.iconData ?? group.icon_data ?? null,
					header_image: group.headerImage ?? group.header_image ?? null,
					visibility: group.visibility || 'open',
					member_count: Math.max(0, Number(group.memberCount ?? group.member_count) || 0),
				}));
			} else if (typeof db.getMutualUserGroups === 'function') {
				const mutualGroups = await db.getMutualUserGroups(userId, viewerId, { limit: 200, offset: 0 });
				groups = mutualGroups.map((group) => ({
					id: String(group.id),
					name: group.name || '',
					description: group.description || '',
					icon_data: group.iconData ?? group.icon_data ?? null,
					header_image: group.headerImage ?? group.header_image ?? null,
					visibility: group.visibility || 'open',
					member_count: Math.max(0, Number(group.memberCount ?? group.member_count) || 0),
				}));
			} else {
				const [viewerGroups, fetchedTargetGroups] = await Promise.all([
					db.getUserGroups(viewerId, { status: 'active', limit: 200, offset: 0 }),
					getAllActiveUserGroups(db, userId),
				]);
				targetGroups = fetchedTargetGroups;
				const targetGroupIds = new Set(targetGroups.map((group) => String(group.id)));
				groups = viewerGroups
					.filter((group) => targetGroupIds.has(String(group.id)))
					.map((group) => ({
						id: String(group.id),
						name: group.name || '',
						description: group.description || '',
						icon_data: group.iconData ?? group.icon_data ?? null,
						header_image: group.headerImage ?? group.header_image ?? null,
						visibility: group.visibility || 'open',
						member_count: Math.max(0, Number(group.memberCount ?? group.member_count) || 0),
					}));
			}
		}

		if (targetGroups === null && typeof db.getUserGroups === 'function') {
			targetGroups = await getAllActiveUserGroups(db, userId);
		}

		const profile = await serializePublicProfile(
			db,
			user,
			viewerId,
			getPublicUrl(req),
			req.user?.visibilityUser || req.user || null,
			targetGroups,
		);
		res.json({ user: { ...profile, groups } });
	} catch (err) {
		console.error('[users] profile error:', err);
		res.status(500).json({ error: 'プロフィール取得に失敗しました' });
	}
});

router.get({
	path: '/',
	summary: '複数ユーザーIDの一括プロフィール取得',
	auth: 'optional',
}, optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const ids = (req.query.ids || '')
		.split(',')
		.map((id) => parseInt(id, 10))
		.filter((id) => Number.isInteger(id) && id >= 0);

	if (ids.length === 0) {
		return res.json({ users: [] });
	}

	try {
		const users = await db.getUsersByIds(ids);
		await attachGroupBadgesToUsers(db, users);
		res.json({ users: users.map((user) => serializeUserCard(user, getPublicUrl(req), {
			includeSearchExclusion: Boolean(req.user?.admin),
		})) });

	} catch (err) {
		console.error('[users] batch error:', err);
		res.status(500).json({ error: 'ユーザー取得に失敗しました' });
	}
});

router.get({
	path: '/:userId/counts',
	summary: 'ユーザーのカウント情報取得',
	auth: 'optional',
}, optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = parseInt(req.params.userId, 10);

	if (!Number.isInteger(userId) || userId < 0) {
		return res.status(400).json({ error: 'Invalid user id' });
	}

	try {
		if (req.user?.id && await hasBlockRelationship(db, req.user.id, userId)) {
			return res.json({
				post_count: 0,
				media_count: 0,
				follower_count: 0,
				following_count: 0,
			});
		}
		if (typeof db.getPublicProfileStats === 'function') {
			const stats = await db.getPublicProfileStats(userId);
			return res.json({
				post_count: Number(stats.postCount ?? stats.post_count ?? 0),
				media_count: Number(stats.mediaCount ?? stats.media_count ?? 0),
				follower_count: Number(stats.followerCount ?? stats.follower_count ?? 0),
				following_count: Number(stats.followingCount ?? stats.following_count ?? 0),
			});
		}

		const [post_count, media_count, follower_count, following_count] =
			await Promise.all([
				db.getPostCount ? db.getPostCount(userId) : 0,
				db.getMediaCount ? db.getMediaCount(userId) : 0,
				db.getFollowerCount ? db.getFollowerCount(userId) : 0,
				db.getFollowingCount ? db.getFollowingCount(userId) : 0,
			]);

		res.json({
			post_count,
			media_count,
			follower_count,
			following_count,
		});
	} catch (err) {
		console.error('[users] counts error:', err);
		res.status(500).json({ error: 'カウント取得に失敗しました' });
	}
});

router.get({
	path: '/:userId/media',
	summary: 'ユーザーの投稿メディア一覧取得',
	auth: 'optional',
}, optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = parseInt(req.params.userId, 10);
	const limit = Math.min(parseInt(req.query.limit, 10) || 15, 50);
	const rawCursor = typeof req.query.cursor === 'string' ? req.query.cursor.trim() : null;
	const offset = !rawCursor ? (parseInt(req.query.offset, 10) || 0) : 0;
	const type = req.query.type;
	if (type && !['image', 'video'].includes(type)) {
		return res.status(400).json({ error: 'Invalid type parameter' });
	}

	if (!Number.isInteger(userId) || userId < 0) {
		return res.status(400).json({ error: 'Invalid user id' });
	}

	try {
		if (req.user?.id && await hasBlockRelationship(db, req.user.id, userId)) {
			return res.json({ media_items: [], next_cursor: null });
		}
		const mediaResult = await db.getMediaPosts(userId, limit, offset, type, { cursor: rawCursor, withNextCursor: true });
		const mediaItems = Array.isArray(mediaResult) ? mediaResult : (mediaResult?.media_items || []);
		const mediaPostIds = [...new Set(mediaItems.map((item) => Number(item.post_id)).filter(Number.isInteger))];
		const mediaPosts = typeof db.getPostsByIds === 'function'
			? await db.getPostsByIds(mediaPostIds)
			: [];
		const viewablePostIds = new Set((await filterViewablePosts(db, mediaPosts, req.user?.id || null))
			.filter((post) => !(post.scheduledAt ?? post.scheduled_at))
			.map((post) => Number(post.id)));
		const visibleMediaItems = mediaItems.filter((item) => viewablePostIds.has(Number(item.post_id)));
		const nextCursor = mediaResult?.next_cursor || mediaItems?.next_cursor || null;
		res.json({
			media_items: visibleMediaItems,
			next_cursor: nextCursor,
		});
	} catch (err) {
		console.error('[users] media error:', err);
		res.status(500).json({ error: 'メディア取得に失敗しました' });
	}
});

router.get({
	path: '/:userId/scheduled',
	summary: '本人の予約済み投稿一覧取得',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = parseInt(req.params.userId, 10);
	const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
	const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

	if (!Number.isInteger(userId) || userId < 0) {
		return res.status(400).json({ error: 'Invalid user id' });
	}
	if (Number(req.user?.id) !== userId) {
		return res.status(403).json({ error: '予約済み投稿は本人のみ閲覧できます' });
	}

	try {
		if (typeof db.getScheduledPostsByUser !== 'function') {
			return res.json({ posts: [], has_more: false });
		}
		const now = new Date().toISOString();
		const scheduled = await db.getScheduledPostsByUser(userId, now, { limit: limit + 1, offset });
		const hasMore = scheduled.length > limit;
		const page = scheduled.slice(0, limit);
		const posts = await serializePostsByIds(
			db,
			page.map((post) => Number(post.id)),
			req.user.id,
			getPublicUrl(req),
			req.user?.visibilityUser || null,
		);
		res.json({ posts, has_more: hasMore });
	} catch (err) {
		console.error('[users] scheduled error:', err);
		res.status(500).json({ error: '予約済み投稿の取得に失敗しました' });
	}
});

router.get({
	path: '/:userId/is-lock',
	summary: 'ユーザーの鍵垢状態確認',
	auth: 'optional',
}, optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = parseInt(req.params.userId, 10);

	if (!Number.isInteger(userId) || userId < 0) {
		return res.status(400).json({ error: 'Invalid user id' });
	}

	try {
		const user = await db.getUserById(userId);
		if (!user) {
			return res.status(404).json({ error: 'User not found' });
		}
		res.json({ lock: !!(user.settings && user.settings.lock) });
	} catch (err) {
		console.error('[users] is-lock error:', err);
		res.status(500).json({ error: '取得に失敗しました' });
	}
});

router.get({
	path: '/:userId/status',
	summary: 'ユーザー関係状態の取得',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = parseInt(req.params.userId, 10);

	if (!req.user.admin) {
		return res.status(403).json({ error: 'Admin access required' });
	}

	if (!Number.isInteger(userId) || userId < 0) {
		return res.status(400).json({ error: 'Invalid user id' });
	}

	try {
		const status = await db.getUserStatus(userId);
		if (!status) {
			return res.status(404).json({ error: 'User not found' });
		}
		res.json({ status });
	} catch (err) {
		console.error('[users] status error:', err);
		res.status(500).json({ error: 'ステータス取得に失敗しました' });
	}
});

router.put({
	path: '/:userId/status',
	summary: 'ユーザー関係状態の更新',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = parseInt(req.params.userId, 10);

	if (!req.user.admin) {
		return res.status(403).json({ error: 'Admin access required' });
	}

	if (!Number.isInteger(userId) || userId < 0) {
		return res.status(400).json({ error: 'Invalid user id' });
	}

	try {
		const { shadow } = req.body || {};
		// shadow が真偽値で指定されていない場合は書き込まない（未指定を解除と解釈しない）。
		if (typeof shadow !== 'boolean') {
			return res.status(400).json({ error: 'shadow には真偽値を指定してください' });
		}
		const status = await require('../services/ModLogService').operation(db, 'admin', req.user.id, shadow ? 'search_exclude' : 'search_include', 'user', userId, () => db.setUserStatus(userId, { shadow }), 'failure');
		if (!status) {
			return res.status(404).json({ error: 'User not found' });
		}
		invalidateUserBriefCache(userId);
		timelineCacheManager.updatePostAuthor(userId, { shadow });
		timelineCacheManager.invalidateAuthorEntries(userId);

		res.json({ success: true, status });
	} catch (err) {
		console.error('[users] set status error:', err);
		res.status(500).json({ error: 'ステータス更新に失敗しました' });
	}
});

router.post({
	path: '/:userId/follow',
	summary: 'ユーザーのフォロー/フォロー解除',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const followerId = req.user.id;
	const followingId = parseInt(req.params.userId, 10);

	if (!Number.isInteger(followingId) || followingId <= 0) {
		return res.status(400).json({ error: 'Invalid user id' });
	}

	try {
		if (await hasBlockRelationship(db, followerId, followingId)) {
			return res.status(403).json({ error: 'ブロック関係にあるユーザーをフォローすることはできません。' });
		}
		const queue = req.app.locals.postActionQueue;
		if (queue && typeof db.getFollowIds === 'function') {
			const follows = await db.getFollowIds(followerId);
			const currentlyFollowing = follows.some((id) => Number(id) === followingId);
			const actionId = queue.enqueue('follow', async () => {
				await assertAuthenticatedUserAccess(req, db, ['write']);
				const result = await db.toggleFollow(followerId, followingId);
				if (result.following) {
					await createNotificationIfAllowed(db, {
						userId: followingId,
						type: 'follow',
						fromUserId: followerId,
						target: { kind: 'user', id: followingId },
					});
				}
			});
			const updatedFollows = new Set(follows.map(Number));
			if (currentlyFollowing) updatedFollows.delete(followingId);
			else updatedFollows.add(followingId);
			return res.status(202).json({ success: true, queued: true, action_id: actionId, following: !currentlyFollowing, updated_follows: [...updatedFollows] });
		}
		const result = await db.toggleFollow(followerId, followingId);

			if (result.following) {
				await createNotificationIfAllowed(db, {
					userId: followingId,
					type: 'follow',
					fromUserId: followerId,
					target: { kind: 'user', id: followingId },
				});
			}

		const updatedFollows = await db.getFollowIds(followerId);

		res.json({
			success: true,
			following: result.following,
			updated_follows: updatedFollows,
		});
	} catch (err) {
		console.error('[users] follow error:', err);
		res.status(400).json({
			error: err.message || 'フォロー処理に失敗しました',
		});
	}
});

router.post({
	path: '/:userId/block',
	summary: 'ユーザーのブロック/ブロック解除（切り替え）',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = req.user.id;
	const targetUserId = parseInt(req.params.userId, 10);

	if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
		return res.status(400).json({ error: 'Invalid user id' });
	}
	if (userId === targetUserId) {
		return res.status(400).json({ error: '自分自身をブロックすることはできません。' });
	}

	try {
		const result = await db.toggleBlock(userId, targetUserId);
		invalidateUserBriefCache(userId);
		invalidateUserBriefCache(targetUserId);
		res.json({
			success: true,
			blocked: result.blocked,
			block: result.block,
			user_id: targetUserId,
		});
	} catch (err) {
		console.error('[users] block error:', err);
		res.status(400).json({
			error: err.message || 'ブロック処理に失敗しました',
		});
	}
});

router.get({
	path: '/:userId/:section(likes|stars)',
	summary: 'ユーザーがいいね/スターした投稿一覧取得',
	auth: 'optional',
}, optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = parseInt(req.params.userId, 10);
	const section = req.params.section;
	const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
	const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
	if (!Number.isInteger(userId) || userId < 0) return res.status(400).json({ error: 'Invalid user id' });

	try {
		const user = await db.getUserById(userId);
		if (!user) return res.status(404).json({ error: 'User not found' });
		if (!isProfileSectionVisible(user, req.user?.id ?? null, section, req.user?.visibilityUser || req.user)) return sendPrivateProfileSection(res, section);
		const ids = section === 'likes'
			? await db.getLikeIds(userId)
			: await db.getStarIds(userId);
		const orderedIds = Array.isArray(ids) ? ids : [];
		const pageIds = orderedIds.slice(offset, offset + limit);
			const posts = await serializePostsByIds(
				db,
				pageIds,
				req.user?.id ?? null,
				getPublicUrl(req),
				req.user?.visibilityUser || null,
			);
		res.json({
			posts,
			has_more: orderedIds.length > offset + limit,
		});
	} catch (err) {
		console.error(`[users] ${section} error:`, err);
		res.status(500).json({ error: 'プロフィール投稿の取得に失敗しました' });
	}
});

router.get({
	path: '/:userId/followers',
	summary: 'ユーザーのフォロワー一覧取得',
	auth: 'optional',
}, optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = parseInt(req.params.userId, 10);
	const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
	const rawCursor = typeof req.query.cursor === 'string' ? req.query.cursor.trim() : null;
	const offset = !rawCursor ? (parseInt(req.query.offset, 10) || 0) : 0;

	if (!Number.isInteger(userId) || userId < 0) {
		return res.status(400).json({ error: 'Invalid user id' });
	}

	try {
		const target = await db.getUserById(userId);
		if (!target) return res.status(404).json({ error: 'User not found' });
		if (!isProfileSectionVisible(target, req.user?.id ?? null, 'followers', req.user?.visibilityUser || req.user)) return sendPrivateProfileSection(res, 'followers');
		const result = await db.getFollowers(userId, limit, offset, { cursor: rawCursor, withNextCursor: true });
		const users = Array.isArray(result) ? result : (result?.users || []);
		const hasMore = Array.isArray(result) ? users.length > limit : !!result?.has_more;
		const nextCursor = result?.next_cursor || null;
		const slice = Array.isArray(result) ? users.slice(0, limit) : users;
		await attachGroupBadgesToUsers(db, slice);
		res.json({
			followers: slice.map((u) => serializeUserCard(u)),
			has_more: hasMore,
			next_cursor: nextCursor,
		});
	} catch (err) {
		console.error('[users] followers error:', err);
		res.status(500).json({ error: 'フォロワー取得に失敗しました' });
	}
});

router.get({
	path: '/:userId/following',
	summary: 'ユーザーのフォロー中一覧取得',
	auth: 'optional',
}, optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = parseInt(req.params.userId, 10);
	const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
	const rawCursor = typeof req.query.cursor === 'string' ? req.query.cursor.trim() : null;
	const offset = !rawCursor ? (parseInt(req.query.offset, 10) || 0) : 0;

	if (!Number.isInteger(userId) || userId < 0) {
		return res.status(400).json({ error: 'Invalid user id' });
	}

	try {
		const target = await db.getUserById(userId);
		if (!target) return res.status(404).json({ error: 'User not found' });
		if (!isProfileSectionVisible(target, req.user?.id ?? null, 'following', req.user?.visibilityUser || req.user)) return sendPrivateProfileSection(res, 'following');
		const result = await db.getFollowing(userId, limit, offset, { cursor: rawCursor, withNextCursor: true });
		const users = Array.isArray(result) ? result : (result?.users || []);
		const hasMore = Array.isArray(result) ? users.length > limit : !!result?.has_more;
		const nextCursor = result?.next_cursor || null;
		const slice = Array.isArray(result) ? users.slice(0, limit) : users;
		await attachGroupBadgesToUsers(db, slice);
		res.json({
			following: slice.map((u) => serializeUserCard(u)),
			has_more: hasMore,
			next_cursor: nextCursor,
		});
	} catch (err) {
		console.error('[users] following error:', err);
		res.status(500).json({ error: 'フォロー中取得に失敗しました' });
	}
});

router.get({
	path: '/:userId/posts',
	summary: 'ユーザーの投稿一覧取得',
	auth: 'optional',
}, optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = parseInt(req.params.userId, 10);
	const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
	const offset = parseInt(req.query.offset, 10) || 0;
	const mode = req.query.mode || 'all';

	if (!Number.isInteger(userId) || userId < 0) {
		return res.status(400).json({ error: 'Invalid user id' });
	}

	try {
		const all = await db.getPostsByUserId(
			userId,
			offset + limit + 1,
			req.user ? req.user.id : null,
		);
			const currentUserId = req.user ? req.user.id : null;
			const knownViewer = req.user?.visibilityUser || null;
			const visibilityContext = await createPostVisibilityContext(
				db,
				all,
				currentUserId,
				null,
				knownViewer,
			);
			let filtered = await filterViewablePosts(db, all, currentUserId, visibilityContext);
		filtered = filtered.filter((post) => !(post.scheduledAt ?? post.scheduled_at));
		if (mode === 'posts') {
			filtered = filtered.filter((p) => !p.replyTo);
		} else if (mode === 'replies') {
			filtered = filtered.filter((p) => p.replyTo);
		}
		const slice = filtered.slice(offset, offset + limit);
		const has_more = filtered.length > offset + limit;
		res.json({
				posts: await serializePostsBatch(
					db,
					slice,
					currentUserId,
					getPublicUrl(req),
					knownViewer,
					visibilityContext,
				),
			has_more,
		});
	} catch (err) {
		console.error('[users] posts error:', err);
		res.status(500).json({ error: 'ポスト取得に失敗しました' });
	}
});

router.get({
	path: '/:userId/pin',
	summary: 'ユーザーの固定投稿一覧取得',
	auth: 'optional',
}, optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = parseInt(req.params.userId, 10);

	if (!Number.isInteger(userId) || userId < 0) {
		return res.status(400).json({ error: 'Invalid user id' });
	}

	try {
		if (req.user?.id && await hasBlockRelationship(db, req.user.id, userId)) {
			return res.json({ pin_id: null });
		}
		const pinId = await db.getPinnedPostId(userId);
		res.json({ pin_id: pinId });
	} catch (err) {
		console.error('[users] pin error:', err);
		res.status(500).json({ error: 'ピン留め取得に失敗しました' });
	}
});

router.post({
	path: '/me/account/delete/prepare',
	summary: 'アカウント削除の確認トークン発行',
	auth: 'session',
}, requireAuthAllowFrozen, requireInteractiveSession, accountOperationLimiter, (req, res) => {
	if (req.user.accountOperation) return res.status(409).json({ error: '別のアカウント処理が進行中です。' });
	discardExpiredAccountConfirmations();
	const confirmationToken = crypto.randomBytes(32).toString('base64url');
	accountDeletionConfirmations.set(getAccountConfirmationKey(confirmationToken), {
		userId: req.user.id,
		sessionTokenHash: req.user.sessionTokenHash,
		expiresAt: Date.now() + ACCOUNT_CONFIRMATION_TTL_MS,
	});
	return res.json({ confirmation_token: confirmationToken, expires_in_seconds: ACCOUNT_CONFIRMATION_TTL_MS / 1000 });
});

router.delete({
	path: '/me/account',
	summary: 'アカウントの完全削除',
	auth: 'session',
}, requireAuthAllowFrozen, requireInteractiveSession, accountOperationLimiter, async (req, res) => {
	const confirmationToken = String(req.body?.confirmation_token || '');
	const key = getAccountConfirmationKey(confirmationToken);
	const confirmation = accountDeletionConfirmations.get(key);
	accountDeletionConfirmations.delete(key);
	if (!confirmation || confirmation.expiresAt <= Date.now() || confirmation.userId !== req.user.id || confirmation.sessionTokenHash !== req.user.sessionTokenHash) {
		return res.status(400).json({ error: 'アカウント削除の確認が無効または期限切れです。' });
	}

	const db = getDbAdapter(req);
	const storage = getStorageAdapter(req);
	let started = null;
	try {
		started = await db.beginAccountOperation(req.user.id, 'deleting');
		if (!started) return res.status(409).json({ error: 'アカウント削除を開始できません。' });
		req.app.locals.realtime?.closeUser?.(req.user.id, 1012, 'Account deletion');
		await deleteOwnedImposterAccounts(req, db, storage, req.user.id);
		const attachmentKeys = await db.getAccountAttachmentKeys(req.user.id);
		await db.invalidateAllSessions(req.user.id);
		const deleted = await db.deleteAccount(req.user.id);
		if (!deleted) throw new Error('Account deletion did not complete');
		invalidateUserBriefCache(req.user.id);
		await deleteStoredAccountAttachments(storage, attachmentKeys);
		res.clearCookie('nyaitter_session');
		res.clearCookie('nyaitter_accounts');
		return res.json({ success: true });
	} catch (error) {
		console.error('[users] account deletion failed:', error);
		if (started) await db.finishAccountOperation(req.user.id, 'deleting').catch(() => {});
		return res.status(500).json({ error: 'アカウント削除に失敗しました。' });
	}
});

router.put({
	path: '/me',
	summary: '自分のプロフィールの更新',
	auth: 'required',
}, requireAuth, profileUpdateLimiter, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = req.user.id;
	const { name, me, bio, header_image, icon_data, settings, block } =
		req.body;
	if (containsProtectedStatus(req.body)) return res.status(400).json({error:'利用状態はプロフィール設定から変更できません'});
	const validationError =
		validateProfileText(name, 'name', config.limits.userNameLength) ||
		validateProfileText(me, 'me', config.limits.profileBioLength) ||
		validateProfileText(bio, 'bio', config.limits.profileBioLength);
	if (validationError) return res.status(400).json({ error: validationError });

	try {
		let nextSettings = settings;
		if (settings !== undefined) {
			const [current, profile] = await Promise.all([db.getUserById(userId), db.getReputationProfile(userId)]);
			const displayError = validateDisplaySettings(settings, actualRanks(profile));
			if (displayError) return res.status(400).json({ error: displayError });
			nextSettings = { ...current?.settings, ...settings };
			if (settings.display_ranks !== undefined) nextSettings.display_ranks = { ...current?.settings?.display_ranks, ...settings.display_ranks };
		}
		const updated = await db.updateUserProfile(userId, {
			name,
			me,
			bio,
			header_image,
			icon_data,
			settings: nextSettings,
			block,
		});
		if (!updated) {
			return res.status(404).json({ error: 'User not found' });
		}
		invalidateUserBriefCache(userId);
		updateUserBriefCache(updated, getPublicUrl(req));
		timelineCacheManager.updatePostAuthor(userId, {
			name: updated.name,
			me: updated.me || updated.bio || '',
			bio: updated.bio || updated.me || '',
			icon_data: updated.icon_data,
			header_image: updated.header_image,
		});
		res.json({
			user: await serializeUser(db, updated, userId, getPublicUrl(req)),
		});
	} catch (err) {
		console.error('[users] update profile error:', err);
		res.status(500).json({ error: 'プロフィール更新に失敗しました' });
	}
});

router.put({
	path: '/:userId',
	summary: 'ユーザープロフィールの更新',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const userId = parseInt(req.params.userId, 10);

	if (!req.user.admin) {
		return res.status(403).json({ error: 'Admin access required' });
	}

	if (!Number.isInteger(userId) || userId < 0) {
		return res.status(400).json({ error: 'Invalid user id' });
	}

	const { verify, freeze, admin } = req.body || {};
	const actions = [
		...(verify !== undefined ? [verify ? 'verify_user' : 'unverify_user'] : []),
		...(freeze !== undefined ? [freeze ? 'freeze' : 'unfreeze'] : []),
		...(admin !== undefined ? [admin ? 'grant_admin' : 'revoke_admin'] : []),
	];
	const modLog = require('../services/ModLogService');

	try {
		let updated;
		try {
			updated = await db.updateUserProfile(userId, { verify, freeze, admin });
		} catch (error) {
			for (const action of actions) await modLog.record(db, 'admin', req.user.id, action, 'user', userId, 'failure');
			throw error;
		}
		for (const action of actions) await modLog.record(db, 'admin', req.user.id, action, 'user', userId, updated ? 'success' : 'failure');
		if (!updated) {
			return res.status(404).json({ error: 'User not found' });
		}
		invalidateUserBriefCache(userId);
		updateUserBriefCache(updated, getPublicUrl(req));
		timelineCacheManager.updatePostAuthor(userId, {
			verify: updated.verify,
			admin: updated.admin,
		});

		res.json({
			user: await serializeUser(db, updated, req.user.id, getPublicUrl(req)),
		});
	} catch (err) {
		console.error('[users] admin update error:', err);
		res.status(500).json({ error: 'ユーザー更新に失敗しました' });
	}
});

module.exports = router;
