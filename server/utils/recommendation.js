/**
 * Shared in-memory post recommendation scoring utility.
 * Keeps databases focused purely on data delivery while Node.js performs scoring.
 *
 * Scoring is intentionally additive but each component is normalized to a bounded
 * range so that no single signal (especially recency) can dominate the feed.
 * Interest affinity is now the largest term, which is what makes the "for you"
 * tab feel closer to what the viewer actually cares about.
 */

// Component ceilings (sum ≈ 162 before penalties).
const RECENCY_MAX = 45;
const RECENCY_HALF_LIFE_HOURS = 18;
const ENGAGEMENT_MAX = 20;
const ENGAGEMENT_SCALE = 8;
const FOLLOW_DIRECT = 22;
const FOLLOW_EXTENDED = 9;
const AFFINITY_MAX = 60;
const AFFINITY_SCALE = 0.8;
// 減衰後の興味スコアがこの値なら「その語に Fully 関心がある」とみなす基準。
// (スター ±3 / いいね ±1 / 自分の投稿 +1 なので、スター4件程度で到達する強さ)
const AFFINITY_REFERENCE = 12;
// 先頭タグは投稿者の主トピックであることが多いので、一致時に少しだけ重くする。
const FIRST_TAG_BOOST = 1.25;
// 候補窓の中でありふれたタグは区別力を欠くため、一致の重みを半減させる (IDF-lite)。
// 閾値は候補数の1割。ただし窓が小さいときは最低10件までは対象にしない。
const COMMON_TAG_RATIO = 0.1;
const COMMON_TAG_MIN_COUNT = 10;
const COMMON_TAG_DAMPING = 0.5;

// 年齢近接ボーナス: 閲覧者と投稿者の推定年齢（どちらも投稿内容からの推定）が
// 近いほど大きく、差が開くほど指数的に減る。どちらか不明なら 0。
const AGE_PROXIMITY_MAX = 15;
const AGE_PROXIMITY_SCALE_YEARS = 6;

function ageProximityScore(viewerAgeEstimate, authorAgeEstimate) {
	const viewerAge = viewerAgeEstimate == null ? NaN : Number(viewerAgeEstimate);
	const authorAge = authorAgeEstimate == null ? NaN : Number(authorAgeEstimate);
	if (!Number.isFinite(viewerAge) || !Number.isFinite(authorAge)) return 0;
	if (viewerAge <= 0 || authorAge <= 0) return 0;
	return AGE_PROXIMITY_MAX * Math.exp(-Math.abs(viewerAge - authorAge) / AGE_PROXIMITY_SCALE_YEARS);
}

// Negative signals.
// 「興味なし」1回の著者は弱く沈め、2回以上で初めて候補から外す（誤タップ対策）。
const DISLIKED_AUTHOR_SOFT_PENALTY = 18;
const DISLIKED_AUTHOR_HARD_COUNT = 2;
// 「興味なし」にした投稿のタグは、その話題への負の興味として最大でこの値まで引く。
// 1回では発動せず（誤タップ対策）、5回で上限に達する。
const NEGATIVE_TAG_MAX_PENALTY = 14;
// 反応済みの投稿は加算ペナルティではなく乗算で強く沈める（高い素点でも再浮上しにくくする）。
const REACTED_SCORE_FACTOR = 0.3;

// Diversity caps for a single page.
const AUTHOR_CAP = 2;
const TOPIC_CAP = 4;
// 発見枠: フォロー中著者だけで上位が埋まる場合に、非フォローの最良候補を1件だけ5位へ入れる。
const EXPLORATION_POSITION = 4;
const EXPLORATION_MIN_FOLLOWS = 5;

function parseTags(tags) {
	if (Array.isArray(tags)) return tags;
	if (typeof tags === 'string') {
		try {
			const parsed = JSON.parse(tags);
			return Array.isArray(parsed) ? parsed : [];
		} catch (_) {
			return [];
		}
	}
	return [];
}

// タグの表記揺れ（全角/半角・大文字小文字）を吸収する正規化。興味プロファイル側と
// 投稿タグ側の両方に同じ正規化をかけることで、保存形式を変えずに一致率を上げる。
function normalizeTag(tag) {
	return String(tag || '').trim().normalize('NFKC').toLowerCase();
}

/**
 * 「単語」より「複合語・句」を重視する。複合語は具体的な関心を表すため、
 * 単語一致の 2 倍の重みを与える。
 */
