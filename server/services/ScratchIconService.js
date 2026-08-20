/*
 * Scratchプロフィールアイコンの安全な取得サービス。
 * GIF・SVGを変換せず、許可済みScratchホストから取得した元画像をそのまま返す。
 */
const crypto = require('crypto');

const DEFAULT_MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const DEFAULT_FAILURE_CACHE_MS = 60 * 1000;
const DEFAULT_MAX_FAILURE_CACHE_ENTRIES = 500;
const ALLOWED_SCRATCH_IMAGE_HOSTS = new Set([
  'uploads.scratch.mit.edu',
  'cdn2.scratch.mit.edu',
]);
const ALLOWED_IMAGE_CONTENT_TYPES = new Set([
  'image/gif',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/svg+xml',
]);

function isAllowedScratchImageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ALLOWED_SCRATCH_IMAGE_HOSTS.has(url.hostname.toLowerCase());
  } catch (_) {
    return false;
  }
}

function normalizeImageContentType(value) {
  const mediaType = String(value || '').split(';', 1)[0].trim().toLowerCase();
  return ALLOWED_IMAGE_CONTENT_TYPES.has(mediaType) ? mediaType : null;
}

function assertSafeSvg(source) {
  const text = source.toString('utf8');
  if (/<(?:script|foreignObject)\b|<!doctype|\son[a-z]+\s*=/i.test(text)) {
    throw new Error('Unsafe SVG content');
  }
  const references = [...text.matchAll(/(?:href|xlink:href)\s*=\s*["']([^"']+)["']/gi)];
  if (references.some((match) => !match[1].startsWith('#') && !match[1].startsWith('data:'))) {
    throw new Error('SVG contains an external reference');
  }
}

class ScratchIconService {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.maxSourceBytes = Number(options.maxSourceBytes || DEFAULT_MAX_SOURCE_BYTES);
    this.failureCacheMs = Math.max(
      1000,
      Number(options.failureCacheMs || DEFAULT_FAILURE_CACHE_MS),
    );
    this.maxFailureCacheEntries = Math.max(
      1,
      Number(options.maxFailureCacheEntries || DEFAULT_MAX_FAILURE_CACHE_ENTRIES),
    );
    this.failureCache = new Map();
  }

  _pruneFailureCache(now = Date.now()) {
    for (const [scid, retryAt] of this.failureCache) {
      if (!retryAt || retryAt <= now) this.failureCache.delete(scid);
    }
    while (this.failureCache.size >= this.maxFailureCacheEntries) {
      const oldestScid = this.failureCache.keys().next().value;
      if (oldestScid === undefined) break;
      this.failureCache.delete(oldestScid);
    }
  }

  async _fetchSourceImage(url) {
    let nextUrl = url;
    for (let redirectCount = 0; redirectCount <= 2; redirectCount += 1) {
      if (!isAllowedScratchImageUrl(nextUrl)) {
        throw new Error('Scratch icon URL is not allowed');
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      let response;
      try {
        response = await this.fetchImpl(nextUrl, {
          redirect: 'manual',
          signal: controller.signal,
          headers: { Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8' },
        });
      } finally {
        clearTimeout(timeout);
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new Error('Scratch icon redirect is missing a location');
        nextUrl = new URL(location, nextUrl).href;
        continue;
      }
      if (!response.ok) throw new Error(`Scratch icon request failed with ${response.status}`);
      const contentType = normalizeImageContentType(response.headers.get('content-type'));
      if (!contentType) throw new Error('Scratch icon response is not a supported image');
      const contentLength = Number(response.headers.get('content-length') || 0);
      if (contentLength > this.maxSourceBytes) throw new Error('Scratch icon is too large');
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0 || buffer.length > this.maxSourceBytes) {
        throw new Error('Scratch icon is empty or too large');
      }
      if (contentType === 'image/svg+xml') assertSafeSvg(buffer);
      return { buffer, contentType, sourceUrl: nextUrl };
    }
    throw new Error('Scratch icon exceeded redirect limit');
  }

  async getSourceIcon(scid, resolveSourceUrl) {
    const normalizedScid = String(scid || '').trim();
    if (!normalizedScid) return null;

    const now = Date.now();
    this._pruneFailureCache(now);
    const retryAt = this.failureCache.get(normalizedScid);
    if (retryAt && retryAt > now) return null;

    try {
      const sourceUrl = await resolveSourceUrl(normalizedScid);
      if (!isAllowedScratchImageUrl(sourceUrl)) {
        throw new Error('Scratch icon source URL is not allowed');
      }
      const source = await this._fetchSourceImage(sourceUrl);
      return {
        sourceUrl: source.sourceUrl,
        buffer: source.buffer,
        contentType: source.contentType,
        etag: `"scratch-icon-${crypto.createHash('sha256').update(source.buffer).digest('hex')}"`,
      };
    } catch (error) {
      this._pruneFailureCache(now);
      this.failureCache.set(normalizedScid, now + this.failureCacheMs);
      throw error;
    }
  }
}

module.exports = {
  ScratchIconService,
  isAllowedScratchImageUrl,
  normalizeImageContentType,
  assertSafeSvg,
};
