const express = require('express');
const crypto = require('crypto');
const {
  generateVerificationCode,
  verifyPendingCode,
  consumeVerificationCode,
} = require('../utils/scratchVerifier');

const { verifyScratchAccount } = require('../utils/scratchAccountVerifier');
const SessionManager = require('../services/auth/SessionManager');
const BotTokenManager = require('../services/auth/BotTokenManager');
const ExternalLoginStateStore = require('../services/auth/ExternalLoginStateStore');
const ExternalLoginProofStore = require('../services/auth/ExternalLoginProofStore');
const { normalizeExternalProfile } = require('../services/auth/ExternalProfileMapper');
const { requireAuth, requireAuthAllowFrozen, optionalAuth } = require('../middleware/auth');

const config = require('../config');
const { isWithinRange } = require('../utils/settingFormats');
const { serializeUser, serializeNotification } = require('../utils/serialize');
const {
  formatNyaitterId,
  getPublicUrl,
  getUserNyaitterAddress,
  getUserNyaitterId,
  parseNyaitterAddress,
} = require('../utils/nyaitterAddress');
const {
  getRequestLoginMetadata,
  generateApprovalPollToken,
  hashApprovalPollToken,
  isUnknownLoginProtectionEnabled,
} = require('../services/auth/LoginSecurityService');

const router = express.Router();
const externalLoginStateStore = new ExternalLoginStateStore();
const externalLoginProofStore = new ExternalLoginProofStore();

function getDbAdapter(req) {
  return req.app.locals.dbAdapter;
}

function isValidScratchUsername(username) {
  return (
    typeof username === 'string' &&
    /^[a-zA-Z0-9_-]+$/.test(username) &&
    isWithinRange(username.length, config.limits.scratchUsernameLength)
  );
}

function requireInteractiveSession(req, res, next) {
  if (req.user?.tokenType !== 'session') {
    return res.status(403).json({ error: 'この操作にはログイン済み端末のセッションが必要です。' });
  }
  return next();
}

function serializeLoginUser(user, req) {
  return {
    id: user.id,
    nyaitter_id: getUserNyaitterId(user),
    name: user.name,
    scid: user.scid || null,
    handle: getUserNyaitterId(user),
    nyaitter_address: getUserNyaitterAddress(user, req),
    auth_provider: user.auth_provider,
    provider_domain: user.provider_domain || null,
    external_profile: user.external_profile || null,
  };
}

function setSessionCookie(res, token, expiresAt) {
  const maxAge = expiresAt
    ? new Date(expiresAt).getTime() - Date.now()
    : 30 * 24 * 60 * 60 * 1000;
  const isProduction = (process.env.NODE_ENV || 'development') === 'production';

  res.cookie('nyaitter_session', token, {
    httpOnly: true,
    secure: isProduction,
    path: '/',
    maxAge: Math.max(maxAge, 3600000),
    sameSite: 'lax',
  });
}

function clearSessionCookie(res) {
  res.clearCookie('nyaitter_session', { path: '/' });
}

const REMEMBERED_ACCOUNTS_COOKIE = 'nyaitter_accounts';
const MAX_REMEMBERED_ACCOUNTS = 8;
// 本番では環境変数を指定すると再起動後も記憶済みアカウントを維持できる。
// 未指定時はプロセスごとの乱数を使い、推測可能な既定鍵を使わない。
const rememberedAccountsSecret = process.env.MULTI_ACCOUNT_COOKIE_SECRET
  || crypto.randomBytes(32).toString('base64url');

function getCookieValue(req, name) {
  const escapedName = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${escapedName}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function signRememberedAccounts(payload) {
  return crypto.createHmac('sha256', rememberedAccountsSecret)
    .update(payload)
    .digest('base64url');
}

function readRememberedAccounts(req) {
  const value = getCookieValue(req, REMEMBERED_ACCOUNTS_COOKIE);
  if (!value) return [];
  const separator = value.lastIndexOf('.');
  if (separator <= 0) return [];
  const payload = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expectedSignature = signRememberedAccounts(payload);
  if (signature.length !== expectedSignature.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    return [];
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed)) return [];
    const seen = new Set();
    return parsed
      .filter((entry) => entry && typeof entry.token === 'string' && Number.isInteger(Number(entry.userId)))
      .map((entry) => ({ token: entry.token, userId: Number(entry.userId) }))
      .filter((entry) => {
        if (seen.has(entry.token)) return false;
        seen.add(entry.token);
        return true;
      })
      .slice(0, MAX_REMEMBERED_ACCOUNTS);
  } catch (_) {
    return [];
  }
}

