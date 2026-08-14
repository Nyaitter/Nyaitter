const crypto = require('crypto');

class SessionManager {
  constructor({ dbAdapter }) {
    this.db = dbAdapter;
  }

  async createSession(userId, meta = {}) {
    if (!this.db || !this.db.createSession) {
      throw new Error('DatabaseAdapterがセッション機能に対応していません');
    }

    const session = await this.db.createSession(userId, meta);
    return {
      id: session.id || null,
      token: session.token,
      expiresAt: session.expiresAt,
      userId: session.userId || userId,
    };
  }

  async validateToken(token) {
    if (!this.db || !this.db.getSessionByToken) return null;

    const session = await this.db.getSessionByToken(token);
    if (!session) return null;

    return {
      userId: session.userId,
      token,
    };
  }

  async invalidateSession(userId, token) {
    if (!this.db || !this.db.invalidateSession) return false;
    return this.db.invalidateSession(token);
  }

  async getUserSessions(userId) {
    if (!this.db || !this.db.getUserSessions) return [];
    return this.db.getUserSessions(userId);
  }

  async invalidateAllSessions(userId) {
    if (!this.db || !this.db.invalidateAllSessions) return 0;
    return this.db.invalidateAllSessions(userId);
  }
}

module.exports = SessionManager;
