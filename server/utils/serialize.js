const {
	formatNyaitterId,
	getUserNyaitterAddress,
	getUserNyaitterId,
} = require('./nyaitterAddress');
const { normalizeNotificationRecord } = require('./notification');
const {
	canViewPost,
	canViewPostWithContext,
	createPostVisibilityContext,
	isPrivatePost,
} = require('./postVisibility');
const { getVisibleDmUnreadCount } = require('../services/DmVisibilityService');

function serializeUserBrief(user, publicUrl = null) {
	if (!user) return null;
	return {
		id: user.id,
		nyaitter_id: getUserNyaitterId(user),
		nyaitter_address: publicUrl
			? getAddressForPublicUrl(user, publicUrl)
			: getUserNyaitterAddress(user),
		name: user.name || '',
		scid: user.scid || null,
		icon_data: user.icon_data || null,
		admin: !!user.admin,
		verify: !!user.verify,
	};
}

function getAddressForPublicUrl(user, publicUrl) {
	if (!user) return null;
	if (user.auth_provider === 'nyaitter' && user.external_id != null && user.provider_domain) {
		return getUserNyaitterAddress(user);
	}
	return `${formatNyaitterId(user.id)}@${new URL(publicUrl).host}`;
}

async function serializeNotifications(db, notifications, publicUrl = null) {
	const normalizedNotifications = (notifications || [])
		.map(normalizeNotificationRecord)
		.filter(Boolean);
	if (normalizedNotifications.length === 0) return [];

	const fromUserIds = [...new Set(normalizedNotifications
		.map((notification) => Number(notification.fromUserId))
		.filter(Number.isInteger))];
	const targetPostIds = [...new Set(normalizedNotifications
		.map((notification) => (
			notification.target?.kind === 'post' ? Number(notification.target.id) : null
		))
		.filter((postId) => Number.isInteger(postId) && postId > 0))];
	const [fromUsers, targetPosts] = await Promise.all([
		fetchNotificationUsersByIds(db, fromUserIds),
		targetPostIds.length > 0 ? db.getPostsByIds(targetPostIds) : [],
	]);
	const fromUsersById = new Map(fromUsers.map((user) => [Number(user.id), user]));
	const targetPostsById = new Map((targetPosts || []).map((post) => [Number(post.id), post]));

	return normalizedNotifications.map((notification) => ({
		id: notification.id,
		type: notification.type,
		from: serializeUserBrief(
			notification.fromUserId != null
				? fromUsersById.get(Number(notification.fromUserId)) || null
				: null,
			publicUrl,
		),
		target: notification.target,
		target_post: notification.target?.kind === 'post'
			? (() => {
				const post = targetPostsById.get(Number(notification.target.id));
				return post ? { id: Number(post.id), content: String(post.content || '') } : null;
			})()
			: null,
		read: notification.read,
		clicked: notification.clicked,
		message: notification.message || null,
		created_at: notification.createdAt,
	}));
}

async function serializeNotification(db, notification, publicUrl = null) {
	const [serialized] = await serializeNotifications(db, [notification], publicUrl);
	return serialized || null;
}

async function serializeUser(db, user, viewerId = null, publicUrl = null) {
	if (!user) return null;
	const id = user.id;
	const isSelf = viewerId != null && Number(viewerId) === Number(id);
	const [follow, like, star, pin, notifications, unreadCount, dmUnreadCount] = await Promise.all([
		db.getFollowIds ? db.getFollowIds(id) : [],
		db.getLikeIds ? db.getLikeIds(id) : [],
		db.getStarIds ? db.getStarIds(id) : [],
		db.getPinnedPostId ? db.getPinnedPostId(id) : null,
		isSelf && db.getNotifications ? db.getNotifications(id, 200) : [],
		isSelf && db.getUnreadNotificationCount ? db.getUnreadNotificationCount(id) : 0,
		isSelf ? getVisibleDmUnreadCount(db, id) : 0,
	]);
	const structuredNotifications = isSelf
		? await serializeNotifications(db, notifications, publicUrl)
		: [];

	return {
		id: user.id,
		nyaitter_id: getUserNyaitterId(user),
		uuid: user.uuid || null,
		name: user.name || '',
		scid: user.scid || null,
		handle: getUserNyaitterId(user),
		nyaitter_address: publicUrl
			? getAddressForPublicUrl(user, publicUrl)
			: getUserNyaitterAddress(user),
		me: user.me || user.bio || '',
		icon_data: user.icon_data || null,
		header_image: user.header_image || null,
		settings: user.settings || {},
		block: isSelf ? (Array.isArray(user.block) ? user.block : []) : [],
		notice: structuredNotifications,
		notification_unread_count: isSelf ? unreadCount : 0,
		dm_unread_count: isSelf ? dmUnreadCount : 0,
		admin: !!user.admin,
		verify: !!user.verify,
		freeze: user.freeze || null,
		shadow: !!user.shadow,
		lock: !!(user.settings && user.settings.lock),
		follow,
		like,
		star,
		pin,
		created_at: user.created_at || user.createdAt || null,
	};
}

