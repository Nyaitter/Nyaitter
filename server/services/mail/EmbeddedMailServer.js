'use strict';

const net = require('net');
const tls = require('tls');
const dns = require('dns').promises;
const os = require('os');
const EventEmitter = require('events');

/**
 * Embedded SMTP Mail Server for NyaitterServer.
 * Supports:
 * 1. Inbound SMTP Receiving on configured port (e.g. 2525 / 1025 / 25)
 * 2. Outbound Direct MX Delivery (resolves recipient domain MX records and sends via SMTP)
 * 3. Mail store / history buffer for viewing & testing
 */
class EmbeddedMailServer extends EventEmitter {
  constructor({ port = 2525, host = '0.0.0.0', hostname = 'localhost', maxHistory = 200 } = {}) {
    super();
    this.port = Number(port) || 2525;
    this.host = host || '0.0.0.0';
    this.hostname = hostname || os.hostname() || 'localhost';
    this.maxHistory = maxHistory;
    this.server = null;
    this.messages = [];
    this.activeSockets = new Set();
  }

  /**
   * Start the embedded SMTP server.
   * @returns {Promise<void>}
   */
  start() {
    return new Promise((resolve, reject) => {
      if (this.server) return resolve();

      this.server = net.createServer((socket) => this._handleConnection(socket));

      this.server.on('error', (err) => {
        console.error('[mail-server] Server error:', err.message);
        this.emit('error', err);
      });

      this.server.listen(this.port, this.host, () => {
        console.log(`[mail-server] Embedded SMTP Server listening on ${this.host}:${this.port} (hostname: ${this.hostname})`);
        resolve();
      });
    });
  }

  /**
   * Stop the embedded SMTP server.
   * @returns {Promise<void>}
   */
  close() {
    return new Promise((resolve) => {
      for (const socket of this.activeSockets) {
        try { socket.destroy(); } catch (_) {}
      }
      this.activeSockets.clear();

      if (this.server && this.server.listening) {
        this.server.close(() => {
          console.log('[mail-server] Embedded SMTP Server stopped.');
          this.server = null;
          resolve();
        });
      } else {
        this.server = null;
        resolve();
      }
    });
  }

  /**
   * Get all captured messages in history.
   * @returns {object[]}
   */
  getMessages() {
    return [...this.messages];
  }

  /**
   * Clear captured message history.
   */
  clearMessages() {
    this.messages = [];
  }

