const config = require('../config');
const crypto = require('crypto');

/**
 * Request ID middleware
 * Adds a unique request ID to every request (for tracing)
 */
function requestId(req, res, next) {
  const header = config.logging.requestIdHeader || 'x-request-id';
  let id = req.headers[header] || req.headers[header.toLowerCase()];

  if (!id) {
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
  if (config.server.trustProxy) {
    app.set('trust proxy', true);
    console.log('[system] trust proxy enabled');
  }
}

/**
 * Enhanced request logger (replaces the simple one in index.js)
 */
function requestLogger(req, res, next) {
  const start = Date.now();
  const { method, originalUrl } = req;
  const requestId = req.id ? `[${req.id}] ` : '';

  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? 'ERROR' : res.statusCode >= 400 ? 'WARN' : 'INFO';

    console.log(
      `${level} ${requestId}${method} ${originalUrl} ${res.statusCode} ${duration}ms`
    );
  });

  next();
}

module.exports = {
  requestId,
  applyTrustProxy,
  requestLogger,
};