'use strict';

const crypto = require('crypto');
const net = require('net');
const tls = require('tls');

const { getEmbeddedMailServer } = require('../mail/EmbeddedMailServer');

class EmailService {
  constructor({ config = {} } = {}) {
    this.config = config;
    this.pendingCodes = new Map(); // normalizedEmail -> { codeHash, expiresAt, attempts, lastSentAt }
    this.cleanupInterval = setInterval(() => this.cleanupExpired(), 60000);
    if (this.cleanupInterval.unref) this.cleanupInterval.unref();
  }

  normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
  }

  isValidEmail(email) {
    const normalized = this.normalizeEmail(email);
    return normalized.length >= 3 && normalized.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
  }

  hashCode(code, email) {
    return crypto
      .createHash('sha256')
      .update(`${this.normalizeEmail(email)}:${String(code).trim()}`)
      .digest('hex');
  }

  cleanupExpired() {
    const now = Date.now();
    for (const [email, record] of this.pendingCodes.entries()) {
      if (record.expiresAt <= now) {
        this.pendingCodes.delete(email);
      }
    }
  }

  generateCode(email, { expiryMinutes = 10, codeLength = 6 } = {}) {
    const normalized = this.normalizeEmail(email);
    const now = Date.now();

    const existing = this.pendingCodes.get(normalized);
    if (existing && existing.lastSentAt && now - existing.lastSentAt < 60000) {
      const remainingSeconds = Math.ceil((60000 - (now - existing.lastSentAt)) / 1000);
      const err = new Error(`認証コードを再送信するには、あと${remainingSeconds}秒お待ちください。`);
      err.status = 429;
      err.code = 'rate_limit_exceeded';
      throw err;
    }

    // Generate random digits
    let code = '';
    const digits = '0123456789';
    const randomBytes = crypto.randomBytes(codeLength);
    for (let i = 0; i < codeLength; i++) {
      code += digits[randomBytes[i] % digits.length];
    }

    const expiresAt = now + expiryMinutes * 60 * 1000;
    this.pendingCodes.set(normalized, {
      codeHash: this.hashCode(code, normalized),
      expiresAt,
      attempts: 0,
      lastSentAt: now,
    });

    return { code, expiresAt, expiresIn: expiryMinutes * 60 };
  }

  verifyCode(email, inputCode, { consume = true } = {}) {
    const normalized = this.normalizeEmail(email);
    const record = this.pendingCodes.get(normalized);

    if (!record) {
      return { success: false, reason: '認証コードが発行されていないか、有効期限が切れています。最初からやり直してください。' };
    }

    if (Date.now() > record.expiresAt) {
      this.pendingCodes.delete(normalized);
      return { success: false, reason: '認証コードの有効期限が切れました。再発行してください。' };
    }

    record.attempts += 1;
    if (record.attempts > 5) {
      this.pendingCodes.delete(normalized);
      return { success: false, reason: '認証コードの試行回数を超過しました。再度発行してください。' };
    }

    const inputHash = this.hashCode(inputCode, normalized);
    if (!crypto.timingSafeEqual(Buffer.from(record.codeHash), Buffer.from(inputHash))) {
      return { success: false, reason: '認証コードが一致しません。正しく入力してください。' };
    }

    if (consume) {
      this.pendingCodes.delete(normalized);
    }
    return { success: true };
  }

  consumeCode(email) {
    const normalized = this.normalizeEmail(email);
    this.pendingCodes.delete(normalized);
  }

  async sendVerificationEmail(email, code, { siteName = 'Nyaitter' } = {}) {
    const normalized = this.normalizeEmail(email);
    const smtp = this.config?.auth?.methods?.email?.smtp || {};

    const subject = `【${siteName}】ログイン認証コード`;
    const textBody = [
      `${siteName} をご利用いただきありがとうございます。`,
      '',
      'ログイン認証コードは以下の通りです:',
      '',
      `  ${code}`,
      '',
      '※ この認証コードの有効期限は10分間です。',
      '※ 本メールに心当たりがない場合は、破棄してください。',
    ].join('\n');

    const embeddedServerConfig = this.config?.auth?.methods?.email?.embeddedServer || {};
    const embeddedMailServer = getEmbeddedMailServer(embeddedServerConfig);

    // If SMTP host is configured, attempt sending via SMTP
    if (smtp.host && smtp.user) {
      try {
        await this._sendViaSmtp(smtp, {
          to: normalized,
          from: smtp.from || `noreply@${smtp.host}`,
          subject,
          text: textBody,
        });
        console.log(`[auth:email] 認証コードを送信しました: ${normalized}`);
        return true;
      } catch (err) {
        console.error('[auth:email] SMTP送信エラー:', err.message);
        throw new Error('認証メールの送信に失敗しました。サーバーのメール設定をご確認ください。');
      }
    }

    // Direct MX Delivery using Embedded Mail Engine
    if (embeddedServerConfig.directDelivery && embeddedMailServer) {
      try {
        await embeddedMailServer.deliverDirect({
          to: normalized,
          from: smtp.from || `noreply@${embeddedServerConfig.hostname || 'localhost'}`,
          subject,
          text: textBody,
        });
        console.log(`[auth:email] MX直接配信完了: ${normalized}`);
        return true;
      } catch (err) {
        console.warn(`[auth:email] MX直接配信失敗 (${err.message}). コンソール出力にフォールバックします。`);
      }
    }

    if (embeddedMailServer) {
      embeddedMailServer.recordMessage({
        direction: 'outbound',
        to: normalized,
        from: smtp.from || 'noreply@localhost',
        subject,
        text: textBody,
      });
    }

    // Fallback: in development or when SMTP is not configured, output to console
    console.log('================================================================');
    console.log(`[auth:email] 認証メール送信 (ローカル/開発モード)`);
    console.log(`To: ${normalized}`);
    console.log(`Subject: ${subject}`);
    console.log(`Verification Code: ${code}`);
    console.log('================================================================');
    return true;
  }

  _sendViaSmtp(smtp, { to, from, subject, text }) {
    return new Promise((resolve, reject) => {
      const port = Number(smtp.port) || (smtp.secure ? 465 : 587);
      const isTls = Boolean(smtp.secure || port === 465);

      const connectFn = isTls ? tls.connect : net.connect;
      const socket = connectFn({ host: smtp.host, port }, () => {
        let step = 0;
        let buffer = '';

        socket.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\r\n');
          buffer = lines.pop(); // keep partial line

          for (const line of lines) {
            const code = parseInt(line.slice(0, 3), 10);
            if (line.charAt(3) === '-') continue; // multiline reply

            if (step === 0 && code === 220) {
              step++;
              socket.write(`EHLO ${smtp.host}\r\n`);
            } else if (step === 1 && code === 250) {
              step++;
              socket.write('AUTH LOGIN\r\n');
            } else if (step === 2 && code === 334) {
              step++;
              socket.write(`${Buffer.from(smtp.user).toString('base64')}\r\n`);
            } else if (step === 3 && code === 334) {
              step++;
              socket.write(`${Buffer.from(smtp.pass || '').toString('base64')}\r\n`);
            } else if (step === 4 && code === 235) {
              step++;
              socket.write(`MAIL FROM:<${from}>\r\n`);
            } else if (step === 5 && code === 250) {
              step++;
              socket.write(`RCPT TO:<${to}>\r\n`);
            } else if (step === 6 && code === 250) {
              step++;
              socket.write('DATA\r\n');
            } else if (step === 7 && code === 354) {
              step++;
              const msg = [
                `From: ${from}`,
                `To: ${to}`,
                `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
                'MIME-Version: 1.0',
                'Content-Type: text/plain; charset=UTF-8',
                '',
                text,
                '.',
              ].join('\r\n');
              socket.write(`${msg}\r\n`);
            } else if (step === 8 && code === 250) {
              step++;
              socket.write('QUIT\r\n');
              socket.end();
              resolve();
            } else if (code >= 400) {
              socket.destroy();
              reject(new Error(`SMTP Error (${code}): ${line}`));
            }
          }
        });
      });

      socket.on('error', (err) => reject(err));
      socket.setTimeout(10000, () => {
        socket.destroy();
        reject(new Error('SMTP connection timeout'));
      });
    });
  }
}

module.exports = EmailService;
