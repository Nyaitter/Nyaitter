'use strict';

const crypto = require('crypto');

function normalizeText(text) {
  return String(text || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function textHash(text) {
  return crypto.createHash('sha256').update(normalizeText(text)).digest('hex');
}

const TERM_CAP = 1024;

// あいまい検索の候補生成に使うバイグラム索引。保存側と検索側で同じ手順にそろえる。
function indexTerms(normalized) {
  const distinct = new Set();
  for (let i = 0; i + 2 <= normalized.length; i++) distinct.add(normalized.slice(i, i + 2));
  let terms = [...distinct];
  if (terms.length > TERM_CAP) {
    terms.sort();
    const stride = Math.ceil(terms.length / TERM_CAP);
    terms = terms.filter((_, index) => index % stride === 0);
  }
  return terms;
}

function extractAiText(response) {
  if (!response) return '';
  if (typeof response === 'string') return response;
  if (typeof response?.choices?.[0]?.message?.content === 'string') {
    return response.choices[0].message.content;
  }
  if (Array.isArray(response?.candidates?.[0]?.content?.parts)) {
    return response.candidates[0].content.parts
      .filter((part) => part && part.thought !== true)
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('');
  }
  return '';
}

const LANGUAGE_NAME_TO_CODE = {
  japanese: 'ja', english: 'en', korean: 'ko', chinese: 'zh',
  spanish: 'es', french: 'fr', german: 'de', portuguese: 'pt',
  italian: 'it', russian: 'ru', arabic: 'ar',
};

function normalizeLanguageCode(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  if (!raw) return null;
  if (LANGUAGE_NAME_TO_CODE[raw]) return LANGUAGE_NAME_TO_CODE[raw];
  const match = /^([a-z]{2,3})(?:-([a-z0-9]{2,8}))?$/.exec(raw);
  if (!match) return null;
  const base = match[1];
  const region = match[2] || '';
  if (base === 'zh') {
    if (region === 'hans' || region === 'cn' || region === 'sg' || region === 'my') return 'zh-Hans';
    if (region === 'hant' || region === 'tw' || region === 'hk' || region === 'mo') return 'zh-Hant';
    return 'zh';
  }
  return region ? `${base}-${region}` : base;
}

function parseLanguageCode(text) {
  const cleaned = String(text || '').trim().toLowerCase();
  if (!cleaned || cleaned.length > 40 || cleaned === 'und') return null;
  const token = cleaned.split(/[\s.,、。:：;；/]+/).filter(Boolean)[0] || '';
  return normalizeLanguageCode(token);
}

function sameLanguage(a, b) {
  const left = normalizeLanguageCode(a);
  const right = normalizeLanguageCode(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.startsWith('zh') || right.startsWith('zh')) return false;
  return left.split('-')[0] === right.split('-')[0];
}

module.exports = {
  normalizeText,
  textHash,
  indexTerms,
  extractAiText,
  normalizeLanguageCode,
  parseLanguageCode,
  sameLanguage,
};
