const crypto = require('crypto');
const config = require('../config');

const TARGET_PROJECT_ID = process.env.SCRATCH_PROJECT_ID || '1239738451';
const PROJECT_OWNER_USERNAME = process.env.SCRATCH_PROJECT_OWNER || 'NyaitterTeam';

// メモリ上に保存する一時的なコード (username -> { code, expiresAt })
const pendingCodes = new Map();

/**
 * 検証コードを生成する
 * @param {string} username - Scratchユーザー名
 * @returns {{ code: string, expiresAt: number }}
 */
function generateVerificationCode(username) {
  const code = crypto.randomBytes(config.auth?.verificationCodeBytes || 4).toString('hex').toUpperCase();
  const msPerMinute = 1000 * 60;
  const expiryMins = config.auth?.verificationCodeExpiryMinutes || 10;
  const expiresAt = Date.now() + msPerMinute * expiryMins;

  pendingCodes.set(username.toLowerCase(), { code, expiresAt });

  for (const [key, value] of pendingCodes.entries()) {
    if (value.expiresAt < Date.now()) {
      pendingCodes.delete(key);
    }
  }

  return { code, expiresAt };
}

/**
 * HTMLエンティティデコード & タグ除去ヘルパー
 */
function decodeHtmlEntities(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * タイムアウト付き fetch ヘルパー
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Scratchのコメント（プロジェクト / プロフィール）から検証コードを探す
 * @param {string} username Scratchユーザー名
 * @param {string} code 検証コード
 * @returns {Promise<boolean>}
 */
async function verifyScratchComment(username, code) {
  if (!username || !code) return false;

  const targetUser = username.trim().toLowerCase();
  const targetCode = code.trim().toUpperCase();

  try {
    const projectCommentsUrl = `https://api.scratch.mit.edu/users/${PROJECT_OWNER_USERNAME}/projects/${TARGET_PROJECT_ID}/comments?limit=40&offset=0`;
    const res = await fetchWithTimeout(projectCommentsUrl);

    if (res.ok) {
      const comments = await res.json();
      if (Array.isArray(comments)) {
        const found = comments.some(c => {
          const author = (c.author?.username || '').trim().toLowerCase();
          const content = (c.content || '').trim().toUpperCase();
          return author === targetUser && content.includes(targetCode);
        });

        if (found) {
          console.log(`[scratchVerifier] コード検証成功 (Project REST API): user=${username}`);
          return true;
        }
      }
    }
  } catch (err) {
    console.warn('[scratchVerifier] Project REST API fetch warning:', err.message);
  }

  try {
    const profileCommentsUrl = `https://scratch.mit.edu/site-api/comments/user/${encodeURIComponent(username)}/?cache=${Date.now()}`;
    const res = await fetchWithTimeout(profileCommentsUrl);

    if (res.ok) {
      const html = await res.text();
      const commentRegex = /<a[^>]*data-comment-user="([^\"]+)"[^>]*>[\s\S]*?<div class="content">([\s\S]*?)<\/div>/gmi;
      let match;

      while ((match = commentRegex.exec(html)) !== null) {
        const commentUser = (match[1] || '').trim().toLowerCase();
        const rawContent = match[2] || '';
        const decodedContent = decodeHtmlEntities(rawContent).toUpperCase();

        if (commentUser === targetUser && decodedContent.includes(targetCode)) {
          console.log(`[scratchVerifier] コード検証成功 (Profile Site API): user=${username}`);
          return true;
        }
      }
    }
  } catch (err) {
    console.warn('[scratchVerifier] Profile Site API fetch warning:', err.message);
  }

  try {
    const siteProjectCommentsUrl = `https://scratch.mit.edu/site-api/comments/project/${TARGET_PROJECT_ID}/?cache=${Date.now()}`;
    const res = await fetchWithTimeout(siteProjectCommentsUrl);

    if (res.ok) {
      const html = await res.text();
      const commentRegex = /<a[^>]*data-comment-user="([^\"]+)"[^>]*>[\s\S]*?<div class="content">([\s\S]*?)<\/div>/gmi;
      let match;

      while ((match = commentRegex.exec(html)) !== null) {
        const commentUser = (match[1] || '').trim().toLowerCase();
        const rawContent = match[2] || '';
        const decodedContent = decodeHtmlEntities(rawContent).toUpperCase();

        if (commentUser === targetUser && decodedContent.includes(targetCode)) {
          console.log(`[scratchVerifier] コード検証成功 (Project Site API): user=${username}`);
          return true;
        }
      }
    }
  } catch (err) {
    console.warn('[scratchVerifier] Project Site API fetch warning:', err.message);
  }

  console.warn(`[scratchVerifier] コードが見つかりませんでした: user=${username}, code=${code}`);
  return false;
}

/**
 * 検証コードが有効か確認し、成功したら消費する
 */
async function checkAndConsumeCode(username, code) {
  const record = pendingCodes.get(username.toLowerCase());
  if (!record) {
    return { success: false, reason: 'コードが見つかりません。再度「コードを取得」してください。' };
  }
  if (record.expiresAt < Date.now()) {
    pendingCodes.delete(username.toLowerCase());
    return { success: false, reason: 'コードの有効期限が切れています。再度コードを取得してください。' };
  }

	const cleanInputCode = code.trim().toUpperCase();
	const expected = Buffer.from(record.code.toUpperCase(), 'utf8');
	const actual = Buffer.from(cleanInputCode, 'utf8');
	if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
		return { success: false, reason: '入力されたコードが一致しません。' };
	}

  const isVerified = await verifyScratchComment(username, cleanInputCode);
  if (!isVerified) {
    return {
      success: false,
      reason: 'Scratchの指定プロジェクトまたはプロフィールコメントにコードが見つかりませんでした。コメントした直後の場合は数秒置いて再度お試しください。'
    };
  }

  pendingCodes.delete(username.toLowerCase());
  return { success: true };
}

module.exports = {
  generateVerificationCode,
  checkAndConsumeCode,
  verifyScratchComment,
};
