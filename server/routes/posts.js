const express = require('express');
const PostService = require('../services/PostService');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const config = require('../config');
const {
	serializePost,
	serializeReply,
	serializePostsBatch,
	serializePostsByIds,
	serializeNotification,
} = require('../utils/serialize');
const {
	CONTENT_TYPE_EXTENSIONS,
	isOwnedAttachmentKey,
	normalizeContentType,
} = require('../adapters/storage/safeStoragePath');
const { getPublicUrl } = require('../utils/nyaitterAddress');
const {
	canViewPost,
	filterViewablePosts,
	filterDiscoverablePosts,
} = require('../utils/postVisibility');
const {
	getDiscoverablePostPage,
} = require('../services/PostDiscoveryQueryService');
const {
	createNotificationIfAllowed,
} = require('../services/NotificationDeliveryService');

const router = express.Router();

function getDbAdapter(req) {
	return req.app.locals.dbAdapter;
}

async function publishNewNotification(req, userId, notification) {
	const structuredNotification = await serializeNotification(
		getDbAdapter(req),
		notification,
		getPublicUrl(req),
	);
	if (!structuredNotification) return;

	const realtime = req.app.locals.realtime;
	if (realtime) {
		try {
			await realtime.publishNewNotification(userId, structuredNotification, getDbAdapter(req));
		} catch (error) {
			console.warn('[posts] notification realtime delivery failed:', error.message);
		}
	}

	const pushService = req.app.locals.pushNotificationService;
	if (pushService?.enabled) {
		void pushService.sendNotificationToUser(userId, structuredNotification).catch((error) => {
			console.warn('[posts] notification push delivery failed:', error.message);
		});
	}
}

async function publishNewTimelinePost(req, authorUserId, postId) {
	const realtime = req.app.locals.realtime;
	if (!realtime?.publishPostToFollowers) return;

	try {
		await realtime.publishPostToFollowers(authorUserId, getDbAdapter(req), postId);
	} catch (error) {
		// 投稿自体はすでに永続化済みのため、リアルタイム配信失敗で投稿APIを失敗させない。
		console.warn('[posts] timeline realtime delivery failed:', error.message);
	}
}

function getStorageAdapter(req) {
	return req.app.locals.storageAdapter;
}

function getAttachmentStorageKeys(attachments) {
	let parsed = attachments;
	if (typeof parsed === 'string') {
		try { parsed = JSON.parse(parsed); } catch (_) { parsed = null; }
	}
	if (!Array.isArray(parsed)) return [];
	return [...new Set(parsed
		.map((attachment) => attachment && (attachment.id || attachment.key || null))
		.filter((key) => typeof key === 'string' && key.length > 0))];
}

async function deleteStoredAttachments(storage, attachments, context) {
	const keys = getAttachmentStorageKeys(attachments);
	if (keys.length === 0 || !storage) return;
	try {
		if (typeof storage.deleteMany === 'function') {
			await storage.deleteMany(keys);
		} else if (typeof storage.delete === 'function') {
			await Promise.all(keys.map((key) => storage.delete(key)));
		}
	} catch (error) {
		console.warn(`[posts] Failed to delete ${keys.length} attachment(s) from storage during ${context}:`, error.message);
	}
}

function safeParsePostId(idStr) {
	const n = parseInt(idStr, 10);
	return Number.isInteger(n) && n > 0 ? n : null;
}

async function getViewablePostIds(db, postIds, viewerId = null) {
	const uniqueIds = [...new Set((postIds || []).map(Number).filter(Number.isInteger))];
	if (uniqueIds.length === 0) return [];
	const posts = await db.getPostsByIds(uniqueIds);
	const viewable = await filterViewablePosts(db, posts, viewerId);
	const visibleIds = new Set(viewable.map((post) => Number(post.id)));
	return uniqueIds.filter((id) => visibleIds.has(id));
}

