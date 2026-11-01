'use strict';

const SessionManager = require('../services/auth/SessionManager');
const BotTokenManager = require('../services/auth/BotTokenManager');
const NyaitterAuthManager = require('../services/auth/NyaitterAuthManager');
const config = require('../config');

function buildContentSecurityPolicy(advertisingOrigins = config.security?.advertisingOrigins || {}, clientAssetOrigins = config.security?.clientAssetOrigins || []) {
  const sourceList = (name) => (advertisingOrigins[name] || []).join(' ');
  const clientSources = clientAssetOrigins.length ? ` ${clientAssetOrigins.join(' ')}` : '';
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "form-action 'self'",
    `script-src 'self' https://cdn.jsdelivr.net https://challenges.cloudflare.com${clientSources}${sourceList('script') ? ` ${sourceList('script')}` : ''}`,
    `frame-src 'self' https://challenges.cloudflare.com${sourceList('frame') ? ` ${sourceList('frame')}` : ''}`,
    `style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com${clientSources}`,
    `img-src 'self' data: https:${sourceList('img') ? ` ${sourceList('img')}` : ''}`,
    "media-src 'self' data: blob: https:",
    "font-src 'self' data: https://fonts.gstatic.com",
    `connect-src 'self' https: wss:${sourceList('connect') ? ` ${sourceList('connect')}` : ''}`,
    "worker-src 'self'",
    "manifest-src 'self'",
  ];

  return csp.join('; ');
}

const DEFAULT_CSP = buildContentSecurityPolicy();

const PERMISSIONS_POLICY = 'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=()';

function parseCookies(req) {
  if (req._parsedCookies) return req._parsedCookies;
  const rawCookie = req.headers?.cookie;
  if (!rawCookie) {
    req._parsedCookies = {};
    return req._parsedCookies;
  }

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
  req._parsedCookies = cookies;
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
  const tokenHash = SessionManager.hashToken(token);
  const db = req.app.locals.dbAdapter;
  const user = typeof db.getUserBySessionToken === 'function'
    ? await db.getUserBySessionToken(tokenHash)
    : await (async () => {
      const sessionInfo = await new SessionManager({ dbAdapter: db }).validateToken(token);
      return sessionInfo ? db.getUserById(sessionInfo.userId) : null;
    })();
  if (!user) {
    return null;
  }

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
    writable: true,
  });
  return principal;
}

async function getAuthenticatedPrincipal(req) {
  if (req._principalPromise) return req._principalPromise;
  req._principalPromise = resolveAuthenticatedPrincipal(req);
  return req._principalPromise;
}

async function resolveAuthenticatedPrincipal(req) {
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
        writable: true,
      });
      return principal;
    }
  }

  if (token.startsWith('nyauth_')) {
    const authManager = new NyaitterAuthManager({
      dbAdapter: req.app.locals.dbAdapter,
    });
    const appAuth = await authManager.validateAccessToken(token, req.app.locals.dbAdapter);
    if (appAuth) {
      const owner = await req.app.locals.dbAdapter.getUserById(appAuth.userId);
      if (!owner) return null;
      const principal = {
        id: appAuth.userId,
        tokenType: 'app',
        isApp: true,
        appId: appAuth.appId,
        appName: appAuth.appName,
        scopes: Array.isArray(appAuth.scopes) ? appAuth.scopes : [],
        admin: false,
        frozen: Boolean(owner.freeze),
        accountOperation: owner.account_operation || null,
      };
      Object.defineProperty(principal, 'visibilityUser', {
        value: owner,
        enumerable: false,
        writable: true,
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
    const user = await req.app.locals.dbAdapter.getUserById(principal.id, { fresh: true });
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    principal.admin = principal.admin === true && user.admin === true;
    principal.frozen = Boolean(user.freeze);
    principal.accountOperation = user.account_operation || null;
    principal.visibilityUser = user;
    req.user = principal;
    if (!await require('../services/ReputationService').enforceAccess(req,res,principal)) return;
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
    const user = await req.app.locals.dbAdapter.getUserById(principal.id, { fresh: true });
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    principal.admin = principal.admin === true && user.admin === true;
    principal.frozen = Boolean(user.freeze);
    principal.accountOperation = user.account_operation || null;
    principal.visibilityUser = user;
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
    if (!await require('../services/ReputationService').enforceAccess(req,res,principal)) return;
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

function isDevelopmentCorsMode() {
  // npm run dev は DEV_BYPASS_AUTH=true を設定するため、開発用途では
  // 一時公開先を含む任意のオリジンから利用できるようにする。
  return process.env.DEV_BYPASS_AUTH === 'true';
}

function isCorsOriginAllowed(origin) {
  if (!origin) return false;
  const allowedOrigins = config.cors?.allowedOrigins || [];
  return (
    isDevelopmentCorsMode() ||
    config.cors?.allowUnknownClient === true ||
    allowedOrigins.includes('*') ||
    allowedOrigins.includes(origin)
  );
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

  // npm run devでは開発用認証バイパスと全オリジンCORSを同時に有効化するため、
  // Cookie付きの状態変更要求もオリジンで拒否しない。
  if (isDevelopmentCorsMode()) return true;
  return config.cors?.credentials === true && isCorsOriginAllowed(origin);
}

function csrfProtection(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }
  const cookies = parseCookies(req);
  const hasBrowserSession = Boolean(cookies.nyaitter_session || cookies.nyaitter_accounts);
  if (!hasBrowserSession) return next();

  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();

  // Originを伴わない要求はブラウザのクロスサイトPOSTでは通常発生しない。
  // Sec-Fetch-Site が cross-site / same-site の場合は、Originが欠落していても
  // CSRFとして拒否する。
  if (!req.headers.origin && (fetchSite === 'cross-site' || fetchSite === 'same-site')) {
    return res.status(403).json({ error: 'Cross-origin state-changing requests are not allowed' });
  }

  // 同一オリジン、またはCORSで明示的に許可したオリジンからのCookie付き状態変更要求は許可する。
  // 許可したオリジンからのブラウザ要求は Sec-Fetch-Site: cross-site になるため、
  // 信頼判定を先に行う。
  if (isSameOriginRequest(req)) return next();

  // 信頼できないオリジンからCookieが同送される状態変更要求はCSRFとして拒否する。
  return res.status(403).json({ error: 'Cross-origin state-changing requests are not allowed' });
}

function flexibleCors(req, res, next) {
  const origin = req.headers.origin;
  const defaultPortOrigin = `http://localhost:${config.server?.port || 3000}`;
  const originAllowed = Boolean(
    origin && (isCorsOriginAllowed(origin) || origin === defaultPortOrigin),
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
    'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Api-Key, X-As-User-Id',
  );
  res.header(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  );
  res.header('Access-Control-Max-Age', String(config.cors?.preflightMaxAge || 600));

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  return next();
}

function securityHeaders(req, res, next) {
  const sec = config.security || {};

  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
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
  isCorsOriginAllowed,
  buildContentSecurityPolicy,
};
