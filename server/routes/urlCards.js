const express = require('express');
const { createRateLimiter } = require('../middleware/rateLimit');
const { getUrlCard } = require('../services/UrlCardService');

const router = express.Router();
const urlCardLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 300 });

router.get('/', urlCardLimiter, async (req, res) => {
  const url = typeof req.query.url === 'string' ? req.query.url : '';
  const card = await getUrlCard(url);
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ card });
});

module.exports = router;