function setRememberedAccountsCookie(res, accounts) {
  const normalized = (accounts || [])
    .filter((entry) => entry && typeof entry.token === 'string' && Number.isInteger(Number(entry.userId)))
    .map((entry) => ({ token: entry.token, userId: Number(entry.userId) }))
    .slice(0, MAX_REMEMBERED_ACCOUNTS);
  if (normalized.length === 0) {
    res.clearCookie(REMEMBERED_ACCOUNTS_COOKIE, { path: '/' });
    return;
  }
  const payload = Buffer.from(JSON.stringify(normalized), 'utf8').toString('base64url');
  const isProduction = (process.env.NODE_ENV || 'development') === 'production';
  res.cookie(REMEMBERED_ACCOUNTS_COOKIE, `${payload}.${signRememberedAccounts(payload)}`, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

function rememberAccountSession(req, res, session) {
  const existing = readRememberedAccounts(req)
    .filter((entry) => entry.token !== session.token && entry.userId !== Number(session.userId));
  setRememberedAccountsCookie(res, [
    { token: session.token, userId: Number(session.userId) },
    ...existing,
  ]);
}

function setAuthenticatedSessionCookies(req, res, session) {
  setSessionCookie(res, session.token, session.expiresAt);
  rememberAccountSession(req, res, session);
}

async function getValidRememberedAccounts(req, db) {
  const remembered = readRememberedAccounts(req);
  const valid = [];
  for (const account of remembered) {
    const session = await db.getSessionByToken(SessionManager.hashToken(account.token));
    if (!session || Number(session.userId) !== account.userId) continue;
    const user = await db.getUserById(account.userId);
    if (!user) continue;
    valid.push({ ...account, session, user });
  }
  return valid;
}

function maskedIpUuid(ip) {
  return crypto
    .createHash('sha256')
    .update(String(ip || ''))
    .digest('hex')
    .slice(0, 32);
}

async function recordLoginLog(db, scid, userId, ip) {
  try {
    if (db && typeof db.addLog === 'function') {
      await db.addLog({
        scratch_id: scid,
        nyaitter_id: userId,
        masked_ip_uuid: maskedIpUuid(ip),
      });
    }
  } catch (err) {
    console.warn('[auth] login log record failed:', err.message);
  }
}

async function publishLoginApprovalNotification(req, userId, approval) {
  const db = getDbAdapter(req);
  const notification = await db.createNotification({
    userId,
    type: 'login_approval',
    fromUserId: null,
    target: { kind: 'route', value: `#login-approval/${approval.id}` },
  });
  const serialized = await serializeNotification(db, notification, getPublicUrl(req));
  const realtime = req.app.locals.realtime;
  if (realtime) await realtime.publishNewNotification(userId, serialized, db);
  const pushService = req.app.locals.pushNotificationService;
  if (pushService?.enabled) {
    void pushService.sendNotificationToUser(userId, serialized, {
      publicUrl: getPublicUrl(req),
    }).catch((error) => {
      console.warn('[auth] login approval push delivery failed:', error.message);
    });
  }
}

async function createAuthenticatedSession(req, res, user, metadata) {
  const db = getDbAdapter(req);
  const sessionManager = new SessionManager({ dbAdapter: db });
  const session = await sessionManager.createSession(user.id, metadata);
  setAuthenticatedSessionCookies(req, res, session);
  await recordLoginLog(db, user.scid || user.handle || '', user.id, req.ip);
  return session;
}

async function beginProtectedLogin(req, res, user) {
  const db = getDbAdapter(req);
  const metadata = getRequestLoginMetadata(req);
  const protectionEnabled = isUnknownLoginProtectionEnabled(user);
  const trusted = await db.getTrustedLoginIp(user.id, metadata.ipHash);
  const trustedIpCount = await db.countTrustedLoginIps(user.id);
  const existingSessions = trustedIpCount === 0 ? await db.getUserSessions(user.id) : [];

  // 初回ログインには通知を受け取る既存端末がないため、認証済みの初回ログインIPを信頼済みにする。
  // 既存セッションがある利用者は、移行直後で信頼IPがまだ未記録でも承認を求める。
  if (!protectionEnabled || trusted || (trustedIpCount === 0 && existingSessions.length === 0)) {
    if (!trusted) await db.trustLoginIp(user.id, metadata);
    const session = await createAuthenticatedSession(req, res, user, metadata);
    return { kind: 'authenticated', session };
  }

  const pollToken = generateApprovalPollToken();
  const approval = await db.createLoginApproval({
    userId: user.id,
    ipHash: metadata.ipHash,
    ipMasked: metadata.ipMasked,
    userAgent: metadata.userAgent,
    pollTokenHash: hashApprovalPollToken(pollToken),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
  await publishLoginApprovalNotification(req, user.id, approval);
  return { kind: 'approval_required', approval, pollToken };
}

function sendLoginResult(req, res, user, result, { external = false } = {}) {
  if (result.kind === 'approval_required') {
    return res.status(202).json({
      success: false,
      approval_required: true,
      approval_id: result.approval.id,
      approval_token: result.pollToken,
      expires_at: result.approval.expiresAt,
      message: 'この場所からのログインには、ログイン済み端末での許可が必要です。',
    });
  }

  const session = result.session;
	return res.json({
		success: true,
		expires_at: session.expiresAt,
		user: serializeLoginUser(user, req),
		...(external ? { note: 'Logged in via external Nyaitter server. Profile was inherited from the external instance.' } : {}),
	});
}

router.post('/scratch/generate', (req, res) => {
  const { username } = req.body;
  if (!username || typeof username !== 'string') {
    return res.status(400).json({ error: 'username is required' });
  }
  if (!isValidScratchUsername(username)) {
    return res.status(400).json({ error: 'Invalid Scratch username format' });
  }

  const { ipHash } = getRequestLoginMetadata(req);
  const { code, expiresAt } = generateVerificationCode(username, ipHash);

  res.json({
    code,
    expiresAt,
    profileUrl: `https://scratch.mit.edu/users/${username}/`,
  });
});

router.post('/scratch/verify', async (req, res) => {
  const { username, code } = req.body;
  // Express derives req.ip from X-Forwarded-For only when trust proxy is enabled.
  // Reading the header directly would allow an untrusted client to forge its IP.
  const ip = req.ip || req.socket?.remoteAddress || '127.0.0.1';
  const { ipHash } = getRequestLoginMetadata(req);

  if (!username || !code) {
    return res.status(400).json({ error: 'username and code are required' });
  }
  if (!isValidScratchUsername(username)) {
    return res.status(400).json({ error: 'Invalid Scratch username format' });
  }

  const bypassAuth = process.env.DEV_BYPASS_AUTH === 'true';
  const isProd = (process.env.NODE_ENV || 'development') === 'production';

  if (bypassAuth && isProd) {
    return res.status(403).json({ error: 'DEV_BYPASS_AUTH is disabled in production' });
  }

  if (!bypassAuth) {
    // コメントの反映待ちやアカウント条件の不一致でログインに失敗しても、コードは
    // 発行時の有効期限まで再試行できるよう、ここでは消費しない。
    const codeResult = await verifyPendingCode(username, code.toUpperCase(), ipHash);
    if (!codeResult.success) {
      return res.status(400).json({ error: codeResult.reason });
    }

    const accountCheck = await verifyScratchAccount(username, code, ip);
    if (!accountCheck.ok) {
      return res.status(400).json({ error: accountCheck.reason || 'Scratchアカウントの検証に失敗しました。' });
    }

    // コメントとアカウント条件の両方を通過した時点でだけ消費する。端末承認待ちも
    // 検証済みログインとして扱うため、承認経由でコードが残り続けることはない。
    const consumption = consumeVerificationCode(username, code, ipHash);
    if (!consumption.success) {
      return res.status(400).json({ error: consumption.reason });
    }
  } else {
    console.warn('[auth] DEV_BYPASS_AUTH が有効です。すべての検証をスキップしています。');
  }

  const db = getDbAdapter(req);

  let user = await db.getUserByScid(username);
  if (!user) {
    user = await db.createUser({
      scid: username,
      name: username,
      auth_provider: 'local',
    });
  }

  const result = await beginProtectedLogin(req, res, user);
  if (result.kind === 'authenticated') {
    console.log(`[auth] Scratch認証成功: ${username} (userId=${user.id})`);
  }
  return sendLoginResult(req, res, user, result);
});

/**
 * POST /server/auth/login-approvals/:approvalId/poll
 * 未承認端末が短命の承認トークンで状態を照合する。許可済みかつ同一IPの時だけセッションを発行する。
 */
router.post('/login-approvals/:approvalId/poll', async (req, res) => {
  const approvalId = String(req.params.approvalId || '');
  const pollToken = String(req.body?.approval_token || '');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(approvalId) || !/^[A-Za-z0-9_-]{20,128}$/.test(pollToken)) {
    return res.status(400).json({ error: '承認情報が無効です。ログインを最初からやり直してください。' });
  }

  const db = getDbAdapter(req);
  const approval = await db.getLoginApprovalByPollToken(approvalId, hashApprovalPollToken(pollToken));
  if (!approval) {
    return res.status(404).json({ error: '承認待ちログインが見つかりません。' });
  }
  if (approval.status === 'pending') {
    return res.status(202).json({ success: false, approval_required: true, pending: true, expires_at: approval.expiresAt });
  }
  if (approval.status !== 'approved') {
    return res.status(403).json({ error: 'このログインは許可されなかったか、期限切れです。' });
  }

  const metadata = getRequestLoginMetadata(req);
  if (metadata.ipHash !== approval.ipHash) {
    return res.status(403).json({ error: 'ログイン要求時と異なるIPアドレスから承認を完了することはできません。' });
  }

  const consumed = await db.consumeLoginApproval(approval.id, hashApprovalPollToken(pollToken));
  if (!consumed) {
    return res.status(409).json({ error: 'この承認は既に使用されたか、期限切れです。' });
  }
  const user = await db.getUserById(approval.userId);
  if (!user) return res.status(404).json({ error: 'ユーザーが見つかりません。' });

  await db.trustLoginIp(user.id, metadata);
  const session = await createAuthenticatedSession(req, res, user, metadata);
	return res.json({
		success: true,
		expires_at: session.expiresAt,
		user: serializeLoginUser(user, req),
	});
});

router.get('/me', requireAuthAllowFrozen, async (req, res) => {
  const db = getDbAdapter(req);
  const user = await db.getUserById(req.user.id);

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json({
    user: await serializeUser(db, user, req.user.id, getPublicUrl(req)),
    isBot: req.user.isBot || false,
    tokenType: req.user.tokenType,
  });
});

function serializeLoginApprovalForOwner(approval) {
  if (!approval) return null;
  return {
    id: approval.id,
    ip_masked: approval.ipMasked,
    user_agent: approval.userAgent,
    status: approval.status,
    created_at: approval.createdAt,
    expires_at: approval.expiresAt,
    decided_at: approval.decidedAt || null,
  };
}

/**
 * GET /server/auth/login-approvals/:approvalId
 * ログイン済み端末が未知IPログイン承認依頼を表示する。
 */
router.get('/login-approvals/:approvalId', requireAuth, requireInteractiveSession, async (req, res) => {
  const db = getDbAdapter(req);
  const approval = await db.getLoginApproval(req.params.approvalId);
  if (!approval || Number(approval.userId) !== Number(req.user.id)) {
    return res.status(404).json({ error: 'ログイン承認依頼が見つかりません。' });
  }
  return res.json({ approval: serializeLoginApprovalForOwner(approval) });
});

/**
 * POST /server/auth/login-approvals/:approvalId/decision
 * 未知IPログインを許可または拒否する。許可時だけIPを信頼済みにする。
 */
router.post('/login-approvals/:approvalId/decision', requireAuth, requireInteractiveSession, async (req, res) => {
  const decision = req.body?.decision;
  if (!['approve', 'deny'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be approve or deny' });
  }
  const db = getDbAdapter(req);
  const approval = await db.decideLoginApproval(req.user.id, req.params.approvalId, decision);
  if (!approval) return res.status(404).json({ error: 'ログイン承認依頼が見つかりません。' });
  if (approval.status === 'approved') {
    await db.trustLoginIp(req.user.id, { ipHash: approval.ipHash, ipMasked: approval.ipMasked });
  }
  return res.json({ success: true, approval: serializeLoginApprovalForOwner(approval) });
});

function serializeSessionForOwner(session, currentToken) {
  const currentTokenHash = currentToken ? SessionManager.hashToken(currentToken) : null;
  return {
    id: session.id,
    ip_masked: session.ipMasked || '旧セッション',
    user_agent: session.userAgent || '不明な端末',
    created_at: session.createdAt,
    expires_at: session.expiresAt,
    current: Boolean(currentTokenHash && session.token === currentTokenHash),
    can_revoke_trust: Boolean(session.ipHash),
	  };
	}

	/**
	 * POST /server/auth/login-security/trust-current-ip
 * 未知IP拒否を有効化する現在のログイン端末を信頼済みIPとして登録する。
 */
router.post('/login-security/trust-current-ip', requireAuth, requireInteractiveSession, async (req, res) => {
  const db = getDbAdapter(req);
  const metadata = getRequestLoginMetadata(req);
  await db.trustLoginIp(req.user.id, metadata);
  return res.json({ success: true, ip_masked: metadata.ipMasked });
});

/**
 * GET /server/auth/sessions
 * 現在有効なセッションを、トークンや生IPを露出せずに返す。
 */
router.get('/sessions', requireAuth, requireInteractiveSession, async (req, res) => {
  const db = getDbAdapter(req);
  const currentToken = getCookieValue(req, 'nyaitter_session');
  const sessions = await db.getUserSessions(req.user.id);
  res.set('Cache-Control', 'no-store');
  return res.json({ sessions: sessions.map((session) => serializeSessionForOwner(session, currentToken)) });
});

/**
 * DELETE /server/auth/sessions/:sessionId
 * 自分の指定セッションだけを無効化する。現在のセッションの場合はCookieも解除する。
 */
router.delete('/sessions/:sessionId', requireAuth, requireInteractiveSession, async (req, res) => {
  const db = getDbAdapter(req);
  const sessions = await db.getUserSessions(req.user.id);
  const target = sessions.find((session) => session.id === req.params.sessionId);
  if (!target) return res.status(404).json({ error: 'セッションが見つかりません。' });

  await db.invalidateSession(target.token);
  const currentToken = getCookieValue(req, 'nyaitter_session');
  const remaining = readRememberedAccounts(req)
    .filter((account) => SessionManager.hashToken(account.token) !== target.token);
  setRememberedAccountsCookie(res, remaining);
  const activeRemoved = Boolean(currentToken && SessionManager.hashToken(currentToken) === target.token);
  if (activeRemoved) clearSessionCookie(res);
  res.set('Cache-Control', 'no-store');
  return res.json({ success: true, invalidated: 1, active_removed: activeRemoved });
});

/**
 * POST /server/auth/sessions/:sessionId/revoke-ip
 * 対象セッションと同一IPの全セッションを無効化し、そのIPを未知IPへ戻す。
 */
router.post('/sessions/:sessionId/revoke-ip', requireAuth, requireInteractiveSession, async (req, res) => {
  const db = getDbAdapter(req);
  const sessions = await db.getUserSessions(req.user.id);
  const target = sessions.find((session) => session.id === req.params.sessionId);
  if (!target) return res.status(404).json({ error: 'セッションが見つかりません。' });
  if (!target.ipHash) return res.status(409).json({ error: '旧セッションのため、このIPの信頼を取り消せません。' });

  const affectedTokens = sessions
    .filter((session) => session.ipHash === target.ipHash)
    .map((session) => session.token);
  const revokedTrust = await db.revokeTrustedLoginIp(req.user.id, target.ipHash);
  const invalidated = await db.invalidateSessionsByIp(req.user.id, target.ipHash);
  const currentToken = getCookieValue(req, 'nyaitter_session');
  const activeRemoved = Boolean(currentToken && affectedTokens.includes(SessionManager.hashToken(currentToken)));
  setRememberedAccountsCookie(res, readRememberedAccounts(req)
    .filter((account) => !affectedTokens.includes(SessionManager.hashToken(account.token))));
  if (activeRemoved) clearSessionCookie(res);

  res.set('Cache-Control', 'no-store');
  return res.json({ success: true, trust_revoked: revokedTrust, invalidated, active_removed: activeRemoved });
});

/**
 * GET /server/auth/accounts
 * 同一ブラウザで記憶したログイン済みアカウントを返す。
 * セッション文字列そのものは決してクライアントへ返さない。
 */
router.get('/accounts', async (req, res) => {
  const db = getDbAdapter(req);
  try {
    const accounts = await getValidRememberedAccounts(req, db);
    setRememberedAccountsCookie(res, accounts);
    res.json({
      accounts: accounts.map((account) => ({
        ...serializeLoginUser(account.user, req),
        active: getCookieValue(req, 'nyaitter_session') === account.token,
      })),
    });
  } catch (error) {
    console.error('[auth] account list error:', error);
    res.status(500).json({ error: 'アカウント一覧の取得に失敗しました' });
  }
});

/**
 * POST /server/auth/accounts/switch
 * 署名済み・HTTPOnlyの記憶済みセッションからアクティブアカウントを切り替える。
 */
router.post('/accounts/switch', async (req, res) => {
  const userId = Number(req.body?.user_id);
  if (!Number.isInteger(userId) || userId < 0) {
    return res.status(400).json({ error: 'user_id is required' });
  }

  const db = getDbAdapter(req);
  try {
    const accounts = await getValidRememberedAccounts(req, db);
    const selected = accounts.find((account) => account.userId === userId);
    if (!selected) {
      return res.status(403).json({ error: 'このブラウザで認証済みのアカウントではありません' });
    }

    setSessionCookie(res, selected.token, selected.session.expiresAt);
    setRememberedAccountsCookie(res, [
      { token: selected.token, userId: selected.userId },
      ...accounts
        .filter((account) => account.token !== selected.token && account.userId !== selected.userId)
        .map((account) => ({ token: account.token, userId: account.userId })),
    ]);
    res.json({ success: true, user: serializeLoginUser(selected.user, req) });
  } catch (error) {
    console.error('[auth] account switch error:', error);
    res.status(500).json({ error: 'アカウントの切替に失敗しました' });
  }
});

router.delete('/accounts/:userId', async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId) || userId < 0) {
    return res.status(400).json({ error: 'Invalid user id' });
  }

  const db = getDbAdapter(req);
  try {
    const accounts = await getValidRememberedAccounts(req, db);
    const selected = accounts.find((account) => account.userId === userId);
    if (!selected) {
      return res.status(404).json({ error: '記憶済みアカウントが見つかりません' });
    }

    const sessionManager = new SessionManager({ dbAdapter: db });
    await sessionManager.invalidateSession(selected.userId, selected.token);
    const remaining = accounts
      .filter((account) => account.token !== selected.token && account.userId !== selected.userId)
      .map((account) => ({ token: account.token, userId: account.userId }));
    setRememberedAccountsCookie(res, remaining);

    const activeRemoved = getCookieValue(req, 'nyaitter_session') === selected.token;
    if (activeRemoved) clearSessionCookie(res);
    res.json({ success: true, active_removed: activeRemoved });
  } catch (error) {
    console.error('[auth] account removal error:', error);
    res.status(500).json({ error: 'アカウントの解除に失敗しました' });
  }
});

/**
 * POST /server/auth/logout
 * 現在のセッションを無効化しCookieを削除
 */
router.post('/logout', optionalAuth, async (req, res) => {
  const db = getDbAdapter(req);

  const cookieToken = getCookieValue(req, 'nyaitter_session');

  const authHeader = req.headers.authorization;
  const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
  const token = headerToken || cookieToken;

  if (token && req.user?.id) {
    const sessionManager = new SessionManager({ dbAdapter: db });
    await sessionManager.invalidateSession(req.user.id, token);
  }

  const remainingAccounts = readRememberedAccounts(req)
    .filter((account) => account.token !== cookieToken);
  setRememberedAccountsCookie(res, remainingAccounts);
  clearSessionCookie(res);
  res.json({ message: 'Logged out successfully' });
});

router.post('/turnstile/verify', async (req, res) => {
  const { token } = req.body;
  const secret = process.env.TURNSTILE_SECRET_KEY;

  if (!secret) {
    return res.status(500).json({ error: 'Turnstileがサーバー側で設定されていません' });
  }
  if (!token) {
    return res.status(400).json({ error: 'token is required' });
  }

  try {
    const formData = new URLSearchParams();
    formData.append('secret', secret);
    formData.append('response', token);

    const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: formData,
    });

    const data = await verifyRes.json();

    if (data.success) {
      res.json({ success: true });
    } else {
      res.status(400).json({ success: false, error: data['error-codes'] || '検証に失敗しました' });
    }
  } catch (e) {
    res.status(500).json({ error: 'Turnstile検証中にエラーが発生しました' });
  }
});

