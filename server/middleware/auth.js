const SessionManager = require('../services/auth/SessionManager');
const BotTokenManager = require('../services/auth/BotTokenManager');
const config = require('../config');

function parseCookies(req) {
  const cookies = {};
  const rawCookie = req.headers.cookie;
  if (!rawCookie) return cookies;

  rawCookie.split(';').forEach((cookie) => {
    const parts = cookie.split('=');
    const name = parts.shift()?.trim();
    if (!name) return;

    try {
      cookies[name] = decodeURIComponent(parts.join('='));
    } catch (_) {
      // Malformed cookies must not turn an authentication attempt into a 500 error.
    }
  });
  return cookies;
}

function extractToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim() || null;
  }
  if (req.headers['x-api-key']) {
    return String(req.headers['x-api-key']).trim() || null;
  }
  // URLクエリのトークンはアクセスログ・Referer・プロキシログに残るため受け付けない。
  // スクリプト利用時は Authorization: Bearer または X-API-Key を使用する。
  const cookies = parseCookies(req);
  return cookies.nyaitter_session || cookies.session || null;
}

async function getSessionPrincipal(req, token) {
  const sessionManager = new SessionManager({
    dbAdapter: req.app.locals.dbAdapter,
  });
  const sessionInfo = await sessionManager.validateToken(token);
  if (!sessionInfo) return null;

  const user = await req.app.locals.dbAdapter.getUserById(sessionInfo.userId);
  if (!user) return null;

  return {
    id: user.id,
    tokenType: 'session',
    isBot: false,
    admin: user.admin === true,
    frozen: Boolean(user.freeze),
  };
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
      // Bot tokens can act as their owner for regular APIs but never obtain
      // administrative privileges, even if the owner is an administrator.
      // 所有者が凍結済みの場合、Botトークン経由で制限を回避させない。
      const owner = await req.app.locals.dbAdapter.getUserById(botInfo.userId);
      if (!owner) return null;
      return {
        id: botInfo.userId,
        tokenType: 'bot',
        isBot: true,
        name: botInfo.name,
        admin: false,
        frozen: Boolean(owner.freeze),
      };
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

  // Cookieを伴うクロスオリジン要求は、資格情報付きCORSを明示的に有効化し、
  // allowedOriginsへ登録したClientだけを信頼する。
  return config.cors.credentials === true && (config.cors.allowedOrigins || []).includes(origin);
}

/**
 * SameSite Cookieだけに依存せず、Cookieが同送される状態変更要求は同一オリジンに限定する。
 * Bearer / Botトークンのみのサーバー間リクエストはCookieを伴わないため影響を受けない。
 */
function csrfProtection(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
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
  const allowedOrigins = config.cors.allowedOrigins || [];
  const defaultPortOrigin = `http://localhost:${config.server.port}`;
  const originAllowed = Boolean(
    origin && (allowedOrigins.includes(origin) || origin === defaultPortOrigin),
  );

  if (originAllowed) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
    if (config.cors.credentials === true) {
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
  res.header('Access-Control-Max-Age', String(config.cors.preflightMaxAge || 600));

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  return next();
}

function securityHeaders(req, res, next) {
  const sec = config.security || {};
  const isDev = (process.env.NODE_ENV || 'development') === 'development';

  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  if (sec.hsts?.enabled) {
    let hsts = `max-age=${sec.hsts.maxAge || 31536000}`;
    if (sec.hsts.includeSubDomains) hsts += '; includeSubDomains';
    res.setHeader('Strict-Transport-Security', hsts);
  }

	if (!res.getHeader('Content-Security-Policy')) {
		// クライアントはインラインscript・イベント属性を使わない。style属性は既存UIの
		// 互換性のため維持するが、script-srcからunsafe-inlineを除外してDOM XSSを抑止する。
		const csp = [
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
		res.setHeader('Content-Security-Policy', csp);
	}

	res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
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
};