async function getDiscoverableModePage(
	db,
	{ mode, tab = 'foryou', query = '', viewerId = null, limit, offset },
) {
	const followIds =
		mode === 'timeline' && tab === 'following' && viewerId != null && db.getFollowIds
			? await db.getFollowIds(viewerId)
			: [];

	return getDiscoverablePostPage({
		db,
		viewerId,
		limit,
		offset,
		fetchCandidatePage: ({ limit: candidateLimit, offset: candidateOffset }) => {
			if (mode === 'timeline') {
				return db.getTimelinePostIds({
					tab,
					followIds,
					limit: candidateLimit,
					offset: candidateOffset,
				});
			}
			if (mode === 'recommended') {
				return db.getRecommendedPostIds({
					limit: candidateLimit,
					offset: candidateOffset,
				});
			}
			if (mode === 'search') {
				return db.searchPostIds(query, candidateLimit, candidateOffset);
			}
			throw new Error(`Unsupported discoverable mode: ${mode}`);
		},
	});
}

async function getThreadReplyPostIds(db, postId, limit, offset) {
	if (typeof db.getThreadReplyPostIds === 'function') {
		try {
			return await db.getThreadReplyPostIds(postId, limit, offset);
		} catch (error) {
			// 外部D1 Workerなどが段階的に更新される間は、従来の直下返信取得へ安全に後退する。
			console.warn('[posts] nested reply query fallback:', error.message);
		}
	}
	return db.getReplyPostIds(postId, limit, offset);
}

function collectPostContext(posts) {
	const authors = new Map();
	const mentionedIds = new Set();
	const visited = new Set();
	const visit = (post) => {
		if (!post || visited.has(post.id)) return;
		visited.add(post.id);
		if (post.author?.id != null) authors.set(Number(post.author.id), post.author);
		for (const match of String(post.content || '').matchAll(/@(\d+)/g)) {
			mentionedIds.add(Number(match[1]));
		}
		visit(post.reply_to_post);
		visit(post.reposted_post);
	};
	for (const post of posts || []) visit(post);
	return {
		authors,
		mentionedIds: [...mentionedIds].filter((id) => Number.isInteger(id) && id > 0),
	};
}

function decodeBase64File(value) {
	if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) {
		throw new Error('Invalid base64 file data');
	}
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
		throw new Error('Invalid base64 file data');
	}
	return Buffer.from(value, 'base64');
}

function validateAttachmentReferences(attachments, userId) {
	if (!Array.isArray(attachments)) {
		throw new Error('attachments must be an array');
	}

	for (const attachment of attachments) {
		if (!attachment || typeof attachment !== 'object') {
			throw new Error('Invalid attachment');
		}
		if (attachment.data !== undefined) {
			const contentType = normalizeContentType(attachment.contentType);
			if (!CONTENT_TYPE_EXTENSIONS.has(contentType)) {
				throw new Error('Unsupported attachment content type');
			}
			decodeBase64File(attachment.data);
			continue;
		}
		if (typeof attachment.id !== 'string' || !isOwnedAttachmentKey(attachment.id, userId)) {
			throw new Error('Attachment does not belong to the current user');
		}
		if (attachment.url !== undefined && !isValidAttachmentUrl(attachment.url)) {
			throw new Error('Invalid attachment URL');
		}
	}
}

// javascript: やクレデンシャル付きURL・オープンリダイレクト系の値を拒否する。
function isValidAttachmentUrl(value) {
	if (typeof value !== 'string' || value.length === 0) return true;
	if (value.startsWith('/')) return true;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && !url.username && !url.password;
	} catch (_) {
		return false;
	}
}