router.get('/test-protected', requireAuth, (req, res) => {
  res.json({
    message: '認証に成功しました！',
    userId: req.user.id,
    isBot: req.user.isBot,
    tokenType: req.user.tokenType,
  });
});

/**
 * POST /server/auth/dev-login
 * 開発用簡易ログイン（DEV_BYPASS_AUTH=true のときのみ有効）
 * 実際のScratch認証をスキップして即座にユーザー+セッションを作成する
 */
router.post('/dev-login', async (req, res) => {
  const isProd = (process.env.NODE_ENV || 'development') === 'production';
  if (process.env.DEV_BYPASS_AUTH !== 'true' || isProd) {
    return res.status(403).json({ error: 'DEV_BYPASS_AUTH が有効な場合のみ使用可能です（本番環境では無効）' });
  }

  const { username } = req.body;
  if (!username || typeof username !== 'string') {
    return res.status(400).json({ error: 'username is required' });
  }
  if (!isValidScratchUsername(username)) {
    return res.status(400).json({ error: 'Invalid username format' });
  }

  const db = getDbAdapter(req);
  const ip = req.ip || req.socket?.remoteAddress || '127.0.0.1';

  let user = await db.getUserByScid(username);
  if (!user) {
    user = await db.createUser({
      scid: username,
      name: username,
      auth_provider: 'local',
    });
  }

  const result = await beginProtectedLogin(req, res, user);
  const payload = sendLoginResult(req, res, user, result);
  return payload;
});

