const {
	createPostVisibilityContext,
	filterDiscoverablePosts,
	filterViewablePosts,
} = require('../utils/postVisibility');

function normalizePostIds(ids) {
	return [...new Set((ids || []).map(Number).filter(Number.isInteger))];
}

/**
 * 検索・タイムライン・おすすめ等の「発見可能な投稿一覧」を取得する。
 *
 * DBアダプターは投稿候補の並び順だけを返す。閲覧者依存の可視性
 * （非公開、検索除外、フォロー関係）は、この共通層で一貫して適用する。
 * `offset` は可視な投稿に対するオフセットなので、非表示候補をまたいで
 * 必要件数に達するまでアダプターへ追加問い合わせを行う。
 */
async function getDiscoverablePostPage({
	db,
	viewerId = null,
	limit = 30,
	offset = 0,
	beforeId = null,
	fetchCandidatePage,
}) {
	if (typeof fetchCandidatePage !== 'function') {
		throw new Error('fetchCandidatePage is required');
	}

	const normalizedLimit = Math.min(Math.max(Number(limit) || 30, 1), 100);
	const normalizedBeforeId = Number.isInteger(Number(beforeId)) && Number(beforeId) > 0
		? Number(beforeId)
		: null;
	const normalizedOffset = normalizedBeforeId == null ? Math.max(Number(offset) || 0, 0) : 0;
	const candidateLimit = Math.min(
		100,
		Math.max(normalizedLimit + 1, normalizedLimit * 2),
	);
	let candidateOffset = 0;
	let candidateBeforeId = normalizedBeforeId;
	let visibleOffset = 0;
	const collectedPosts = [];
	let hasMore = false;
	let requiresOffsetPagination = false;

	while (true) {
		const candidatePage = await fetchCandidatePage({
			limit: candidateLimit,
			offset: candidateOffset,
			beforeId: candidateBeforeId,
		});
		const candidateIds = normalizePostIds(candidatePage?.ids);
		requiresOffsetPagination ||= candidatePage?.use_offset_pagination === true;
		const reportedNextOffset = Number(candidatePage?.next_offset);
		const nextCandidateOffset =
			Number.isInteger(reportedNextOffset) && reportedNextOffset > candidateOffset
				? reportedNextOffset
				: candidateOffset + candidateIds.length;
		if (candidateIds.length === 0) {
			if (!candidatePage?.has_more) break;
			if (candidateBeforeId != null) break;
			if (nextCandidateOffset <= candidateOffset) break;
			candidateOffset = nextCandidateOffset;
			continue;
		}

		const postsById = new Map(
			(await db.getPostsByIds(candidateIds)).filter(Boolean).map((post) => [
				Number(post.id),
				post,
			]),
		);
		const orderedPosts = candidateIds
			.map((id) => postsById.get(id))
			.filter(Boolean);
			const visibilityContext = await createPostVisibilityContext(
				db,
				orderedPosts,
				viewerId,
			);
			const viewablePosts = await filterViewablePosts(
				db,
				orderedPosts,
				viewerId,
				visibilityContext,
			);
			const discoverablePosts = await filterDiscoverablePosts(
				db,
				viewablePosts,
				viewerId,
				visibilityContext,
			);

		for (const post of discoverablePosts) {
			if (visibleOffset < normalizedOffset) {
				visibleOffset += 1;
				continue;
			}
			collectedPosts.push(post);
			if (collectedPosts.length > normalizedLimit) break;
		}
		if (collectedPosts.length > normalizedLimit) {
			hasMore = true;
			break;
		}

		if (candidateBeforeId != null) {
			candidateBeforeId = candidatePage?.next_cursor ?? candidateIds[candidateIds.length - 1];
		} else {
			if (nextCandidateOffset <= candidateOffset) break;
			candidateOffset = nextCandidateOffset;
		}
		if (!candidatePage?.has_more) break;
	}

	const posts = collectedPosts.slice(0, normalizedLimit);
	const ids = posts.map((post) => Number(post.id));
	return {
		ids,
		posts,
		has_more: hasMore,
		use_offset_pagination: requiresOffsetPagination,
		next_cursor: !requiresOffsetPagination && hasMore && ids.length > 0
			? ids[ids.length - 1]
			: null,
	};
}

module.exports = {
	getDiscoverablePostPage,
};