router.post('/uploads', requireAuth, async (req, res) => {
	const storage = getStorageAdapter(req);
	if (!storage || typeof storage.upload !== 'function') {
		return res.status(501).json({ error: 'Storage adapter not available' });
	}

	const { file, fileName, contentType } = req.body || {};
	if (!file || typeof fileName !== 'string' || !fileName.trim()) {
		return res.status(400).json({ error: 'file and fileName are required' });
	}

	const normalizedContentType = normalizeContentType(contentType);
	if (!CONTENT_TYPE_EXTENSIONS.has(normalizedContentType)) {
		return res.status(415).json({ error: 'Unsupported file content type' });
	}

	let buffer;
	try {
		buffer = decodeBase64File(file);
	} catch (_) {
		return res.status(400).json({ error: 'Invalid base64 file data' });
	}

	const maxSize = (config.limits.maxFileUploadSizeMB || 10) * 1024 * 1024;
	if (buffer.length === 0) {
		return res.status(400).json({ error: 'File must not be empty' });
	}
	if (buffer.length > maxSize) {
		return res.status(413).json({ error: `File too large (max ${config.limits.maxFileUploadSizeMB}MB)` });
	}

	try {
		const result = await storage.upload({
			file: buffer,
			fileName,
			contentType: normalizedContentType,
			folder: `attachments/${req.user.id}`,
		});

		res.json(result);
	} catch (err) {
		console.error('[posts] upload error:', err);
		res.status(500).json({ error: 'ファイルのアップロードに失敗しました' });
	}
});

router.delete('/uploads', requireAuth, async (req, res) => {
	const storage = getStorageAdapter(req);
	const { fileIds } = req.body || {};

	if (!Array.isArray(fileIds) || fileIds.length === 0) {
		return res.status(400).json({ error: 'fileIds is required' });
	}

	if (!storage || typeof storage.delete !== 'function') {
		return res.status(501).json({ error: 'Storage adapter not available' });
	}

	try {
		for (const fileId of fileIds) {
			if (typeof fileId !== 'string' || !isOwnedAttachmentKey(fileId, req.user.id)) {
				return res.status(403).json({ error: 'You can only delete your own attachments' });
			}
		}

		const uniqueFileIds = [...new Set(fileIds)];
		if (uniqueFileIds.length > 1000) {
			return res.status(400).json({ error: 'A maximum of 1000 files can be deleted per request' });
		}
		if (typeof storage.deleteMany === 'function') {
			await storage.deleteMany(uniqueFileIds);
		} else {
			await Promise.all(uniqueFileIds.map((fileId) => storage.delete(fileId)));
		}
		res.json({ success: true, deleted_count: uniqueFileIds.length });
	} catch (err) {
		console.error('[posts] delete uploads error:', err);
		res.status(500).json({ error: 'ファイル削除に失敗しました' });
	}
});

router.post('/', requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const storage = getStorageAdapter(req);
	const postService = new PostService({ dbAdapter: db, storageAdapter: storage });

	const { content, attachments = [], mask, lock, reply_to, repost_to } = req.body;
	const userId = req.user.id;

	const hasContent =
		typeof content === 'string' && content.trim().length > 0;
	const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
	const isSimpleRepost = (content === null || content === undefined || content === '') && repost_to;

	if (!hasContent && !hasAttachments && !isSimpleRepost) {
		return res.status(400).json({ error: 'content, attachments, or repost_to is required' });
	}
	const trimmed = hasContent ? content.trim() : '';
	if (trimmed.length > config.limits.postContentMax) {
		return res.status(400).json({ error: `content must be ${config.limits.postContentMax} characters or less` });
	}

	let processedAttachments;
	try {
		validateAttachmentReferences(attachments, userId);
		processedAttachments = attachments.map((att) => {
			if (att.data !== undefined) {
				return {
					buffer: decodeBase64File(att.data),
					fileName: att.fileName || 'file',
					contentType: normalizeContentType(att.contentType),
				};
			}
			return att;
		});
	} catch (error) {
		return res.status(400).json({ error: error.message || 'Invalid attachments' });
	}

	try {
		for (const targetId of [reply_to, repost_to].filter(Boolean)) {
			const target = await db.getPostById(Number(targetId));
			if (!target || !(await canViewPost(db, target, userId))) {
				return res.status(404).json({ error: 'Post not found' });
			}
		}

		const post = await postService.createPost({
			userId,
			content: trimmed,
			attachments: processedAttachments,
			mask: !!mask,
			lock: !!lock,
			replyTo: reply_to || null,
			repostTo: repost_to || null,
		});

		if (reply_to && post.replyTo) {
			const parent = await db.getPostById(post.replyTo);
			if (parent && parent.userId !== userId) {
					const notification = await createNotificationIfAllowed(db, {
						userId: parent.userId,
						type: 'reply',
						fromUserId: userId,
					target: { kind: 'post', id: post.id },
					});
					await publishNewNotification(req, parent.userId, notification);
			}
		}

		if (repost_to && post.repostTo) {
			const original = await db.getPostById(post.repostTo);
			if (original && original.userId !== userId) {
					const notification = await createNotificationIfAllowed(db, {
						userId: original.userId,
						type: 'quote',
						fromUserId: userId,
						target: { kind: 'post', id: post.id },
					});
					await publishNewNotification(req, original.userId, notification);
			}
		}

		await publishNewTimelinePost(req, userId, post.id);

		res.status(201).json({
			success: true,
			post: await serializePost(db, post, userId, 0, getPublicUrl(req)),
		});
	} catch (err) {
		console.error('[posts] create error:', err);
		res.status(500).json({ error: '投稿の作成に失敗しました' });
	}
});

