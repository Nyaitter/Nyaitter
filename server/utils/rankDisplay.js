'use strict';

const { rankOf, trustRank } = require('./reputationPolicy');
const { reputation: policy } = require('../config');
const trustOrder = ['Trusted', 'Reliable', 'Credible', 'Neutral'];
const attachedRanks = new WeakMap();

function actualRanks(profile) {
  return { trust: trustRank(profile, policy), writer: rankOf(profile.writer, policy.writer), reviewer: rankOf(profile.reviewer, policy.reviewer) };
}

function displayOptions(actual) {
  const index = trustOrder.indexOf(actual.trust);
  return {
    trust: index >= 0 ? trustOrder.slice(index + 1) : [],
    writer: Array.from({ length: actual.writer }, (_, rank) => rank),
    reviewer: Array.from({ length: actual.reviewer }, (_, rank) => rank),
  };
}

function displayRanks(actual, overrides = {}) {
  const options = displayOptions(actual);
  return Object.fromEntries(Object.entries(actual).map(([key, rank]) => [key, options[key].includes(overrides?.[key]) ? overrides[key] : rank]));
}

function validateDisplaySettings(settings, actual) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return '設定はオブジェクトで指定してください';
  if (Object.hasOwn(settings, 'show_ranks') && typeof settings.show_ranks !== 'boolean') return 'ランク表示の設定は真偽値で指定してください';
  if (!Object.hasOwn(settings, 'display_ranks')) return null;
  const overrides = settings.display_ranks;
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return '表示ランクの指定が正しくありません';
  const options = displayOptions(actual);
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(options, key) || (value !== null && !options[key].includes(value))) return '表示ランクは現在より低いランクを指定してください';
  }
  return null;
}

function ownDisplaySettings(settings = {}, actual = null) {
  const overrides = settings.display_ranks;
  const options = actual ? displayOptions(actual) : { trust: trustOrder, writer: policy.writer.map((_, rank) => rank), reviewer: policy.reviewer.map((_, rank) => rank) };
  return { show_ranks: settings.show_ranks === true, display_ranks: Object.fromEntries(Object.entries(options).map(([key, ranks]) => [key, ranks.includes(overrides?.[key]) ? overrides[key] : null])) };
}

async function attachDisplayRanks(db, users) {
  const records = (users || []).filter(user => user && Number.isSafeInteger(Number(user.id)) && Number(user.id) > 0);
  const ids = [...new Set(records.map(user => Number(user.id)))];
  if (!ids.length) return users;
  const context = await db.getReputationDisplayContext(ids);
  const currentUsers = new Map(context.users.filter(Boolean).map(user => [Number(user.id), user]));
  for (const user of records) {
    const current = currentUsers.get(Number(user.id));
    if (!current) { attachedRanks.delete(user); continue; }
    const actual = actualRanks(context.profiles[Number(user.id)] || {});
    attachedRanks.set(user, { actual, display: displayRanks(actual, current.settings?.display_ranks) });
  }
  return users;
}

function publicDisplayRanks(user) {
  return attachedRanks.get(user)?.display || null;
}

function ownDisplaySettingsForUser(user) {
  return ownDisplaySettings(user.settings, attachedRanks.get(user)?.actual);
}

module.exports = { ownDisplaySettingsForUser, actualRanks, displayRanks, displayOptions, validateDisplaySettings, ownDisplaySettings, attachDisplayRanks, publicDisplayRanks };