router.post('/bot-tokens', requireAuth, async (req, res) => {
  const { name } = req.body;
  const userId = req.user?.id;
  const db = getDbAdapter(req);

  if (!userId) {
    return res.status(401).json({ error: '認証が必要です' });
  }

  const botTokenManager = new BotTokenManager({ dbAdapter: db });

  try {
    const result = await botTokenManager.createBotToken(userId, { name });
    res.json({
      message: 'Botトークンを生成しました。このトークンは一度だけ表示されます。',
      token: result.token,
      tokenId: result.tokenId,
      name: result.name,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Botトークンの生成に失敗しました' });
  }
});

router.get('/bot-tokens', requireAuth, async (req, res) => {
  const userId = req.user?.id;
  const db = getDbAdapter(req);
  if (!userId) return res.status(401).json({ error: '認証が必要です' });

  const botTokenManager = new BotTokenManager({ dbAdapter: db });
  const tokens = await botTokenManager.getUserBotTokens(userId);

  res.json({ tokens });
});

router.delete('/bot-tokens/:tokenId', requireAuth, async (req, res) => {
  const userId = req.user?.id;
  const { tokenId } = req.params;
  const db = getDbAdapter(req);

  if (!userId) return res.status(401).json({ error: '認証が必要です' });

  const botTokenManager = new BotTokenManager({ dbAdapter: db });
  const success = await botTokenManager.revokeBotToken(userId, tokenId);

  if (success) {
    res.json({ message: 'Botトークンを無効化しました' });
  } else {
    res.status(404).json({ error: 'トークンが見つかりません' });
  }
});

function resolveExternalServer(domain, nyaitterAddress) {
  const configuredServers = config.federation?.trusted_servers || [];
  // 未設定時に利用者入力のドメインへサーバーから接続すると、内部ネットワークを
  // 参照できるSSRF経路になる。外部ログインは常に明示的な許可リストに限定する。
  if (configuredServers.length === 0) return null;

  const configured = configuredServers.find((server) =>
    String(server.domain || '').toLowerCase() === domain || server.nyaitter_id === nyaitterAddress,
  );
  return configured ? { ...configured, trust_mode: 'allowlist' } : null;
}

async function verifyExternalLoginProof(trustedServer, nyaitterAddress, proof) {
  if (!trustedServer.verify_endpoint) {
    throw new Error('Trusted server does not provide a verification endpoint');
  }

  const endpoint = new URL(trustedServer.verify_endpoint);
  const localDevelopmentHost = /^(localhost|127\.0\.0\.1)(?::\d{1,5})?$/i.test(endpoint.host);
  if (endpoint.protocol !== 'https:' && !(localDevelopmentHost && endpoint.protocol === 'http:')) {
    throw new Error('Trusted server verification endpoint must use HTTPS (http is allowed only for localhost)');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ nyaitter_address: nyaitterAddress, proof }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`External proof verification failed: ${response.status}`);
    }
    const result = await response.json();
    if (result?.valid !== true || !result.profile || typeof result.profile !== 'object') {
      throw new Error('External proof was not accepted');
    }
    return result.profile;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * GET /server/auth/external/trusted
 * 信頼できる外部Nyaitterサーバーの一覧を返す（ログインUI用）
 */
router.get('/external/trusted', (req, res) => {
  const trusted = (config.federation?.trusted_servers || []).map(s => ({
    nyaitter_id: s.nyaitter_id,
    domain: s.domain,
  }));
  res.json({
    trusted_servers: trusted,
		enabled: Boolean(config.federation?.allow_external_login && trusted.length > 0),
		trust_mode: 'allowlist',
		standard_endpoints: null,
  });
});

/**
 * POST /server/auth/external/init
 * 外部Nyaitterサーバーでのログインを開始する
 *
 * 注意: nyaitter_address のドメイン部（#id@ドメイン）は、
 * そのNyaitterサーバーを実際にホストしているドメインに依存します。
 */
router.post('/external/init', async (req, res) => {
  const { nyaitter_address } = req.body;

  if (!nyaitter_address || typeof nyaitter_address !== 'string') {
    return res.status(400).json({
      error: 'nyaitter_address is required',
      example: '#1234@your-nyaitter-domain.example.com'
    });
  }

  if (!config.federation?.allow_external_login) {
    return res.status(403).json({ error: 'External Nyaitter login is not enabled on this server' });
  }

  const parsedAddress = parseNyaitterAddress(nyaitter_address);
  if (!parsedAddress) {
    return res.status(400).json({
      error: 'Invalid nyaitter_address format',
      expected: '#{id}@{domain}',
      note: 'The domain part depends on where that Nyaitter instance is hosted.'
    });
  }

  const { id: externalId, domain, address: canonicalAddress } = parsedAddress;
  const trusted = resolveExternalServer(domain, canonicalAddress);

  if (!trusted) {
    return res.status(403).json({ error: 'This Nyaitter server is not in the trusted list' });
  }

  const publicUrl = getPublicUrl(req);
  const state = externalLoginStateStore.create({ nyaitterAddress: canonicalAddress });
  const callbackUrl = new URL('/login', publicUrl);
  callbackUrl.searchParams.set('external_login', '1');
  callbackUrl.searchParams.set('state', state);

  let authUrl;
  try {
    const defaultProtocol = /^(localhost|127\.0\.0\.1)(?::\d{1,5})?$/i.test(domain) ? 'http' : 'https';
    const endpoint = new URL(trusted.auth_endpoint || `${defaultProtocol}://${domain}/auth/external`);
    const localDevelopmentHost = /^(localhost|127\.0\.0\.1)(?::\d{1,5})?$/i.test(endpoint.host);
    if (endpoint.protocol !== 'https:' && !(localDevelopmentHost && endpoint.protocol === 'http:')) {
      throw new Error('External authentication endpoint must use HTTPS (http is allowed only for localhost)');
    }
    endpoint.searchParams.set('redirect', callbackUrl.toString());
    endpoint.searchParams.set('nyaitter_address', canonicalAddress);
    endpoint.searchParams.set('state', state);
    authUrl = endpoint.toString();
  } catch (error) {
    return res.status(500).json({ error: error.message || 'External authentication endpoint is invalid' });
  }

  res.json({
    success: true,
    message: 'External login initiated',
    nyaitter_address: canonicalAddress,
    target_domain: domain,
    trust_mode: trusted.trust_mode,
    auth_url: authUrl,
    redirect_uri: callbackUrl.toString(),
    expires_in: 600,
    note: 'Redirect the user to auth_url. The external server must return to redirect_uri with proof and state query parameters.',
  });
});

/**
 * POST /server/auth/external/complete
 * 外部Nyaitterサーバーでの認証完了後、プロフィール情報を受け取ってログイン/参加する
 *
 * 注意:
 * - nyaitter_address のドメイン部分は、外部サーバーが実際にホストされているドメインです。
 * - このサーバーの公開URLは、要求元URLから自動導出されます（PUBLIC_URL は要求がない処理のフォールバックです）。
 */
router.post('/external/complete', async (req, res) => {
  const { nyaitter_address, proof, state } = req.body || {};

  if (!proof || typeof proof !== 'string') {
    return res.status(400).json({ error: 'proof is required' });
  }

  const stateRecord = state ? externalLoginStateStore.get(state) : null;
  if (state && !stateRecord) {
    return res.status(400).json({ error: 'External login state is invalid or expired. Please start again.' });
  }
  const addressToVerify = stateRecord?.nyaitterAddress || nyaitter_address;
  if (stateRecord && nyaitter_address && nyaitter_address !== stateRecord.nyaitterAddress) {
    return res.status(400).json({ error: 'External login address does not match the pending login request' });
  }

  const parsedAddress = parseNyaitterAddress(addressToVerify);
  if (!parsedAddress) {
    return res.status(400).json({ error: 'Invalid nyaitter_address format; expected #1234@example.com' });
  }
  if (!config.federation?.allow_external_login) {
    return res.status(403).json({ error: 'External Nyaitter login is not enabled on this server' });
  }

  const { id: externalId, domain: providerDomain, address: canonicalAddress } = parsedAddress;
  const trustedServer = resolveExternalServer(providerDomain, canonicalAddress);
  if (!trustedServer) {
    return res.status(403).json({ error: 'This Nyaitter server is not in the trusted list' });
  }

  let verifiedProfile;
  try {
    verifiedProfile = await verifyExternalLoginProof(trustedServer, canonicalAddress, proof);
  } catch (error) {
    console.warn('[auth] external proof verification failed:', error.message);
    return res.status(401).json({ error: 'External login proof could not be verified' });
  }

  if (state) externalLoginStateStore.consume(state);

  const db = getDbAdapter(req);
  const profile = normalizeExternalProfile(
    verifiedProfile,
    formatNyaitterId(externalId),
  );

  const user = await db.getOrCreateExternalUser({
    providerDomain,
    externalId,
    profile,
  });

  const result = await beginProtectedLogin(req, res, user);
  return sendLoginResult(req, res, user, result, { external: true });
});

function isSafeRedirectUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    if (url.username || url.password) return false;
    const localDevelopmentHost = /^(localhost|127\.0\.0\.1)(?::\d{1,5})?$/i.test(url.host);
    return url.protocol === 'https:' || (localDevelopmentHost && url.protocol === 'http:');
  } catch (_) {
    return false;
  }
}

