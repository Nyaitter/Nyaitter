'use strict';

/**
 * Base abstract class for Authentication Providers.
 * Any new authentication method (Scratch, Passkey, OAuth, Email, etc.)
 * can implement this class and register with AuthProviderRegistry.
 */
class BaseAuthProvider {
  /**
   * Unique name of the auth provider (e.g. 'scratch', 'passkey', 'oauth')
   * @type {string}
   */
  get name() {
    throw new Error('AuthProvider must define a name getter');
  }

  /**
   * Human-readable display label (e.g. 'Scratch', 'パスキー')
   * @type {string}
   */
  get displayName() {
    return this.name;
  }

  /**
   * Check if this auth provider is enabled in server configuration.
   * @param {object} config - Server config
   * @param {object} [req] - Express request
   * @returns {boolean}
   */
  isEnabled(config, req = null) {
    return true;
  }

  /**
   * Get public configuration / metadata exposed to clients.
   * @param {object} config
   * @param {object} [req]
   * @returns {object}
   */
  getPublicConfig(config, req = null) {
    return {
      name: this.name,
      displayName: this.displayName,
      enabled: this.isEnabled(config, req),
    };
  }

  /**
   * Phase 1: Initiate authentication (issue challenge, generate code, create auth URL, etc.)
   * @param {import('express').Request} req
   * @param {object} payload
   * @param {object} context
   * @returns {Promise<object>}
   */
  async initiate(req, payload, context) {
    throw new Error(`Initiate not implemented for provider ${this.name}`);
  }

  /**
   * Phase 2: Verify authentication credentials/response.
   * Must return an object with:
   * {
   *   success: true,
   *   identity: {
   *     authProvider: string,
   *     externalId?: string|number,
   *     scid?: string,
   *     name?: string,
   *     providerDomain?: string,
   *   },
   *   profile?: object,
   *   credentials?: object,
   * }
   * @param {import('express').Request} req
   * @param {object} payload
   * @param {object} context
   * @returns {Promise<object>}
   */
  async verify(req, payload, context) {
    throw new Error(`Verify not implemented for provider ${this.name}`);
  }

  /**
   * Resolve existing user or create a new user account for verified identity.
   * @param {object} db - Database adapter
   * @param {object} authResult - Verified authentication result
   * @param {object} context - Execution context
   * @returns {Promise<object>} User record
   */
  async resolveUser(db, authResult, context = {}) {
    const { identity, profile } = authResult;
    if (!identity) {
      throw new Error('Authentication result missing identity');
    }

    const providerName = identity.authProvider || this.name;
    const providerUserId = identity.externalId || identity.scid;

    // 1. Try finding by linked auth provider
    if (typeof db.findUserByAuthProvider === 'function') {
      const existingUser = await db.findUserByAuthProvider(providerName, providerUserId);
      if (existingUser) return existingUser;
    } else {
      if (identity.scid) {
        const existingUser = await db.getUserByScid(identity.scid);
        if (existingUser) return existingUser;
      }
      if (identity.externalId != null && typeof db.getUserByExternalId === 'function') {
        const existingUser = await db.getUserByExternalId(providerName, identity.externalId);
        if (existingUser) return existingUser;
      }
    }

    // 2. Create new user
    const newUser = await db.createUser({
      scid: identity.scid || null,
      name: identity.name || identity.scid || `${this.displayName}_User`,
      auth_provider: providerName,
      external_id: identity.externalId != null ? String(identity.externalId) : null,
      provider_domain: identity.providerDomain || null,
      external_profile: profile || null,
    });

    // 3. Link initial auth provider
    if (typeof db.linkAuthProvider === 'function') {
      try {
        await db.linkAuthProvider(newUser.id, providerName, providerUserId, profile || {});
      } catch (e) {
        // Ignore duplicate on initial creation
      }
    }

    return newUser;
  }
}

module.exports = BaseAuthProvider;