router.get('/', optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);

	try {
					const posts = await db.getRecentPosts(config.limits.timelineDefaultLimit);
			const currentUserId = req.user ? req.user.id : null;
			const viewablePosts = await filterViewablePosts(db, posts, currentUserId);
			const discoverablePosts = await filterDiscoverablePosts(
				db,
				viewablePosts,
				currentUserId,
			);

			const enriched = await serializePostsBatch(
				db,
				discoverablePosts,

				currentUserId,
				getPublicUrl(req),
			);
			res.json({ posts: enriched });

	} catch (err) {
		console.error('[posts] get error:', err);
		res.status(500).json({ error: '投稿の取得に失敗しました' });
	}
});

router.get('/trending', optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);

	try {
					const posts = await db.getTrendingPosts(limit);
			const currentUserId = req.user ? req.user.id : null;
			const viewablePosts = await filterViewablePosts(db, posts, currentUserId);
			const discoverablePosts = await filterDiscoverablePosts(
				db,
				viewablePosts,
				currentUserId,
			);
			const hydrated = await serializePostsBatch(
				db,
				discoverablePosts,

				currentUserId,
				getPublicUrl(req),
			);
			res.json({ posts: hydrated });

	} catch (err) {
		console.error('[posts] trending error:', err);
		res.status(500).json({ error: 'トレンド取得に失敗しました' });
	}
});

router.get('/search', optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const q = req.query.q || '';
	const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
	const offset = parseInt(req.query.offset, 10) || 0;

	if (!q.trim()) {
		return res.json({ posts: [], has_next: false });
	}

		try {
			const currentUserId = req.user ? req.user.id : null;
			const { ids, has_more } = await getDiscoverableModePage(db, {
				mode: 'search',
				query: q,
				viewerId: currentUserId,
				limit,
				offset,
			});
			const posts = await serializePostsByIds(db, ids, currentUserId, getPublicUrl(req));
			res.json({ posts, has_next: has_more });
	} catch (err) {
		console.error('[posts] search error:', err);
		res.status(500).json({ error: '検索に失敗しました' });
	}
});

router.get('/recommended', optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
	const offset = parseInt(req.query.offset, 10) || 0;

		try {
			const currentUserId = req.user ? req.user.id : null;
			const { ids, has_more } = await getDiscoverableModePage(db, {
				mode: 'recommended',
				viewerId: currentUserId,
				limit,
				offset,
			});
			const posts = await serializePostsByIds(db, ids, currentUserId, getPublicUrl(req));
			res.json({ posts, has_next: has_more });
	} catch (err) {
		console.error('[posts] recommended error:', err);
		res.status(500).json({ error: 'おすすめ投稿の取得に失敗しました' });
	}
});

