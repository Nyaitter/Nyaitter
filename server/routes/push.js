const express = require('express');
const config = require('../config');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function getPushService(req) {
  return req.app.locals.pushNotificationService;
}

function isSameOriginRequest(req) {
  const origin = req.headers.origin;
  if (!origin) return true;

  // req.protocol は Express の trust proxy 設定に従うため、
  // クライアントが偽造した x-forwarded-proto を無条件に信頼しない。
  const protocol = req.protocol === 'https' ? 'https' : 'http';
  const expectedOrigin = `${protocol}://${req.get('host')}`;
  if (origin === expectedOrigin) return true;

  if (config.federation?.publicUrl) {
    try {
      return origin === new URL(config.federation.publicUrl).origin;
    } catch (_) {
      return false;
    }
  }
  return false;
}

function requireSessionPrincipal(req, res, next) {
  if (req.user?.tokenType !== 'session') {
    return res.status(403).json({ error: 'Browser session authentication is required' });
  }
  return next();
}

function validateEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length < 16 || endpoint.length > 4096) return false;
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function validateKey(value, minLength, maxLength) {
  return typeof value === 'string'
    && value.length >= minLength
    && value.length <= maxLength
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function normalizeSubscription(value) {
  if (!value || typeof value !== 'object') return null;
  const endpoint = value.endpoint;
  const keys = value.keys;
  if (!validateEndpoint(endpoint) || !keys || typeof keys !== 'object') return null;
  if (!validateKey(keys.p256dh, 32, 256) || !validateKey(keys.auth, 16, 128)) return null;

  const expirationTime = value.expirationTime == null ? null : Number(value.expirationTime);
  if (expirationTime != null && (!Number.isFinite(expirationTime) || expirationTime < 0)) return null;

  return {
    endpoint,
    expirationTime,
    keys: {
      p256dh: keys.p256dh,
      auth: keys.auth,
    },
  };
}

router.get('/config', requireAuth, requireSessionPrincipal, async (req, res) => {
  const pushService = getPushService(req);
  const publicConfig = pushService?.getPublicConfiguration?.() || {
    enabled: false,
    vapid_public_key: null,
  };

  let subscriptionCount = 0;
  try {
    subscriptionCount = (await req.app.locals.dbAdapter.getPushSubscriptions(req.user.id)).length;
  } catch (error) {
    console.warn('[push] Failed to count subscriptions:', error.message);
  }

  res.json({
    ...publicConfig,
    subscription_count: subscriptionCount,
  });
});

router.post('/subscriptions', requireAuth, requireSessionPrincipal, async (req, res) => {
  if (!isSameOriginRequest(req)) {
    return res.status(403).json({ error: 'Cross-origin subscription requests are not allowed' });
  }

  const pushService = getPushService(req);
  if (!pushService?.enabled) {
    return res.status(503).json({ error: 'Web Push is not configured on this server' });
  }

  const subscription = normalizeSubscription(req.body?.subscription);
  if (!subscription) {
    return res.status(400).json({ error: 'Invalid PushSubscription' });
  }

  try {
    const stored = await req.app.locals.dbAdapter.upsertPushSubscription(req.user.id, subscription);
    if (!stored) return res.status(404).json({ error: 'User not found' });
    return res.status(201).json({ success: true });
  } catch (error) {
    console.error('[push] Subscription save error:', error);
    return res.status(500).json({ error: 'Push subscription could not be saved' });
  }
});

router.delete('/subscriptions', requireAuth, requireSessionPrincipal, async (req, res) => {
  if (!isSameOriginRequest(req)) {
    return res.status(403).json({ error: 'Cross-origin subscription requests are not allowed' });
  }

  const endpoint = req.body?.endpoint;
  if (!validateEndpoint(endpoint)) {
    return res.status(400).json({ error: 'Invalid subscription endpoint' });
  }

  try {
    await req.app.locals.dbAdapter.deletePushSubscription(req.user.id, endpoint);
    return res.json({ success: true });
  } catch (error) {
    console.error('[push] Subscription delete error:', error);
    return res.status(500).json({ error: 'Push subscription could not be removed' });
  }
});

module.exports = router;
