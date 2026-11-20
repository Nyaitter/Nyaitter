'use strict';

const { getAiService } = require('./ai/AiService');
const { calculateStringSimilarity } = require('../utils/fuzzySearch');
const {
  normalizeText,
  textHash,
  indexTerms,
  extractAiText,
  normalizeLanguageCode,
  parseLanguageCode,
  sameLanguage,
} = require('../utils/textLanguage');

const REQUEST_TIMEOUT_MS = 20_000;
const ROUTING_TIMEOUT_MS = 50_000;
const SENTENCE_END_CHARS = '.!?。！？…';
const CLOSING_CHARS = ')]}\u300d\u300f\u201d\u2019"\u0027\u00bb>';

function stripClosingChars(text) {
  let result = String(text || '').trimEnd();
  while (result && CLOSING_CHARS.includes(result[result.length - 1])) result = result.slice(0, -1).trimEnd();
  return result;
}

// 応答が長さ制限で切れたかどうか。プロバイダが理由を返さない場合は、文末の形から推定する。
function looksTruncated(response, sourceText, translatedText) {
  if (response && typeof response === 'object') {
    if (response.choices?.[0]?.finish_reason === 'length') return true;
    if (response.candidates?.[0]?.finishReason === 'MAX_TOKENS') return true;
  }
  const source = stripClosingChars(sourceText);
  if (!source || !SENTENCE_END_CHARS.includes(source[source.length - 1])) return false;
  const translated = stripClosingChars(translatedText);
  if (!translated) return true;
  return !SENTENCE_END_CHARS.includes(translated[translated.length - 1]);
}
const MAX_TEXT_LENGTH = 5000;
const FUZZY_MAX_LENGTH = 3000;
const RESULT_CACHE_LIMIT = 1000;

class TranslationService {
  constructor({ dbAdapter, aiService, translationConfig = {} } = {}) {
    this.db = dbAdapter;
    this.ai = aiService || getAiService();
    this.config = translationConfig || {};
    this.queue = [];
    this.pending = new Map();
    this.activeCount = 0;
    this.resultCache = new Map();
  }

  get maxConcurrent() {
    const value = Number(this.config.maxConcurrent);
    return Number.isInteger(value) && value > 0 ? value : 5;
  }

  get similarityThreshold() {
    const value = Number(this.config.similarityThreshold);
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0.9;
  }

  _cacheGet(key) {
    const value = this.resultCache.get(key);
    if (value) {
      this.resultCache.delete(key);
      this.resultCache.set(key, value);
    }
    return value || null;
  }

  _cacheSet(key, value) {
    this.resultCache.delete(key);
    this.resultCache.set(key, value);
    while (this.resultCache.size > RESULT_CACHE_LIMIT) {
      this.resultCache.delete(this.resultCache.keys().next().value);
    }
  }

  async translate({ text, targetLanguage, sourceLanguage } = {}) {
    const source = String(text || '');
    const target = normalizeLanguageCode(targetLanguage) || String(targetLanguage || '').trim();
    if (!source.trim()) throw new Error('翻訳するテキストがありません');
    if (source.length > MAX_TEXT_LENGTH) throw new Error('翻訳するテキストが長すぎます');
    if (!target) throw new Error('翻訳先の言語が指定されていません');

    const hash = textHash(source);
    const key = `${hash}|${target}`;
    const remembered = this._cacheGet(key);
    if (remembered) return { ...remembered, cached: true };

    const exact = await this.db.findTranslationByHash(hash, target).catch(() => null);
    if (exact) {
      const result = { translatedText: exact.translatedText, sourceLanguage: exact.sourceLanguage, targetLanguage: target };
      this._cacheSet(key, result);
      return { ...result, cached: true };
    }
    const fuzzy = await this._findFuzzy(source, target, sourceLanguage);
    if (fuzzy) {
      const result = { translatedText: fuzzy.translatedText, sourceLanguage: fuzzy.sourceLanguage, targetLanguage: target };
      this._cacheSet(key, result);
      return { ...result, cached: true };
    }

    if (this.pending.has(key)) return this.pending.get(key);
    const promise = new Promise((resolve, reject) => {
      this.queue.push({ key, text: source, targetLanguage: target, sourceLanguage: sourceLanguage || null, resolve, reject });
    });
    this.pending.set(key, promise);
    promise.catch(() => {}).finally(() => {
      if (this.pending.get(key) === promise) this.pending.delete(key);
    });
    this._pump();
    return promise;
  }

