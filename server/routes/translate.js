'use strict';

const api = require('../utils/ApiRegistry');
const { createRateLimiter } = require('../middleware/rateLimit');
const { requireAuth } = require('../middleware/auth');

const router = api.createRouter({
  tag: 'translate',
  basePath: '/translate',
  description: 'テキスト翻訳 API',
});

const translateLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 120 });

const MAX_BATCH = 50;

function toResponse(result) {
  return {
    translated_text: result.translatedText,
    source_language: result.sourceLanguage,
    target_language: result.targetLanguage,
    cached: !!result.cached,
  };
}

router.post({
  path: '/',
  summary: 'テキストの翻訳',
  auth: 'required',
}, requireAuth, translateLimiter, async (req, res) => {
  const service = req.app.locals.translationService;
  if (!service) return res.status(503).json({ error: '翻訳は現在利用できません' });
  const body = req.body || {};
  const targetLanguage = body.target_language ?? body.targetLanguage;
  const sourceLanguage = body.source_language ?? body.sourceLanguage;
  try {
    if (Array.isArray(body.texts)) {
      if (body.texts.length > MAX_BATCH) return res.status(400).json({ error: '一度に翻訳できる数を超えています' });
      const translations = [];
      for (const text of body.texts) {
        translations.push(toResponse(await service.translate({ text, targetLanguage, sourceLanguage })));
      }
      return res.json({ translations });
    }
    const result = await service.translate({ text: body.text, targetLanguage, sourceLanguage });
    return res.json(toResponse(result));
  } catch (error) {
    return res.status(400).json({ error: error.message || '翻訳に失敗しました' });
  }
});

module.exports = router;
