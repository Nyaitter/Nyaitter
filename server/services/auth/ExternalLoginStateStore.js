const crypto = require('crypto');

const DEFAULT_MAX_ENTRIES = 128;
const PRUNE_INTERVAL_MS = 60 * 1000;

class ExternalLoginStateStore {
  constructor({ ttlMs = 10 * 60 * 1000, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = Number.isInteger(maxEntries) && maxEntries > 0
      ? maxEntries
      : DEFAULT_MAX_ENTRIES;
    this.states = new Map();
    this.lastPrunedAt = 0;
  }

  create({ nyaitterAddress }) {
    this.removeExpired();
    this.removeOldestEntries();
    const state = crypto.randomBytes(32).toString('base64url');
    this.states.set(state, {
      nyaitterAddress,
      expiresAt: Date.now() + this.ttlMs,
    });
    return state;
  }

  get(state) {
    if (typeof state !== 'string' || state.length < 32) return null;
    this.removeExpiredIfNeeded();
    const record = this.states.get(state);
    if (!record) return null;
    if (record.expiresAt <= Date.now()) {
      this.states.delete(state);
      return null;
    }
    return record;
  }

  consume(state) {
    const record = this.get(state);
    if (!record) return null;
    this.states.delete(state);
    return record;
  }

  removeExpiredIfNeeded(now = Date.now()) {
    if (now - this.lastPrunedAt < PRUNE_INTERVAL_MS) return;
    this.removeExpired(now);
  }

  removeExpired(now = Date.now()) {
    this.lastPrunedAt = now;
    for (const [state, record] of this.states.entries()) {
      if (record.expiresAt <= now) this.states.delete(state);
    }
  }

  removeOldestEntries() {
    while (this.states.size >= this.maxEntries) {
      const oldestState = this.states.keys().next().value;
      if (oldestState === undefined) return;
      this.states.delete(oldestState);
    }
  }
}

module.exports = ExternalLoginStateStore;
