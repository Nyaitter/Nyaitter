'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
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
  const value = config.server?.trustProxy;
  if (value) {
    // true = すべてのプロキシを信頼、数値 = 信頼するホップ数、
    // 文字列 = Express が解釈する 'loopback' やサブネットなど。
    app.set('trust proxy', value);
    console.log(`[system] trust proxy enabled (${typeof value === 'boolean' ? 'all' : value})`);
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

const zlib = require('zlib');

/**
 * High-performance built-in response compression middleware (gzip / deflate)
 * Reduces large JSON timeline/post payloads by up to 90%
 */
function httpCompression(req, res, next) {
  const acceptEncoding = req.headers['accept-encoding'] || '';
  if (!acceptEncoding || req.method === 'HEAD') {
    return next();
  }

  const useGzip = acceptEncoding.includes('gzip');
  const useDeflate = !useGzip && acceptEncoding.includes('deflate');
  if (!useGzip && !useDeflate) {
    return next();
  }

  const originalSend = res.send;
  res.send = function (body) {
    if (res.headersSent) {
      return originalSend.call(this, body);
    }

    // Only compress text and JSON payloads larger than 1KB
    const contentType = res.getHeader('Content-Type') || '';
    const isCompressible = typeof contentType === 'string' && (
      contentType.includes('application/json') ||
      contentType.includes('text/') ||
      contentType.includes('application/javascript')
    );

    let buffer;
    if (typeof body === 'string') {
      buffer = Buffer.from(body);
    } else if (Buffer.isBuffer(body)) {
      buffer = body;
    } else if (body && typeof body === 'object') {
      buffer = Buffer.from(JSON.stringify(body));
      if (!contentType) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }

    if (!buffer || buffer.length < 1024 || (contentType && !isCompressible)) {
      return originalSend.call(this, body);
    }

    const encoding = useGzip ? 'gzip' : 'deflate';
    const compressAsync = useGzip ? zlib.gzip : zlib.deflate;

    compressAsync(buffer, { level: 4 }, (err, compressed) => {
      if (err || !compressed || res.destroyed) {
        return originalSend.call(res, body);
      }
      res.setHeader('Content-Encoding', encoding);
      res.removeHeader('Content-Length');
      res.setHeader('Vary', 'Accept-Encoding');
      return originalSend.call(res, compressed);
    });
  };

  next();
}


// ---------------------------------------------------------------------------
// Compressed static file serving
// express.static streams files without compression. For text assets
// (JS/CSS/HTML/JSON/SVG) this middleware serves a brotli/gzip variant that is
// compressed once and kept in a bounded in-memory cache keyed by the file's
// mtime/size, so repeat requests cost no CPU. Headers (Cache-Control, ETag,
// conditional requests) mirror what the express.static mount behind it would
// produce via the shared setHeaders callback, so behavior is unchanged apart
// from the transfer encoding. Anything not handled here falls through to
// express.static untouched (ranges, non-text types, missing files, HEAD).
// ---------------------------------------------------------------------------
const COMPRESSED_STATIC_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};
const COMPRESSED_STATIC_CACHE_LIMIT = 64 * 1024 * 1024;

function compressedStatic(rootDir, setHeaders) {
  const root = path.resolve(rootDir);
  const cache = new Map();
  let cacheBytes = 0;

  function cacheGet(key) {
    const entry = cache.get(key);
    if (entry) {
      cache.delete(key);
      cache.set(key, entry);
    }
    return entry;
  }

  function cacheSet(key, entry) {
    const existing = cache.get(key);
    if (existing) cacheBytes -= existing.buffer.length;
    cache.set(key, entry);
    cacheBytes += entry.buffer.length;
    while (cacheBytes > COMPRESSED_STATIC_CACHE_LIMIT && cache.size > 1) {
      const oldestKey = cache.keys().next().value;
      const oldest = cache.get(oldestKey);
      cache.delete(oldestKey);
      if (oldest) cacheBytes -= oldest.buffer.length;
    }
  }

  return function compressedStaticMiddleware(req, res, next) {
    if (req.method !== 'GET') return next();
    if (req.headers.range) return next();
    const acceptEncoding = String(req.headers['accept-encoding'] || '');
    const encoding = acceptEncoding.includes('br') ? 'br' : acceptEncoding.includes('gzip') ? 'gzip' : null;
    if (!encoding) return next();

    let decodedPath;
    try {
      decodedPath = decodeURIComponent(req.path || '/');
    } catch (_) {
      return next();
    }
    if (decodedPath.split('/').some((segment) => segment.startsWith('.'))) return next();
    const ext = path.extname(decodedPath).toLowerCase();
    const contentType = COMPRESSED_STATIC_TYPES[ext];
    if (!contentType) return next();

    const filePath = path.join(root, decodedPath);
    if (!filePath.startsWith(root + path.sep)) return next();

    fs.stat(filePath, (statErr, stat) => {
      if (statErr || !stat.isFile()) return next();

      const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
      const applyHeaders = () => {
        if (typeof setHeaders === 'function') setHeaders(res, filePath);
        res.setHeader('Content-Type', contentType);
        res.setHeader('ETag', etag);
        res.setHeader('Last-Modified', stat.mtime.toUTCString());
        res.setHeader('Vary', 'Accept-Encoding');
      };

      const ifNoneMatch = req.headers['if-none-match'];
      if (ifNoneMatch && ifNoneMatch.split(',').map((v) => v.trim()).includes(etag)) {
        applyHeaders();
        res.status(304).end();
        return;
      }
      const ifModifiedSince = req.headers['if-modified-since'];
      if (ifModifiedSince && !ifNoneMatch) {
        const sinceMs = Date.parse(ifModifiedSince);
        if (!Number.isNaN(sinceMs) && Math.floor(stat.mtimeMs / 1000) <= Math.floor(sinceMs / 1000)) {
          applyHeaders();
          res.status(304).end();
          return;
        }
      }

      const key = `${filePath}|${encoding}`;
      const cached = cacheGet(key);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        applyHeaders();
        res.setHeader('Content-Encoding', encoding);
        res.setHeader('Content-Length', cached.buffer.length);
        res.end(cached.buffer);
        return;
      }

      fs.readFile(filePath, (readErr, data) => {
        if (readErr) return next();
        const done = (err, compressed) => {
          if (err || !compressed || compressed.length >= data.length) {
            // Not compressible in practice; let express.static handle it.
            return next();
          }
          cacheSet(key, { mtimeMs: stat.mtimeMs, size: stat.size, buffer: compressed });
          if (res.destroyed || res.headersSent) return;
          applyHeaders();
          res.setHeader('Content-Encoding', encoding);
          res.setHeader('Content-Length', compressed.length);
          res.end(compressed);
        };
        if (encoding === 'br') {
          zlib.brotliCompress(data, {
            params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 },
          }, done);
        } else {
          zlib.gzip(data, { level: 6 }, done);
        }
      });
    });
  };
}

module.exports = {
  requestId,
  applyTrustProxy,
  requestLogger,
  httpCompression,
  compressedStatic,
};