'use strict';

const { parseFeatureAccess } = require('./featureAccess');

const defaults = {
  featureAccess: {},
  notes: {
    engagedRate: 0.25, incidentalRate: 0.05, reviewEngagedRate: 0.5, reviewIncidentalRate: 0.15,
    relevanceLimit: 0.7, reviewRelevanceLimit: 0.9, minReviewVotes: 5, minPublicSample: 5,
    reviewRatio: 0.7, publicRatio: 0.75, rejectRatio: 0.7, quorumRate: 0.1,
    minIndependentAgeDays: 7, minLaterVotes: 5, laterRatio: 0.7, maxRatings: 200,
    maxCandidates: 500, maxNotesPerPost: 20, maxWeight: 1.3, penalty: 0.1,
  },
  dailyCaps: { trust: null, ban: 1 },
  trust: {
    Trusted: { minScore: 900, rateMultiplier: 1.5, queuePriority: 3, disabledFeatures: [], publicRatioReduction: 0.05, dailyNotes: null, ratingWeight: 1.3, publicBonus: 1, noteVisibility: 1 },
    Reliable: { minScore: 600, rateMultiplier: 1.3, queuePriority: 2, disabledFeatures: [], publicRatioReduction: 0.04, dailyNotes: null, ratingWeight: 1.2, publicBonus: 0.5, noteVisibility: 0.5 },
    Credible: { minScore: 300, rateMultiplier: 1.1, queuePriority: 1, disabledFeatures: [], publicRatioReduction: 0.02, dailyNotes: null, ratingWeight: 1.1, publicBonus: 0.25, noteVisibility: 0.25 },
    Neutral: { minScore: 0, rateMultiplier: 1, queuePriority: 0, disabledFeatures: [], publicRatioReduction: 0, dailyNotes: null, ratingWeight: 1, publicBonus: 0, noteVisibility: 0 },
    Questionable: { minScore: -10, rateMultiplier: 0.75, queuePriority: -1, disabledFeatures: ['notes'], publicRatioReduction: 0, dailyNotes: null, ratingWeight: 1, publicBonus: 0, noteVisibility: 0 },
    Suspicious: { minScore: -1000000, rateMultiplier: 0.5, queuePriority: -2, disabledFeatures: ['notes', 'uploads'], publicRatioReduction: 0, dailyNotes: null, ratingWeight: 1, publicBonus: 0, noteVisibility: 0 },
    Banned: { minScore: -1000001, rateMultiplier: 0.25, queuePriority: -3, disabledFeatures: ['write', 'notes', 'uploads'], publicRatioReduction: 0, dailyNotes: null, ratingWeight: 1, publicBonus: 0, noteVisibility: 0 },
  },
  positivePost: { minUsers: 5, minAgeDays: 30, minTrust: 0, award: 2 },
  penalties: { publicNote: -3, rejectedNote: -2, approvedReport: -5, falseReports: -3, falseReportRepeat: 3 },
};

function merge(base, input) {
  if (Array.isArray(base)) return structuredClone(input === undefined ? base : input);
  const out = {};
  for (const key of Object.keys(base)) {
    const value = input?.[key];
    out[key] = base[key] && typeof base[key] === 'object' ? merge(base[key], value) : (value === undefined ? base[key] : value);
  }
  if (input?.rateLimits !== undefined) out.rateLimits = { ...input.rateLimits };
  return out;
}

