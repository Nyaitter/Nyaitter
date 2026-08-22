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
      allowSignup: this.isSignupAllowed(config, req),
      codeLength: emailConfig.codeLength || 6,
      turnstileRequired: Boolean(config?.turnstile?.enabled),
    };
  }

  async initiate(req, payload = {}, context = {}) {
    const { email, turnstile_token } = payload;
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
      const turnstileResult = await verifyTurnstile(turnstile_token);
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
    const result = this.emailService.verifyCode(normalizedEmail, code, { consume: false });
    if (!result.success) {
      const err = new Error(result.reason || '認証コードの検証に失敗しました。');
      err.status = 400;
      throw err;
    }

    const providedName = payload.name ? String(payload.name).trim() : null;

    return {
      success: true,
      identity: {
        authProvider: 'email',
        externalId: normalizedEmail,
        name: providedName,
      },
      profile: {
        email: normalizedEmail,
      },
    };
  }

  async resolveUser(db, authResult, context = {}) {
    const user = await super.resolveUser(db, authResult, context);
    if (authResult?.identity?.externalId) {
      this.emailService.consumeCode(authResult.identity.externalId);
    }
    return user;
  }
}

module.exports = EmailAuthProvider;
