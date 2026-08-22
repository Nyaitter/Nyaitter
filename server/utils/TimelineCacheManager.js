/**
 * Smart Timeline Cache Manager with In-Place Mutations.
 * Preserves high cache durability by patching cached timelines instead of flushing them.
 */

class TimelineCacheManager {
	constructor(ttlMs = 60000) {
		this.ttlMs = ttlMs;
		this.cache = new Map(); // key -> { data, expiresAt }
	}

	get(key) {
		const entry = this.cache.get(key);
		if (!entry) return null;
		if (entry.expiresAt <= Date.now()) {
			this.cache.delete(key);
			return null;
		}
		return entry.data;
	}

	set(key, data, customTtlMs = null) {
		const ttl = customTtlMs ?? this.ttlMs;
		this.cache.set(key, {
			data,
			expiresAt: Date.now() + ttl,
		});
	}

	/**
	 * Prepends a newly created post to relevant cached timelines (e.g. foryou tab, offset 0).
	 */
	onPostCreated(post, serializedPost = null) {
		const postId = Number(post.id);
		const authorId = Number(post.userId ?? post.user_id);
		const isPublicRoot = !post.groupId && !post.group_id && !post.replyTo && !post.reply_to;

		for (const [key, entry] of this.cache.entries()) {
			if (entry.expiresAt <= Date.now()) {
				this.cache.delete(key);
				continue;
			}
			// Only update page 1 (offset 0, no beforeId)
			if (!key.includes(':0:0') && !key.endsWith(':0:0')) continue;

			const [mode, tab] = key.split(':');
			if (mode !== 'timeline' && mode !== 'recommended') continue;

			if (isPublicRoot && (tab === 'foryou' || mode === 'recommended')) {
				if (Array.isArray(entry.data?.posts)) {
					const existingIdx = entry.data.posts.findIndex((p) => Number(p.id) === postId);
					if (existingIdx === -1) {
						const itemToInsert = serializedPost || {
							id: postId,
							userId: authorId,
							content: post.content,
							createdAt: post.createdAt || post.created_at || new Date().toISOString(),
							...post,
						};
						entry.data.posts.unshift(itemToInsert);
						if (entry.data.posts.length > 30) {
							entry.data.posts.pop();
						}
					}
				}
			}
		}
	}

	/**
	 * In-place updates an edited post inside cached timelines.
	 */
	onPostUpdated(postId, updatedFields) {
		const pId = Number(postId);
		for (const [key, entry] of this.cache.entries()) {
			if (entry.expiresAt <= Date.now()) {
				this.cache.delete(key);
				continue;
			}
			if (Array.isArray(entry.data?.posts)) {
				for (const post of entry.data.posts) {
					if (Number(post.id) === pId) {
						if (updatedFields.content !== undefined) post.content = updatedFields.content;
						if (updatedFields.attachments !== undefined) post.attachments = updatedFields.attachments;
						if (updatedFields.mask !== undefined) post.mask = updatedFields.mask;
						if (updatedFields.lock !== undefined) post.lock = updatedFields.lock;
						if (updatedFields.like_count !== undefined) post.like_count = updatedFields.like_count;
						if (updatedFields.star_count !== undefined) post.star_count = updatedFields.star_count;
					}
				}
			}
		}
	}

	/**
	 * In-place removes a deleted post from cached timelines.
	 */
	onPostDeleted(postId) {
		const pId = Number(postId);
		for (const [key, entry] of this.cache.entries()) {
			if (entry.expiresAt <= Date.now()) {
				this.cache.delete(key);
				continue;
			}
			if (Array.isArray(entry.data?.posts)) {
				entry.data.posts = entry.data.posts.filter((p) => Number(p.id) !== pId);
			}
		}
	}

	/**
	 * In-place updates like / star counts on reaction toggle without invalidating the cache.
	 */
	onReactionUpdated(postId, { likeDelta = 0, starDelta = 0, likeCount = null, starCount = null } = {}) {
		const pId = Number(postId);
		for (const [key, entry] of this.cache.entries()) {
			if (entry.expiresAt <= Date.now()) {
				this.cache.delete(key);
				continue;
			}
			if (Array.isArray(entry.data?.posts)) {
				for (const post of entry.data.posts) {
					if (Number(post.id) === pId) {
						if (likeCount !== null) {
							post.like_count = likeCount;
						} else if (likeDelta !== 0) {
							post.like_count = Math.max(0, (Number(post.like_count) || 0) + likeDelta);
						}
						if (starCount !== null) {
							post.star_count = starCount;
						} else if (starDelta !== 0) {
							post.star_count = Math.max(0, (Number(post.star_count) || 0) + starDelta);
						}
					}
				}
			}
		}
	}

	clear() {
		this.cache.clear();
	}
}

const timelineCacheManager = new TimelineCacheManager(60000); // 60s durable TTL
module.exports = timelineCacheManager;
