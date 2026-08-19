'use strict';

const crypto = require('crypto');
const config = require('../config');

const REQUEST_ID_REGEX = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * Request ID middleware
 * Adds a unique request ID to every request (for tracing)
 */
function requestId(req, res, next) {
  const header = config.logging?.requestIdHeader || 'x-request-id';
  let id = req.headers[header] || req.headers[header.toLowerCase()];

  // 外部から渡されるトレースIDはログ・レスポンスヘッダーに反映されるため、
  // 可視ASCIIの短い値だけを許可してヘッダー／ログ注入を防ぐ。
  if (typeof id !== 'string' || !REQUEST_ID_REGEX.test(id)) {
    id = crypto.randomBytes(8).toString('hex');
  }

  req.id = id;
  res.setHeader(header, id);
  next();
}

/**
 * Apply trust proxy setting to the app
 * Must be called before any middleware that uses req.ip
 */
function applyTrustProxy(app) {
  if (config.server?.trustProxy) {
    app.set('trust proxy', true);
    console.log('[system] trust proxy enabled');
  }
}

/**
 * Enhanced request logger
 */
function requestLogger(req, res, next) {
  const start = Date.now();
  const { method } = req;
  const path = (req.originalUrl || req.url || '').split('?')[0];

  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? 'ERROR' : res.statusCode >= 400 ? 'WARN' : 'INFO';
    const reqPrefix = req.id ? `[${req.id}] ` : '';

    console.log(
      `${level} ${reqPrefix}${method} ${path} ${res.statusCode} ${duration}ms`
    );
  });

  next();
}

module.exports = {
  requestId,
  applyTrustProxy,
  requestLogger,
};