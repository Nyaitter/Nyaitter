/**
 * Smart Timeline ID List Cache Manager.
 * Caches only post ID arrays and metadata with short TTL and instant invalidation
 * on write events, ensuring new posts appear immediately on timelines.
 */

class TimelineCacheManager {
	constructor(ttlMs = 5000) {
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
	 * Instantly invalidates all top-page timeline caches when a new post is created.
	 */
	onPostCreated(post) {
		for (const key of this.cache.keys()) {
			// Invalidate any first-page query (offset: 0, beforeId: 0)
			if (key.endsWith(':0:0') || key.includes(':0:0:0') || key.startsWith('timeline:') || key.startsWith('recommended:')) {
				this.cache.delete(key);
			}
		}
	}

	/**
	 * Removes deleted post ID from cached timelines or invalidates top pages.
	 */
	onPostDeleted(postId) {
		const pId = Number(postId);
		for (const [key, entry] of this.cache.entries()) {
			if (entry.expiresAt <= Date.now()) {
				this.cache.delete(key);
				continue;
			}
			entry.ids = entry.ids.filter((id) => id !== pId);
			if (key.endsWith(':0:0')) {
				this.cache.delete(key);
			}
		}
	}

	onPostUpdated() {
		// Invalidate first pages on post updates
		this.clearTopPages();
	}

	onReactionUpdated() {
		// Reactions handled in unified post cache
	}

	clearTopPages() {
		for (const key of this.cache.keys()) {
			if (key.endsWith(':0:0')) {
				this.cache.delete(key);
			}
		}
	}

	clear() {
		this.cache.clear();
	}
}

const timelineCacheManager = new TimelineCacheManager(5000); // 5s short cache, instantly cleared on new post
module.exports = timelineCacheManager;
