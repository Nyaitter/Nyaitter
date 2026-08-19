'use strict';

const config = require('../config');

function createRateLimiter(options = {}) {
  const windowMs = options.windowMs || config.rateLimit?.general?.windowMs || 60000;
  const max = options.max || config.rateLimit?.general?.max || 1000;
  const keyGenerator = options.keyGenerator || ((req) => {
    if (req.user?.id) return `user:${req.user.id}`;
    return req.ip || 'unknown';
  });

  const store = new Map(); // key -> { count, resetTime }

  // Background pruning on unref interval prevents O(N) map traversal on request hot path
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (!entry || entry.resetTime <= now) store.delete(key);
    }
  }, Math.max(10000, windowMs));
  timer.unref();

  return function rateLimitMiddleware(req, res, next) {
    if (!config.rateLimit?.enabled) {
      return next();
    }

    const key = keyGenerator(req);
    const now = Date.now();
    let entry = store.get(key);

    if (!entry || now >= entry.resetTime) {
      entry = { count: 0, resetTime: now + windowMs };
      store.set(key, entry);
    }

    entry.count += 1;

    if (entry.count > max) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil((entry.resetTime - now) / 1000)));
      return res.status(429).json({
        error: 'Too Many Requests',
        message: 'リクエストが多すぎます。しばらく待ってから再度お試しください。',
      });
    }

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - entry.count));
    res.setHeader('X-RateLimit-Reset', Math.ceil(entry.resetTime / 1000));

    next();
  };
}

const generalLimiter = createRateLimiter();
const authLimiter = createRateLimiter({
  windowMs: config.rateLimit?.auth?.windowMs,
  max: config.rateLimit?.auth?.max || 20,
});

module.exports = {
  createRateLimiter,
  generalLimiter,
  authLimiter,
};