router.get('/page', optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const mode = String(req.query.mode || 'timeline');
	const tab = String(req.query.tab || 'foryou');
	const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
	const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
	const currentUserId = req.user ? req.user.id : null;

		try {
			let result = { ids: [], has_more: false };
			const isDiscoverableMode = [
				'timeline',
				'recommended',
				'search',
			].includes(mode);
			if (isDiscoverableMode) {
				result = await getDiscoverableModePage(db, {
					mode,
					tab,
					query: String(req.query.q || ''),
					viewerId: currentUserId,
					limit,
					offset,
				});
			} else if (mode === 'profile') {
			const userId = safeParsePostId(req.query.user_id);
			if (!userId) return res.status(400).json({ error: 'user_id is required' });
			const subType = ['all', 'posts_only', 'replies_only'].includes(req.query.sub_type)
				? req.query.sub_type
				: 'all';
			if (db.getProfilePostIds) {
				result = await db.getProfilePostIds({ userId, subType, limit, offset });
			} else {
				const posts = await db.getPostsByUserId(userId, offset + limit + 1, currentUserId);
				const filtered = posts.filter((post) => (
					subType === 'posts_only' ? post.replyTo == null
						: subType === 'replies_only' ? post.replyTo != null : true
				));
				result = {
					ids: filtered.slice(offset, offset + limit).map((post) => post.id),
					has_more: filtered.length > offset + limit,
				};
			}
			const pinId = safeParsePostId(req.query.pin_id);
			if (offset === 0 && pinId && !result.ids.includes(pinId)) result.ids.push(pinId);
		} else if (mode === 'ids') {
			const ids = String(req.query.ids || '')
				.split(',')
				.map(safeParsePostId)
				.filter(Boolean)
				.slice(offset, offset + limit);
			result = { ids, has_more: false };
		} else {
			return res.status(400).json({ error: 'Unsupported post page mode' });
		}

			const viewableIds = isDiscoverableMode
				? result.ids || []
				: await getViewablePostIds(db, result.ids || [], currentUserId);
			const posts = await serializePostsByIds(
				db,
				viewableIds,
			currentUserId,
			getPublicUrl(req),
		);
		const postContext = collectPostContext(posts);
		const authorIds = new Set(postContext.authors.keys());
		const missingMentionIds = postContext.mentionedIds.filter((id) => !authorIds.has(id));
		const mentionUsers = missingMentionIds.length > 0 && db.getUsersByIds
			? await db.getUsersByIds(missingMentionIds)
			: [];
		const contextUsers = [
			...postContext.authors.values(),
			...(mentionUsers || []),
		];
		
		res.json({
			posts,
			has_more: !!result.has_more,
			context: {
				users: (contextUsers || []).map((user) => ({
					id: user.id,
					name: user.name || '',
					scid: user.scid || null,
					icon_data: user.icon_data || null,
				})),
			},
			meta: {
				mode,
				requested_count: viewableIds.length,
				post_count: posts.length,
				includes_metrics: true,
			},
		});
	} catch (err) {
		console.error('[posts] page error:', err);
		res.status(500).json({ error: '投稿ページの取得に失敗しました' });
	}
});

router.get('/ids', optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const tab = req.query.tab || 'foryou';
	const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
	const offset = parseInt(req.query.offset, 10) || 0;
	const currentUserId = req.user ? req.user.id : null;

		try {
			const result = await getDiscoverableModePage(db, {
				mode: 'timeline',
				tab,
				viewerId: currentUserId,
				limit,
				offset,
			});
			res.json({ ids: result.ids, has_more: result.has_more });

	} catch (err) {
		console.error('[posts] ids error:', err);
		res.status(500).json({ error: '投稿IDの取得に失敗しました' });
	}
});

router.get('/trending-hashtags', optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);

	try {
		const trends = await db.getTrendingHashtags(limit);
		res.json({ trends });
	} catch (err) {
		console.error('[posts] trending-hashtags error:', err);
		res.status(500).json({ error: 'トレンドの取得に失敗しました' });
	}
});

