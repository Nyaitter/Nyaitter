const crypto = require('crypto');

class ExternalLoginProofStore {
  constructor({ ttlMs = 10 * 60 * 1000 } = {}) {
    this.ttlMs = ttlMs;
    this.proofs = new Map();
  }

  create({ nyaitterAddress, profile, userId }) {
    this.removeExpired();
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

  removeExpired() {
    const now = Date.now();
    for (const [proof, record] of this.proofs.entries()) {
      if (record.expiresAt <= now) this.proofs.delete(proof);
    }
  }
}

module.exports = ExternalLoginProofStore;
