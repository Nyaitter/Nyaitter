'use strict';

const { getAiService } = require('./ai/AiService');
const { calculateStringSimilarity } = require('../utils/fuzzySearch');
const {
  normalizeText,
  textHash,
  indexTerms,
  extractAiText,
  normalizeLanguageCode,
  sameLanguage,
  detectTextLanguage,
} = require('../utils/textLanguage');

const REQUEST_TIMEOUT_MS = 60_000;
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

  async _runJob(job) {
    const sourceLanguage = job.sourceLanguage
      ? normalizeLanguageCode(job.sourceLanguage)
      : await detectTextLanguage(this.ai, this.config, job.text);
    if (!sourceLanguage) throw new Error('言語を判定できませんでした');
    if (sameLanguage(sourceLanguage, job.targetLanguage)) {
      return { translatedText: job.text, sourceLanguage, targetLanguage: job.targetLanguage, cached: false };
    }
    const response = await this.ai.generate({
      provider: this.config.provider || 'auto',
      model: this.config.model || undefined,
      system: [
        `Translate the user's text into ${job.targetLanguage}.`,
        'Preserve the original tone, nuance, and feel as much as possible.',
        'Keep placeholders such as {name}, mentions, hashtags, URLs, and line breaks unchanged.',
        'Output only the translated text.',
      ].join(' '),
      text: job.text,
      maxOutputTokens: 2048,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    const translatedText = extractAiText(response).trim();
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