  async _findFuzzy(text, target, sourceLanguage) {
    const normalized = normalizeText(text);
    if (normalized.length < 2 || normalized.length > FUZZY_MAX_LENGTH) return null;
    const terms = indexTerms(normalized);
    if (!terms.length) return null;
    let candidates = [];
    try {
      candidates = await this.db.findTranslationCandidates({
        targetLanguage: target,
        sourceLanguage: sourceLanguage ? normalizeLanguageCode(sourceLanguage) : null,
        terms,
        termCount: terms.length,
        minLength: Math.floor(normalized.length * 0.75),
        maxLength: Math.ceil(normalized.length * 1.25),
      });
    } catch {
      return null;
    }
    let best = null;
    let bestScore = 0;
    for (const candidate of candidates || []) {
      const score = calculateStringSimilarity(normalized, candidate.sourceNormalized || normalizeText(candidate.sourceText));
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    return best && bestScore >= this.similarityThreshold ? best : null;
  }

  _pump() {
    while (this.activeCount < this.maxConcurrent && this.queue.length) {
      const job = this.queue.shift();
      this.activeCount += 1;
      this._runJob(job).then(job.resolve, job.reject).finally(() => {
        this.activeCount -= 1;
        this._pump();
      });
    }
  }

  // 元の言語の推定と翻訳を1回の呼び出しで行う。1行目が言語コード、2行目以降が翻訳。
  async _generateTranslation(job, hinted) {
    const response = await this.ai.generate({
      provider: this.config.provider || 'auto',
      model: this.config.model || undefined,
      reasoningEffort: this.config.reasoningEffort || undefined,
      system: [
        `Translate the user's text into ${job.targetLanguage}.`,
        'First, identify the language of the text. The first line of your reply must contain only the ISO 639-1 language code of the original text, such as ja, en, ko, or zh.',
        'From the second line on, write the translation.',
        'Translate the whole text; do not leave out or summarize any part of it, and finish the last sentence completely, never stopping in the middle of a word or sentence.',
        'Before translating, grasp the tone and feel of the whole text, and keep that same tone and feel in the translation.',
        'Preserving the meaning and nuance matters more than translating word for word. If a literal translation would lose the nuance, rephrase it in another natural way, or leave that part in the original language instead of forcing a translation.',
        'Render idioms and set phrases by what they mean and how they land, not word for word. Never carry a metaphor over literally when it would sound unnatural in the target language; drop the metaphor and say what it means, in the same tone. If a phrase describes what someone or something is, keep it as a description of what they are; do not turn it into an action they perform.',
        'Do not force translations of slang; leave slang as it is.',
        'If you keep a slang expression in the original language, keep the whole expression; do not translate half of it.',
        'When you keep slang in the original language, word the rest of the sentence so its meaning stays clear from the context. If a slang term is not widely known, work a brief hint at its meaning into the wording of the sentence itself; do not transliterate kept slang into the target language\u2019s script, and do not attach a parenthetical gloss to it.',
        'Keep proper nouns as they are, or write them as they are read in the target language.',
        'Keep placeholders such as {name}, mentions, hashtags, URLs, and line breaks unchanged.',
        'If the text is already in the target language, write the original text unchanged from the second line on.',
      ].join(' '),
      text: job.text,
      maxOutputTokens: 2048,
      timeoutMs: REQUEST_TIMEOUT_MS,
      routingTimeoutMs: ROUTING_TIMEOUT_MS,
    });
    const raw = extractAiText(response);
    const newlineIndex = raw.indexOf('\n');
    const detected = newlineIndex >= 0 ? parseLanguageCode(raw.slice(0, newlineIndex)) : null;
    const sourceLanguage = hinted || detected;
    if (!sourceLanguage) throw new Error('言語を判定できませんでした');
    let translatedText = (detected ? raw.slice(newlineIndex + 1) : raw).trim();
    if (sameLanguage(sourceLanguage, job.targetLanguage)) translatedText = job.text;
    const truncated = translatedText !== job.text && looksTruncated(response, job.text, translatedText);
    return { sourceLanguage, translatedText, truncated };
  }

  async _runJob(job) {
    const hinted = job.sourceLanguage ? normalizeLanguageCode(job.sourceLanguage) : null;
    let sourceLanguage = hinted;
    let translatedText = null;
    if (hinted && sameLanguage(hinted, job.targetLanguage)) {
      translatedText = job.text;
    } else {
      // 途中で切れた翻訳は保存せず、1回だけ訳し直す。
      let attempt = await this._generateTranslation(job, hinted);
      if (attempt.truncated) attempt = await this._generateTranslation(job, hinted);
      if (attempt.truncated) throw new Error('翻訳結果が途中で切れました');
      sourceLanguage = attempt.sourceLanguage;
      translatedText = attempt.translatedText;
    }
    if (!translatedText) throw new Error('翻訳結果が空でした');
    const normalized = normalizeText(job.text);
    const terms = normalized.length <= FUZZY_MAX_LENGTH ? indexTerms(normalized) : [];
    const record = {
      sourceHash: textHash(job.text),
      sourceText: job.text,
      sourceNormalized: normalized,
      bigramCount: terms.length,
      terms,
      sourceLanguage,
      targetLanguage: job.targetLanguage,
      translatedText,
    };
    await this.db.saveTranslation(record).catch(() => {});
    const result = { translatedText, sourceLanguage, targetLanguage: job.targetLanguage };
    this._cacheSet(job.key, result);
    return { ...result, cached: false };
  }
}

module.exports = { TranslationService };
