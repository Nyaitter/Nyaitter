const dns = require('dns').promises;
const https = require('https');
const net = require('net');

const MAX_URL_LENGTH = 2048;
const MAX_HTML_BYTES = 128 * 1024;
const MAX_REDIRECTS = 10;
const REQUEST_TIMEOUT_MS = 20000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;
const cardCache = new Map();

function isPrivateIpv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [first, second] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19))
  );
}

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return !isPrivateIpv4(address);
  if (family !== 6) return false;

  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    return !isPrivateIpv4(normalized.slice('::ffff:'.length));
  }
  return !(
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('ff')
  );
}

function normalizeTargetUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) {
    return null;
  }
  if (/[\u0000-\u001F\u007F]/.test(value)) return null;

  try {
    const target = new URL(value);
    const hostname = target.hostname.toLowerCase().replace(/\.$/, '');
    if (
      target.protocol !== 'https:' ||
      target.username ||
      target.password ||
      (target.port && target.port !== '443') ||
      !hostname ||
      hostname === 'localhost' ||
      hostname.endsWith('.localhost')
    ) {
      return null;
    }
    target.hostname = hostname;
    target.hash = '';
    return target;
  } catch (_) {
    return null;
  }
}

async function resolvePublicAddresses(hostname) {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!Array.isArray(records) || records.length === 0 || records.length > 16) {
    throw new Error('URL host could not be resolved');
  }
  if (records.some((record) => !isPublicAddress(record.address))) {
    throw new Error('URL host resolves to a non-public address');
  }
  return records;
}

function readAttribute(tag, name) {
  const unquotedValue = `[^\\s"'=<>${String.fromCharCode(96)}]+`;
  const expression = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|(${unquotedValue}))`,
    'i',
  );
  const match = expression.exec(tag);
  return match ? match[1] ?? match[2] ?? match[3] ?? '' : '';
}

function decodeHtmlText(value, maximumLength) {
  const decoded = String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => {
      const value = String(code).toLowerCase().startsWith('x')
        ? Number.parseInt(String(code).slice(1), 16)
        : Number.parseInt(code, 10);
      return Number.isSafeInteger(value) && value >= 0 && value <= 0x10ffff
        ? String.fromCodePoint(value)
        : '';
    })
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return decoded.slice(0, maximumLength);
}

function findMetaContent(html, acceptedKeys) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const key = (readAttribute(tag, 'property') || readAttribute(tag, 'name')).toLowerCase();
    if (!acceptedKeys.has(key)) continue;
    const content = decodeHtmlText(readAttribute(tag, 'content'), 280);
    if (content) return content;
  }
  return '';
}

function parseCardMetadata(html, targetUrl) {
  const titleTag = /<title\b[^>]*>([\s\S]{0,4096}?)<\/title\s*>/i.exec(html);
  const title =
    findMetaContent(html, new Set(['og:title', 'twitter:title'])) ||
    decodeHtmlText(titleTag?.[1], 160) ||
    targetUrl.hostname;
  const description = findMetaContent(
    html,
    new Set(['og:description', 'twitter:description', 'description']),
  ).slice(0, 280);
  const siteName = findMetaContent(html, new Set(['og:site_name'])).slice(0, 100);
  return {
    url: targetUrl.href,
    hostname: targetUrl.hostname,
    title,
    description,
    site_name: siteName,
  };
}

function fetchHtml(targetUrl, redirectCount = 0) {
  return resolvePublicAddresses(targetUrl.hostname).then((addresses) => {
    const address = addresses[0];
    return new Promise((resolve, reject) => {
      let completed = false;
      const finish = (callback) => (value) => {
        if (completed) return;
        completed = true;
        callback(value);
      };
      const request = https.request(
        {
          protocol: 'https:',
          hostname: targetUrl.hostname,
          port: 443,
          path: `${targetUrl.pathname}${targetUrl.search}`,
          method: 'GET',
          agent: false,
          headers: {
            Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
            'Accept-Encoding': 'identity',
            'User-Agent': 'Nyaitter-URLCard/1.0',
            Range: `bytes=0-${MAX_HTML_BYTES - 1}`,
          },
          servername: targetUrl.hostname,
          lookup: (_hostname, _options, callback) => {
            callback(null, address.address, address.family);
          },
        },
        (response) => {
          const status = Number(response.statusCode || 0);
          if (status >= 300 && status < 400 && response.headers.location) {
            response.resume();
            if (redirectCount >= MAX_REDIRECTS) {
              finish(reject)(new Error('Too many redirects'));
              return;
            }
            const redirected = normalizeTargetUrl(
              new URL(response.headers.location, targetUrl).href,
            );
            if (!redirected) {
              finish(reject)(new Error('Unsafe redirect target'));
              return;
            }
            fetchHtml(redirected, redirectCount + 1).then(
              finish(resolve),
              finish(reject),
            );
            return;
          }

          const contentType = String(response.headers['content-type'] || '').toLowerCase();
          if (status < 200 || status >= 300 || !/(^|\/)html(?:;|$)|application\/xhtml\+xml/.test(contentType)) {
            response.resume();
            finish(reject)(new Error('Target did not return HTML'));
            return;
          }

          const chunks = [];
          let totalBytes = 0;
          response.on('data', (chunk) => {
            if (completed) return;
            totalBytes += chunk.length;
            if (totalBytes > MAX_HTML_BYTES) {
              response.destroy();
              finish(reject)(new Error('HTML response is too large'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', finish(() => {
            resolve({
              targetUrl,
              html: Buffer.concat(chunks, totalBytes).toString('utf8'),
            });
          }));
          response.on('error', finish(reject));
        },
      );
      request.setTimeout(REQUEST_TIMEOUT_MS, () => {
        request.destroy(new Error('URL card request timed out'));
      });
      request.on('error', finish(reject));
      request.end();
    });
  });
}

function pruneCardCache(now) {
  for (const [key, entry] of cardCache) {
    if (!entry || entry.expiresAt <= now) cardCache.delete(key);
  }
  while (cardCache.size > MAX_CACHE_ENTRIES) {
    cardCache.delete(cardCache.keys().next().value);
  }
}

async function getUrlCard(value) {
  const targetUrl = normalizeTargetUrl(value);
  if (!targetUrl) return null;

  const now = Date.now();
  pruneCardCache(now);
  const cached = cardCache.get(targetUrl.href);
  if (cached && cached.expiresAt > now) return cached.card;

  try {
    const { html, targetUrl: finalUrl } = await fetchHtml(targetUrl);
    const card = parseCardMetadata(html, finalUrl);
    cardCache.set(targetUrl.href, { card, expiresAt: now + CACHE_TTL_MS });
    pruneCardCache(now);
    return card;
  } catch (_) {
    return null;
  }
}

module.exports = {
  getUrlCard,
};
