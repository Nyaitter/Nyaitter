const crypto = require('crypto');
const config = require('../../config');

function hashSessionToken(token) {
  return crypto
    .createHash('sha256')
    .update(String(token || ''), 'utf8')
    .digest('base64url');
}

class SessionManager {
  constructor({ dbAdapter }) {
    this.db = dbAdapter;
  }

  static hashToken(token) {
    return hashSessionToken(token);
  }

  async createSession(userId, meta = {}) {
    if (!this.db || !this.db.createSession) {
      throw new Error('DatabaseAdapterがセッション機能に対応していません');
    }

    // Cookieへ返すランダムなBearer値と、DBへ保存する照合値を分離する。
    // DB流出時にセッションをそのまま再利用されないよう、平文トークンは永続化しない。
    const token = crypto.randomBytes(config.auth.sessionTokenBytes).toString('base64url');
    const session = await this.db.createSession(userId, {
      ...meta,
      token: hashSessionToken(token),
    });
    return {
      id: session.id || null,
      token,
      expiresAt: session.expiresAt,
      userId: session.userId || userId,
    };
  }

  async validateToken(token) {
    if (!this.db || !this.db.getSessionByToken || !token) return null;

    const session = await this.db.getSessionByToken(hashSessionToken(token));
    if (!session) return null;

    return {
      userId: session.userId,
      token,
    };
  }

  static onInvalidate(listener) {
    if (typeof listener === 'function') {
      SessionManager._invalidationListeners.add(listener);
    }
  }

  static _notifyInvalidate(tokenHashOrUserId) {
    for (const listener of SessionManager._invalidationListeners) {
      try {
        listener(tokenHashOrUserId);
      } catch (_) {}
    }
  }

  async invalidateSession(_userId, token) {
    if (!this.db || !this.db.invalidateSession || !token) return false;
    const tokenHash = hashSessionToken(token);
    const result = await this.db.invalidateSession(tokenHash);
    SessionManager._notifyInvalidate(tokenHash);
    if (_userId != null) SessionManager._notifyInvalidate(Number(_userId));
    return result;
  }

  async getUserSessions(userId) {
    if (!this.db || !this.db.getUserSessions) return [];
    return this.db.getUserSessions(userId);
  }

  async invalidateAllSessions(userId) {
    if (!this.db || !this.db.invalidateAllSessions) return 0;
    const result = await this.db.invalidateAllSessions(userId);
    SessionManager._notifyInvalidate(Number(userId));
    return result;
  }
}

SessionManager._invalidationListeners = new Set();

module.exports = SessionManager;
