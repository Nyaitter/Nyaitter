const crypto = require('crypto');

class ExternalLoginStateStore {
  constructor({ ttlMs = 10 * 60 * 1000 } = {}) {
    this.ttlMs = ttlMs;
    this.states = new Map();
  }

  create({ nyaitterAddress }) {
    this.removeExpired();
    const state = crypto.randomBytes(32).toString('base64url');
    this.states.set(state, {
      nyaitterAddress,
      expiresAt: Date.now() + this.ttlMs,
    });
    return state;
  }

  get(state) {
    if (typeof state !== 'string' || state.length < 32) return null;
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

  removeExpired() {
    const now = Date.now();
    for (const [state, record] of this.states.entries()) {
      if (record.expiresAt <= now) this.states.delete(state);
    }
  }
}

module.exports = ExternalLoginStateStore;
