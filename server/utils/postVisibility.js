'use strict';

const { normalizeBlockList } = require('./blockList');

function getPostAuthorId(post) {
	const value = post?.userId ?? post?.user_id ?? post?.userid;
	const id = Number(value);
	return Number.isInteger(id) ? id : null;
}

function normalizeUserId(value) {
	const id = Number(value);
	return Number.isInteger(id) ? id : null;
}

/**
 * 投稿の非公開状態を返す。
 * 投稿自身の lock または投稿者設定 settings.lock のいずれかが有効なら非公開である。
 */
function isPrivatePost(post, author = null) {
	return Boolean(post?.lock || author?.settings?.lock);
}

async function getAuthorsById(db, posts) {
	const ids = [...new Set((posts || [])
		.map(getPostAuthorId)
		.filter((id) => id != null))];
	if (ids.length === 0) return new Map();

	let authors = [];
	if (typeof db.getUsersByIds === 'function') {
		authors = (await db.getUsersByIds(ids)).filter(Boolean);
	}

	// 一覧向けの軽量ユーザー取得では settings や shadow が省略されるアダプターがある。
	// 非公開・検索除外の判定は属性欠落時に公開扱いへ後退してはならないため、
	// 該当者だけ完全レコードを再取得する。
	const byId = new Map(authors.map((author) => [Number(author.id), author]));
	const idsNeedingFullRecord = ids.filter((id) => {
		const author = byId.get(id) || {};
		return (
			!Object.prototype.hasOwnProperty.call(author, 'settings') ||
			!Object.prototype.hasOwnProperty.call(author, 'shadow')
		);
	});
	if (typeof db.getUserById === 'function') {
		const completeAuthors = await Promise.all(idsNeedingFullRecord.map((id) => db.getUserById(id)));
		for (const author of completeAuthors.filter(Boolean)) byId.set(Number(author.id), author);
	}
	return byId;
}

function normalizeFollowRelationshipSnapshot(value) {
	return {
		followingIds: new Set((value?.followingIds ?? value?.following_ids ?? [])
			.map(normalizeUserId)
			.filter((id) => id != null)),
		followerIds: new Set((value?.followerIds ?? value?.follower_ids ?? [])
			.map(normalizeUserId)
			.filter((id) => id != null)),
	};
}

/**
 * 候補投稿者に限定した閲覧者のフォロー関係を取得する。
 * 実装済みアダプターでは1回のDB操作（D1では1回のWorker往復）で完了する。
 * 旧アダプターには安全な後方互換フォールバックを残す。
 */
async function getFollowRelationshipSnapshot(db, viewerId, authorIds) {
	const normalizedViewerId = normalizeUserId(viewerId);
	const ids = [...new Set((authorIds || [])
		.map(normalizeUserId)
		.filter((id) => id != null && id !== normalizedViewerId))];
	if (normalizedViewerId == null || ids.length === 0) {
		return { followingIds: new Set(), followerIds: new Set() };
	}

	if (typeof db.getFollowRelationshipSnapshot === 'function') {
		try {
			return normalizeFollowRelationshipSnapshot(await db.getFollowRelationshipSnapshot(
				normalizedViewerId,
				ids,
			));
		} catch (error) {
			// 段階デプロイ時に旧D1 Workerへ接続した場合などは、旧プリミティブへ安全に後退する。
			console.warn('[postVisibility] batch follow relationship fallback:', error.message);
		}
	}

	const followingIds = new Set(
		typeof db.getFollowIds === 'function'
			? (await db.getFollowIds(normalizedViewerId)).map(Number)
			: [],
	);
	const followerIds = new Set();
	if (typeof db.isFollowing === 'function') {
		const reciprocalIds = await Promise.all(ids
			.filter((authorId) => followingIds.has(authorId))
			.map(async (authorId) => (
				await db.isFollowing(authorId, normalizedViewerId) ? authorId : null
			)));
		for (const authorId of reciprocalIds) {
			if (authorId != null) followerIds.add(authorId);
		}
	}
	return { followingIds, followerIds };
}

/**
 * ページに含まれる投稿の可視性判定に必要なデータを一括取得する。
 * ブロックは閲覧者と投稿者の正規化済みblock配列だけで判定し、相互フォローは
 * 候補投稿者に限定した関係スナップショットで判定するため、投稿件数に比例した
 * DB/Worker呼び出しを発生させない。
 */