router.post('/hydrate', optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const postIds = [...new Set((req.body.post_ids || [])
		.map((id) => parseInt(id, 10))
		.filter((id) => Number.isInteger(id) && id > 0))].slice(0, 100);

	try {
		const currentUserId = req.user ? req.user.id : null;
		const posts = await serializePostsByIds(db, postIds, currentUserId, getPublicUrl(req));
		res.json({ posts });
	} catch (err) {
		console.error('[posts] hydrate error:', err);
		res.status(500).json({ error: '投稿の取得に失敗しました' });
	}
});

router.post('/metrics', optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const postIds = [...new Set((req.body.post_ids || [])
		.map((id) => parseInt(id, 10))
		.filter((id) => Number.isInteger(id) && id > 0))].slice(0, 100);

	try {
		const currentUserId = req.user ? req.user.id : null;
		const viewableIds = await getViewablePostIds(db, postIds, currentUserId);
		const metrics = db.getPostMetricsBatch
			? await db.getPostMetricsBatch(viewableIds, currentUserId)
			: await Promise.all(viewableIds.map(async (postId) => ({
				post_id: postId,
				like_count: db.getLikeCount ? await db.getLikeCount(postId) : 0,
				star_count: db.getStarCount ? await db.getStarCount(postId) : 0,
				reply_count: db.getReplyCount ? await db.getReplyCount(postId) : 0,
				repost_count: db.getRepostCount ? await db.getRepostCount(postId) : 0,
			})));
		res.json({ metrics });
	} catch (err) {
		console.error('[posts] metrics error:', err);
		res.status(500).json({ error: '集計の取得に失敗しました' });
	}
});

router.get('/:id/thread', optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const postId = safeParsePostId(req.params.id);
	if (!postId) return res.status(400).json({ error: 'Invalid post id' });

	try {
		const currentUserId = req.user ? req.user.id : null;
		const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
		const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
					const root = await db.getPostById(postId);
			if (!root || !(await canViewPost(db, root, currentUserId))) {
				return res.status(404).json({ error: 'Post not found' });
			}
			const replyPage = await getThreadReplyPostIds(db, postId, limit, offset);
			const viewableReplyIds = await getViewablePostIds(db, replyPage.ids, currentUserId);
			const [mainPost, replies] = await Promise.all([
				serializePost(db, root, currentUserId, 0, getPublicUrl(req)),
				serializePostsByIds(db, viewableReplyIds, currentUserId, getPublicUrl(req)),
			]);

		res.json({ post: mainPost, replies, has_more: replyPage.has_more, offset, limit });
	} catch (err) {
		console.error('[posts] thread error:', err);
		res.status(500).json({ error: '投稿スレッドの取得に失敗しました' });
	}
});

router.get('/:id', optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const postId = safeParsePostId(req.params.id);
	const currentUserId = req.user ? req.user.id : null;

	if (!postId) {
		return res.status(400).json({ error: 'Invalid post id' });
	}

	try {
		const post = await db.getPostById(postId);
					if (!post || !(await canViewPost(db, post, currentUserId))) {
				return res.status(404).json({ error: 'Post not found' });
			}
			res.json({ post: await serializePost(db, post, currentUserId, 0, getPublicUrl(req)) });

	} catch (err) {
		console.error('[posts] detail error:', err);
		res.status(500).json({ error: '投稿の取得に失敗しました' });
	}
});

router.get('/:id/replies', optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const postId = safeParsePostId(req.params.id);
	const currentUserId = req.user ? req.user.id : null;

	if (!postId) {
		return res.status(400).json({ error: 'Invalid post id' });
	}

	try {
		const root = await db.getPostById(postId);
		if (!root || !(await canViewPost(db, root, currentUserId))) {
			return res.status(404).json({ error: 'Post not found' });
		}
		const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
		const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
		const page = await db.getReplyPostIds(postId, limit, offset);
		const viewableReplyIds = await getViewablePostIds(db, page.ids, currentUserId);
		const replies = await serializePostsByIds(db, viewableReplyIds, currentUserId, getPublicUrl(req));
		res.json({ replies, has_more: page.has_more, offset, limit });
	} catch (err) {
		console.error('[posts] replies error:', err);
		res.status(500).json({ error: 'リプライの取得に失敗しました' });
	}
});