function buildPolicy(input = {}) {
  let overrides = {};
  if (process.env.NYAITTER_REPUTATION_CONFIG) overrides = JSON.parse(process.env.NYAITTER_REPUTATION_CONFIG);
  const configuredFeatures = parseFeatureAccess(input?.featureAccess);
  const overrideFeatures = parseFeatureAccess(overrides?.featureAccess);
  const policy = merge(merge(defaults, input), overrides);
  policy.featureAccess = { ...configuredFeatures, ...overrideFeatures };
  if (!input || typeof input!=='object' || Array.isArray(input) || !overrides || typeof overrides!=='object' || Array.isArray(overrides)) throw new Error('Reputation config must be an object');
  for (const [key, value] of Object.entries(policy.notes)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid reputation.notes.${key}`);
    if (/Rate$|Ratio$|relevanceLimit|RelevanceLimit/.test(key) && value > 1) throw new Error(`Invalid reputation.notes.${key}`);
  }
  if (policy.notes.minPublicSample < 5 || policy.notes.minReviewVotes < 3 || policy.notes.minLaterVotes < 3
    || policy.notes.maxRatings > 500 || policy.notes.maxCandidates > 2000 || policy.notes.maxNotesPerPost > 100
    || policy.notes.maxWeight < 1 || policy.notes.maxWeight > 1.5) throw new Error('Unsafe reputation note limits');
  if (policy.notes.penalty > 1 || policy.notes.minPublicSample > policy.notes.maxRatings) throw new Error('Unsafe reputation note limits');
  for (const key of ['minReviewVotes','minPublicSample','minLaterVotes','maxRatings','maxCandidates','maxNotesPerPost']) if (!Number.isInteger(policy.notes[key]) || policy.notes[key]<1) throw new Error(`Invalid reputation.notes.${key}`);
  for (const key of ['reviewRatio','publicRatio','rejectRatio','laterRatio']) if (policy.notes[key]<=0.5) throw new Error(`Unsafe reputation.notes.${key}`);
  if (policy.notes.reviewEngagedRate<policy.notes.engagedRate || policy.notes.reviewIncidentalRate<policy.notes.incidentalRate || policy.notes.reviewRelevanceLimit<policy.notes.relevanceLimit) throw new Error('Review distribution must not shrink');
  const benefitOrder = ['Neutral', 'Credible', 'Reliable', 'Trusted'];
  for (const rank of Object.values(policy.trust)) {
    if (!Number.isFinite(rank.publicRatioReduction) || rank.publicRatioReduction < 0 || policy.notes.publicRatio - rank.publicRatioReduction < 0.6) throw new Error('Unsafe trust public ratio reduction');
    if (!(rank.dailyNotes === null || (Number.isInteger(rank.dailyNotes) && rank.dailyNotes >= 1 && rank.dailyNotes <= 20))) throw new Error('Invalid trust daily notes');
    if (!Number.isFinite(rank.ratingWeight) || rank.ratingWeight < 1 || rank.ratingWeight > policy.notes.maxWeight) throw new Error('Unsafe trust rating weight');
    if (!Number.isFinite(rank.publicBonus) || rank.publicBonus < 0 || rank.publicBonus > 1) throw new Error('Invalid trust public bonus');
    if (!Number.isFinite(rank.noteVisibility) || rank.noteVisibility < 0 || rank.noteVisibility > 1) throw new Error('Invalid trust note visibility');
  }
  benefitOrder.forEach((rank, i) => {
    if (!i) return;
    const rules = policy.trust[rank], previous = policy.trust[benefitOrder[i - 1]];
    if (rules.publicRatioReduction < previous.publicRatioReduction || rules.ratingWeight < previous.ratingWeight
      || rules.publicBonus < previous.publicBonus || rules.noteVisibility < previous.noteVisibility
      || (previous.dailyNotes === null && rules.dailyNotes !== null)
      || (rules.dailyNotes !== null && previous.dailyNotes !== null && rules.dailyNotes < previous.dailyNotes)) throw new Error('Trust benefits must not shrink');
  });
  if (policy.trust.Neutral.publicRatioReduction !== 0 || policy.trust.Neutral.ratingWeight !== 1 || policy.trust.Neutral.publicBonus !== 0 || policy.trust.Neutral.noteVisibility !== 0) throw new Error('Neutral trust effects must be neutral');
  if (policy.trust.Trusted.noteVisibility !== 1) throw new Error('Trusted note visibility must be full');
  for (const rank of Object.values(policy.trust)) {
    if (!Number.isFinite(rank.minScore) || !Number.isFinite(rank.rateMultiplier) || rank.rateMultiplier <= 0 || rank.rateMultiplier > 2
      || !Number.isInteger(rank.queuePriority) || Math.abs(rank.queuePriority) > 5 || !Array.isArray(rank.disabledFeatures)
      || rank.disabledFeatures.some(f => !['write', 'notes', 'uploads', 'dm'].includes(f))) throw new Error('Invalid trust policy');
    if (rank.rateLimits && Object.values(rank.rateLimits).some(v => !Number.isInteger(v) || v < 1)) throw new Error('Invalid trust rate limits');
  }
  const ordered=['Trusted','Reliable','Credible','Neutral','Questionable'];
  if (policy.trust.Neutral.minScore!==0 || ordered.some((rank,i)=>i && policy.trust[ordered[i-1]].minScore<=policy.trust[rank].minScore)) throw new Error('Trust thresholds must decrease through Neutral=0');
  if (policy.trust.Suspicious.minScore>=policy.trust.Questionable.minScore || policy.trust.Banned.minScore>policy.trust.Suspicious.minScore) throw new Error('Trust thresholds must decrease through Neutral=0');
  if (!Number.isInteger(policy.positivePost.minUsers) || policy.positivePost.minUsers<3 || !Number.isFinite(policy.positivePost.minAgeDays) || policy.positivePost.minAgeDays<0 || !Number.isFinite(policy.positivePost.minTrust) || !Number.isFinite(policy.positivePost.award) || policy.positivePost.award<0 || policy.positivePost.award>10) throw new Error('Invalid positive post evidence');
  for (const [dimension, cap] of Object.entries(policy.dailyCaps)) if (!(dimension !== 'ban' && cap === null) && (!Number.isFinite(cap) || cap < 0 || cap > 100)) throw new Error('Invalid reputation daily cap');
  for (const [key, value] of Object.entries(policy.penalties)) if (!Number.isFinite(value) || (key === 'falseReportRepeat' ? !Number.isInteger(value) || value < 2 : value > 0 || value < -100)) throw new Error('Invalid reputation penalty');
  return policy;
}

function trustRank(profile, policy) {
  if (Number(profile?.ban?.score || 0) > 0) return 'Banned';
  return ['Trusted', 'Reliable', 'Credible', 'Neutral', 'Questionable'].find(rank => Number(profile?.trust?.score || 0) >= policy.trust[rank].minScore) || 'Suspicious';
}

module.exports = { buildPolicy, trustRank };
