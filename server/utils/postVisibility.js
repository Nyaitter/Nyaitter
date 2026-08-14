'use strict';

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

	// 一覧向けの軽量ユーザー取得では settings が省略されるアダプターがある。
	// 非公開判定は設定欠落時に公開扱いへ後退してはならないため、該当者だけ完全レコードを再取得する。
	const byId = new Map(authors.map((author) => [Number(author.id), author]));
	const idsNeedingFullRecord = ids.filter((id) => !Object.prototype.hasOwnProperty.call(byId.get(id) || {}, 'settings'));
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

module.exports = {
	canViewPost,
	filterViewablePosts,
	getPostAuthorId,
	getAuthorsById,
	isPrivatePost,
};
