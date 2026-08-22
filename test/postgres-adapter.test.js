'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const PostgresAdapter = require('../server/adapters/database/postgres/PostgresAdapter');

test('PostgresAdapter handles user lifecycle, queries, and cache invalidation', async () => {
  const executedQueries = [];
  const userTable = new Map();
  const sessionTable = new Map();
  const postTable = new Map();
  const dmE2eKeysTable = new Map();

  userTable.set(101, {
    id: 101,
    name: 'PGUser',
    handle: '@101',
    auth_provider: 'local',
    created_at: new Date().toISOString(),
  });

  const mockPool = {
    query: async (sql, values = []) => {
      executedQueries.push({ sql: String(sql).trim(), values });
      const sqlText = String(sql).trim();

      if (sqlText.includes('SELECT * FROM users WHERE id = $1')) {
        const u = userTable.get(Number(values[0]));
        return { rows: u ? [u] : [] };
      }
      if (sqlText.includes('UPDATE users SET')) {
        const u = userTable.get(Number(values.at(-1)));
        if (u) {
          u.bio = 'Updated bio';
          return { rows: [u] };
        }
        return { rows: [] };
      }
      if (sqlText.includes('SELECT * FROM sessions WHERE token = $1')) {
        const s = sessionTable.get(values[0]);
        return { rows: s ? [s] : [] };
      }
      if (sqlText.includes('INSERT INTO sessions')) {
        const s = {
          token: values[0],
          user_id: values[1],
          created_at: values[2],
          expires_at: values[3],
        };
        sessionTable.set(s.token, s);
        return { rows: [s] };
      }
      if (sqlText.includes('INSERT INTO dm_e2e_keys')) {
        dmE2eKeysTable.set(Number(values[0]), values[1]);
        return { rows: [] };
      }
      if (sqlText.includes('SELECT user_id, public_key FROM dm_e2e_keys')) {
        const rows = [];
        for (const id of values[0] || []) {
          if (dmE2eKeysTable.has(Number(id))) {
            rows.push({ user_id: Number(id), public_key: dmE2eKeysTable.get(Number(id)) });
          }
        }
        return { rows };
      }
      if (sqlText.includes('COUNT(*)')) {
        return { rows: [{ count: 0 }] };
      }

      return { rows: [] };
    },
  };

  const pg = new PostgresAdapter({ connectionString: 'postgres://localhost/test' });
  pg.pool = mockPool;

  // 1. Get user (populates cache)
  const user = await pg.getUserById(101);
  assert.equal(user.name, 'PGUser');
  assert.ok(pg._userCache.has(101));

  // 2. Cache invalidation on update
  await pg.updateUserProfile(101, { bio: 'Updated bio' });
  assert.equal(pg._userCache.has(101), false);

  // 3. Create Session
  const session = await pg.createSession(101, { userAgent: 'test' });
  assert.ok(session.token);

  // 4. Set & Get DM E2E Key
  await pg.setDmPublicKey(101, 'pg_public_key');
  const e2eKeys = await pg.getDmPublicKeys([101]);
  assert.equal(e2eKeys[0].public_key, 'pg_public_key');

  assert.ok(executedQueries.length >= 4);
});
