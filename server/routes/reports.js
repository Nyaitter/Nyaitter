const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimit');
const config = require('../config');

const router = express.Router();
const reportCreateLimiter = createRateLimiter(config.rateLimit.reportCreate);
const reportActionLimiter = createRateLimiter(config.rateLimit.reportAction);

function getModerationReportService(req) {
  return req.app.locals.moderationReportService;
}

function parseReportId(raw) {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

// 報告者の識別情報は、一覧・詳細のいずれにも絶対に含めない。
function serializeReportForAdmin(report) {
  if (!report) return null;
  return {
    id: Number(report.id),
    target_kind: report.targetKind,
    target_id: String(report.targetId),
    description: report.description || '',
    target_snapshot: report.targetSnapshot || {},
    assignment_type: report.assignmentType || 'report',
    status: report.status,
    assigned_at: report.assignedAt || null,
    created_at: report.createdAt || null,
    resolved_at: report.resolvedAt || null,
    resolution: report.resolution || null,
  };
}

router.post('/', requireAuth, reportCreateLimiter, async (req, res) => {
  const service = getModerationReportService(req);
  const { target_kind, target_id, description } = req.body || {};

  try {
    const report = await service.createReport({
      reporterUserId: req.user.id,
      targetKind: target_kind,
      targetId: target_id,
      description,
    });
    res.status(201).json({
      success: true,
      report: {
        id: Number(report.id),
        status: report.status,
        created_at: report.createdAt || null,
      },
    });
  } catch (error) {
    const message = error.message || '報告の送信に失敗しました';
    const status = /見つかりません|権限|自分自身|自分のポスト|invalid|characters/i.test(message)
      ? 400
      : 500;
    if (status === 500) console.error('[reports] create error:', error);
    res.status(status).json({ error: message });
  }
});

router.get('/assigned', requireAuth, async (req, res) => {
  if (!req.user.admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const service = getModerationReportService(req);
  const status = ['assigned', 'resolved'].includes(String(req.query.status))
    ? String(req.query.status)
    : 'assigned';
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  try {
    const reports = await service.db.listModerationReportsForAdmin(req.user.id, {
      status,
      limit,
      offset,
    });
    res.json({ reports: reports.map(serializeReportForAdmin) });
  } catch (error) {
    console.error('[reports] assigned list error:', error);
    res.status(500).json({ error: '割り当て済み報告の取得に失敗しました' });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  if (!req.user.admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const reportId = parseReportId(req.params.id);
  if (!reportId) return res.status(400).json({ error: 'Invalid report id' });

  try {
    const report = await getModerationReportService(req).db.getModerationReportById(reportId);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    if (Number(report.assignedAdminId) !== Number(req.user.id)) {
      return res.status(403).json({ error: 'This report is not assigned to you' });
    }
    res.json({ report: serializeReportForAdmin(report) });
  } catch (error) {
    console.error('[reports] detail error:', error);
    res.status(500).json({ error: '報告詳細の取得に失敗しました' });
  }
});

router.post('/:id/appeal-decision', requireAuth, reportActionLimiter, async (req, res) => {
  if (!req.user.admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const reportId = parseReportId(req.params.id);
  if (!reportId) return res.status(400).json({ error: 'Invalid report id' });

  try {
    const report = await getModerationReportService(req).resolveFreezeAppeal({
      reportId,
      adminId: req.user.id,
      decision: req.body?.decision,
    });
    return res.json({ success: true, report: serializeReportForAdmin(report) });
  } catch (error) {
    const message = error.message || '異議申し立ての対応に失敗しました';
    const status = /権限|判断|対象|見つかりません/i.test(message) ? 400 : 500;
    if (status === 500) console.error('[reports] appeal decision error:', error);
    return res.status(status).json({ error: message });
  }
});

router.post('/:id/verification-decision', requireAuth, reportActionLimiter, async (req, res) => {
  if (!req.user.admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const reportId = parseReportId(req.params.id);
  if (!reportId) return res.status(400).json({ error: 'Invalid report id' });

  try {
    const report = await getModerationReportService(req).resolveVerificationApplication({
      reportId,
      adminId: req.user.id,
      decision: req.body?.decision,
    });
    return res.json({ success: true, report: serializeReportForAdmin(report) });
  } catch (error) {
    const message = error.message || '認証申請の対応に失敗しました';
    const status = /権限|判断|対象|見つかりません/i.test(message) ? 400 : 500;
    if (status === 500) console.error('[reports] verification decision error:', error);
    return res.status(status).json({ error: message });
  }
});

router.post('/:id/resolve', requireAuth, reportActionLimiter, async (req, res) => {
  if (!req.user.admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const reportId = parseReportId(req.params.id);
  if (!reportId) return res.status(400).json({ error: 'Invalid report id' });

  try {
    const report = await getModerationReportService(req).resolveReport({
      reportId,
      adminId: req.user.id,
      actions: req.body?.actions || {},
    });
    res.json({ success: true, report: serializeReportForAdmin(report) });
  } catch (error) {
    const message = error.message || '報告対応に失敗しました';
    const status = /権限|必要|対象|ポスト以外|characters/i.test(message) ? 400 : 500;
    if (status === 500) console.error('[reports] resolve error:', error);
    res.status(status).json({ error: message });
  }
});

module.exports = router;
