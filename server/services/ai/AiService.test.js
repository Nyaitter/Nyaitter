'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  AiService,
  resolveReasoningEffort,
  isValidReasoningEffort,
  modelOmitsReasoningEffort,
  isReasoningEffortError,
} = require('./AiService');

test('resolveReasoningEffort accepts only exact API values', () => {
  assert.equal(resolveReasoningEffort(''), null);
  assert.equal(resolveReasoningEffort(undefined), null);
  assert.equal(resolveReasoningEffort('none'), 'none');
  assert.equal(resolveReasoningEffort('medium'), 'medium');
  assert.equal(resolveReasoningEffort('xhigh'), 'xhigh');
  // No normalization: near-miss spellings are invalid, never rewritten.
  assert.equal(resolveReasoningEffort('middle'), null);
  assert.equal(resolveReasoningEffort('Medium'), null);
  assert.equal(resolveReasoningEffort(' LOW '), null);
  assert.equal(resolveReasoningEffort('default'), null);
  assert.equal(resolveReasoningEffort('bogus'), null);
  assert.equal(isValidReasoningEffort(''), true);
  assert.equal(isValidReasoningEffort('medium'), true);
  assert.equal(isValidReasoningEffort('middle'), false);
  assert.equal(isValidReasoningEffort('Medium'), false);
  assert.equal(isValidReasoningEffort('bogus'), false);
});

test('modelOmitsReasoningEffort only skips non-reasoning families', () => {
  assert.equal(modelOmitsReasoningEffort('gpt-4o'), true);
  assert.equal(modelOmitsReasoningEffort('gpt-4o-mini'), true);
  assert.equal(modelOmitsReasoningEffort('gpt-3.5-turbo'), true);
  assert.equal(modelOmitsReasoningEffort('chatgpt-4o-latest'), true);
  assert.equal(modelOmitsReasoningEffort('o3'), false);
  assert.equal(modelOmitsReasoningEffort('gpt-5'), false);
  assert.equal(modelOmitsReasoningEffort('future-model-1'), false);
});

test('isReasoningEffortError matches only effort rejections', () => {
  assert.equal(isReasoningEffortError({ statusCode: 400, param: 'reasoning_effort', code: 'unsupported_value' }), true);
  assert.equal(isReasoningEffortError({ statusCode: 400, param: '', code: 'invalid reasoning_effort value' }), true);
  assert.equal(isReasoningEffortError({ statusCode: 400, param: 'max_completion_tokens', code: 'unsupported_value' }), false);
  assert.equal(isReasoningEffortError({ statusCode: 429, param: 'reasoning_effort', code: '' }), false);
  assert.equal(isReasoningEffortError(new Error('boom')), false);
});

async function withFakeOpenAi(run, onChat) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, body: body ? JSON.parse(body) : null });
      res.setHeader('content-type', 'application/json');
      if (req.url.endsWith('/models')) {
        res.end(JSON.stringify({ data: [{ id: 'gpt-5' }, { id: 'o3' }, { id: 'gpt-4o' }] }));
      } else {
        const reply = onChat ? onChat(requests[requests.length - 1].body) : null;
        if (reply) {
          res.statusCode = reply.status;
          res.end(JSON.stringify(reply.payload));
        } else {
          res.end(JSON.stringify({ choices: [{ message: { content: '<safe>' } }] }));
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aisvc-test-'));
  try {
    const service = new AiService({
      providers: [{ id: 'fake', type: 'openai', url: `http://127.0.0.1:${server.address().port}/v1`, apikey: 'test-key' }],
      modelDbPath: path.join(dir, 'models.json'),
      workDir: dir,
    });
    await run(service, requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('generate sends reasoning_effort for OpenAI chat completions', async () => {
  await withFakeOpenAi(async (service, requests) => {
    await service.generate({ provider: 'fake', model: 'gpt-5', text: 'hi', reasoningEffort: 'medium' });
    const chat = requests.find((r) => r.url.endsWith('/chat/completions'));
    assert.ok(chat, 'chat completion request captured');
    assert.equal(chat.body.reasoning_effort, 'medium');
  });
});

test('generate does not send non-exact effort spellings', async () => {
  await withFakeOpenAi(async (service, requests) => {
    await service.generate({ provider: 'fake', model: 'gpt-5', text: 'hi', reasoningEffort: 'middle' });
    const chat = requests.find((r) => r.url.endsWith('/chat/completions'));
    assert.ok(chat);
    assert.ok(!('reasoning_effort' in chat.body));
  });
});

test('generate omits reasoning_effort by default (current behavior preserved)', async () => {
  await withFakeOpenAi(async (service, requests) => {
    await service.generate({ provider: 'fake', model: 'gpt-5', text: 'hi' });
    const chat = requests.find((r) => r.url.endsWith('/chat/completions'));
    assert.ok(chat);
    assert.ok(!('reasoning_effort' in chat.body));
  });
});

test('generate passes efforts through as-is and skips non-reasoning models', async () => {
  await withFakeOpenAi(async (service, requests) => {
    await service.generate({ provider: 'fake', model: 'o3', text: 'hi', reasoningEffort: 'none' });
    await service.generate({ provider: 'fake', model: 'gpt-4o', text: 'hi', reasoningEffort: 'high' });
    const chats = requests.filter((r) => r.url.endsWith('/chat/completions'));
    assert.equal(chats.length, 2);
    // No per-model remapping: the configured value reaches the API unchanged.
    assert.equal(chats[0].body.reasoning_effort, 'none');
    assert.ok(!('reasoning_effort' in chats[1].body));
  });
});

test('generate retries once without reasoning_effort when the API rejects the value', async () => {
  const effortError = {
    status: 400,
    payload: { error: { code: 'unsupported_value', param: 'reasoning_effort', message: "Unsupported value: 'reasoning_effort' does not support 'none' with this model." } },
  };
  await withFakeOpenAi(async (service, requests) => {
    const result = await service.generate({ provider: 'fake', model: 'o3', text: 'hi', reasoningEffort: 'none' });
    assert.ok(result.choices);
    const chats = requests.filter((r) => r.url.endsWith('/chat/completions'));
    assert.equal(chats.length, 2);
    assert.equal(chats[0].body.reasoning_effort, 'none');
    assert.ok(!('reasoning_effort' in chats[1].body));
  }, (body) => ('reasoning_effort' in body ? effortError : null));
});

test('generate does not retry unrelated API errors', async () => {
  const otherError = {
    status: 400,
    payload: { error: { code: 'unsupported_value', param: 'max_completion_tokens', message: 'Unsupported parameter.' } },
  };
  await withFakeOpenAi(async (service, requests) => {
    await assert.rejects(service.generate({ provider: 'fake', model: 'o3', text: 'hi', reasoningEffort: 'none' }));
    const chats = requests.filter((r) => r.url.endsWith('/chat/completions'));
    assert.equal(chats.length, 1);
  }, () => otherError);
});