async function serializePublicProfile(db, user, viewerId = null, publicUrl = null) {
	if (!user) return null;
	const isSelf = viewerId != null && Number(viewerId) === Number(user.id);
	const settings = user.settings || {};
	const state = (enabled) => (isSelf || enabled ? 'public' : 'private');
	const visibility = {
		scid: state(Boolean(settings.show_scid)),
		likes: state(Boolean(settings.show_like)),
		stars: state(Boolean(settings.show_star)),
		following: state(Boolean(settings.show_follow)),
		followers: state(settings.show_follower !== false),
		posts: isSelf || !settings.lock ? 'public' : 'followers_only',
	};
	const viewer = viewerId != null && db.getUserById ? await db.getUserById(viewerId) : null;
	const viewerBlocksProfile = Boolean(viewer?.block?.map(Number).includes(Number(user.id)));
	const profileBlocksViewer = Boolean(viewerId != null && user.block?.map(Number).includes(Number(viewerId)));
	const [followingCount, followerCount, postCount, mediaCount, pinnedPostId] = await Promise.all([
		db.getFollowingCount ? db.getFollowingCount(user.id) : (db.getFollowIds ? db.getFollowIds(user.id).then((ids) => ids.length) : 0),
		db.getFollowerCount ? db.getFollowerCount(user.id) : 0,
		db.getPostCount ? db.getPostCount(user.id) : 0,
		db.getMediaCount ? db.getMediaCount(user.id) : 0,
		db.getPinnedPostId ? db.getPinnedPostId(user.id) : null,
	]);

	return {
		id: user.id,
		nyaitter_id: getUserNyaitterId(user),
		name: user.name || '',
		me: user.me || user.bio || '',
		header_image: user.header_image || null,
		icon_available: Boolean(user.icon_data || user.scid),
		account_state: user.freeze ? 'frozen' : 'active',
		admin: !!user.admin,
		verify: !!user.verify,
		visibility,
		...(viewerId != null ? { relationship: { viewer_blocks_profile: viewerBlocksProfile, profile_blocks_viewer: profileBlocksViewer } } : {}),
		...(visibility.scid === 'public' && user.scid ? { scid: user.scid } : {}),
		following_count: Number(followingCount || 0),
		follower_count: Number(followerCount || 0),
		post_count: Number(postCount || 0),
		media_count: Number(mediaCount || 0),
		pinned_post_id: pinnedPostId || null,
		created_at: user.created_at || user.createdAt || null,
	};
}

async function fetchPostsByIds(db, postIds) {
	const ids = [...new Set((postIds || []).map(Number).filter(Number.isInteger))];
	if (ids.length === 0) return [];
	try {
		const posts = await db.getPostsByIds(ids);
		if (Array.isArray(posts)) return posts;
	} catch (_) {
		// Adapters that have not yet implemented the batch method use the safe fallback.
	}
	return (await Promise.all(ids.map((id) => db.getPostById(id)))).filter(Boolean);
}

async function fetchNotificationUsersByIds(db, userIds) {
	const ids = [...new Set((userIds || []).map(Number).filter(Number.isInteger))];
	if (ids.length === 0) return [];
	if (typeof db.getUsersByIds === 'function') {
		try {
			const users = await db.getUsersByIds(ids);
			if (Array.isArray(users)) return users.filter(Boolean);
		} catch (_) {
			// 一括取得が利用できない旧アダプターだけ、既存の単件取得へ後退する。
		}
	}
	if (typeof db.getUserById !== 'function') return [];
	return (await Promise.all(ids.map((id) => db.getUserById(id)))).filter(Boolean);
}