function buildConfirmProfile(user, req) {
  return {
    name: user.name || '',
    me: user.me || user.bio || '',
    bio: user.me || user.bio || '',
    icon_data: null,
    header_image: null,
    nyaitter_id: getUserNyaitterId(user),
    nyaitter_address: getUserNyaitterAddress(user, req),
  };
}

/**
 * GET /server/auth/external/confirm-context
 * 外部ログイン確認画面用。ログイン中ユーザーと要求アドレスの対応を返す。
 */
router.get('/external/confirm-context', optionalAuth, async (req, res) => {
  if (!config.federation?.allow_external_login) {
    return res.status(403).json({ error: 'このサーバーでは外部Nyaitter連携が無効です。' });
  }

  const nyaitterAddress = String(req.query.nyaitter_address || '').trim();
  const state = String(req.query.state || '').trim();
  const redirect = String(req.query.redirect || '').trim();

  if (!nyaitterAddress || !state || !redirect) {
    return res.status(400).json({ error: 'nyaitter_address, state, redirect が必要です。' });
  }
  if (!parseNyaitterAddress(nyaitterAddress)) {
    return res.status(400).json({ error: 'Nyaitterアドレスの形式が正しくありません。' });
  }
  if (!isSafeRedirectUrl(redirect)) {
    return res.status(400).json({ error: '戻り先URLが安全ではありません。' });
  }

  const db = getDbAdapter(req);
  let currentUser = null;
  if (req.user?.id && req.user.tokenType === 'session') {
    const user = await db.getUserById(req.user.id);
    if (user) {
      currentUser = serializeLoginUser(user, req);
    }
  }

  const addressMatches = currentUser
    && String(currentUser.nyaitter_address || '').toLowerCase() === nyaitterAddress.toLowerCase();

  res.json({
    enabled: true,
    nyaitter_address: nyaitterAddress,
    state,
    redirect,
    logged_in: Boolean(currentUser),
    address_matches: Boolean(addressMatches),
    user: currentUser,
  });
});

