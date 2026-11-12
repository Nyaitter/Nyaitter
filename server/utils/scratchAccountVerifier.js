const { verifyScratchComment } = require('./scratchVerifier');
const config = require('../config');

const IphubAPIKey = process.env.IPHUB_KEY;
const scratchVerificationPolicy = config.auth.scratchVerification;
const SCRATCH_REQUEST_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url, options = {}, timeoutMs = SCRATCH_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
// Any operational exception must be explicit in environment configuration;
// production code must not embed permanent authentication bypass accounts.
const TrustedUsers = new Set(
  String(process.env.TRUSTED_SCRATCH_USERS || '')
    .split(',')
    .map((username) => username.trim().toLowerCase())
    .filter(Boolean),
);

/**
 * IPHubでIPの評価を行う
 */
async function checkIpWithIphub(ip) {
  if (!scratchVerificationPolicy.ipRestrictionEnabled) {
    return { ok: true, skipped: true };
  }
  if (!IphubAPIKey) {
    console.warn('[scratchAccountVerifier] IPHUB_KEY が設定されていないため、IPチェックをスキップします');
    return { ok: true, skipped: true };
  }

  try {
    const res = await fetchWithTimeout(`https://v2.api.iphub.info/ip/${encodeURIComponent(ip)}`, {
      headers: { "X-Key": IphubAPIKey }
    });

    if (!res.ok) {
      return { ok: false, error: `IPHub API error: ${res.status}` };
    }

    const data = await res.json();

    if (data.block && data.block >= 1) {
      return { ok: false, reason: "VPN/Proxy/Anonymity network is not allowed." };
    }
    if (data.countryCode && data.countryCode !== 'JP') {
      return { ok: false, reason: "Service is only available in Japan." };
    }

    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Scratchプロフィールページから基本情報を取得・解析
 */
async function checkScratchProfile(username) {
  try {
    const res = await fetchWithTimeout(`https://scratch.mit.edu/users/${encodeURIComponent(username)}/`);
    if (!res.ok) {
      return { ok: false, error: `Scratch profile fetch failed: ${res.status}` };
    }

    const html = await res.text();
    const cleanHtml = html.replace(/<script[\s\S]*?<\/script>/gi, "");

    if (!cleanHtml.includes('<span class="location">Japan</span>')) {
      return { ok: false, reason: "Not available in your region." };
    }
    if (!cleanHtml.includes('Scratcher')) {
      return { ok: false, reason: "Nyaitterの利用条件を満たしていません。" };
    }
    if (scratchVerificationPolicy.rejectNewScratcher && cleanHtml.includes('New Scratcher')) {
      return { ok: false, reason: "NewScratcherのScratchIDでは利用できません。" };
    }
    if (username.length < 4) {
      return { ok: false, reason: "ユーザー名が短すぎます。" };
    }

    if (
      scratchVerificationPolicy.rejectStudentAccounts &&
      /<a[^>]*href="(?!.users)[^"]class[^"]"[^>]>/i.test(cleanHtml)
    ) {
      return { ok: false, reason: "生徒アカウントでは利用できません。" };
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * フォロワー数を厳密にカウントする
 */
async function countQualifiedFollowers(username, minimum = scratchVerificationPolicy.minQualifiedFollowers) {
  if (TrustedUsers.has(String(username).toLowerCase())) {
    return 999;
  }

  const THREE_MONTHS_AGO = new Date();
  THREE_MONTHS_AGO.setMonth(THREE_MONTHS_AGO.getMonth() - 3);

  let offset = 0;
  const limit = 40;
  let validFollowerCount = 0;
  let hasMore = true;

  while (hasMore && validFollowerCount < minimum) {
    try {
      const res = await fetchWithTimeout(
        `https://api.scratch.mit.edu/users/${encodeURIComponent(username)}/followers?limit=${limit}&offset=${offset}`
      );
      if (!res.ok) break;

      const followers = await res.json();
      if (!Array.isArray(followers) || !followers.length) break;

      for (const f of followers) {
        if (
          f.history?.joined &&
          new Date(f.history.joined) < THREE_MONTHS_AGO &&
          f.profile?.country === "Japan" &&
          f.username &&
          f.username.length >= 4
        ) {
          validFollowerCount++;
        }
      }

      if (followers.length < limit) {
        hasMore = false;
      } else {
        offset += limit;
        if (offset > 200) break;
      }
    } catch (e) {
      break;
    }
  }

  return validFollowerCount;
}

/**
 * 総合的なScratchアカウント検証
 */
async function verifyScratchAccount(username, code, ip) {
  if (TrustedUsers.has(String(username).toLowerCase())) {
    return { ok: true, skipped: true };
  }

  const ipCheck = await checkIpWithIphub(ip);
  if (!ipCheck.ok) {
    return { ok: false, reason: ipCheck.reason || ipCheck.error };
  }

  const profileCheck = await checkScratchProfile(username);
  if (!profileCheck.ok) {
    return { ok: false, reason: profileCheck.reason || profileCheck.error };
  }

  const minimumFollowers = scratchVerificationPolicy.minQualifiedFollowers;
  if (minimumFollowers > 0) {
    const followerCount = await countQualifiedFollowers(username, minimumFollowers);
    if (followerCount < minimumFollowers) {
      return {
        ok: false,
        reason: `信頼できるフォロワー数の条件を満たしていません(${followerCount}/${minimumFollowers})。`
      };
    }
  }

  const isVerified = await verifyScratchComment(username, code);
  if (!isVerified) {
    return { ok: false, reason: "指定されたコードがScratchのコメントに見つかりませんでした。" };
  }

  return { ok: true };
}

module.exports = {
  verifyScratchAccount,
  checkIpWithIphub,
  countQualifiedFollowers,
};
