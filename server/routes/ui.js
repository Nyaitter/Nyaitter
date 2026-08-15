const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { getVisibleDmUnreadCount } = require('../services/DmVisibilityService');

const router = express.Router();

function getDbAdapter(req) {
  return req.app.locals.dbAdapter;
}

/**
 * GET /server/api/ui/summary
 * ナビゲーション表示に必要な、利用者本人の軽量なカウンターをまとめて返す。
 */
router.get('/summary', requireAuth, async (req, res) => {
  const db = getDbAdapter(req);
  const userId = req.user.id;

  try {
    const [notificationUnreadCount, dmUnreadCount] = await Promise.all([
      db.getUnreadNotificationCount ? db.getUnreadNotificationCount(userId) : 0,
			getVisibleDmUnreadCount(db, userId),
    ]);

    res.json({
      notification_unread_count: Number(notificationUnreadCount || 0),
      dm_unread_count: Number(dmUnreadCount || 0),
    });
  } catch (error) {
    console.error('[ui] summary error:', error);
    res.status(500).json({ error: 'ナビゲーション情報の取得に失敗しました' });
  }
});

module.exports = router;