function tagWeight(normalizedTag) {
	if (normalizedTag.includes('の')) return 2;
	if (normalizedTag.length >= 4 && /^[\p{Script=Han}\p{Script=Katakana}a-zA-Z0-9_-]+$/u.test(normalizedTag)) {
		return 2;
	}
	return 1;
}

/**
 * 生の興味スコアを絶対基準で 0..1 に詰め、利用量に依存しない重みにする。
 * プロファイル内の最大値で割る方式だと、偶発的な1件のいいねだけでも満点になり、
 * 「興味の薄さ」が反映されずフィード全体がその語に傾く。絶対基準で頭打ちにする。
 */
function normalizeProfile(keywordProfile) {
	const normalized = new Map();
	if (!(keywordProfile instanceof Map) || keywordProfile.size === 0) return normalized;
	for (const [keyword, value] of keywordProfile.entries()) {
		const numeric = Number(value) || 0;
		if (numeric <= 0) continue;
		const key = normalizeTag(keyword);
		if (!key) continue;
		const scaled = Math.min(1, numeric / AFFINITY_REFERENCE);
		if (scaled > (normalized.get(key) || 0)) normalized.set(key, scaled);
	}
	return normalized;
}

function toCountMap(source, { numericKeys = false } = {}) {
	if (source instanceof Map) {
		if (!numericKeys) return source;
		return new Map([...source.entries()].map(([key, value]) => [Number(key), Number(value) || 0]));
	}
	if (source && typeof source === 'object') {
		return new Map(Object.entries(source).map(([key, value]) => [numericKeys ? Number(key) : key, Number(value) || 0]));
	}
	return new Map();
}

// 発見枠: 先頭 EXPLORATION_POSITION+1 件が全てフォロー中著者なら、非フォロー著者の
// 最良候補を5位へ入れる。選択済みの中に候補があれば5位と入れ替え、無ければ圏外から
// 挿入して末尾を落とす（件数は維持し、多様性キャップも維持する）。順序の決定性は保つ。
function applyExploration(selected, pool, followCount) {
	if (followCount < EXPLORATION_MIN_FOLLOWS) return selected;
	if (selected.length <= EXPLORATION_POSITION) return selected;
	const head = selected.slice(0, EXPLORATION_POSITION + 1);
	if (head.some((item) => !item.directFollowed)) return selected;
	const inSelected = selected.slice(EXPLORATION_POSITION + 1).find((item) => !item.directFollowed);
	if (inSelected) {
		const at = selected.indexOf(inSelected);
		selected[at] = selected[EXPLORATION_POSITION];
		selected[EXPLORATION_POSITION] = inSelected;
		return selected;
	}
	const selectedIds = new Set(selected.map((item) => item.id));
	const authorCounts = new Map();
	const topicCounts = new Map();
	for (const item of selected) {
		if (item.authorId != null) authorCounts.set(item.authorId, (authorCounts.get(item.authorId) || 0) + 1);
		if (item.topTag) topicCounts.set(item.topTag, (topicCounts.get(item.topTag) || 0) + 1);
	}
	const outsider = pool.find((item) => {
		if (item.directFollowed || selectedIds.has(item.id)) return false;
		if (item.authorId != null && (authorCounts.get(item.authorId) || 0) >= AUTHOR_CAP) return false;
		if (item.topTag && (topicCounts.get(item.topTag) || 0) >= TOPIC_CAP) return false;
		return true;
	});
	if (!outsider) return selected;
	// 挿入で元の5位が落ちてしまう小さいページでは挿入しない。
	if (selected.length <= EXPLORATION_POSITION + 1) return selected;
	selected.splice(EXPLORATION_POSITION, 0, outsider);
	selected.pop();
	return selected;
}