async function createPostVisibilityContext(db, posts, viewerId = null, authorsById = null) {
	const values = (posts || []).filter(Boolean);
	const normalizedViewerId = normalizeUserId(viewerId);
	const resolvedAuthorsById = authorsById || await getAuthorsById(db, values);
	const authorIds = [...new Set(values
		.map(getPostAuthorId)
		.filter((id) => id != null))];
	const [viewer, followSnapshot] = await Promise.all([
		normalizedViewerId != null && typeof db.getUserById === 'function'
			? db.getUserById(normalizedViewerId)
			: null,
		getFollowRelationshipSnapshot(db, normalizedViewerId, authorIds),
	]);

	return {
		viewerId: normalizedViewerId,
		viewer,
		authorsById: resolvedAuthorsById,
		viewerBlockedIds: new Set(normalizeBlockList(viewer?.block, viewer?.id)),
		followingIds: followSnapshot.followingIds,
		followerIds: followSnapshot.followerIds,
	};
}

function hasBlockRelationshipInContext(context, authorId) {
	if (!context || context.viewerId == null || context.viewerId === authorId) return false;
	if (context.viewerBlockedIds.has(authorId)) return true;
	const author = context.authorsById.get(authorId) || null;
	return normalizeBlockList(author?.block, author?.id).includes(context.viewerId);
}

function canViewPostWithContext(post, context) {
	if (!post || !context) return false;
	const authorId = getPostAuthorId(post);
	if (authorId == null) return false;
	const author = context.authorsById.get(authorId) || null;

	if (hasBlockRelationshipInContext(context, authorId)) return false;
	if (!isPrivatePost(post, author)) return true;
	if (context.viewerId == null) return false;
	if (context.viewerId === authorId) return true;
	return context.followingIds.has(authorId) && context.followerIds.has(authorId);
}

/**
 * 投稿の閲覧可否を判定する。
 * 非公開投稿は投稿者本人、または投稿者と相互フォローであるログイン済みユーザーだけが閲覧できる。
 * 未許可時は投稿の存在自体を明かさないため false を返す。
 */
async function canViewPost(db, post, viewerId = null, author = null, visibilityContext = null) {
	if (!post) return false;
	const authorId = getPostAuthorId(post);
	if (authorId == null) return false;
	if (visibilityContext) return canViewPostWithContext(post, visibilityContext);

	const authorsById = new Map();
	if (author) authorsById.set(authorId, author);
	const context = await createPostVisibilityContext(db, [post], viewerId, authorsById);
	return canViewPostWithContext(post, context);
}

/**
 * 表示不許可の投稿を除外する。呼び出し側の入力順を維持する。
 */
async function filterViewablePosts(db, posts, viewerId = null, visibilityContext = null) {
	const values = (posts || []).filter(Boolean);
	const context = visibilityContext || await createPostVisibilityContext(db, values, viewerId);
	return values.filter((post) => canViewPostWithContext(post, context));
}

/**
 * 検索除外ユーザーの投稿を発見可能な一覧へ載せるか判定する。
 *
 * 検索除外は投稿自体の公開範囲を変えない。プロフィール等の直接一覧は
 * 別途 `filterViewablePosts` を使うため、ここはタイムライン・おすすめ・
 * 検索のような発見経路にだけ適用する。検索除外中の投稿者本人と、投稿者を
 * フォローしているログイン済みユーザーは投稿を発見できる。
 */
async function filterDiscoverablePosts(db, posts, viewerId = null, visibilityContext = null) {
	const values = (posts || []).filter(Boolean);
	const context = visibilityContext || await createPostVisibilityContext(db, values, viewerId);
	return values.filter((post) => {
		const authorId = getPostAuthorId(post);
		const author = context.authorsById.get(authorId) || null;
		if (!author?.shadow) return true;
		if (context.viewerId == null) return false;
		if (context.viewerId === authorId) return true;
		return context.followingIds.has(authorId);
	});
}

module.exports = {
	canViewPost,
	canViewPostWithContext,
	filterViewablePosts,
	filterDiscoverablePosts,
	createPostVisibilityContext,
	getFollowRelationshipSnapshot,
	getPostAuthorId,
	getAuthorsById,
	isPrivatePost,
};
