'use strict';

const { hasBlockRelationship } = require('./blockRelationship');

function getPostAuthorId(post) {
	const value = post?.userId ?? post?.user_id ?? post?.userid;
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

/**
 * 投稿の閲覧可否を判定する。
 * 非公開投稿は投稿者本人、または投稿者と相互フォローであるログイン済みユーザーだけが閲覧できる。
 * 未許可時は投稿の存在自体を明かさないため false を返す。
 */
async function canViewPost(db, post, viewerId = null, author = null) {
	if (!post) return false;
	const authorId = getPostAuthorId(post);
	if (authorId == null) return false;

	const postAuthor = author && Object.prototype.hasOwnProperty.call(author, 'settings')
		? author
		: (typeof db.getUserById === 'function' ? await db.getUserById(authorId) : null);
	if (
		viewerId != null &&
		Number(viewerId) !== authorId &&
		await hasBlockRelationship(db, viewerId, authorId)
	) {
		return false;
	}
	if (!isPrivatePost(post, postAuthor)) return true;
	if (viewerId == null) return false;
	if (Number(viewerId) === authorId) return true;
	if (typeof db.isFollowing !== 'function') return false;

	const [viewerFollowsAuthor, authorFollowsViewer] = await Promise.all([
		db.isFollowing(Number(viewerId), authorId),
		db.isFollowing(authorId, Number(viewerId)),
	]);
	return Boolean(viewerFollowsAuthor && authorFollowsViewer);
}

/**
 * 表示不許可の投稿を除外する。呼び出し側の入力順を維持する。
 */
async function filterViewablePosts(db, posts, viewerId = null) {
	const values = (posts || []).filter(Boolean);
	const authorsById = await getAuthorsById(db, values);
	const visibility = await Promise.all(values.map((post) => canViewPost(
		db,
		post,
		viewerId,
		authorsById.get(getPostAuthorId(post)) || null,
	)));
	return values.filter((_, index) => visibility[index]);
}

/**
 * 検索除外ユーザーの投稿を発見可能な一覧へ載せるか判定する。
 *
 * 検索除外は投稿自体の公開範囲を変えない。プロフィール等の直接一覧は
 * 別途 `filterViewablePosts` を使うため、ここはタイムライン・おすすめ・
 * 検索のような発見経路にだけ適用する。検索除外中の投稿者本人と、投稿者を
 * フォローしているログイン済みユーザーは投稿を発見できる。
 */
async function filterDiscoverablePosts(db, posts, viewerId = null) {
	const values = (posts || []).filter(Boolean);
	const authorsById = await getAuthorsById(db, values);
	const visibility = await Promise.all(values.map(async (post) => {
		const authorId = getPostAuthorId(post);
		const author = authorsById.get(authorId) || null;
		if (!author?.shadow) return true;
		if (viewerId == null) return false;
		if (Number(viewerId) === Number(authorId)) return true;
		if (typeof db.isFollowing !== 'function') return false;
		return Boolean(await db.isFollowing(Number(viewerId), Number(authorId)));
	}));
	return values.filter((_, index) => visibility[index]);
}

module.exports = {
	canViewPost,
	filterViewablePosts,
	filterDiscoverablePosts,
	getPostAuthorId,
	getAuthorsById,
	isPrivatePost,
};