function scoreRecommendedPosts(candidatePosts, {
	viewerId = null,
	keywordProfile = new Map(),
	directFollows = new Set(),
	extendedFollows = new Set(),
	reactedPostIds = new Set(),
	dislikedPostIds = new Set(),
	dislikedAuthors = new Set(),
	dislikedAuthorCounts = null,
	negativeTagCounts = null,
	blockedAuthors = new Set(),
	viewerAgeEstimate = null,
	authorAgeEstimates = null,
	now = Date.now(),
	limit = 30,
} = {}) {
	const normalizedLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
	const parsedViewerId = Number(viewerId);
	const validViewerId = Number.isSafeInteger(parsedViewerId) && parsedViewerId > 0 ? parsedViewerId : null;
	const affinityProfile = normalizeProfile(keywordProfile);
	const authorAgeById = Number.isFinite(Number(viewerAgeEstimate)) && viewerAgeEstimate != null
		? toCountMap(authorAgeEstimates, { numericKeys: true })
		: new Map();
	const dislikedCounts = toCountMap(dislikedAuthorCounts, { numericKeys: true });
	const negativeTags = new Map();
	for (const [tag, count] of toCountMap(negativeTagCounts).entries()) {
		const key = normalizeTag(tag);
		if (key && count > (negativeTags.get(key) || 0)) negativeTags.set(key, count);
	}

	// 事前パス: タグのパースと正規化は候補ごとに1回だけ行い、affinity 照合・
	// トピック判定・出現頻度 (IDF-lite) で使い回す。
	const posts = Array.isArray(candidatePosts) ? candidatePosts : [];
	const prepared = new Array(posts.length);
	const tagDocumentFrequency = new Map();
	for (let i = 0; i < posts.length; i += 1) {
		const post = posts[i];
		const seen = new Set();
		const tags = [];
		if (post) {
			for (const rawTag of parseTags(post.tags)) {
				const normalizedTag = normalizeTag(rawTag);
				if (!normalizedTag || seen.has(normalizedTag)) continue;
				seen.add(normalizedTag);
				tags.push(normalizedTag);
				tagDocumentFrequency.set(normalizedTag, (tagDocumentFrequency.get(normalizedTag) || 0) + 1);
			}
		}
		prepared[i] = tags;
	}
	const commonTagThreshold = Math.max(COMMON_TAG_MIN_COUNT, Math.ceil(posts.length * COMMON_TAG_RATIO));
	const tagWeightCache = new Map();
	const weightOf = (normalizedTag) => {
		let weight = tagWeightCache.get(normalizedTag);
		if (weight === undefined) {
			weight = tagWeight(normalizedTag);
			if ((tagDocumentFrequency.get(normalizedTag) || 0) >= commonTagThreshold) weight *= COMMON_TAG_DAMPING;
			tagWeightCache.set(normalizedTag, weight);
		}
		return weight;
	};

	const scored = [];

	for (let i = 0; i < posts.length; i += 1) {
		const post = posts[i];
		if (!post) continue;
		const postId = Number(post.id);
		const authorId = Number(post.userId ?? post.user_id);
		if (validViewerId != null && authorId === validViewerId) continue;
		if (dislikedPostIds?.has(postId)) continue;
		if (blockedAuthors?.has(authorId)) continue;
		// Postgres は候補 SQL で「興味なし」著者を除外するため、採点側も同じく除外しないと
		// D1・インメモリだけが表示されて3アダプタの挙動がずれる。ただし除外は
		// 「興味なし」が2回以上付いた著者だけにし、1回はペナルティに留める。
		if (dislikedAuthors?.has(authorId)) continue;
		const dislikeCount = dislikedCounts.get(authorId) || 0;
		if (dislikeCount >= DISLIKED_AUTHOR_HARD_COUNT) continue;

		const rawCreatedAtMs = new Date(post.createdAt || post.created_at || now).getTime();
		const createdAtMs = Number.isFinite(rawCreatedAtMs) ? rawCreatedAtMs : now;
		const ageHours = Math.max(0, (now - createdAtMs) / (1000 * 3600));
		const recencyScore = RECENCY_MAX * Math.pow(2, -ageHours / RECENCY_HALF_LIFE_HOURS);

		const lCount = Math.max(0, Number(post.likeCount ?? post.like_count) || 0);
		const sCount = Math.max(0, Number(post.starCount ?? post.star_count) || 0);
		const rCount = Math.max(0, Number(post.repostCount ?? post.repost_count) || 0);
		const replyCount = Math.max(0, Number(post.replyCount ?? post.reply_count) || 0);
		const engagementRaw = (lCount * 1) + (sCount * 1.5) + (rCount * 3) + (replyCount * 1.5);
		const engagementScore = ENGAGEMENT_MAX * (1 - Math.exp(-engagementRaw / ENGAGEMENT_SCALE));

		let followScore = 0;
		let affinityScore = 0;
		let ageProximity = 0;
		let penalty = 0;
		let followed = false;
		let directFollowed = false;

		if (validViewerId != null) {
			if (directFollows?.has(authorId)) { followScore = FOLLOW_DIRECT; followed = true; directFollowed = true; }
			else if (extendedFollows?.has(authorId)) { followScore = FOLLOW_EXTENDED; followed = true; }

			if (dislikeCount === 1) penalty += DISLIKED_AUTHOR_SOFT_PENALTY;

			const tags = prepared[i];
			if (tags.length > 0) {
				if (affinityProfile.size > 0) {
					let matched = 0;
					for (let t = 0; t < tags.length; t += 1) {
						const affinity = affinityProfile.get(tags[t]);
						if (!affinity) continue;
						matched += affinity * weightOf(tags[t]) * (t === 0 ? FIRST_TAG_BOOST : 1);
					}
					if (matched > 0) {
						affinityScore = AFFINITY_MAX * (1 - Math.exp(-matched * AFFINITY_SCALE));
					}
				}
				if (negativeTags.size > 0) {
					let negativity = 0;
					for (const tag of tags) {
						const count = negativeTags.get(tag) || 0;
						if (count >= DISLIKED_AUTHOR_HARD_COUNT) negativity += Math.min(1, (count - 1) / 4);
					}
					if (negativity > 0) penalty += NEGATIVE_TAG_MAX_PENALTY * Math.min(1, negativity);
				}
			}

			const authorAge = authorAgeById.get(authorId);
			ageProximity = ageProximityScore(viewerAgeEstimate, authorAge);
		}

		let totalScoreRaw = Math.max(0, recencyScore + engagementScore + followScore + affinityScore + ageProximity - penalty);
		if (validViewerId != null && reactedPostIds?.has(postId)) totalScoreRaw *= REACTED_SCORE_FACTOR;
		const recommendationPenalty = Math.max(0, Math.min(1, Number(post?.recommendation_penalty ?? post?.recommendationPenalty) || 0));
		const totalScore = totalScoreRaw * (1 - recommendationPenalty);
		scored.push({
			id: Number.isSafeInteger(postId) ? postId : null,
			authorId: Number.isSafeInteger(authorId) ? authorId : null,
			score: totalScore,
			createdAt: createdAtMs,
			topTag: prepared[i].length > 0 ? prepared[i][0] : null,
			followed,
			directFollowed,
			post,
		});
	}

	// Deterministic ordering: score, then recency, then id. This keeps pagination
	// stable when two posts have the same score.
	scored.sort((a, b) => b.score - a.score || b.createdAt - a.createdAt || (b.id || 0) - (a.id || 0));
	// 発見枠の発動条件は直接フォローの数だけで数える（拡張フォローは含めない）。
	const followCount = validViewerId == null ? 0 : (directFollows?.size || 0);
	if (scored.length <= normalizedLimit) return applyExploration(scored, scored, followCount);

	// Diversity: avoid a single prolific account or a single topic filling the page.
	const selected = [];
	const deferred = [];
	const authorCounts = new Map();
	const topicCounts = new Map();
	for (const item of scored) {
		const authorId = item.authorId;
		const authorCount = authorId == null ? 0 : (authorCounts.get(authorId) || 0);
		const topicCount = item.topTag ? (topicCounts.get(item.topTag) || 0) : 0;
		if ((authorId != null && authorCount >= AUTHOR_CAP) || (item.topTag && topicCount >= TOPIC_CAP)) {
			deferred.push(item);
			continue;
		}
		selected.push(item);
		if (authorId != null) authorCounts.set(authorId, authorCount + 1);
		if (item.topTag) topicCounts.set(item.topTag, topicCount + 1);
		if (selected.length >= normalizedLimit) return applyExploration(selected, scored, followCount);
	}
	for (const item of deferred) {
		selected.push(item);
		if (selected.length >= normalizedLimit) break;
	}
	return applyExploration(selected, scored, followCount);
}

