const config = require('../config');

const DEFAULT_PORTS = new Map([
  ['http:', '80'],
  ['https:', '443'],
]);

function formatNyaitterId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 0) {
    throw new Error('Nyaitter ID must be a non-negative integer');
  }
  return `#${String(id).padStart(4, '0')}`;
}

function normalizePublicUrl(value) {
  if (!value || typeof value !== 'string') return null;

  try {
    const parsed = new URL(value.trim());
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      return null;
    }
    return parsed.origin;
  } catch (_) {
    return null;
  }
}

function isSafeHost(host) {
  if (typeof host !== 'string' || host.length === 0 || host.length > 255) return false;
  if (/\s|[\\/@?#]/.test(host)) return false;
  try {
    const parsed = new URL(`http://${host}`);
    return parsed.hostname === host.split(':')[0] || host.startsWith('[');
  } catch (_) {
    return false;
  }
}

/**
 * Derive this instance's public origin from the active request. Behind a proxy,
 * Express's req.protocol and req.hostname follow forwarded headers only when
 * server.trustProxy is enabled. PUBLIC_URL is only a safe fallback for jobs
 * that have no request context.
 */
function getPublicUrl(req = null) {
  const configured = normalizePublicUrl(process.env.PUBLIC_URL || config.federation?.publicUrl);
  // 本番は設定済みの正規URLを使い、利用者が送るHostヘッダーで認証コールバックや
  // 共有URLのオリジンが変化しないようにする。
  if ((process.env.NODE_ENV || 'development') === 'production' && configured) {
    return configured;
  }

  if (req && typeof req.get === 'function') {
    const forwardedHost = config.server?.trustProxy === true
      ? String(req.headers['x-forwarded-host'] || '').split(',')[0].trim()
      : '';
    const host = forwardedHost || req.get('host');
    if (isSafeHost(host)) {
      const protocol = req.protocol === 'https' ? 'https' : 'http';
      const derived = normalizePublicUrl(`${protocol}://${host}`);
      if (derived) return derived;
    }
  }

  if (configured) return configured;

  const port = config.server?.port || 3000;
  return `http://localhost:${port}`;
}

function getAddressDomain(publicUrl) {
  const parsed = new URL(publicUrl);
  const defaultPort = DEFAULT_PORTS.get(parsed.protocol);
  return parsed.port && parsed.port !== defaultPort
    ? `${parsed.hostname}:${parsed.port}`
    : parsed.hostname;
}

function buildNyaitterAddress(id, publicUrl) {
  return `${formatNyaitterId(id)}@${getAddressDomain(publicUrl)}`;
}

function buildLocalNyaitterAddress(id, req = null) {
  return buildNyaitterAddress(id, getPublicUrl(req));
}

function buildExternalNyaitterAddress(externalId, providerDomain) {
  const normalizedDomain = String(providerDomain || '').trim().toLowerCase();
  if (!isSafeHost(normalizedDomain)) {
    throw new Error('Invalid Nyaitter provider domain');
  }
  return `${formatNyaitterId(externalId)}@${normalizedDomain}`;
}

function parseNyaitterAddress(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^#(\d{1,16})@([A-Za-z0-9.-]+(?::\d{1,5})?)$/);
  if (!match) return null;

  const id = Number(match[1]);
  const domain = match[2].toLowerCase();
  if (!Number.isSafeInteger(id) || id < 0 || !isSafeHost(domain)) return null;

  return {
    id,
    domain,
    address: buildExternalNyaitterAddress(id, domain),
  };
}

function getUserNyaitterId(user) {
	if (!user) return null;
	return formatNyaitterId(
		user.auth_provider === 'nyaitter' && user.external_id != null
			? user.external_id
			: user.id,
	);
}

function getUserNyaitterAddress(user, req = null) {
	if (!user) return null;
	if (user.auth_provider === 'nyaitter' && user.external_id != null && user.provider_domain) {
		return buildExternalNyaitterAddress(user.external_id, user.provider_domain);
	}
	return buildLocalNyaitterAddress(user.id, req);
}

module.exports = {

  buildExternalNyaitterAddress,
  buildLocalNyaitterAddress,
  buildNyaitterAddress,
  formatNyaitterId,
  getAddressDomain,
  getPublicUrl,
  getUserNyaitterAddress,
  getUserNyaitterId,
  normalizePublicUrl,
  parseNyaitterAddress,
};
