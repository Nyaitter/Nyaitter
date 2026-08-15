const config = require('../config');

const store = new Map(); // key -> { count, resetTime }

function createRateLimiter(options = {}) {
  const windowMs = options.windowMs || config.rateLimit.windowMs || 60000;
  const max = options.max || config.rateLimit.max || 1000;
  const keyGenerator = options.keyGenerator || ((req) => {
    if (req.user?.id) {
      return `user:${req.user.id}`;
    }
    return req.ip || 'unknown';
  });

  return function rateLimitMiddleware(req, res, next) {
    if (!config.rateLimit.enabled) {
      return next();
    }

    const key = keyGenerator(req);
    const now = Date.now();
    let entry = store.get(key);

    if (!entry || now > entry.resetTime) {
      entry = { count: 0, resetTime: now + windowMs };
      store.set(key, entry);
    }

    entry.count++;

    if (entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((entry.resetTime - now) / 1000));
      return res.status(429).json({
        error: 'Too Many Requests',
        message: 'リクエストが多すぎます。しばらく待ってから再度お試しください。',
      });
    }

    // Add rate limit headers (good practice)
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - entry.count));
    res.setHeader('X-RateLimit-Reset', Math.ceil(entry.resetTime / 1000));

    next();
  };
}

const generalLimiter = createRateLimiter();
const authLimiter = createRateLimiter({
  windowMs: config.rateLimit.auth?.windowMs,
  max: config.rateLimit.auth?.max || 20,
});

module.exports = {
  createRateLimiter,
  generalLimiter,
  authLimiter,
};