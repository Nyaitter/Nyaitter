'use strict';

const SessionManager = require('../services/auth/SessionManager');
const BotTokenManager = require('../services/auth/BotTokenManager');
const config = require('../config');

const DEFAULT_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com",
  "img-src 'self' data: https:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self' https: wss:",
  "worker-src 'self'",
  "manifest-src 'self'",
].join('; ');

const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=()';

function parseCookies(req) {
  const rawCookie = req.headers.cookie;
  if (!rawCookie) return {};

  const cookies = {};
  const pairs = rawCookie.split(';');
  for (let i = 0; i < pairs.length; i += 1) {
    const pair = pairs[i];
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const name = pair.slice(0, eqIdx).trim();
    if (!name) continue;
    const val = pair.slice(eqIdx + 1).trim();
    try {
      cookies[name] = decodeURIComponent(val);
    } catch (_) {
      cookies[name] = val;
    }
  }
  return cookies;
}

function extractToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim() || null;
  }
  if (req.headers['x-api-key']) {
    return String(req.headers['x-api-key']).trim() || null;
  }
  // URLクエリのトークンはアクセスログ・Referer等に残るため受け付けない。
  const cookies = parseCookies(req);
  return cookies.nyaitter_session || cookies.session || null;
}

async function getSessionPrincipal(req, token) {
  const db = req.app.locals.dbAdapter;
  const tokenHash = SessionManager.hashToken(token);
  let user = null;

  if (typeof db.getUserBySessionToken === 'function') {
    user = await db.getUserBySessionToken(tokenHash);
  } else {
    const sessionManager = new SessionManager({ dbAdapter: db });
    const sessionInfo = await sessionManager.validateToken(token);
    if (!sessionInfo) return null;
    user = await db.getUserById(sessionInfo.userId);
  }
  if (!user) return null;

  const principal = {
    id: user.id,
    tokenType: 'session',
    sessionTokenHash: tokenHash,
    isBot: false,
    admin: user.admin === true,
    frozen: Boolean(user.freeze),
    accountOperation: user.account_operation || null,
  };
  Object.defineProperty(principal, 'visibilityUser', {
    value: user,
    enumerable: false,
  });
  return principal;
}

async function getAuthenticatedPrincipal(req) {
  const token = extractToken(req);
  if (!token) return null;

  if (token.startsWith(config.auth.botTokenPrefix)) {
    const botManager = new BotTokenManager({
      dbAdapter: req.app.locals.dbAdapter,
    });
    const botInfo = await botManager.validateBotToken(token);
    if (botInfo) {
      const owner = await req.app.locals.dbAdapter.getUserById(botInfo.userId);
      if (!owner) return null;
      const principal = {
        id: botInfo.userId,
        tokenType: 'bot',
        isBot: true,
        name: botInfo.name,
        admin: false,
        frozen: Boolean(owner.freeze),
        accountOperation: owner.account_operation || null,
      };
      Object.defineProperty(principal, 'visibilityUser', {
        value: owner,
        enumerable: false,
      });
      return principal;
    }
  }

  return getSessionPrincipal(req, token);
}

async function requireAuthAllowFrozen(req, res, next) {
  try {
    const principal = await getAuthenticatedPrincipal(req);
    if (!principal) {
      return res.status(401).json({
        error: 'Authentication required',
        message: 'この操作にはログインが必要です。',
      });
    }
    req.user = principal;
    return next();
  } catch (error) {
    console.error('[auth] requireAuthAllowFrozen error:', error);
    return res.status(500).json({ error: 'Authentication error' });
  }
}

async function requireAuth(req, res, next) {
  try {
    const principal = await getAuthenticatedPrincipal(req);
    if (!principal) {
      return res.status(401).json({
        error: 'Authentication required',
        message: 'この操作にはログインが必要です。',
      });
    }
    if (principal.frozen) {
      return res.status(403).json({
        error: 'Account frozen',
        message: '凍結中のアカウントではこの操作を実行できません。',
      });
    }
    if (principal.accountOperation) {
      return res.status(423).json({
        error: 'Account maintenance in progress',
        message: 'NyaitterIDの処理中です。完了するまで接続できません。',
      });
    }
    req.user = principal;
    return next();
  } catch (error) {
    console.error('[auth] requireAuth error:', error);
    return res.status(500).json({ error: 'Authentication error' });
  }
}

async function optionalAuth(req, res, next) {
  try {
    req.user = await getAuthenticatedPrincipal(req);
  } catch (error) {
    console.warn('[auth] optionalAuth validation failed:', error.message);
    req.user = null;
  }
  return next();
}

function isSameOriginRequest(req) {
  const origin = req.headers.origin;
  if (!origin) return true;

  const protocol = req.protocol === 'https' ? 'https' : 'http';
  const expectedOrigin = `${protocol}://${req.get('host')}`;
  if (origin === expectedOrigin) return true;

  if (config.federation?.publicUrl) {
    try {
      if (origin === new URL(config.federation.publicUrl).origin) return true;
    } catch (_) {
      // Invalid federation URL is not an allowed browser origin.
    }
  }

  return config.cors?.credentials === true && (config.cors?.allowedOrigins || []).includes(origin);
}

function csrfProtection(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }
  const cookies = parseCookies(req);
  const hasBrowserSession = Boolean(cookies.nyaitter_session || cookies.nyaitter_accounts);
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (hasBrowserSession && (!isSameOriginRequest(req) || fetchSite === 'cross-site')) {
    return res.status(403).json({ error: 'Cross-origin state-changing requests are not allowed' });
  }
  return next();
}

function flexibleCors(req, res, next) {
  const origin = req.headers.origin;
  const allowedOrigins = config.cors?.allowedOrigins || [];
  const defaultPortOrigin = `http://localhost:${config.server?.port || 3000}`;
  const originAllowed = Boolean(
    origin && (allowedOrigins.includes(origin) || origin === defaultPortOrigin),
  );

  if (originAllowed) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
    if (config.cors?.credentials === true) {
      res.header('Access-Control-Allow-Credentials', 'true');
    }
  }

  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Api-Key',
  );
  res.header(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, DELETE, OPTIONS',
  );
  res.header('Access-Control-Max-Age', String(config.cors?.preflightMaxAge || 600));

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  return next();
}

function securityHeaders(req, res, next) {
  const sec = config.security || {};

  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  if (sec.hsts?.enabled) {
    let hsts = `max-age=${sec.hsts.maxAge || 31536000}`;
    if (sec.hsts.includeSubDomains) hsts += '; includeSubDomains';
    res.setHeader('Strict-Transport-Security', hsts);
  }

  if (!res.getHeader('Content-Security-Policy')) {
    res.setHeader('Content-Security-Policy', DEFAULT_CSP);
  }

  res.setHeader('Permissions-Policy', PERMISSIONS_POLICY);
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');

  return next();
}

module.exports = {
  requireAuth,
  requireAuthAllowFrozen,
  optionalAuth,
  csrfProtection,
  flexibleCors,
  securityHeaders,
  getAuthenticatedPrincipal,
  extractToken,
  isSameOriginRequest,
};
