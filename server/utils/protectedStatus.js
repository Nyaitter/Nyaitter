'use strict';

function protectedKey(key) {
  const name = String(key);
  const camelBase = name.charAt(0).toLowerCase() + name.slice(1);
  return /^(?:trust|writer|reviewer|reputation|note_rank|note_affirmative_score|note_max_per_day|note_min_public_threshold|score|scores|successes|weight|rank)(?:$|_|[A-Z])/.test(camelBase)
    || /^(?:trust|writer|reviewer|reputation|note)(?:Score|Rank|Weight|MaxPerDay|MinPublicThreshold)$/.test(camelBase)
    || /^(?:trust|writer|reviewer|reputation|note)(?:score|rank|weight|maxperday|minpublicthreshold)$/.test(camelBase);
}

function containsProtectedStatus(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => {
    if (key === 'display_ranks') {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return true;
      return Object.entries(item).some(([dimension, rank]) => !['trust', 'writer', 'reviewer'].includes(dimension) || (rank !== null && !['string', 'number'].includes(typeof rank)));
    }
    return protectedKey(key) || containsProtectedStatus(item);
  });
}

function publicSettings(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(publicSettings);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !protectedKey(key) && !['display_ranks', 'show_ranks'].includes(key)).map(([key, item]) => [key, publicSettings(item)]));
}

module.exports = { containsProtectedStatus, publicSettings };
