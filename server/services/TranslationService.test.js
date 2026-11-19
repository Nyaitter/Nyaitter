'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const InMemoryAdapter = require('../adapters/database/InMemoryAdapter');
const { TranslationService } = require('./TranslationService');
const { textHash } = require('../utils/textLanguage');

// 検出リクエストには言語コードを返し、翻訳リクエストには «» で囲んで返すモック。
function makeAi({ delayMs = 0 } = {}) {
  const state = { calls: 0, translateCalls: 0, active: 0, maxActive: 0 };
  const ai = {
    generate: async (request) => {
      state.calls += 1;
      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      try {
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        const system = String(request.system || '');
        if (system.includes('ISO 639-1')) return request.text.includes('こんにちは') ? 'ja' : 'en';
        state.translateCalls += 1;
        return `«${request.text}»`;
      } finally {
        state.active -= 1;
      }
    },
  };
  return { ai, state };
}

function makeService(ai, config = {}) {
  const db = new InMemoryAdapter();
  const service = new TranslationService({ dbAdapter: db, aiService: ai, translationConfig: config });
  return { db, service };
}

test('翻訳してDBへ保存し、次回の同一テキストはキャッシュから返す', async () => {
  const { ai, state } = makeAi();
  const { db, service } = makeService(ai);
  const first = await service.translate({ text: 'Hello world', targetLanguage: 'ja' });
  assert.equal(first.translatedText, '«Hello world»');
  assert.equal(first.sourceLanguage, 'en');
  assert.equal(first.cached, false);
  const saved = await db.findTranslationByHash(textHash('Hello world'), 'ja');
  assert.equal(saved.translatedText, '«Hello world»');

  const callsBefore = state.calls;
  const second = await service.translate({ text: 'Hello world', targetLanguage: 'ja' });
  assert.equal(second.cached, true);
  assert.equal(second.translatedText, '«Hello world»');
  assert.equal(state.calls, callsBefore);
});

test('一致度が閾値以上のテキストは保存済みの翻訳で応答する', async () => {
  const { ai, state } = makeAi();
  const { service } = makeService(ai);
  const original = 'The quick brown fox jumps over the lazy dog near the river bank today';
  await service.translate({ text: original, targetLanguage: 'ja' });
  const translateCallsBefore = state.translateCalls;
  const similar = await service.translate({ text: `${original}!`, targetLanguage: 'ja' });
  assert.equal(similar.translatedText, `«${original}»`);
  assert.equal(similar.cached, true);
  assert.equal(state.translateCalls, translateCallsBefore);
});

test('対象言語と原文の言語が同じ場合は原文をそのまま返し、保存しない', async () => {
  const { ai } = makeAi();
  const { db, service } = makeService(ai);
  const result = await service.translate({ text: 'こんにちは、世界', targetLanguage: 'ja' });
  assert.equal(result.translatedText, 'こんにちは、世界');
  assert.equal(result.sourceLanguage, 'ja');
  assert.equal(await db.findTranslationByHash(textHash('こんにちは、世界'), 'ja'), null);
});

test('並行作業数は設定値までに制限される', async () => {
  const { ai, state } = makeAi({ delayMs: 30 });
  const { service } = makeService(ai, { maxConcurrent: 2 });
  const texts = ['one apple', 'two bananas', 'three cherries', 'four dates', 'five figs', 'six grapes'];
  const results = await Promise.all(texts.map((text) => service.translate({ text, targetLanguage: 'ja' })));
  assert.equal(results.length, 6);
  assert.ok(state.maxActive <= 2, `maxActive=${state.maxActive}`);
});

test('似ていないテキストは保存済みの翻訳に一致しない', async () => {
  const { ai, state } = makeAi();
  const { service } = makeService(ai);
  await service.translate({ text: 'The quick brown fox jumps over the lazy dog near the river bank today', targetLanguage: 'ja' });
  const before = state.translateCalls;
  const other = await service.translate({ text: 'Completely different sentence about quantum physics and entropy', targetLanguage: 'ja' });
  assert.equal(other.cached, false);
  assert.equal(state.translateCalls, before + 1);
});

test('多数の翻訳が保存されていても、近いテキストだけが候補になる', async () => {
  const { ai, state } = makeAi();
  const { service } = makeService(ai);
  for (let i = 0; i < 30; i++) {
    await service.translate({ text: `Unrelated stored sentence number ${i} with its own distinct wording`, targetLanguage: 'ja' });
  }
  const target = 'A particular announcement about the library opening hours on weekends';
  await service.translate({ text: target, targetLanguage: 'ja' });
  const before = state.translateCalls;
  const hit = await service.translate({ text: `${target}.`, targetLanguage: 'ja' });
  assert.equal(hit.cached, true);
  assert.equal(hit.translatedText, `«${target}»`);
  assert.equal(state.translateCalls, before);
});

test('一度翻訳したテキストはDBを引かずに応答する', async () => {
  const { ai } = makeAi();
  const { db, service } = makeService(ai);
  await service.translate({ text: 'Cache me please', targetLanguage: 'ja' });
  let lookups = 0;
  const original = db.findTranslationByHash.bind(db);
  db.findTranslationByHash = async (...args) => { lookups += 1; return original(...args); };
  const again = await service.translate({ text: 'Cache me please', targetLanguage: 'ja' });
  assert.equal(again.cached, true);
  assert.equal(lookups, 0);
});

test('同一テキストの同時リクエストは1回の翻訳に集約される', async () => {
  const { ai, state } = makeAi({ delayMs: 20 });
  const { service } = makeService(ai);
  const [a, b] = await Promise.all([
    service.translate({ text: 'Same text here', targetLanguage: 'ja' }),
    service.translate({ text: 'Same text here', targetLanguage: 'ja' }),
  ]);
  assert.equal(a.translatedText, b.translatedText);
  assert.equal(state.translateCalls, 1);
});
