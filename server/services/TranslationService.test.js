'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const InMemoryAdapter = require('../adapters/database/InMemoryAdapter');
const { TranslationService } = require('./TranslationService');
const { textHash } = require('../utils/textLanguage');

// 翻訳リクエストには、1行目に言語コード、2行目以降に «» で囲んだ翻訳を返すモック。
function makeAi({ delayMs = 0 } = {}) {
  const state = { calls: 0, translateCalls: 0, active: 0, maxActive: 0, requests: [] };
  const ai = {
    generate: async (request) => {
      state.calls += 1;
      state.requests.push(request);
      state.translateCalls += 1;
      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      try {
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        const code = request.text.includes('こんにちは') ? 'ja' : 'en';
        return `${code}\n«${request.text}»`;
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
  assert.equal(state.calls, 1);
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

test('対象言語と原文の言語が同じ場合は原文をそのまま返し、判定結果を保存する', async () => {
  const { ai, state } = makeAi();
  const { db, service } = makeService(ai);
  const result = await service.translate({ text: 'こんにちは、世界', targetLanguage: 'ja' });
  assert.equal(result.translatedText, 'こんにちは、世界');
  assert.equal(result.sourceLanguage, 'ja');
  const saved = await db.findTranslationByHash(textHash('こんにちは、世界'), 'ja');
  assert.equal(saved.translatedText, 'こんにちは、世界');
  const callsBefore = state.calls;
  const again = await service.translate({ text: 'こんにちは、世界', targetLanguage: 'ja' });
  assert.equal(again.cached, true);
  assert.equal(state.calls, callsBefore);
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

test('長さ制限で切れた応答は訳し直し、完成した翻訳だけを保存する', async () => {
  let calls = 0;
  const ai = {
    generate: async () => {
      calls += 1;
      if (calls === 1) {
        return { choices: [{ message: { content: 'en\nCut off in the middle of a wo' }, finish_reason: 'length' }] };
      }
      return { choices: [{ message: { content: 'en\nComplete translation.' }, finish_reason: 'stop' }] };
    },
  };
  const { db, service } = makeService(ai);
  const result = await service.translate({ text: 'A sentence that needs a full translation.', targetLanguage: 'ja' });
  assert.equal(calls, 2);
  assert.equal(result.translatedText, 'Complete translation.');
  const saved = await db.findTranslationByHash(textHash('A sentence that needs a full translation.'), 'ja');
  assert.equal(saved.translatedText, 'Complete translation.');
});

test('文末が途中で切れた応答は訳し直す', async () => {
  let calls = 0;
  const ai = {
    generate: async () => {
      calls += 1;
      return calls === 1 ? 'en\n最後まで行かない途中の文' : 'en\n最後まで訳した文。';
    },
  };
  const { service } = makeService(ai);
  const result = await service.translate({ text: 'A sentence that needs a full translation.', targetLanguage: 'ja' });
  assert.equal(calls, 2);
  assert.equal(result.translatedText, '最後まで訳した文。');
});

test('訳し直しても切れる場合は保存せずに失敗する', async () => {
  let calls = 0;
  const ai = {
    generate: async () => {
      calls += 1;
      return 'en\nAlways cut off mid wo';
    },
  };
  const { db, service } = makeService(ai);
  await assert.rejects(
    service.translate({ text: 'A sentence that needs a full translation.', targetLanguage: 'ja' }),
    /途中で切れました/,
  );
  assert.equal(calls, 2);
  const saved = await db.findTranslationByHash(textHash('A sentence that needs a full translation.'), 'ja');
  assert.equal(saved, null);
});

test('ツール呼び出しで返された翻訳結果を使う', async () => {
  const ai = {
    generate: async (request) => {
      assert.ok(Array.isArray(request.tools));
      return {
        choices: [{
          message: {
            tool_calls: [{
              id: 'call-1',
              function: {
                name: 'submit_translation',
                arguments: JSON.stringify({ source_language: 'en', translated_text: '«ツール経由の翻訳。»' }),
              },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      };
    },
  };
  const { service } = makeService(ai);
  const result = await service.translate({ text: 'A tool call sentence.', targetLanguage: 'ja' });
  assert.equal(result.sourceLanguage, 'en');
  assert.equal(result.translatedText, '«ツール経由の翻訳。»');
});

test('ツール呼び出しが使えないプロバイダではテキスト形式に切り替える', async () => {
  let calls = 0;
  const ai = {
    generate: async (request) => {
      calls += 1;
      if (request.tools) throw Object.assign(new Error('Tool calls are not supported'), { code: 'AI_CAPABILITY' });
      return 'en\n«テキスト経由の翻訳。»';
    },
  };
  const { service } = makeService(ai);
  const result = await service.translate({ text: 'A fallback sentence.', targetLanguage: 'ja' });
  assert.equal(calls, 2);
  assert.equal(result.translatedText, '«テキスト経由の翻訳。»');
});

test('ツール呼び出しが返らなかった場合は応答テキストから読み取る', async () => {
  const { ai } = makeAi();
  const { service } = makeService(ai);
  const result = await service.translate({ text: 'Plain text reply', targetLanguage: 'ja' });
  assert.equal(result.translatedText, '«Plain text reply»');
  assert.equal(result.sourceLanguage, 'en');
});

test('翻訳リクエストには日本語と中国語の見分け方と出力言語の確認が含まれる', async () => {
  const { ai, state } = makeAi();
  const { service } = makeService(ai);
  await service.translate({ text: '一回pixiv見てこいよ', targetLanguage: 'en' });
  const system = state.requests[0].system;
  assert.ok(system.includes('hiragana or katakana is Japanese, never Chinese'));
  assert.ok(system.includes('hangul is Korean'));
  assert.ok(system.includes('Write the translation in en only'));
  assert.ok(system.includes('check that the translation is not written in the language you identified'));
});

test('保存済み翻訳の検索中でも、同じ文のリクエストは合流して検索を繰り返さない', async () => {
  const { ai, state } = makeAi();
  const { db, service } = makeService(ai);
  let lookups = 0;
  const original = db.findTranslationByHash.bind(db);
  db.findTranslationByHash = async (...args) => {
    lookups += 1;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return original(...args);
  };
  const [a, b] = await Promise.all([
    service.translate({ text: 'Join during lookup', targetLanguage: 'ja' }),
    service.translate({ text: 'Join during lookup', targetLanguage: 'ja' }),
  ]);
  assert.equal(a.translatedText, '«Join during lookup»');
  assert.equal(b.translatedText, a.translatedText);
  assert.equal(state.translateCalls, 1);
  assert.equal(lookups, 1);
});

test('キューで待機中の文へのリクエストは、新しく追加せず待機中の翻訳に合流する', async () => {
  const { ai, state } = makeAi({ delayMs: 60 });
  const { service } = makeService(ai, { maxConcurrent: 1 });
  const first = service.translate({ text: 'First in line', targetLanguage: 'ja' });
  const queued = service.translate({ text: 'Queued sentence', targetLanguage: 'ja' });
  const duplicate = service.translate({ text: 'Queued sentence', targetLanguage: 'ja' });
  const [firstResult, queuedResult, duplicateResult] = await Promise.all([first, queued, duplicate]);
  assert.equal(firstResult.translatedText, '«First in line»');
  assert.equal(queuedResult.translatedText, '«Queued sentence»');
  assert.equal(duplicateResult.translatedText, queuedResult.translatedText);
  assert.equal(state.translateCalls, 2);
});

test('設定した reasoning effort が翻訳リクエストに渡り、未設定では渡らない', async () => {
  const configured = makeAi();
  const { service } = makeService(configured.ai, { reasoningEffort: 'none' });
  await service.translate({ text: 'Hello world', targetLanguage: 'ja' });
  assert.equal(configured.state.requests[0].reasoningEffort, 'none');

  const plain = makeAi();
  const { service: plainService } = makeService(plain.ai);
  await plainService.translate({ text: 'Hello world', targetLanguage: 'ja' });
  assert.equal(plain.state.requests[0].reasoningEffort, undefined);
});