/**
 * 生の興味スコア行を時間減衰（既定 半減期14日）し、減衰後の上位だけを返す。
 * これにより「昔に貯めた興味」が最近の興味を締め出さなくなる。
 */
function buildAffinityProfile(rows, { now = Date.now(), halfLifeDays = 14, limit = 25 } = {}) {
	const map = new Map();
	for (const row of rows || []) {
		const keyword = String(row?.keyword || '').trim().toLowerCase();
		if (!keyword) continue;
		const updatedAt = new Date(row?.updated_at ?? now).getTime();
		const days = Number.isFinite(updatedAt) ? Math.max(0, (now - updatedAt) / 86400000) : 0;
		const score = (Number(row?.score) || 0) * Math.pow(0.5, days / halfLifeDays);
		if (score <= 0) continue;
		map.set(keyword, score);
	}
	return new Map(
		[...map.entries()]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.slice(0, Math.max(1, Number(limit) || 25)),
	);
}

module.exports = {
	scoreRecommendedPosts,
	buildAffinityProfile,
	ageProximityScore,
	AGE_PROXIMITY_MAX,
	DISLIKED_AUTHOR_SOFT_PENALTY,
	NEGATIVE_TAG_MAX_PENALTY,
	REACTED_SCORE_FACTOR,
};
