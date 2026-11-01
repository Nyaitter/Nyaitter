'use strict';

const DIRECTIVES = ['script', 'frame', 'connect', 'img'];

function normalizeAdvertisingOrigins(value, label = 'advertising origins') {
  let candidates = value;
  if (typeof candidates === 'string') {
    const trimmed = candidates.trim();
    if (!trimmed) return [];
    try {
      candidates = JSON.parse(trimmed);
    } catch (_) {
      candidates = trimmed.split(',');
    }
  }
  if (!Array.isArray(candidates)) {
    if (candidates !== undefined && candidates !== null && candidates !== '') {
      console.warn(`[config] ${label} must be an array or JSON array; ignoring it.`);
    }
    return [];
  }

  const origins = new Set();
  for (const entry of candidates) {
    if (typeof entry !== 'string') continue;
    const candidate = entry.trim();
    if (!candidate) continue;
    try {
      if (!/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(candidate)) throw new Error('invalid form');
      const url = new URL(candidate);
      if (url.protocol !== 'https:' || !url.hostname || url.username || url.password
        || url.pathname !== '/' || url.search || url.hash
        || url.hostname.startsWith('.') || url.hostname.endsWith('.')
        || url.hostname.includes('..') || Number(url.port) > 65535) throw new Error('invalid origin');
      origins.add(url.origin);
    } catch (_) {
      console.warn(`[config] Ignoring invalid ${label}: ${candidate}. Use an https origin without credentials or a path.`);
    }
  }
  return [...origins];
}

function normalizeAdvertisingSources(value) {
  const configured = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(DIRECTIVES.map((directive) => [
    directive,
    normalizeAdvertisingOrigins(configured[directive], `security.advertisingOrigins.${directive}`),
  ]));
}

module.exports = { DIRECTIVES, normalizeAdvertisingOrigins, normalizeAdvertisingSources };
