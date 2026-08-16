const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();
const verificationApplicationLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 5 });

function getModerationService(req) {
  return req.app.locals.moderationReportService || null;
}

function serializeVerificationApplication(application) {
  if (!application || application.assignmentType !== 'verification_application') return null;
  return {
    id: Number(application.id),
    status: application.status,
    assigned_at: application.assignedAt || null,
    created_at: application.createdAt || null,
  };
}

router.get('/me', requireAuth, async (req, res) => {
  const service = getModerationService(req);
  if (!service) return res.status(503).json({ error: 'Moderation service is unavailable' });
  try {
    const application = await service.getVerificationApplicationStatus(req.user.id);
    return res.json({ application: serializeVerificationApplication(application) });
  } catch (error) {
    console.error('[verification-applications] get status error:', error);
    return res.status(500).json({ error: '認証申請の状態を取得できませんでした' });
  }
});

router.post('/', requireAuth, verificationApplicationLimiter, async (req, res) => {
  const service = getModerationService(req);
  if (!service) return res.status(503).json({ error: 'Moderation service is unavailable' });
  try {
    const application = await service.createVerificationApplication({ userId: req.user.id });
    return res.status(201).json({ application: serializeVerificationApplication(application) });
  } catch (error) {
    const message = error.message || '認証申請を送信できませんでした';
    const status = /すでに|認証済み|見つかりません/.test(message) ? 400 : 500;
    if (status === 500) console.error('[verification-applications] create error:', error);
    return res.status(status).json({ error: message });
  }
});

module.exports = router;
