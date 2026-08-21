'use strict';

const BaseAuthProvider = require('./BaseAuthProvider');
const EmailService = require('../EmailService');

class EmailAuthProvider extends BaseAuthProvider {
  constructor() {
    super();
    this.emailService = new EmailService();
  }

  get name() {
    return 'email';
  }

  get displayName() {
    return 'メールアドレス';
  }

  isEnabled(config) {
    return Boolean(config?.auth?.methods?.email?.enabled);
  }

  getPublicConfig(config, req = null) {
    const emailConfig = config?.auth?.methods?.email || {};
    return {
      name: this.name,
      displayName: this.displayName,
      enabled: this.isEnabled(config, req),
      codeLength: emailConfig.codeLength || 6,
      turnstileRequired: Boolean(config?.turnstile?.enabled),
    };
  }

  async initiate(req, payload = {}, context = {}) {
    const { email, turnstileToken } = payload;
    const { config, verifyTurnstile } = context;

    if (!email || typeof email !== 'string') {
      const err = new Error('メールアドレスを入力してください。');
      err.status = 400;
      throw err;
    }

    if (!this.emailService.isValidEmail(email)) {
      const err = new Error('メールアドレスの形式が正しくありません。');
      err.status = 400;
      throw err;
    }

    if (config?.turnstile?.enabled && typeof verifyTurnstile === 'function') {
      const turnstileResult = await verifyTurnstile(turnstileToken);
      if (turnstileResult.success !== true) {
        const err = new Error('Turnstileチャレンジを完了してください。');
        err.status = 403;
        err.code = 'turnstile_required';
        throw err;
      }
    }

    const emailConfig = config?.auth?.methods?.email || {};
    const expiryMinutes = emailConfig.codeExpiryMinutes || 10;
    const codeLength = emailConfig.codeLength || 6;

    this.emailService.config = config;
    const { code, expiresAt, expiresIn } = this.emailService.generateCode(email, {
      expiryMinutes,
      codeLength,
    });

    await this.emailService.sendVerificationEmail(email, code, {
      siteName: config?.siteName || 'Nyaitter',
    });

    return {
      success: true,
      email: this.emailService.normalizeEmail(email),
      expiresAt,
      expiresIn,
      message: '認証コードをメールに送信しました。',
    };
  }

  async verify(req, payload = {}, context = {}) {
    const { email, code } = payload;
    if (!email || !code) {
      const err = new Error('メールアドレスと認証コードを入力してください。');
      err.status = 400;
      throw err;
    }

    const normalizedEmail = this.emailService.normalizeEmail(email);
    const result = this.emailService.verifyCode(normalizedEmail, code);
    if (!result.success) {
      const err = new Error(result.reason || '認証コードの検証に失敗しました。');
      err.status = 400;
      throw err;
    }

    const defaultName = normalizedEmail.split('@')[0].slice(0, 50);

    return {
      success: true,
      identity: {
        authProvider: 'email',
        externalId: normalizedEmail,
        name: defaultName,
      },
      profile: {
        email: normalizedEmail,
      },
    };
  }

  async resolveUser(db, authResult, context = {}) {
    const { identity, profile } = authResult;
    const email = identity.externalId;

    let user = null;
    if (typeof db.getUserByExternalId === 'function') {
      user = await db.getUserByExternalId('email', email);
    }

    if (!user) {
      user = await db.createUser({
        name: identity.name || email.split('@')[0],
        auth_provider: 'email',
        external_id: email,
        external_profile: profile || { email },
      });
    }

    return user;
  }
}

module.exports = EmailAuthProvider;
