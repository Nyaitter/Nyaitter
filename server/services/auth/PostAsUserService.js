const { readRememberedAccounts } = require('./RememberedAccountService');
const SessionManager = require('./SessionManager');
const config = require('../../config');
const { trustRank } = require('../../utils/reputationPolicy');
const { hasFeatureAccess } = require('../../utils/featureAccess');
const { canOperateImposter } = require('../ImposterService');

function normalizeUserId(value) {
  const userId = Number(value);
  return Number.isInteger(userId) && userId > 0 ? userId : null;
}

function postAsAuthorizationError(message, statusCode = 403) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/**
 * 現在のログインセッションを切り替えず、同じブラウザで認証済みのアカウント、
 * またはそのアカウントが操作できるインポスターを投稿先として返す。
 */
async function resolvePostingUser(req, db, requestedUserId = null) {
  const currentUserId = normalizeUserId(req.user?.id);
  const requestedId = requestedUserId == null || requestedUserId === ''
    ? currentUserId
    : normalizeUserId(requestedUserId);
  if (!requestedId) {
    throw postAsAuthorizationError('投稿アカウントIDが正しくありません。', 400);
  }

  if (requestedId === currentUserId) {
    return db.getUserById(requestedId, { fresh: true });
  }

  // キュー待機中のセッション失効や権限変更をキャッシュで見逃さない。
  const rememberedAccounts = (await Promise.all(readRememberedAccounts(req).map(async (account) => {
    const session = await db.getSessionByToken(SessionManager.hashToken(account.token));
    if (!session || Number(session.userId) !== account.userId) return null;
    const user = await db.getUserById(session.userId, { fresh: true });
    return user ? { userId: Number(user.id), user } : null;
  }))).filter(Boolean);
  const directAccount = rememberedAccounts.find((account) => account.userId === requestedId);
  if (directAccount) return directAccount.user;

  const imposter = await db.getUserById(requestedId, { fresh: true });
  if (imposter && rememberedAccounts.some((account) => canOperateImposter(imposter, account.userId))) {
    return imposter;
  }

  throw postAsAuthorizationError('このブラウザで投稿を許可されたアカウントではありません。');
}

function assertPostingUserWritable(user) {
  if (!user) throw postAsAuthorizationError('投稿アカウントが見つかりません。', 404);
  if (user.freeze) throw postAsAuthorizationError('凍結中のアカウントでは投稿できません。');
  if (user.account_operation) {
    throw postAsAuthorizationError('NyaitterIDの処理中です。完了するまで投稿できません。', 423);
  }
  return user;
}

async function assertPostingUserAccess(req, db, postingUser, features) {
  const principal = req.user;
  const authenticatedUser = assertPostingUserWritable(await db.getUserById(principal?.id, { fresh: true }));
  if (Number(postingUser?.id) === Number(authenticatedUser.id)) postingUser = authenticatedUser;
  assertPostingUserWritable(postingUser);
  const users = [{
    user: authenticatedUser,
    admin: authenticatedUser.admin === true && principal.admin === true,
  }];
  if (Number(postingUser.id) !== Number(authenticatedUser.id)) {
    users.push({ user: postingUser, admin: postingUser.admin === true });
  }
  for (const { user, admin } of users) {
    if (admin) continue;
    const profile = await db.getReputationProfile(user.id);
    if (!hasFeatureAccess(config.reputation, trustRank(profile, config.reputation), features)) {
      throw postAsAuthorizationError('現在のアカウント状態ではこの機能を利用できません');
    }
  }
  return postingUser;
}

async function assertAuthenticatedUserAccess(req, db, features) {
  return assertPostingUserAccess(req, db, await db.getUserById(req.user?.id, { fresh: true }), features);
}

module.exports = {
  resolvePostingUser,
  assertPostingUserWritable,
  assertPostingUserAccess,
  assertAuthenticatedUserAccess,
};
