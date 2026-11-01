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
  dailyCaps: { trust: null, writer: null, reviewer: null, ban: 1 },
  reviewerVisibility: [0, 0.1, 0.25, 0.5, 0.75, 1],
  writer: [
    { score: 0, successes: 0, dailyNotes: null, publicRatioReduction: 0 },
    { score: 180, successes: 10, dailyNotes: null, publicRatioReduction: 0.01 },
    { score: 360, successes: 30, dailyNotes: null, publicRatioReduction: 0.02 },
    { score: 540, successes: 60, dailyNotes: null, publicRatioReduction: 0.03 },
    { score: 720, successes: 120, dailyNotes: null, publicRatioReduction: 0.04 },
    { score: 900, successes: 180, dailyNotes: null, publicRatioReduction: 0.05 },
  ],
  reviewer: [
    { score: 0, successes: 0, weight: 1, writerBonus: 0 },
    { score: 360, successes: 20, weight: 1.05, writerBonus: 0.1 },
    { score: 720, successes: 60, weight: 1.1, writerBonus: 0.25 },
    { score: 1080, successes: 120, weight: 1.15, writerBonus: 0.5 },
    { score: 1440, successes: 240, weight: 1.2, writerBonus: 0.75 },
    { score: 1800, successes: 360, weight: 1.3, writerBonus: 1 },
  ],
  trust: {
    Trusted: { minScore: 900, rateMultiplier: 1.5, queuePriority: 3, disabledFeatures: [] },
    Reliable: { minScore: 600, rateMultiplier: 1.3, queuePriority: 2, disabledFeatures: [] },
    Credible: { minScore: 300, rateMultiplier: 1.1, queuePriority: 1, disabledFeatures: [] },
    Neutral: { minScore: 0, rateMultiplier: 1, queuePriority: 0, disabledFeatures: [] },
    Questionable: { minScore: -10, rateMultiplier: 0.75, queuePriority: -1, disabledFeatures: ['notes'] },
    Suspicious: { minScore: -1000000, rateMultiplier: 0.5, queuePriority: -2, disabledFeatures: ['notes', 'uploads'] },
    Banned: { minScore: -1000001, rateMultiplier: 0.25, queuePriority: -3, disabledFeatures: ['write', 'notes', 'uploads'] },
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
  if (!Array.isArray(policy.reviewerVisibility) || policy.reviewerVisibility.length !== defaults.reviewer.length
    || policy.reviewerVisibility[0] !== 0
    || policy.reviewerVisibility.at(-1) !== 1 || policy.reviewerVisibility.slice(0, -1).includes(1)
    || policy.reviewerVisibility.some((value, i, values) => !Number.isFinite(value) || value < 0 || value > 1 || (i > 0 && value < values[i - 1]))) throw new Error('Invalid reviewer visibility');
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
  for (const dimension of ['writer', 'reviewer']) {
    if (!Array.isArray(policy[dimension]) || policy[dimension].length !== defaults[dimension].length) throw new Error(`Invalid ${dimension} ranks`);
    policy[dimension].forEach((rank, i) => {
      if (!rank || typeof rank !== 'object' || Array.isArray(rank)) throw new Error(`Invalid ${dimension} rank`);
      for (const [key, value] of Object.entries(rank)) if (!(dimension === 'writer' && key === 'dailyNotes' && value === null) && (!Number.isFinite(value) || value < 0)) throw new Error(`Invalid ${dimension} rank`);
      if (!Number.isFinite(rank.score) || rank.score < 0 || !Number.isFinite(rank.successes) || rank.successes < 0) throw new Error('Invalid rank thresholds');
      if (!i && (rank.score !== 0 || rank.successes !== 0)) throw new Error('Initial rank thresholds must be zero');
      if (i && (rank.score <= policy[dimension][i - 1].score || rank.successes <= policy[dimension][i - 1].successes)) throw new Error('Rank thresholds must increase');
      if (!Number.isInteger(rank.successes)) throw new Error('Rank successes must be an integer');
      if (dimension === 'writer' && (!Number.isFinite(rank.publicRatioReduction) || rank.publicRatioReduction < 0 || policy.notes.publicRatio-rank.publicRatioReduction < 0.6 || (!i && rank.publicRatioReduction !== 0) || (rank.dailyNotes !== null && (!Number.isInteger(rank.dailyNotes) || rank.dailyNotes < 1 || rank.dailyNotes>20)))) throw new Error('Unsafe writer limits');
      if (dimension === 'reviewer' && (!Number.isFinite(rank.weight) || !Number.isFinite(rank.writerBonus) || rank.weight < 1 || rank.weight > policy.notes.maxWeight || rank.writerBonus < 0 || rank.writerBonus > 1)) throw new Error('Unsafe reviewer weight');
      const previous=policy[dimension][i - 1];
      if (i && (dimension === 'writer' ? rank.publicRatioReduction < previous.publicRatioReduction || (previous.dailyNotes === null && rank.dailyNotes !== null) || (rank.dailyNotes !== null && previous.dailyNotes !== null && rank.dailyNotes < previous.dailyNotes) : rank.weight < previous.weight || rank.writerBonus < previous.writerBonus)) throw new Error('Rank benefits must not shrink');
    });
  }
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

function rankOf(profile, ranks) {
  let rank = 0;
  ranks.forEach((threshold, i) => {
    if (Number(profile?.score || 0) >= threshold.score && Number(profile?.successes || 0) >= threshold.successes) rank = i;
  });
  return rank;
}

function trustRank(profile, policy) {
  if (Number(profile?.ban?.score || 0) > 0) return 'Banned';
  return ['Trusted', 'Reliable', 'Credible', 'Neutral', 'Questionable'].find(rank => Number(profile?.trust?.score || 0) >= policy.trust[rank].minScore) || 'Suspicious';
}

module.exports = { buildPolicy, rankOf, trustRank };
