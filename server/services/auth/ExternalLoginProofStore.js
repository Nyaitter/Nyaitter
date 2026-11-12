const crypto = require('crypto');

const DEFAULT_MAX_ENTRIES = 128;
const PRUNE_INTERVAL_MS = 60 * 1000;

class ExternalLoginProofStore {
  constructor({ ttlMs = 10 * 60 * 1000, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = Number.isInteger(maxEntries) && maxEntries > 0
      ? maxEntries
      : DEFAULT_MAX_ENTRIES;
    this.proofs = new Map();
    this.lastPrunedAt = 0;
  }

  create({ nyaitterAddress, profile, userId }) {
    this.removeExpired();
    this.removeOldestEntries();
    const proof = crypto.randomBytes(32).toString('base64url');
    this.proofs.set(proof, {
      nyaitterAddress,
      profile,
      userId,
      expiresAt: Date.now() + this.ttlMs,
    });
    return proof;
  }

  get(proof) {
    if (typeof proof !== 'string' || proof.length < 32) return null;
    this.removeExpiredIfNeeded();
    const record = this.proofs.get(proof);
    if (!record) return null;
    if (record.expiresAt <= Date.now()) {
      this.proofs.delete(proof);
      return null;
    }
    return record;
  }

  consume(proof) {
    const record = this.get(proof);
    if (!record) return null;
    this.proofs.delete(proof);
    return record;
  }

  removeExpiredIfNeeded(now = Date.now()) {
    if (now - this.lastPrunedAt < PRUNE_INTERVAL_MS) return;
    this.removeExpired(now);
  }

  removeExpired(now = Date.now()) {
    this.lastPrunedAt = now;
    for (const [proof, record] of this.proofs.entries()) {
      if (record.expiresAt <= now) this.proofs.delete(proof);
    }
  }

  removeOldestEntries() {
    while (this.proofs.size >= this.maxEntries) {
      const oldestProof = this.proofs.keys().next().value;
      if (oldestProof === undefined) return;
      this.proofs.delete(oldestProof);
    }
  }
}

module.exports = ExternalLoginProofStore;