async function fetchUsersByIds(db, userIds) {
	const ids = [...new Set((userIds || []).map(Number).filter(Number.isInteger))];
	if (ids.length === 0) return [];

	let users = [];
	try {
		const batch = await db.getUsersByIds(ids);
		if (Array.isArray(batch)) users = batch.filter(Boolean);
	} catch (_) {
		// Fall through to the safe per-user lookup.
	}

	const usersById = new Map(users.map((user) => [Number(user.id), user]));
	// 非公開判定には settings.lock が必須。軽量バッチ取得が設定を省略する場合は、
	// そのユーザーだけ完全レコードを取得し、設定欠落を公開扱いにしない。
	const idsNeedingFullRecord = ids.filter((id) => !Object.prototype.hasOwnProperty.call(usersById.get(id) || {}, 'settings'));
	if (typeof db.getUserById === 'function') {
		const completeUsers = await Promise.all(idsNeedingFullRecord.map((id) => db.getUserById(id)));
		for (const user of completeUsers.filter(Boolean)) usersById.set(Number(user.id), user);
	}
	return ids.map((id) => usersById.get(id)).filter(Boolean);
}

async function fetchPostMetrics(db, postIds, currentUserId) {
	const ids = [...new Set((postIds || []).map(Number).filter(Number.isInteger))];
	if (ids.length === 0) return [];
	try {
		const metrics = await db.getPostMetricsBatch(ids, currentUserId);
		if (Array.isArray(metrics)) return metrics;
	} catch (_) {
		// Keep compatibility with adapters without a batch implementation.
	}
	return Promise.all(ids.map(async (postId) => ({
		post_id: postId,
		like_count: db.getLikeCount ? await db.getLikeCount(postId) : 0,
		star_count: db.getStarCount ? await db.getStarCount(postId) : 0,
		reply_count: db.getReplyCount ? await db.getReplyCount(postId) : 0,
		repost_count: db.getRepostCount ? await db.getRepostCount(postId) : 0,
		liked_by_me: currentUserId != null && db.hasUserLikedPost
			? await db.hasUserLikedPost(currentUserId, postId)
			: false,
		starred_by_me: currentUserId != null && db.hasUserStarredPost
			? await db.hasUserStarredPost(currentUserId, postId)
			: false,
	})));
}

/**
 * Serializes a page of posts in a bounded number of adapter operations.
 * Authors, metrics and up to two levels of reply/repost references are loaded
 * once per page rather than once per individual post.
 */
