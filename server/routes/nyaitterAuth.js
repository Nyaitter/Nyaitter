'use strict';

const express = require('express');
const NyaitterAuthManager = require('../services/auth/NyaitterAuthManager');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function getAuthManager(req) {
  return new NyaitterAuthManager({
    dbAdapter: req.app.locals.dbAdapter,
  });
}

// 1. Initiate authorization request (called by external app with its API credentials)
router.post('/initiate', async (req, res) => {
  try {
    const manager = getAuthManager(req);
    const result = await manager.createAuthorizationRequest(req.body, req);
    return res.json(result);
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      error: error.message || '認証リクエストの作成に失敗しました。',
    });
  }
});

// 2. Get authorization request details (called by Nyaitter client on #nyaitter-auth)
router.get('/requests/:requestId', async (req, res) => {
  try {
    const manager = getAuthManager(req);
    const currentUserId = req.user?.id || null;
    const result = await manager.getAuthorizationRequest(req.params.requestId, currentUserId, req.app.locals.dbAdapter);
    return res.json({
      success: true,
      request: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      error: error.message || '認証リクエストの取得に失敗しました。',
      code: error.code || undefined,
    });
  }
});

// 3. User approves authorization (requires user login)
router.post('/approve', requireAuth, async (req, res) => {
  try {
    const { request_id, granted_scopes } = req.body;
    if (!request_id) {
      return res.status(400).json({
        success: false,
        error: 'リクエストID (request_id) が必要です。',
      });
    }

    const manager = getAuthManager(req);
    const result = await manager.approveAuthorization(
      request_id,
      req.user.id,
      granted_scopes,
      req.app.locals.dbAdapter,
    );
    return res.json(result);
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      error: error.message || '認証の承認に失敗しました。',
    });
  }
});

// 4. User denies authorization
router.post('/deny', async (req, res) => {
  try {
    const { request_id } = req.body;
    if (!request_id) {
      return res.status(400).json({
        success: false,
        error: 'リクエストID (request_id) が必要です。',
      });
    }

    const manager = getAuthManager(req);
    const result = await manager.denyAuthorization(request_id);
    return res.json(result);
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      error: error.message || '認証の拒否処理に失敗しました。',
    });
  }
});

// 5. Exchange temporary token/code for user info & persistent access token (called by external app)
router.post('/token', async (req, res) => {
  try {
    const manager = getAuthManager(req);
    const result = await manager.exchangeCodeForToken(req.body, req.app.locals.dbAdapter);
    return res.json(result);
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      error: error.message || 'トークンの検証・交換に失敗しました。',
      code: error.code || undefined,
    });
  }
});

// 6. Userinfo endpoint (called with Authorization: Bearer nyauth_...)
router.get('/userinfo', requireAuth, async (req, res) => {
  try {
    const db = req.app.locals.dbAdapter;
    const user = await db.getUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'ユーザーが見つかりません。' });
    }
    return res.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        scid: user.scid || null,
        handle: user.handle || null,
        icon_data: user.icon_data || null,
        me: user.me || null,
        created_at: user.created_at || null,
      },
      scopes: req.user.scopes || ['*'],
      app_id: req.user.appId || null,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'ユーザー情報の取得に失敗しました。',
    });
  }
});

// 7. Get user's authorized applications (Settings screen)
router.get('/authorized-apps', requireAuth, async (req, res) => {
  try {
    const manager = getAuthManager(req);
    const apps = await manager.getUserAuthorizedApps(req.user.id, req.app.locals.dbAdapter);
    return res.json({
      success: true,
      apps,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      error: error.message || '連携アプリ一覧の取得に失敗しました。',
    });
  }
});

// 8. Update authorized application scopes (Settings screen)
router.patch('/authorized-apps/:id', requireAuth, async (req, res) => {
  try {
    const manager = getAuthManager(req);
    const { scopes } = req.body;
    if (!Array.isArray(scopes)) {
      return res.status(400).json({
        success: false,
        error: 'scopes は配列である必要があります。',
      });
    }
    const updated = await manager.updateAuthorizedAppScopes(
      req.params.id,
      req.user.id,
      scopes,
      req.app.locals.dbAdapter,
    );
    return res.json({
      success: true,
      app: updated,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      error: error.message || '連携アプリの権限更新に失敗しました。',
    });
  }
});

// 9. Revoke authorized application (Settings screen)
router.delete('/authorized-apps/:id', requireAuth, async (req, res) => {
  try {
    const manager = getAuthManager(req);
    const result = await manager.revokeAuthorizedApp(
      req.params.id,
      req.user.id,
      req.app.locals.dbAdapter,
    );
    return res.json(result);
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      error: error.message || '連携アプリの解除に失敗しました。',
    });
  }
});

module.exports = router;