router.post('/:id/like', requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const storage = getStorageAdapter(req);
	const postService = new PostService({ dbAdapter: db, storageAdapter: storage });

	const postId = safeParsePostId(req.params.id);
	const userId = req.user.id;

	if (!postId) {
		return res.status(400).json({ error: 'Invalid post id' });
	}

	try {
		const post = await db.getPostById(postId);
		if (!post || !(await canViewPost(db, post, userId))) {
			return res.status(404).json({ error: 'Post not found' });
		}
		const result = await postService.toggleLike(userId, postId);

		if (result.liked) {
			if (post.userId !== userId) {
					const notification = await createNotificationIfAllowed(db, {
						userId: post.userId,
						type: 'like',
						fromUserId: userId,
					target: { kind: 'post', id: postId },
					});
					await publishNewNotification(req, post.userId, notification);
			}
		}

		const updatedLikes = await db.getLikeIds(userId);

		res.json({
			success: true,
			liked: result.liked,
			count: result.count,
			updated_likes: updatedLikes,
		});
	} catch (err) {
		console.error('[posts] like error:', err);
		res.status(500).json({ error: 'いいね処理に失敗しました' });
	}
});

router.post('/:id/star', requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const storage = getStorageAdapter(req);
	const postService = new PostService({ dbAdapter: db, storageAdapter: storage });

	const postId = safeParsePostId(req.params.id);
	const userId = req.user.id;

	if (!postId) {
		return res.status(400).json({ error: 'Invalid post id' });
	}

	try {
		const post = await db.getPostById(postId);
		if (!post || !(await canViewPost(db, post, userId))) {
			return res.status(404).json({ error: 'Post not found' });
		}
		const result = await postService.toggleStar(userId, postId);

		if (result.starred) {
			if (post.userId !== userId) {
					const notification = await createNotificationIfAllowed(db, {
						userId: post.userId,
						type: 'star',
						fromUserId: userId,
					target: { kind: 'post', id: postId },
					});
					await publishNewNotification(req, post.userId, notification);
			}
		}

		const updatedStars = await db.getStarIds(userId);

		res.json({
			success: true,
			starred: result.starred,
			count: result.count,
			updated_stars: updatedStars,
		});
	} catch (err) {
		console.error('[posts] star error:', err);
		res.status(500).json({ error: 'スター処理に失敗しました' });
	}
});

router.delete('/:id', requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const storage = getStorageAdapter(req);
	const postId = safeParsePostId(req.params.id);
	const userId = req.user.id;

	if (!postId) {
		return res.status(400).json({ error: 'Invalid post id' });
	}

	try {
		const postToDelete = await db.getPostById(postId);
		const success = await db.deletePost(postId, userId);

		if (!success) {
			return res.status(403).json({ error: 'You do not have permission to delete this post' });
		}

			if (postToDelete) {
				await deleteStoredAttachments(storage, postToDelete.attachments, 'post deletion');
			}

		res.json({ success: true, message: 'Post deleted' });
	} catch (err) {
		console.error('[posts] delete error:', err);
		res.status(500).json({ error: '投稿の削除に失敗しました' });
	}
});

router.delete('/admin/:id', requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const storage = getStorageAdapter(req);
	const postId = safeParsePostId(req.params.id);

	if (!req.user.admin) {
		return res.status(403).json({ error: 'Admin access required' });
	}

	if (!postId) {
		return res.status(400).json({ error: 'Invalid post id' });
	}

	try {
		const postToDelete = await db.getPostById(postId);
		const success = await db.adminDeletePost(postId);

		if (!success) {
			return res.status(404).json({ error: 'Post not found' });
		}

			if (postToDelete) {
				await deleteStoredAttachments(storage, postToDelete.attachments, 'admin post deletion');
			}

		res.json({ success: true, message: 'Post deleted by admin' });
	} catch (err) {
		console.error('[posts] admin delete error:', err);
		res.status(500).json({ error: '管理者削除に失敗しました' });
	}
});

