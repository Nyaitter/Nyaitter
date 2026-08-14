'use strict';

const crypto = require('crypto');

const fallbackSecret = crypto.randomBytes(32).toString('base64url');
const ipHashSecret = process.env.LOGIN_SECURITY_HMAC_SECRET
  || process.env.MULTI_ACCOUNT_COOKIE_SECRET
  || fallbackSecret;

function normalizeIp(ip) {
  const value = String(ip || '').trim();
  if (!value) return 'unknown';
  return value.startsWith('::ffff:') ? value.slice(7) : value;
}

function hashIp(ip) {
  return crypto
    .createHmac('sha256', ipHashSecret)
    .update(normalizeIp(ip))
    .digest('hex');
}

function maskIp(ip) {
  const normalized = normalizeIp(ip);
  if (normalized === 'unknown') return '不明なIPアドレス';
  if (normalized.includes('.')) {
    const parts = normalized.split('.');
    return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.*` : 'IPv4アドレス';
  }
  const parts = normalized.split(':').filter(Boolean);
  return parts.length > 0 ? `${parts.slice(0, 3).join(':')}::/48` : 'IPv6アドレス';
}

function normalizeUserAgent(userAgent) {
  return String(userAgent || '不明な端末').replace(/[\r\n\t]+/g, ' ').slice(0, 512);
}

function getRequestLoginMetadata(req) {
  const ip = req.ip || req.socket?.remoteAddress || '';
  return {
    ipHash: hashIp(ip),
    ipMasked: maskIp(ip),
    userAgent: normalizeUserAgent(req.get?.('user-agent') || req.headers?.['user-agent']),
  };
}

function generateApprovalPollToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashApprovalPollToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function isUnknownLoginProtectionEnabled(user) {
  return user?.settings?.reject_unknown_login !== false;
}

module.exports = {
  getRequestLoginMetadata,
  hashIp,
  maskIp,
  generateApprovalPollToken,
  hashApprovalPollToken,
  isUnknownLoginProtectionEnabled,
};
