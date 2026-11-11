'use strict';

// 投稿者年齢帯ラベルと、その帯を代表する年齢。集約はこの代表値の中央値で決める。
const AUTHOR_AGE_BAND_VALUES = Object.freeze({
  under13: 11,
  '13-15': 14,
  '16-17': 16,
  '18-24': 21,
  '25-34': 29,
  '35over': 40,
});

// 投稿推定のみで推定年齢が決まっている場合に、安全マージンへ追加する年数。
const POST_ONLY_EXTRA_MARGIN_YEARS = 3;

// 集約で参照する直近の投稿推定サンプル数。
const AGGREGATION_WINDOW = 50;

// 非表示にする対象年齢と実効年齢の差（この差以上で hide）。
const HIDE_GAP_YEARS = 4;

const AGE_RATING_PATTERN = /<age:(all|12|15|18)>/i;
const AUTHOR_AGE_PATTERN = /<author:(under13|13-15|16-17|18-24|25-34|35over|unknown)>/i;

// 年齢ラベルが無ければ null（呼び出し側は保存値を変更しない）。
function parseAgeRating(text) {
  if (typeof text !== 'string') return null;
  const match = AGE_RATING_PATTERN.exec(text);
  if (!match) return null;
  return match[1].toLowerCase() === 'all' ? 0 : Number(match[1]);
}

// 年齢帯ラベルが無い、または unknown の場合は null。
function parseAuthorAgeBand(text) {
  if (typeof text !== 'string') return null;
  const match = AUTHOR_AGE_PATTERN.exec(text);
  if (!match) return null;
  const band = match[1].toLowerCase();
  return band === 'unknown' ? null : band;
}

function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

// 現在の推定から候補へ動かす量。若い方向は差の半分（最低1）、高い方向は差の2割（最低1）。
function nextAgeEstimate(current, candidate) {
  if (candidate == null) return current;
  if (current == null) return candidate;
  const diff = candidate - current;
  if (diff === 0) return current;
  if (diff < 0) return current - Math.max(1, Math.ceil(-diff / 2));
  return current + Math.max(1, Math.floor(diff / 5));
}

// 投稿1件分の年齢帯を記録し、十分なサンプルが集まっていれば推定年齢へ反映する。
async function aggregateAuthorAge(db, userId, postId, band, { minSamples = 5 } = {}) {
  if (!db || typeof db.recordPostAgeEstimate !== 'function' || typeof db.getPostAgeBands !== 'function') return null;
  if (!Object.prototype.hasOwnProperty.call(AUTHOR_AGE_BAND_VALUES, band)) return null;
  const authorId = Number(userId);
  if (!Number.isSafeInteger(authorId) || authorId <= 0) return null;

  await db.recordPostAgeEstimate(postId, authorId, band);
  const bands = await db.getPostAgeBands(authorId, AGGREGATION_WINDOW);
  const validBands = (Array.isArray(bands) ? bands : [])
    .filter((value) => Object.prototype.hasOwnProperty.call(AUTHOR_AGE_BAND_VALUES, value));
  const samples = validBands.length;

  const user = typeof db.getUserById === 'function' ? await db.getUserById(authorId) : null;
  if (!user) return { samples, updated: false };

  // ウィンドウ（直近50件）を超える最小サンプル数は永久に満たせないため丸める。
  const threshold = Math.min(AGGREGATION_WINDOW, Math.max(1, Number(minSamples) || 5));
  if (samples < threshold) {
    if (Number(user.age_samples || 0) !== samples && typeof db.updateUserAgeEstimate === 'function') {
      await db.updateUserAgeEstimate(authorId, { ageSamples: samples });
    }
    return { samples, updated: false };
  }

  const candidate = median(validBands.map((value) => AUTHOR_AGE_BAND_VALUES[value]));
  if (candidate == null) return { samples, updated: false };

  const current = user.age_estimate != null ? Number(user.age_estimate) : null;
  const next = nextAgeEstimate(current, candidate);
  const fields = { ageSamples: samples };
  if (next !== current) {
    fields.ageEstimate = next;
    fields.ageEstimatedAt = new Date();
    fields.ageSource = 'post';
  } else if (user.age_source !== 'post') {
    fields.ageSource = 'post';
  }
  if (typeof db.updateUserAgeEstimate === 'function') {
    await db.updateUserAgeEstimate(authorId, fields);
  }
  return { samples, candidate, previous: current, next, updated: next !== current };
}

// AutoMod のモード名を正規化する。不正・未指定は安全側の off として扱い、
// config・サービス・年齢系の判定で同じ規則を使う。
function resolveAutoModMode(autoModConfig) {
  const mode = String(autoModConfig?.mode || '').trim().toLowerCase();
  return ['off', 'legacy', 'v2'].includes(mode) ? mode : 'off';
}

// 年齢系の仕組み（表示ペナルティ・おすすめの年齢近接）は AutoMod V2 のときだけ動かす。
function isAgeFeaturesActive(autoModConfig) {
  return resolveAutoModMode(autoModConfig) === 'v2';
}

// 閲覧者の実効年齢から年齢制限の段階を決める。保存値は一切変更しない。
// 段階は none / mask / hide のみ。年齢が足りていれば none で何も出さず、
// mask は通常のクッションと区別がつかない形で serialize 側が畳む。
function computeAgePenalty({ rating, authorId, viewer, margin = 5, unknown = 'mask' } = {}) {
  const normalizedRating = Number(rating) || 0;
  if (normalizedRating <= 0) return 'none';
  if (viewer && authorId != null && Number(viewer.id) === Number(authorId)) return 'none';

  const estimate = viewer?.ageEstimate != null ? Number(viewer.ageEstimate) : null;
  if (estimate == null || !Number.isFinite(estimate)) {
    return unknown === 'none' ? 'none' : 'mask';
  }
  const extraMargin = viewer?.ageSource === 'post' ? POST_ONLY_EXTRA_MARGIN_YEARS : 0;
  const effectiveAge = estimate - (Number(margin) || 0) - extraMargin;
  if (effectiveAge >= normalizedRating) return 'none';
  return normalizedRating - effectiveAge >= HIDE_GAP_YEARS ? 'hide' : 'mask';
}

module.exports = {
  AUTHOR_AGE_BAND_VALUES,
  POST_ONLY_EXTRA_MARGIN_YEARS,
  AGGREGATION_WINDOW,
  HIDE_GAP_YEARS,
  parseAgeRating,
  parseAuthorAgeBand,
  median,
  nextAgeEstimate,
  aggregateAuthorAge,
  computeAgePenalty,
  isAgeFeaturesActive,
  resolveAutoModMode,
};
