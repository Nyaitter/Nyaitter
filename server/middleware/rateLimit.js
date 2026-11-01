'use strict';

const config = require('../config');

/**
 * 堅牢なIPアドレス抽出ヘルパー
 * プロキシ背後および直接接続から安全にIPを取得
 */
function getClientIp(req) {
  if (config.server?.trustProxy) {
    const cfIp = req.headers['cf-connecting-ip'];
    if (typeof cfIp === 'string' && cfIp.trim()) return cfIp.trim();

    if (req.ip) return req.ip;

    const xRealIp = req.headers['x-real-ip'];
    if (typeof xRealIp === 'string' && xRealIp.trim()) return xRealIp.trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function createRateLimiter(options = {}) {
  const windowMs = options.windowMs || config.rateLimit?.general?.windowMs || 60000;
  const max = options.max || config.rateLimit?.general?.max || 1000;
  const category = options.category || Object.keys(config.rateLimit || {}).find(key=>config.rateLimit[key]===options) || 'general';
  const keyGenerator = options.keyGenerator || ((req) => {
    if (req.user?.id) return `user:${req.user.id}`;
    return `ip:${getClientIp(req)}`;
  });

  const store = new Map(); // key -> { count, resetTime, blockedUntil }
  const maxTrackedKeys = Math.max(
    100,
    Number(options.maxTrackedKeys ?? config.rateLimit?.maxTrackedKeys) || 10000,
  );

  const pruneExpiredEntries = (now = Date.now()) => {
    for (const [key, entry] of store) {
      if (!entry || (entry.resetTime <= now && (!entry.blockedUntil || entry.blockedUntil <= now))) {
        store.delete(key);
      }
    }
  };

  const trimStore = (now = Date.now()) => {
    pruneExpiredEntries(now);
    while (store.size >= maxTrackedKeys) {
      const oldestKey = store.keys().next().value;
      if (oldestKey === undefined) break;
      store.delete(oldestKey);
    }
  };

  const timer = setInterval(() => {
    pruneExpiredEntries();
  }, Math.max(10000, windowMs));
  timer.unref();

  return async function rateLimitMiddleware(req, res, next) {
    if (!config.rateLimit?.enabled) {
      return next();
    }

    let effectiveMax=max; let rules=null;
    try {
      if (options.resolvePrincipal && !req.user && req.app?.locals?.dbAdapter) req.user=await require('./auth').getAuthenticatedPrincipal(req);
      if (req.user && category!=='auth') {
        const reputation=require('../services/ReputationService');
        rules=req.trustPolicy || await reputation.effectivePolicy(req.app.locals.dbAdapter,req.user);
        req.trustPolicy=rules;
        req.trustPolicyPrincipalId=req.user.id;
        if (!rules.exempt) effectiveMax=rules.rateLimits?.[category] ?? Math.max(1,Math.floor(max*rules.rateMultiplier));
      }
    } catch(error) {
      console.error('[rateLimit] status lookup:',error.message);
      return res.status(503).json({error:'利用状態を確認できませんでした'});
    }
    const now = Date.now();
    const ipKey=`ip:${getClientIp(req)}`;
    if (options.resolvePrincipal && req.user && !rules?.exempt) {
      let ipEntry=store.get(ipKey);
      if (ipEntry?.blockedUntil && now<ipEntry.blockedUntil) {res.setHeader('Retry-After',Math.max(1,Math.ceil((ipEntry.blockedUntil-now)/1000)));return res.status(429).json({error:'Too Many Requests'});}
      if (!ipEntry || now>=ipEntry.resetTime) {if (!ipEntry) trimStore(now);ipEntry={count:0,resetTime:now+windowMs};store.set(ipKey,ipEntry);}
      ipEntry.count++;
      if (ipEntry.count>max) {res.setHeader('Retry-After',Math.max(1,Math.ceil((ipEntry.resetTime-now)/1000)));return res.status(429).json({error:'Too Many Requests',message:'接続元からのリクエストが多すぎます。'});}
    }
    const key = options.resolvePrincipal && (!req.user || rules?.exempt)?ipKey:keyGenerator(req);
    let entry = store.get(key);

    // 継続的過剰リクエストによる一時ブロック判定
    if (entry?.blockedUntil && now < entry.blockedUntil) {
      const retryAfterSec = Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000));
      res.setHeader('Retry-After', retryAfterSec);
      return res.status(429).json({
        error: 'Too Many Requests',
        message: '過剰なリクエストが検出されたため、一時的にアクセスを制限しています。',
      });
    }

    if (!entry || now >= entry.resetTime) {
      if (!entry) trimStore(now);
      entry = { count: 0, resetTime: now + windowMs, blockedUntil: 0 };
      store.set(key, entry);
    }

    entry.count += 1;

    // 上限の2倍を超える過剰リクエストを発行した場合はクールダウンブロック
    if (entry.count > effectiveMax * 2) {
      entry.blockedUntil = now + Math.max(windowMs * 5, 300000);
      res.setHeader('Retry-After', Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000)));
      return res.status(429).json({
        error: 'Too Many Requests',
        message: '過剰なリクエストが検出されたため、一時的にアクセスを制限しています。',
      });
    }

    if (entry.count > effectiveMax) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil((entry.resetTime - now) / 1000)));
      return res.status(429).json({
        error: 'Too Many Requests',
        message: 'リクエストが多すぎます。しばらく待ってから再度お試しください。',
      });
    }

    res.setHeader('X-RateLimit-Limit', effectiveMax);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, effectiveMax - entry.count));
    res.setHeader('X-RateLimit-Reset', Math.ceil(entry.resetTime / 1000));

    next();
  };
}

const generalLimiter = createRateLimiter({resolvePrincipal:true,category:'general'});
const authLimiter = createRateLimiter({
  category: 'auth',
  keyGenerator: req => `ip:${getClientIp(req)}`,
  windowMs: config.rateLimit?.auth?.windowMs,
  max: config.rateLimit?.auth?.max || 20,
});

module.exports = {
  createRateLimiter,
  generalLimiter,
  authLimiter,
  getClientIp,
};