router.get('/:id/reposts', optionalAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const postId = safeParsePostId(req.params.id);
	const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);

	if (!postId) {
		return res.status(400).json({ error: 'Invalid post id' });
	}

	try {
		const post = await db.getPostById(postId);
		const currentUserId = req.user ? req.user.id : null;
		if (!post || !(await canViewPost(db, post, currentUserId))) {
			return res.status(404).json({ error: 'Post not found' });
		}
		const reposts = await db.getRepostsOfPost(postId, limit);
		res.json({ reposts });
	} catch (err) {
		console.error('[posts] reposts list error:', err);
		res.status(500).json({ error: 'リポスト一覧の取得に失敗しました' });
	}
});

router.post('/:id/repost', requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const postId = safeParsePostId(req.params.id);
	const userId = req.user.id;

	if (!postId) {
		return res.status(400).json({ error: 'Invalid post id' });
	}

	try {
		const original = await db.getPostById(postId);
		if (!original || !(await canViewPost(db, original, userId))) {
			return res.status(404).json({ error: 'Post not found' });
		}
		const repost = await db.repostPost(userId, postId);
		res.status(201).json({
			success: true,
			post: await serializePost(db, repost, userId, 0, getPublicUrl(req)),
		});
	} catch (err) {
		console.error('[posts] repost error:', err);
		res.status(400).json({ error: err.message || 'リポストに失敗しました' });
	}
});

router.post('/:id/pin', requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const postId = safeParsePostId(req.params.id);
	const userId = req.user.id;

	if (!postId) {
		return res.status(400).json({ error: 'Invalid post id' });
	}

	try {
		const result = await db.togglePin(userId, postId);
		const pinId = result.pinned ? postId : null;
		res.json({ success: true, pinned: result.pinned, pin_id: pinId });
	} catch (err) {
		console.error('[posts] pin error:', err);
		res.status(400).json({ error: err.message || 'ピン留め処理に失敗しました' });
	}
});

router.put('/:id', requireAuth, async (req, res) => {
	const db = getDbAdapter(req);
	const storage = getStorageAdapter(req);
	const postId = safeParsePostId(req.params.id);
	const userId = req.user.id;

	if (!postId) {
		return res.status(400).json({ error: 'Invalid post id' });
	}

	const { content, attachments, mask, lock } = req.body || {};

	if (typeof content !== 'string' || content.trim().length === 0) {
		return res.status(400).json({ error: 'content is required' });
	}
	if (content.trim().length > config.limits.postContentMax) {
		return res.status(400).json({ error: `content must be ${config.limits.postContentMax} characters or less` });
	}
	if (attachments !== undefined) {
		try {
			validateAttachmentReferences(attachments, userId);
		} catch (error) {
			return res.status(400).json({ error: error.message || 'Invalid attachments' });
		}
	}

	try {
		const post = await db.getPostById(postId);
		if (!post) {
			return res.status(404).json({ error: 'Post not found' });
		}
		if (post.userId !== userId) {
			return res.status(403).json({ error: 'You can only edit your own posts' });
		}

		const updated = await db.updatePost(postId, {
			content: content.trim(),
			attachments:
				Array.isArray(attachments) && attachments.length > 0
					? attachments
					: null,
				mask: !!mask,
				lock: !!lock,
			});

		res.json({
			success: true,
			post: await serializePost(db, updated || post, userId, 0, getPublicUrl(req)),
		});
	} catch (err) {
		console.error('[posts] edit error:', err);
		res.status(500).json({ error: '投稿の更新に失敗しました' });
	}
});

module.exports = router;