async function serializePostsBatch(db, rootPosts, currentUserId = null, publicUrl = null) {
	const initialPosts = (rootPosts || []).filter(Boolean);
	if (initialPosts.length === 0) return [];

	const postsById = new Map(initialPosts.map((post) => [Number(post.id), post]));
	let frontier = initialPosts;
	for (let depth = 0; depth < 2; depth += 1) {
		const relationIds = [];
		for (const post of frontier) {
			if (post.replyTo != null && !postsById.has(Number(post.replyTo))) relationIds.push(post.replyTo);
			if (post.repostTo != null && !postsById.has(Number(post.repostTo))) relationIds.push(post.repostTo);
		}
		const related = await fetchPostsByIds(db, relationIds);
		for (const post of related) postsById.set(Number(post.id), post);
		frontier = related;
		if (frontier.length === 0) break;
	}

	const allPosts = [...postsById.values()];
	const [users, metrics] = await Promise.all([
		fetchUsersByIds(db, allPosts.map((post) => post.userId)),
		fetchPostMetrics(db, allPosts.map((post) => post.id), currentUserId),
	]);
	const usersById = new Map(users.map((user) => [Number(user.id), user]));
	const metricsByPostId = new Map(metrics.map((metric) => [Number(metric.post_id), metric]));
	const visibilityContext = await createPostVisibilityContext(
		db,
		allPosts,
		currentUserId,
		usersById,
	);
	const visibleByPostId = new Map(allPosts.map((post) => [
		Number(post.id),
		canViewPostWithContext(post, visibilityContext),
	]));
	const briefUsersById = new Map();
	const visitingPostIds = new Set();

	function getBriefUser(author) {
		const authorId = Number(author?.id);
		if (!briefUsersById.has(authorId)) {
			briefUsersById.set(authorId, serializeUserBrief(author, publicUrl));
		}
		return briefUsersById.get(authorId);
	}

	function compose(post, depth = 0) {
		const postId = Number(post?.id);
		if (!post || !visibleByPostId.get(postId) || visitingPostIds.has(postId)) return null;

		// 同じ再帰経路だけを追跡することで、各ノードでSetを複製する必要をなくす。
		visitingPostIds.add(postId);
		const metric = metricsByPostId.get(postId) || {};
		const author = usersById.get(Number(post.userId)) || null;
		const replyToPost = depth < 2 && post.replyTo != null
			? compose(postsById.get(Number(post.replyTo)), depth + 1)
			: null;
		const repostedPost = depth < 2 && post.repostTo != null
			? compose(postsById.get(Number(post.repostTo)), depth + 1)
			: null;
		const brief = getBriefUser(author);

		const serialized = {
			id: post.id,
			userid: post.userId,
			content: post.content,
			mask: !!post.mask,
			lock: !!post.lock,
			announcement: !!post.announcement,
			private: isPrivatePost(post, author),
			attachments: post.attachments || [],
			reply_id: post.replyTo || null,
			repost_to: post.repostTo || null,
			created_at: post.createdAt,
			user: brief,
			author: brief,
			reply_to_post: replyToPost,
			reposted_post: repostedPost,
			like_count: Number(metric.like_count || 0),
			star_count: Number(metric.star_count || 0),
			reply_count: Number(metric.reply_count || 0),
			repost_count: Number(metric.repost_count || 0),
			liked_by_me: !!metric.liked_by_me,
			starred_by_me: !!metric.starred_by_me,
		};
		visitingPostIds.delete(postId);
		return serialized;
	}

	return initialPosts.map((post) => compose(post)).filter(Boolean);
}

async function serializePost(db, post, currentUserId = null, depth = 0, publicUrl = null) {
	if (!post) return null;
	const [serialized] = await serializePostsBatch(db, [post], currentUserId, publicUrl);
	return serialized || null;
}

async function serializeReply(db, post, currentUserId = null, publicUrl = null) {
	if (!post || !(await canViewPost(db, post, currentUserId))) return null;
	const [author, parent] = await Promise.all([
		db.getUserById ? db.getUserById(post.userId) : null,
		post.replyTo && db.getPostById ? db.getPostById(post.replyTo) : null,
	]);
	const replyToUser = parent && db.getUserById ? await db.getUserById(parent.userId) : null;

	return {
		id: post.id,
		userid: post.userId,
			content: post.content,
			mask: !!post.mask,
			lock: !!post.lock,
			announcement: !!post.announcement,
			private: isPrivatePost(post, author),
			attachments: post.attachments || [],
		reply_id: post.replyTo || null,
		repost_to: post.repostTo || null,
		created_at: post.createdAt,
		author_id: author ? author.id : null,
		author_nyaitter_id: author ? getUserNyaitterId(author) : null,
		author_nyaitter_address: author
			? (publicUrl ? getAddressForPublicUrl(author, publicUrl) : getUserNyaitterAddress(author))
			: null,
		author_name: author ? author.name : '',
		author_scid: author ? author.scid : null,
		author_icon_data: author ? author.icon_data : null,
		author_admin: author ? !!author.admin : false,
		author_verify: author ? !!author.verify : false,
		reply_to_user_id: replyToUser ? replyToUser.id : null,
		reply_to_user_nyaitter_id: replyToUser ? getUserNyaitterId(replyToUser) : null,
		reply_to_user_name: replyToUser ? replyToUser.name : null,
	};
}

async function serializePostsByIds(db, postIds, currentUserId = null, publicUrl = null) {
	const posts = await fetchPostsByIds(db, postIds);
	const byId = new Map(posts.map((post) => [Number(post.id), post]));
	const ordered = (postIds || []).map((id) => byId.get(Number(id))).filter(Boolean);
	return serializePostsBatch(db, ordered, currentUserId, publicUrl);
}

module.exports = {
	serializeUser,
	serializeUserBrief,
	serializePublicProfile,
	serializeNotification,
	serializeNotifications,
	serializePost,
	serializeReply,
	serializePostsBatch,
	serializePostsByIds,
};
