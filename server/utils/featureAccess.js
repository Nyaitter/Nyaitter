'use strict';

const { parseIntegerRange, isWithinRange, describeIntegerRange } = require('./settingFormats');

const trustNumbers = Object.freeze({ Trusted: 3, Reliable: 2, Credible: 1, Neutral: 0, Questionable: -1, Suspicious: -2, Banned: -3 });
const featureNames = Object.freeze(['write', 'posts', 'polls', 'notes', 'uploads', 'dm', 'call', 'spaces', 'groups']);

function parseFeatureAccess(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid reputation.featureAccess');
  return Object.fromEntries(Object.entries(value).map(([feature, setting]) => {
    const range = (typeof setting === 'string' || typeof setting === 'number')
      ? parseIntegerRange(setting, { minimum: -3, maximum: 3 }) : null;
    if (!featureNames.includes(feature) || !range) throw new Error('Invalid reputation.featureAccess.' + feature);
    return [feature, describeIntegerRange(range)];
  }));
}

function hasFeatureAccess(policy, rank, features) {
  if (!Object.hasOwn(trustNumbers, rank) || !Array.isArray(features)) return false;
  return features.every(feature => {
    if (!featureNames.includes(feature) || policy.trust[rank].disabledFeatures.includes(feature)) return false;
    const setting = policy.featureAccess?.[feature];
    return setting === undefined || isWithinRange(trustNumbers[rank], parseIntegerRange(setting, { minimum: -3, maximum: 3 }));
  });
}

function requestFeatures(req, apiEndpoint = '/') {
  if (['GET', 'HEAD', 'OPTIONS'].includes(String(req.method).toUpperCase())) return [];
  let path = decodeURIComponent(String(req.originalUrl || req.url || '').split('?')[0]).toLowerCase();
  const prefix = apiEndpoint.replace(/\/$/, '').toLowerCase();
  if (prefix && (path === prefix || path.startsWith(prefix + '/'))) path = path.slice(prefix.length);
  path = path.replace(/^\/api(?=\/|$)/, '');
  const parts = path.split('/').filter(Boolean);
  const resource = parts[0];
  if (['auth', 'reports', 'appeals', 'verification-applications'].includes(resource)
    || (resource === 'users' && parts[1] === 'me')
    || (resource === 'users' && parts[2] === 'block')) return [];
  const features = ['write'];
  if ((resource === 'notes' || resource === 'posts' && parts[2] === 'notes') && String(req.method).toUpperCase() !== 'DELETE') features.push('notes');
  else if (['posts', 'polls', 'uploads', 'dm', 'spaces', 'groups'].includes(resource)) features.push(resource);
  if (resource === 'calls') features.push('call');
  return features;
}

function realtimeFeatures(message) {
  const type = message?.type;
  if (typeof type !== 'string' || ['call:leave', 'space:leave_voice', 'space:subscribe', 'space:unsubscribe'].includes(type)) return [];
  if (type.startsWith('call:')) return ['write', 'call', ...(message.kind === 'dm' ? ['dm'] : [])];
  if (['space:join_voice', 'space:voice_state', 'space:signal'].includes(type)) return ['write', 'spaces', 'call'];
  return [];
}

async function enforceRealtimeAccess(db, principal, message, policy) {
  const features = realtimeFeatures(message);
  if (!features.length) return true;
  if (principal.guest === true) return hasFeatureAccess(policy, 'Neutral', features);
  const user = await db.getUserById(principal.id);
  if (!user || user.freeze || user.account_operation) return false;
  if (user.admin === true) return true;
  const { trustRank } = require('./reputationPolicy');
  const profile = await db.getReputationProfile(principal.id);
  return hasFeatureAccess(policy, trustRank(profile, policy), features);
}

module.exports = { trustNumbers, featureNames, parseFeatureAccess, hasFeatureAccess, requestFeatures, realtimeFeatures, enforceRealtimeAccess };
