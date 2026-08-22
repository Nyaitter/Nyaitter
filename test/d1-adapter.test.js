'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const D1Adapter = require('../server/adapters/database/d1/D1Adapter');

test('D1Adapter routes and executes API requests correctly', async () => {
  const requests = [];

  // Mock fetch function
  const mockFetch = async (url, options = {}) => {
    const urlStr = String(url);
    const parsed = new URL(urlStr);
    const pathname = parsed.pathname;
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    
    requests.push({ url: urlStr, pathname, method, body });

    // Mock endpoints
    if (pathname === '/users' && method === 'POST') {
      return {
        ok: true,
        json: async () => ({ id: 101, name: body.name, scid: body.scid, auth_provider: 'local' }),
      };
    }
    if (pathname === '/users/101' && method === 'GET') {
      return {
        ok: true,
        json: async () => ({ id: 101, name: 'TestD1User', scid: 'scid_d1' }),
      };
    }
    if (pathname === '/posts' && method === 'POST') {
      return {
        ok: true,
        json: async () => ({ id: 501, user_id: body.userId, content: body.content, tags: body.tags || [] }),
      };
    }
    if (pathname === '/trending-hashtags' && method === 'GET') {
      return {
        ok: true,
        json: async () => ({
          hashtags: [{ tag: 'nyaitter', count: 5 }],
          tags: [{ tag: 'cats', count: 3 }],
          trends: [{ tag: '#nyaitter', count: 5 }, { tag: 'cats', count: 3 }],
        }),
      };
    }
    if (pathname === '/sessions' && method === 'POST') {
      return {
        ok: true,
        json: async () => ({ token: 'd1_token_123', userId: body.userId, tokenHash: 'hash_123' }),
      };
    }
    if (pathname === '/groups' && method === 'POST') {
      return {
        ok: true,
        json: async () => ({ id: 'grp_1', name: body.name, owner_id: body.ownerId, visibility: 'public' }),
      };
    }
    if (pathname === '/dm-channels' && method === 'POST') {
      return {
        ok: true,
        json: async () => ({ id: '101:102', participants: [101, 102], created_at: new Date().toISOString() }),
      };
    }
    if (pathname === '/dm-e2e-keys' && method === 'PUT') {
      return {
        ok: true,
        json: async () => ({ user_id: body.userId, public_key: body.publicKey }),
      };
    }
    if (pathname === '/dm-e2e-keys' && method === 'GET') {
      return {
        ok: true,
        json: async () => [{ user_id: 101, public_key: 'pk_101' }],
      };
    }

    return {
      ok: true,
      json: async () => ({}),
    };
  };

  const d1 = new D1Adapter({
    endpoint: 'https://d1.example.com',
    token: 'test_token',
    fetch: mockFetch,
  });

  await d1.connect();

  // 1. Create User
  const user = await d1.createUser({ name: 'TestD1User', scid: 'scid_d1' });
  assert.equal(user.id, 101);
  assert.equal(user.name, 'TestD1User');

  // 2. Get User
  const byId = await d1.getUserById(101);
  assert.equal(byId.id, 101);

  // 3. Create Post
  const post = await d1.createPost({ userId: 101, content: 'Hello D1', tags: ['d1'] });
  assert.equal(post.id, 501);

  // 4. Trending hashtags
  const trends = await d1.getTrendingHashtags(10, { summary: true });
  assert.ok(Array.isArray(trends.hashtags));
  assert.ok(Array.isArray(trends.tags));

  // 5. Create Session
  const session = await d1.createSession(101, { userAgent: 'test' });
  assert.equal(session.token, 'd1_token_123');

  // 6. Create Group
  const group = await d1.createGroup({ ownerId: 101, name: 'D1 Group' });
  assert.equal(group.id, 'grp_1');

  // 7. DM E2E Key
  await d1.setDmPublicKey(101, 'pk_101');
  const keys = await d1.getDmPublicKeys([101]);
  assert.equal(keys[0].public_key, 'pk_101');

  assert.ok(requests.length >= 7);
  await d1.disconnect();
});
