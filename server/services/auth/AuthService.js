'use strict';

const { defaultRegistry } = require('./AuthProviderRegistry');

class AuthService {
  constructor({ registry = defaultRegistry, config } = {}) {
    this.registry = registry;
    this.config = config;
  }

  /**
   * Get all enabled auth providers config for public clients.
   * @param {import('express').Request} req
   * @returns {object[]}
   */
  getPublicProviders(req = null) {
    return this.registry.getPublicProvidersConfig(this.config, req);
  }

  /**
   * Initiate authentication with the specified provider.
   * @param {string} providerName
   * @param {import('express').Request} req
   * @param {object} payload
   * @param {object} context
   * @returns {Promise<object>}
   */
  async initiate(providerName, req, payload = {}, context = {}) {
    const provider = this.registry.getProvider(providerName);
    if (!provider) {
      const err = new Error(`未対応の認証方式です: ${providerName}`);
      err.status = 400;
      err.code = 'unsupported_auth_provider';
      throw err;
    }

    const cfg = context.config || this.config;
    if (!provider.isEnabled(cfg, req)) {
      const err = new Error(`この認証方式は無効化されています: ${providerName}`);
      err.status = 403;
      err.code = 'auth_provider_disabled';
      throw err;
    }

    return await provider.initiate(req, payload, {
      config: cfg,
      ...context,
    });
  }

  /**
   * Verify authentication with the specified provider and resolve user.
   * @param {string} providerName
   * @param {import('express').Request} req
   * @param {object} payload
   * @param {object} context
   * @returns {Promise<{ user: object, authResult: object }>}
   */
  async verifyAndResolveUser(providerName, req, payload = {}, context = {}) {
    const provider = this.registry.getProvider(providerName);
    if (!provider) {
      const err = new Error(`未対応の認証方式です: ${providerName}`);
      err.status = 400;
      err.code = 'unsupported_auth_provider';
      throw err;
    }

    const cfg = context.config || this.config;
    if (!provider.isEnabled(cfg, req)) {
      const err = new Error(`この認証方式は無効化されています: ${providerName}`);
      err.status = 403;
      err.code = 'auth_provider_disabled';
      throw err;
    }

    const authResult = await provider.verify(req, payload, {
      config: cfg,
      ...context,
    });

    if (!authResult || authResult.success !== true) {
      const err = new Error(authResult?.error || '認証に失敗しました。');
      err.status = 400;
      throw err;
    }

    const db = context.db || req.app?.locals?.dbAdapter;
    if (!db) {
      throw new Error('Database adapter is required to resolve user');
    }

    const user = await provider.resolveUser(db, authResult, {
      config: cfg,
      ...context,
    });

    return { user, authResult };
  }

  /**
   * Get all linked authentication providers for a user.
   * @param {number|string} userId
   * @param {object} db
   * @returns {Promise<object[]>}
   */
  async getLinkedProviders(userId, db) {
    if (!db || typeof db.getUserAuthProviders !== 'function') {
      return [];
    }
    const providers = await db.getUserAuthProviders(userId);
    return providers.map((p) => {
      const providerInstance = this.registry.getProvider(p.provider);
      return {
        id: p.id,
        provider: p.provider,
        providerDisplayName: providerInstance?.displayName || p.provider,
        providerUserId: p.providerUserId,
        isPrimary: Boolean(p.isPrimary),
        linkedAt: p.createdAt || p.created_at,
      };
    });
  }

  /**
   * Link an additional authentication provider to an existing logged-in account.
   * @param {string} providerName
   * @param {number|string} userId
   * @param {import('express').Request} req
   * @param {object} payload
   * @param {object} context
   * @returns {Promise<object>}
   */
  async linkProvider(providerName, userId, req, payload = {}, context = {}) {
    const provider = this.registry.getProvider(providerName);
    if (!provider) {
      const err = new Error(`未対応の認証方式です: ${providerName}`);
      err.status = 400;
      err.code = 'unsupported_auth_provider';
      throw err;
    }

    const cfg = context.config || this.config;
    if (!provider.isEnabled(cfg, req)) {
      const err = new Error(`この認証方式は無効化されています: ${providerName}`);
      err.status = 403;
      err.code = 'auth_provider_disabled';
      throw err;
    }

    const authResult = await provider.verify(req, payload, {
      config: cfg,
      ...context,
    });

    if (!authResult || authResult.success !== true) {
      const err = new Error(authResult?.error || '認証に失敗しました。');
      err.status = 400;
      throw err;
    }

    const db = context.db || req.app?.locals?.dbAdapter;
    if (!db || typeof db.linkAuthProvider !== 'function') {
      throw new Error('Database adapter does not support linking auth providers');
    }

    const { identity, profile } = authResult;
    const providerUserId = identity.externalId || identity.scid;

    const record = await db.linkAuthProvider(
      userId,
      identity.authProvider || providerName,
      providerUserId,
      profile || {},
    );

    return {
      success: true,
      linkedProvider: {
        id: record.id,
        provider: record.provider,
        providerDisplayName: provider.displayName,
        providerUserId: record.providerUserId,
        linkedAt: record.createdAt || record.created_at,
      },
    };
  }

  /**
   * Unlink an authentication provider from an account.
   * @param {string} providerName
   * @param {number|string} userId
   * @param {object} db
   * @param {string|null} [providerUserId]
   * @returns {Promise<object>}
   */
  async unlinkProvider(providerName, userId, db, providerUserId = null) {
    if (!db || typeof db.unlinkAuthProvider !== 'function') {
      throw new Error('Database adapter does not support unlinking auth providers');
    }

    return await db.unlinkAuthProvider(userId, providerName, providerUserId);
  }
}

module.exports = AuthService;