  /**
   * Record a sent or received email in history.
   * @param {object} message
   */
  recordMessage(message) {
    const record = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      receivedAt: new Date().toISOString(),
      ...message,
    };
    this.messages.unshift(record);
    if (this.messages.length > this.maxHistory) {
      this.messages.length = this.maxHistory;
    }
    this.emit('mail', record);
    return record;
  }

  /**
   * Deliver email directly to recipient domain's MX servers.
   * @param {object} param0
   * @returns {Promise<object>}
   */
  async deliverDirect({ to, from, subject, text, html }) {
    const recipient = String(to || '').trim().toLowerCase();
    const domain = recipient.split('@')[1];
    if (!domain) throw new Error(`Invalid recipient email: ${recipient}`);

    const sender = String(from || `noreply@${this.hostname}`).trim();

    // 1. Resolve MX records
    let mxRecords = [];
    try {
      mxRecords = await dns.resolveMx(domain);
      mxRecords.sort((a, b) => a.priority - b.priority);
    } catch (dnsErr) {
      // Fallback to domain A record if no MX record
      mxRecords = [{ exchange: domain, priority: 0 }];
    }

    if (mxRecords.length === 0) {
      throw new Error(`No mail server found for domain ${domain}`);
    }

    let lastError = null;
    for (const mx of mxRecords) {
      try {
        const result = await this._sendSmtpTransaction(mx.exchange, 25, {
          to: recipient,
          from: sender,
          subject,
          text,
          html,
        });

        this.recordMessage({
          direction: 'outbound',
          to: recipient,
          from: sender,
          subject,
          text,
          mxHost: mx.exchange,
          status: 'delivered',
        });

        return { success: true, mxHost: mx.exchange, result };
      } catch (err) {
        lastError = err;
        console.warn(`[mail-server] MX delivery to ${mx.exchange} failed: ${err.message}. Trying next MX...`);
      }
    }

    throw lastError || new Error(`Failed to deliver email to ${domain}`);
  }

  _sendSmtpTransaction(mxHost, port, { to, from, subject, text }) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: mxHost, port: port || 25 }, () => {
        let step = 0;
        let buffer = '';

        socket.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\r\n');
          buffer = lines.pop();

          for (const line of lines) {
            const code = parseInt(line.slice(0, 3), 10);
            if (line.charAt(3) === '-') continue;

            if (step === 0 && code === 220) {
              step++;
              socket.write(`EHLO ${this.hostname}\r\n`);
            } else if (step === 1 && (code === 250 || code === 220)) {
              step++;
              socket.write(`MAIL FROM:<${from}>\r\n`);
            } else if (step === 2 && code === 250) {
              step++;
              socket.write(`RCPT TO:<${to}>\r\n`);
            } else if (step === 3 && code === 250) {
              step++;
              socket.write('DATA\r\n');
            } else if (step === 4 && code === 354) {
              step++;
              const msg = [
                `From: ${from}`,
                `To: ${to}`,
                `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
                `Date: ${new Date().toUTCString()}`,
                'MIME-Version: 1.0',
                'Content-Type: text/plain; charset=UTF-8',
                '',
                text || '',
                '.',
              ].join('\r\n');
              socket.write(`${msg}\r\n`);
            } else if (step === 5 && code === 250) {
              step++;
              socket.write('QUIT\r\n');
              socket.end();
              resolve({ code, line });
            } else if (code >= 400) {
              socket.destroy();
              reject(new Error(`SMTP Error (${code}): ${line}`));
            }
          }
        });
      });

      socket.setTimeout(15000, () => {
        socket.destroy();
        reject(new Error('Connection to MX server timed out'));
      });

      socket.on('error', (err) => reject(err));
    });
  }

  _handleConnection(socket) {
    this.activeSockets.add(socket);
    socket.setEncoding('utf8');

    let state = 'COMMAND'; // COMMAND | DATA | AUTH_USER | AUTH_PASS
    let mailFrom = '';
    const rcptTo = [];
    let dataBuffer = '';
    let buffer = '';

    socket.write(`220 ${this.hostname} Nyaitter Embedded ESMTP Server ready\r\n`);

    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\r\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (state === 'DATA') {
          if (line === '.') {
            state = 'COMMAND';
            const parsed = this._parseRawEmail(dataBuffer);
            const recorded = this.recordMessage({
              direction: 'inbound',
              from: mailFrom,
              to: [...rcptTo],
              subject: parsed.subject,
              headers: parsed.headers,
              text: parsed.text,
              raw: dataBuffer,
            });
            console.log(`[mail-server] Received email for ${rcptTo.join(', ')}: ${parsed.subject}`);
            dataBuffer = '';
            mailFrom = '';
            rcptTo.length = 0;
            socket.write(`250 2.0.0 Ok: queued as ${recorded.id}\r\n`);
          } else {
            const unescaped = line.startsWith('..') ? line.slice(1) : line;
            dataBuffer += unescaped + '\n';
          }
          continue;
        }

        if (state === 'AUTH_USER') {
          state = 'AUTH_PASS';
          socket.write('334 UGFzc3dvcmQ6\r\n'); // Base64: Password:
          continue;
        }

        if (state === 'AUTH_PASS') {
          state = 'COMMAND';
          socket.write('235 2.7.0 Authentication successful\r\n');
          continue;
        }

        const cmd = line.trim().toUpperCase();
        if (cmd.startsWith('HELO') || cmd.startsWith('EHLO')) {
          socket.write(`250-${this.hostname}\r\n250-SIZE 20480000\r\n250-8BITMIME\r\n250-AUTH LOGIN PLAIN\r\n250 OK\r\n`);
        } else if (cmd.startsWith('MAIL FROM:')) {
          const match = /<([^>]+)>/.exec(line) || /MAIL FROM:\s*(\S+)/i.exec(line);
          mailFrom = match ? match[1].trim() : '';
          rcptTo.length = 0;
          socket.write('250 2.1.0 Ok\r\n');
        } else if (cmd.startsWith('RCPT TO:')) {
          const match = /<([^>]+)>/.exec(line) || /RCPT TO:\s*(\S+)/i.exec(line);
          if (match) rcptTo.push(match[1].trim());
          socket.write('250 2.1.5 Ok\r\n');
        } else if (cmd === 'DATA') {
          if (rcptTo.length === 0) {
            socket.write('503 5.5.1 Error: need RCPT command\r\n');
          } else {
            state = 'DATA';
            dataBuffer = '';
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          }
        } else if (cmd === 'RSET') {
          mailFrom = '';
          rcptTo.length = 0;
          dataBuffer = '';
          state = 'COMMAND';
          socket.write('250 2.0.0 Ok\r\n');
        } else if (cmd === 'NOOP') {
          socket.write('250 2.0.0 Ok\r\n');
        } else if (cmd === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
        } else if (cmd === 'AUTH LOGIN') {
          state = 'AUTH_USER';
          socket.write('334 VXNlcm5hbWU6\r\n'); // Base64: Username:
        } else if (cmd.startsWith('AUTH PLAIN')) {
          socket.write('235 2.7.0 Authentication successful\r\n');
        } else {
          socket.write('502 5.5.2 Command not implemented\r\n');
        }
      }
    });

    socket.on('close', () => {
      this.activeSockets.delete(socket);
    });

    socket.on('error', () => {
      this.activeSockets.delete(socket);
    });
  }

  _parseRawEmail(raw) {
    const parts = raw.split(/\r?\n\r?\n/);
    const headerBlock = parts[0] || '';
    const body = parts.slice(1).join('\n');

    const headers = {};
    const headerLines = headerBlock.split(/\r?\n/);
    for (const line of headerLines) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        const key = line.slice(0, idx).trim().toLowerCase();
        const val = line.slice(idx + 1).trim();
        headers[key] = val;
      }
    }

    let subject = headers['subject'] || '(No Subject)';
    if (subject.startsWith('=?UTF-8?B?')) {
      try {
        const b64 = subject.slice(10, -2);
        subject = Buffer.from(b64, 'base64').toString('utf8');
      } catch (_) {}
    }

    return { headers, subject, text: body.trim() };
  }
}

let globalEmbeddedMailServer = null;

function getEmbeddedMailServer(options) {
  if (!globalEmbeddedMailServer && options) {
    globalEmbeddedMailServer = new EmbeddedMailServer(options);
  }
  return globalEmbeddedMailServer;
}

module.exports = {
  EmbeddedMailServer,
  getEmbeddedMailServer,
};
