'use strict';

const NUMERIC_HASHTAG_REGEX = /#(\d+)(?=$|[<>\/@#\s])/g;

function extractNumericHashtagUserIds(content) {
  if (content == null) return [];
  const ids = new Set();
  NUMERIC_HASHTAG_REGEX.lastIndex = 0;
  let match;
  while ((match = NUMERIC_HASHTAG_REGEX.exec(String(content))) !== null) {
    const id = Number(match[1]);
    if (Number.isSafeInteger(id) && id > 0) ids.add(id);
  }
  return [...ids];
}

function isMentionedInText(content, userId) {
  if (content == null || userId == null) return false;
  const id = Number(userId);
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  const text = String(content);
  if (new RegExp(`@${id}\\b`).test(text)) return true;
  return extractNumericHashtagUserIds(text).includes(id);
}

module.exports = {
  NUMERIC_HASHTAG_REGEX,
  extractNumericHashtagUserIds,
  isMentionedInText,
};