'use strict';

function parseIntegerRange(value, { minimum = 0 } = {}) {
  const candidate = String(value ?? '').trim();
  if (!candidate) return null;

  if (/^\d+$/.test(candidate)) {
    const exact = Number(candidate);
    if (!Number.isSafeInteger(exact) || exact < minimum) return null;
    return { min: exact, max: exact };
  }

  const match = candidate.match(/^(\d+)?\.\.(\d+)?$/);
  if (!match || (!match[1] && !match[2])) return null;

  const min = match[1] === undefined ? null : Number(match[1]);
  const max = match[2] === undefined ? null : Number(match[2]);
  if (
    (min !== null && (!Number.isSafeInteger(min) || min < minimum)) ||
    (max !== null && (!Number.isSafeInteger(max) || max < minimum)) ||
    (min !== null && max !== null && min > max)
  ) {
    return null;
  }

  return { min, max };
}

function parseDuration(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }

  const candidate = String(value ?? '').trim();
  if (!candidate) return null;
  if (/^\d+$/.test(candidate)) {
    const milliseconds = Number(candidate);
    return Number.isSafeInteger(milliseconds) && milliseconds > 0
      ? milliseconds
      : null;
  }

  const tokens = /(\d+)(ms|min|s)/g;
  let index = 0;
  let milliseconds = 0;
  const units = new Set();
  let match;

  while ((match = tokens.exec(candidate)) !== null) {
    if (match.index !== index || units.has(match[2])) return null;
    index = tokens.lastIndex;
    units.add(match[2]);

    const amount = Number(match[1]);
    const multiplier = match[2] === 'min' ? 60_000 : match[2] === 's' ? 1_000 : 1;
    if (!Number.isSafeInteger(amount) || amount < 0) return null;
    milliseconds += amount * multiplier;
    if (!Number.isSafeInteger(milliseconds)) return null;
  }

  return index === candidate.length && milliseconds > 0 ? milliseconds : null;
}

function isWithinRange(value, range) {
  const number = Number(value);
  if (!Number.isFinite(number) || !range) return false;
  return (
    (range.min === null || number >= range.min) &&
    (range.max === null || number <= range.max)
  );
}

function describeIntegerRange(range) {
  if (!range) return '';
  if (range.min !== null && range.max !== null && range.min === range.max) {
    return String(range.min);
  }
  if (range.min !== null && range.max !== null) return `${range.min}..${range.max}`;
  if (range.min !== null) return `${range.min}..`;
  if (range.max !== null) return `..${range.max}`;
  return '';
}

module.exports = {
  parseIntegerRange,
  parseDuration,
  isWithinRange,
  describeIntegerRange,
};
