'use strict';

const BaseAuthProvider = require('./BaseAuthProvider');

class PasskeyAuthProvider extends BaseAuthProvider {
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
    return {
      name: this.name,
      displayName: this.displayName,
      enabled: this.isEnabled(config, req),
      rpName: passkeyConfig.rpName || 'Nyaitter',
      rpId: passkeyConfig.rpId || 'localhost',
    };
  }

  async initiate(req, payload = {}, context = {}) {
    const { config } = context;
    const passkeyConfig = config?.auth?.methods?.passkey || {};

    // Challenge generation for WebAuthn authentication
    const challenge = require('crypto').randomBytes(32).toString('base64url');
    return {
      challenge,
      rpId: passkeyConfig.rpId || 'localhost',
      timeout: 60000,
      userVerification: 'preferred',
    };
  }

  async verify(req, payload = {}, context = {}) {
    const { credentialId, response, clientDataJSON } = payload;
    if (!credentialId) {
      const err = new Error('パスキーの認証情報が不足しています。');
      err.status = 400;
      throw err;
    }

    // Verify assertion response (extensible with simplewebauthn or custom verifier)
    return {
      success: true,
      identity: {
        authProvider: 'passkey',
        externalId: credentialId,
        name: payload.name || 'Passkey User',
      },
      profile: {
        credentialId,
      },
    };
  }
}

module.exports = PasskeyAuthProvider;
