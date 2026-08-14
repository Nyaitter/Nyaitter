const path = require('path');

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const CONTENT_TYPE_EXTENSIONS = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['video/mp4', '.mp4'],
  ['video/webm', '.webm'],
  ['audio/mpeg', '.mp3'],
  ['audio/ogg', '.ogg'],
  ['audio/wav', '.wav'],
  ['audio/x-wav', '.wav'],
  ['application/pdf', '.pdf'],
  ['text/plain', '.txt'],
  ['text/csv', '.csv'],
  ['application/zip', '.zip'],
]);

function normalizeContentType(contentType) {
  return String(contentType || 'application/octet-stream')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
}

function getSafeExtension(fileName, contentType) {
  const normalizedContentType = normalizeContentType(contentType);
  const mappedExtension = CONTENT_TYPE_EXTENSIONS.get(normalizedContentType);
  if (mappedExtension) return mappedExtension;

  const candidate = path.extname(String(fileName || '')).toLowerCase();
  if (/^\.[a-z0-9]{1,10}$/.test(candidate)) return candidate;
  return '';
}

function normalizeFolder(folder) {
  const value = String(folder || '').replace(/\\/g, '/');
  const parts = value.split('/');

  if (
    !value ||
    value.startsWith('/') ||
    parts.some((part) => !SAFE_SEGMENT.test(part) || part === '.' || part === '..')
  ) {
    throw new Error('Invalid storage folder');
  }

  return parts.join('/');
}

function normalizeStorageKey(key) {
  const value = String(key || '').replace(/\\/g, '/');
  const parts = value.split('/');

  if (
    !value ||
    value.startsWith('/') ||
    parts.length < 2 ||
    parts.some((part) => !SAFE_SEGMENT.test(part) || part === '.' || part === '..')
  ) {
    throw new Error('Invalid storage key');
  }

  return parts.join('/');
}

function isOwnedAttachmentKey(key, userId) {
  const normalizedKey = normalizeStorageKey(key);
  const expectedPrefix = `attachments/${Number(userId)}/`;
  return normalizedKey.startsWith(expectedPrefix);
}

module.exports = {
  CONTENT_TYPE_EXTENSIONS,
  getSafeExtension,
  isOwnedAttachmentKey,
  normalizeContentType,
  normalizeFolder,
  normalizeStorageKey,
};
