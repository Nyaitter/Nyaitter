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
   * Check if new account registration is permitted for this auth provider.
   * @param {object} config - Server config
   * @param {object} [req] - Express request
   * @returns {boolean}
   */
  isSignupAllowed(config, req = null) {
    const methodConfig = config?.auth?.methods?.[this.name] || config?.auth?.[this.name] || {};
    if (methodConfig.allowSignup !== undefined) {
      return Boolean(methodConfig.allowSignup);
    }
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
      allowSignup: this.isSignupAllowed(config, req),
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

    // 2. Check if new account creation is allowed for this provider
    const cfg = context.config || {};
    if (!this.isSignupAllowed(cfg, context.req)) {
      const err = new Error('この認証方式での新規アカウント作成は無効化されています。');
      err.status = 403;
      err.code = 'signup_disabled';
      throw err;
    }

    // 3. Resolve username for new user account
    let finalUserName = '';
    const isPublicHandleProvider = providerName === 'scratch' || providerName === 'nyaitter';

    if (isPublicHandleProvider) {
      finalUserName = String(identity.name || identity.scid || '').trim();
    } else {
      // For email, passkey, etc., require explicit user-provided username to protect privacy
      const providedName = String(context.payload?.name || context.payload?.username || context.name || identity.name || '').trim();
      const isFallbackOrEmail = !providedName
        || providedName === String(identity.externalId)
        || providedName.includes('@')
        || providedName === `${this.displayName}_User`
        || providedName === 'Passkey User';

      if (isFallbackOrEmail) {
        const err = new Error('ユーザー名を設定してください。');
        err.status = 400;
        err.code = 'username_required';
        throw err;
      }
      finalUserName = providedName;
    }

    const maxNameLen = cfg.limits?.userNameLength?.max || 50;
    if (finalUserName.length > maxNameLen) {
      const err = new Error(`ユーザー名は${maxNameLen}文字以内で入力してください。`);
      err.status = 400;
      throw err;
    }

    // 4. Create new user
    const newUser = await db.createUser({
      scid: identity.scid || null,
      name: finalUserName,
      auth_provider: providerName,
      external_id: identity.externalId != null ? String(identity.externalId) : null,
      provider_domain: identity.providerDomain || null,
      external_profile: profile || null,
    });

    // 5. Link initial auth provider
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
