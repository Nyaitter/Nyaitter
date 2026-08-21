'use strict';

const crypto = require('crypto');
const BaseAuthProvider = require('./BaseAuthProvider');

class PasskeyAuthProvider extends BaseAuthProvider {
  constructor() {
    super();
    this.pendingChallenges = new Map();
  }

  get name() {
    return 'passkey';
  }

  get displayName() {
    return 'パスキー';
  }

  isEnabled(config) {
    return Boolean(config?.auth?.methods?.passkey?.enabled);
  }

  getPublicConfig(config, req = null) {
    const passkeyConfig = config?.auth?.methods?.passkey || {};
    const rpId = passkeyConfig.rpId || req?.hostname || 'localhost';
    return {
      name: this.name,
      displayName: this.displayName,
      enabled: this.isEnabled(config, req),
      allowSignup: this.isSignupAllowed(config, req),
      rpName: passkeyConfig.rpName || 'Nyaitter',
      rpId,
    };
  }

  generateChallenge(rpId, ttlMs = 5 * 60 * 1000) {
    this._sweepExpiredChallenges();
    const challenge = crypto.randomBytes(32).toString('base64url');
    this.pendingChallenges.set(challenge, {
      challenge,
      rpId,
      expiresAt: Date.now() + ttlMs,
    });
    return challenge;
  }

  consumeChallenge(challenge) {
    if (!challenge || typeof challenge !== 'string') return null;
    const entry = this.pendingChallenges.get(challenge);
    if (!entry) return null;
    this.pendingChallenges.delete(challenge);
    if (entry.expiresAt < Date.now()) return null;
    return entry;
  }

  _sweepExpiredChallenges() {
    const now = Date.now();
    for (const [key, val] of this.pendingChallenges.entries()) {
      if (val.expiresAt <= now) this.pendingChallenges.delete(key);
    }
  }

  async initiate(req, payload = {}, context = {}) {
    const { config } = context;
    const passkeyConfig = config?.auth?.methods?.passkey || {};
    const rpId = passkeyConfig.rpId || req?.hostname || 'localhost';

    // Challenge generation for WebAuthn authentication
    const challenge = this.generateChallenge(rpId);
    return {
      challenge,
      rpId,
      timeout: 60000,
      userVerification: 'preferred',
    };
  }

  async verify(req, payload = {}, context = {}) {
    const { credentialId, response } = payload;
    if (!credentialId) {
      const err = new Error('パスキーの認証情報 (credentialId) が不足しています。');
      err.status = 400;
      throw err;
    }

    if (!response || typeof response !== 'object') {
      const err = new Error('パスキーの認証レスポンス (response) が不足しています。');
      err.status = 400;
      throw err;
    }

    const clientDataJSONRaw = response.clientDataJSON || payload.clientDataJSON;
    if (!clientDataJSONRaw) {
      const err = new Error('パスキーのクライアントデータ (clientDataJSON) が不足しています。');
      err.status = 400;
      throw err;
    }

    let clientData;
    try {
      const clientDataStr = Buffer.from(clientDataJSONRaw, 'base64url').toString('utf8');
      clientData = JSON.parse(clientDataStr);
    } catch (_) {
      const err = new Error('clientDataJSON の形式が不正です。');
      err.status = 400;
      throw err;
    }

    // 1. Verify Challenge (prevent replay attacks and uninitiated requests)
    const pending = this.consumeChallenge(clientData.challenge);
    if (!pending) {
      const err = new Error('パスキーの認証チャレンジが無効か、有効期限が切れています。もう一度やり直してください。');
      err.status = 400;
      err.code = 'invalid_challenge';
      throw err;
    }

    // 2. Verify type (webauthn.get for sign in, webauthn.create for registration/linking)
    const allowedTypes = ['webauthn.get', 'webauthn.create'];
    if (!allowedTypes.includes(clientData.type)) {
      const err = new Error(`不正なWebAuthnタイプです: ${clientData.type}`);
      err.status = 400;
      throw err;
    }

    // 3. Verify authenticatorData / attestationObject
    if (clientData.type === 'webauthn.get') {
      const authenticatorDataRaw = response.authenticatorData;
      if (!authenticatorDataRaw) {
        const err = new Error('認証器データ (authenticatorData) が不足しています。');
        err.status = 400;
        throw err;
      }
      const authDataBuf = Buffer.from(authenticatorDataRaw, 'base64url');
      if (authDataBuf.length < 37) {
        const err = new Error('authenticatorData のサイズが無効です。');
        err.status = 400;
        throw err;
      }
      const flags = authDataBuf[32];
      const userPresent = (flags & 0x01) !== 0;
      if (!userPresent) {
        const err = new Error('パスキー認証時のユーザー存在確認 (User Present) が確認できませんでした。');
        err.status = 400;
        throw err;
      }
      if (!response.signature) {
        const err = new Error('パスキーの署名 (signature) が不足しています。');
        err.status = 400;
        throw err;
      }
    } else if (clientData.type === 'webauthn.create') {
      if (!response.attestationObject) {
        const err = new Error('アテステーションデータ (attestationObject) が不足しています。');
        err.status = 400;
        throw err;
      }
    }

    return {
      success: true,
      identity: {
        authProvider: 'passkey',
        externalId: credentialId,
        name: payload.name || 'Passkey User',
      },
      profile: {
        credentialId,
        rawId: payload.rawId || null,
        type: payload.type || 'public-key',
      },
    };
  }

  async resolveUser(db, authResult, context = {}) {
    const { identity } = authResult;
    const credentialId = identity?.externalId;
    if (!credentialId) {
      const err = new Error('パスキーの認証情報が不足しています。');
      err.status = 400;
      throw err;
    }

    let existingUser = null;
    if (typeof db.findUserByAuthProvider === 'function') {
      existingUser = await db.findUserByAuthProvider(this.name, credentialId);
    } else if (typeof db.getUserByExternalId === 'function') {
      existingUser = await db.getUserByExternalId(this.name, credentialId);
    }

    if (!existingUser) {
      const err = new Error('このパスキーに紐付けられているアカウントが見つかりません。先にログインして設定画面からパスキーを連携してください。');
      err.status = 404;
      err.code = 'user_not_found';
      throw err;
    }

    return existingUser;
  }
}

module.exports = PasskeyAuthProvider;