/**
 * POST /server/auth/external/confirm
 * ログイン中ユーザーが外部ログイン要求を承認し、proof を発行する。
 */
router.post('/external/confirm', requireAuth, requireInteractiveSession, async (req, res) => {
  if (!config.federation?.allow_external_login) {
    return res.status(403).json({ error: 'このサーバーでは外部Nyaitter連携が無効です。' });
  }

  const nyaitterAddress = String(req.body?.nyaitter_address || '').trim();
  const state = String(req.body?.state || '').trim();
  const redirect = String(req.body?.redirect || '').trim();

  if (!nyaitterAddress || !state || !redirect) {
    return res.status(400).json({ error: 'nyaitter_address, state, redirect が必要です。' });
  }
  if (state.length < 16 || state.length > 256) {
    return res.status(400).json({ error: 'state が無効です。' });
  }
  if (!parseNyaitterAddress(nyaitterAddress)) {
    return res.status(400).json({ error: 'Nyaitterアドレスの形式が正しくありません。' });
  }
  if (!isSafeRedirectUrl(redirect)) {
    return res.status(400).json({ error: '戻り先URLが安全ではありません。' });
  }

  const db = getDbAdapter(req);
  const user = await db.getUserById(req.user.id);
  if (!user) {
    return res.status(404).json({ error: 'ユーザーが見つかりません。' });
  }

  const localAddress = getUserNyaitterAddress(user, req);
  if (!localAddress || localAddress.toLowerCase() !== nyaitterAddress.toLowerCase()) {
    return res.status(403).json({
      error: '要求されたNyaitterアドレスは、いまログインしているアカウントと一致しません。',
      expected: localAddress,
      requested: nyaitterAddress,
    });
  }

  const profile = buildConfirmProfile(user, req);
  const proof = externalLoginProofStore.create({
    nyaitterAddress: localAddress,
    profile,
    userId: user.id,
  });

  let redirectUrl;
  try {
    const target = new URL(redirect);
    target.searchParams.set('external_login', '1');
    target.searchParams.set('state', state);
    target.searchParams.set('proof', proof);
    redirectUrl = target.toString();
  } catch (_) {
    return res.status(400).json({ error: '戻り先URLが無効です。' });
  }

  res.json({
    success: true,
    proof,
    state,
    redirect_url: redirectUrl,
    expires_in: 600,
  });
});

/**
 * POST /server/auth/external/verify
 * 他サーバーが proof の正当性を確認する。
 */
router.post('/external/verify', async (req, res) => {
  if (!config.federation?.allow_external_login) {
    return res.status(403).json({ valid: false, error: 'External login is disabled on this server' });
  }

  const nyaitterAddress = String(req.body?.nyaitter_address || '').trim();
  const proof = String(req.body?.proof || '').trim();
  if (!nyaitterAddress || !proof) {
    return res.status(400).json({ valid: false, error: 'nyaitter_address and proof are required' });
  }

  const record = externalLoginProofStore.consume(proof);
  if (!record) {
    return res.status(401).json({ valid: false, error: 'proof is invalid or expired' });
  }
  if (String(record.nyaitterAddress).toLowerCase() !== nyaitterAddress.toLowerCase()) {
    return res.status(401).json({ valid: false, error: 'proof does not match nyaitter_address' });
  }

  res.json({
    valid: true,
    profile: record.profile,
  });
});

module.exports = router;
