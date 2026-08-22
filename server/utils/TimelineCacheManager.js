/**
 * Smart Timeline ID List Cache Manager.
 * Caches only post ID arrays and metadata, leaving post objects to be served
 * from the unified MemoryBoundedCache (Post Cache).
 */

class TimelineCacheManager {
	constructor(ttlMs = 60000) {
		this.ttlMs = ttlMs;
		this.cache = new Map(); // key -> { ids: number[], has_more: boolean, expiresAt: number }
	}

	getIds(key) {
		const entry = this.cache.get(key);
		if (!entry) return null;
		if (entry.expiresAt <= Date.now()) {
			this.cache.delete(key);
			return null;
		}
		return { ids: [...entry.ids], has_more: entry.has_more };
	}

	setIds(key, { ids = [], has_more = false }, customTtlMs = null) {
		const ttl = customTtlMs ?? this.ttlMs;
		this.cache.set(key, {
			ids: Array.isArray(ids) ? ids.map(Number) : [],
			has_more: Boolean(has_more),
			expiresAt: Date.now() + ttl,
		});
	}

	/**
	 * Prepends newly created post ID to relevant timeline caches.
	 */
	onPostCreated(post) {
		const postId = Number(post.id);
		const isPublicRoot = !post.groupId && !post.group_id && !post.replyTo && !post.reply_to;

		for (const [key, entry] of this.cache.entries()) {
			if (entry.expiresAt <= Date.now()) {
				this.cache.delete(key);
				continue;
			}
			// Only update top page (offset 0, beforeId 0)
			if (!key.includes(':0:0') && !key.endsWith(':0:0')) continue;

			const [mode, tab] = key.split(':');
			if (mode !== 'timeline' && mode !== 'recommended') continue;

			if (isPublicRoot && (tab === 'foryou' || mode === 'recommended')) {
				if (!entry.ids.includes(postId)) {
					entry.ids.unshift(postId);
					if (entry.ids.length > 30) entry.ids.pop();
				}
			}
		}
	}

	/**
	 * Removes deleted post ID from cached timelines.
	 */
	onPostDeleted(postId) {
		const pId = Number(postId);
		for (const [key, entry] of this.cache.entries()) {
			if (entry.expiresAt <= Date.now()) {
				this.cache.delete(key);
				continue;
			}
			entry.ids = entry.ids.filter((id) => id !== pId);
		}
	}

	clear() {
		this.cache.clear();
	}
}

const timelineCacheManager = new TimelineCacheManager(60000); // 60s durable TTL
module.exports = timelineCacheManager;
