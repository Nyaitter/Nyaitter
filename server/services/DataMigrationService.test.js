'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const InMemoryAdapter = require('../adapters/database/InMemoryAdapter');
const { TABLES, normalizeSnapshot, verifySnapshotChecksum, createSnapshot } = require('./DataMigrationService');
const { TABLE_COLUMNS } = require('./DataMigrationSchema');
const { importPostgresSnapshot } = require('./DataMigrationSql');
const { countTables, sameCounts } = require('../migrations/migrate-data');

function snapshot(tables = {}) {
  return { version: 1, tables: { users: [], ...tables } };
}

function sqliteWorkerDb(sqlite) {
  return {
    prepare(sql) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        run() { return sqlite.prepare(sql).run(...args); },
        all() { return { results: sqlite.prepare(sql).all(...args) }; },
        first() { return sqlite.prepare(sql).get(...args) || null; },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        for (const statement of statements) statement.run();
        sqlite.exec('COMMIT');
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

test('legacy snapshots preserve destination audit history while explicit empty logs clear it', async () => {
  const db = new InMemoryAdapter();
  db.modLogs = [{ id: 'existing', createdAt: '2026-01-01', actorType: 'admin', actorId: null, action: 'ban', targetType: 'user', targetId: '1', result: 'ok' }];

  assert.equal(normalizeSnapshot(snapshot()).mod_logs_present, false);
  await db.importDataSnapshot(snapshot(), { replace: true });
  assert.equal(db.modLogs.length, 1);
  assert.equal(db.modLogs[0].id, 'existing');

  assert.equal(normalizeSnapshot(snapshot({ mod_logs: [] })).mod_logs_present, true);
  await db.importDataSnapshot(snapshot({ mod_logs: [] }), { replace: true });
  assert.deepEqual(db.modLogs, []);
});

test('legacy import is allowed for a new memory destination; non-replace remains rejected', async () => {
  const db = new InMemoryAdapter();
  await assert.doesNotReject(db.importDataSnapshot(snapshot(), { replace: true }));
  await assert.rejects(db.importDataSnapshot(snapshot(), { replace: false }), /replace=true/);
});

// PostgreSQL の information_schema 応答を模した最小クライアント。
// 列は DataMigrationSchema の定義から作り、実DBの代わりに使う。
function pgSchemaRows(tables) {
  const rows = [];
  for (const table of tables) {
    for (const column of TABLE_COLUMNS[table]) rows.push({ table_name: table, column_name: column });
  }
  return rows;
}

function fakePostgresClient(queries, { failOn = null, availableTables = TABLES } = {}) {
  const schemaRows = pgSchemaRows(availableTables);
  return {
    async query(sql, params) {
      queries.push(sql);
      if (sql.includes('information_schema.columns')) {
        const wanted = new Set(params?.[0] || []);
        return { rows: schemaRows.filter((row) => wanted.has(row.table_name)) };
      }
      if (sql.startsWith('SELECT to_regclass')) return { rows: [{ name: 'x' }] };
      if (failOn && sql.startsWith(failOn)) throw new Error('injected insert failure');
      return { rows: [] };
    },
    release() {},
  };
}

test('Postgres replacement failure rolls back without deleting omitted audit history', async () => {
  const queries = [];
  const client = fakePostgresClient(queries, { failOn: 'INSERT INTO "users"' });
  const pool = { async connect() { return client; } };
  await assert.rejects(importPostgresSnapshot(pool, snapshot({ users: [{ id: 1, name: 'test' }] }), { replace: true }), /injected insert failure/);
  assert.equal(queries.includes('DELETE FROM "mod_logs"'), false);
  assert.equal(queries.at(-1), 'ROLLBACK');
});

test('Postgres replacement only deletes tables the snapshot actually contains', async () => {
  const queries = [];
  const client = fakePostgresClient(queries);
  const pool = { async connect() { return client; } };
  // 旧形式（version 1）は polls などを知らない。宛先の既存行を消してはいけない。
  const legacy = { version: 1, tables: { users: [{ id: 1, name: 'u' }], posts: [], mod_logs: [] } };
  const report = await importPostgresSnapshot(pool, legacy, { replace: true });
  assert.equal(queries.some((sql) => sql === 'DELETE FROM "polls"'), false);
  assert.equal(queries.some((sql) => sql === 'DELETE FROM "account_recovery_requests"'), false);
  assert.equal(queries.includes('DELETE FROM "users"'), true);
  assert.equal(report.preserved_tables.includes('polls'), true);
  assert.equal(report.imported_tables.includes('polls'), false);
  assert.equal(Object.hasOwn(report.imported, 'polls'), true);
  assert.equal(report.imported.polls, null);
});

test('Postgres replacement reports trigger-deleted reputation tables', async () => {
  const queries = [];
  const client = fakePostgresClient(queries);
  const pool = { async connect() { return client; } };
  const report = await importPostgresSnapshot(pool, {
    version: 2,
    tables_present: ['users', 'posts'],
    tables: { users: [], posts: [] },
  }, { replace: true });
  assert.equal(report.cascaded_tables.includes('reputation_events'), true);
});

test('Postgres replacement reports the full migration cascade closure for multiple roots', async () => {
  const queries = [];
  const client = fakePostgresClient(queries);
  const pool = { async connect() { return client; } };
  const report = await importPostgresSnapshot(pool, {
    version: 2,
    tables_present: ['users', 'posts', 'groups', 'spaces'],
    tables: { users: [], posts: [], groups: [], spaces: [] },
  }, { replace: true });
  const lost = [
    'community_notes', 'note_ratings', 'note_reason_tags', 'note_distribution', 'note_rating_reasons',
    'note_vote_admissions', 'note_creation_claims', 'note_selection_identities', 'reputation_events',
    'reputation_daily', 'reputation_profiles', 'reviewer_outcome_claims', 'reviewer_outcome_candidates',
  ];
  for (const table of lost) assert.equal(report.cascaded_tables.includes(table), true, `${table} should be reported`);
  for (const table of ['note_reason_tag_defs', 'reputation_scopes', 'reputation_notice_claims']) {
    assert.equal(report.cascaded_tables.includes(table), false, `${table} should remain`);
  }
});

test('Postgres import copies the six previously omitted tables and metadata columns', async () => {
  const queries = [];
  const client = fakePostgresClient(queries);
  const pool = { async connect() { return client; } };
  const full = {
    version: 2,
    tables_present: ['users', 'posts', 'account_recovery_requests', 'blocked_login_ips', 'polls', 'poll_votes', 'authorized_apps', 'post_feedback'],
    tables: {
      users: [{ id: 1, name: 'u', note_rank: 12, note_max_per_day: 4, note_min_public_threshold: 2 }],
      posts: [{ id: 10, user_id: 1, content: 'x', like_count: 9, reply_control: 'followers', scheduled_at: '2026-01-01T00:00:00.000Z' }],
      account_recovery_requests: [{ id: 'r1', user_id: 1, ip_hash: 'h', request_token_hash: 't', status: 'expired', wait_until: '2026-01-01T00:00:00.000Z' }],
      blocked_login_ips: [{ user_id: 1, ip_hash: 'h', ip_masked: 'm' }],
      polls: [{ id: 'p1', post_id: 10, user_id: 1, title: 'q', options: [{ id: 1, text: 'a' }] }],
      poll_votes: [{ id: 'v1', poll_id: 'p1', user_id: 1, option_id: 1 }],
      authorized_apps: [{ id: 1, user_id: 1, app_id: 'a', app_token_hash: 'h', app_name: 'n', scopes: ['read'] }],
      post_feedback: [{ user_id: 1, post_id: 10, kind: 'not_interested' }],
    },
  };
  const report = await importPostgresSnapshot(pool, full, { replace: true });
  for (const table of ['account_recovery_requests', 'blocked_login_ips', 'polls', 'poll_votes', 'authorized_apps', 'post_feedback']) {
    assert.equal(queries.some((sql) => sql.startsWith(`INSERT INTO "${table}"`)), true, `${table} must be inserted`);
    assert.equal(report.imported[table], 1);
  }
  const userInsert = queries.find((sql) => sql.startsWith('INSERT INTO "users"'));
  assert.match(userInsert, /"note_rank"/);
  assert.match(userInsert, /"note_max_per_day"/);
  const postInsert = queries.find((sql) => sql.startsWith('INSERT INTO "posts"'));
  assert.match(postInsert, /"reply_control"/);
  assert.match(postInsert, /"scheduled_at"/);
  // 派生カウンタは投入せず、実データから再計算する。
  assert.doesNotMatch(postInsert, /"like_count"/);
  assert.equal(queries.some((sql) => sql.startsWith('UPDATE posts SET like_count = (SELECT COUNT(*)')), true);
});

test('Postgres import fails before deleting anything when a snapshot table is missing at the destination', async () => {
  const queries = [];
  const client = fakePostgresClient(queries, { availableTables: TABLES.filter((table) => table !== 'polls') });
  const pool = { async connect() { return client; } };
  const withPolls = {
    version: 2,
    tables_present: ['users', 'polls'],
    tables: { users: [{ id: 1, name: 'u' }], polls: [{ id: 'p1', post_id: 1, user_id: 1, title: 'q' }] },
  };
  await assert.rejects(importPostgresSnapshot(pool, withPolls, { replace: true }), /missing tables required by the snapshot: polls/);
  assert.equal(queries.some((sql) => sql.startsWith('DELETE')), false);
  assert.equal(queries.at(-1), 'ROLLBACK');
});

test('Postgres import reports columns the destination does not have instead of dropping them silently', async () => {
  const queries = [];
  const client = fakePostgresClient(queries);
  // migration 034 未適用の宛先を模す（users に note_* が無い）。
  const schemaRows = pgSchemaRows(TABLES);
  const original = client.query.bind(client);
  client.query = async (sql, params) => {
    if (sql.includes('information_schema.columns')) {
      const wanted = new Set(params?.[0] || []);
      return { rows: schemaRows.filter((row) => wanted.has(row.table_name) && !row.column_name.startsWith('note_')) };
    }
    return original(sql, params);
  };
  const pool = { async connect() { return client; } };
  const report = await importPostgresSnapshot(pool, {
    version: 2,
    tables_present: ['users'],
    tables: { users: [{ id: 1, name: 'u', note_rank: 5 }] },
  }, { replace: true });
  assert.deepEqual(report.skipped_columns.users.sort(), ['note_affirmative_score', 'note_max_per_day', 'note_min_public_threshold', 'note_rank']);
});

test('D1 adapter forwards legacy omission across the worker boundary', async () => {
  const D1Adapter = require('../adapters/database/d1/D1Adapter');
  const adapter = Object.create(D1Adapter.prototype);
  adapter._read = async () => ({ tables: { mod_logs: [] } });
  let sent;
  adapter._write = async (_path, body) => { sent = body.snapshot; return { counts: {} }; };
  await adapter.importDataSnapshot(snapshot(), { replace: true });
  assert.equal(sent.mod_logs_present, false);
  assert.deepEqual(sent.tables.mod_logs, []);
  await adapter.importDataSnapshot(normalizeSnapshot(snapshot()), { replace: true });
  assert.equal(sent.mod_logs_present, false);
});

test('legacy omitted mod_logs counts do not reject a successful import preserving destination logs', () => {
  const legacy = normalizeSnapshot(snapshot());
  const destination = normalizeSnapshot(snapshot({ mod_logs: [{ id: 'kept', created_at: '2026-01-01', actor_type: 'admin', action: 'ban', target_type: 'user', target_id: '1', result: 'ok' }] }));
  const sourceCounts = countTables(legacy);
  const destinationCounts = countTables(destination);
  assert.equal(Object.hasOwn(sourceCounts, 'mod_logs'), false);
  assert.equal(destinationCounts.mod_logs, 1);
  assert.equal(sameCounts(sourceCounts, destinationCounts), true);
});

test('old checksummed snapshots remain valid, and omitted versus explicit-empty logs survive verification', () => {
  const previousTables = Object.fromEntries(TABLES.filter((table) => table !== 'mod_logs').map((table) => [table, []]));
  const legacyUnsigned = { version: 1, created_at: '2025-01-02T00:00:00.000Z', source_adapter: 'postgres', tables: previousTables };
  legacyUnsigned.checksum = crypto.createHash('sha256').update(JSON.stringify(legacyUnsigned)).digest('hex');
  const verifiedLegacy = verifySnapshotChecksum(legacyUnsigned);
  assert.equal(verifiedLegacy.mod_logs_present, false);
  const { checksum: _legacyChecksum, ...legacyBase } = legacyUnsigned;
  const oldFormatWithLogs = { ...legacyBase, tables: { users: [], mod_logs: [] } };
  oldFormatWithLogs.checksum = crypto.createHash('sha256').update(JSON.stringify(oldFormatWithLogs)).digest('hex');
  assert.equal(verifySnapshotChecksum(oldFormatWithLogs).mod_logs_present, true);
  const explicit = createSnapshot('memory', { users: [], mod_logs: [] });
  assert.equal(verifySnapshotChecksum(explicit).mod_logs_present, true);
});

test('D1 worker preserves omitted logs and clears explicitly empty logs against SQLite', async () => {
  const { importMigrationSnapshot, MIGRATION_TABLES, MIGRATION_COLUMNS } = await import('../../workers/d1-proxy/src/index.js');
  const sqlite = new DatabaseSync(':memory:');
  for (const table of MIGRATION_TABLES) {
    const columns = MIGRATION_COLUMNS[table].map((column) => `"${column}" TEXT`).join(', ');
    sqlite.exec(`CREATE TABLE "${table}" (${columns})`);
  }
  sqlite.prepare('INSERT INTO mod_logs (id, created_at, actor_type, action, target_type, target_id, result) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('audit-1', '2026-01-01', 'admin', 'ban', 'user', '1', 'ok');
  const db = sqliteWorkerDb(sqlite);

  await importMigrationSnapshot(db, { version: 1, tables: { users: [] } });
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM mod_logs').get().n, 1);
  await importMigrationSnapshot(db, { version: 1, tables: { users: [], mod_logs: [] } });
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM mod_logs').get().n, 0);
  sqlite.close();
});

test('D1 worker failure in atomic batch rolls back all snapshot replacement changes', async () => {
  const { importMigrationSnapshot, MIGRATION_TABLES, MIGRATION_COLUMNS } = await import('../../workers/d1-proxy/src/index.js');
  const sqlite = new DatabaseSync(':memory:');
  for (const table of MIGRATION_TABLES) {
    const columns = MIGRATION_COLUMNS[table].map((column) => `"${column}" TEXT`).join(', ');
    sqlite.exec(`CREATE TABLE "${table}" (${columns})`);
  }
  sqlite.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run(1, 'existing-user');
  sqlite.prepare('INSERT INTO mod_logs (id, created_at, actor_type, action, target_type, target_id, result) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('audit-2', '2026-01-01', 'admin', 'ban', 'user', '2', 'ok');
  sqlite.exec("CREATE TRIGGER reject_user_import BEFORE INSERT ON users BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  const db = sqliteWorkerDb(sqlite);
  await assert.rejects(importMigrationSnapshot(db, { version: 1, tables: { users: [{ id: 9 }], mod_logs: [] } }), /injected failure/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM mod_logs').get().n, 1);
  assert.equal(sqlite.prepare('SELECT id, name FROM users').get().name, 'existing-user');
  sqlite.close();
});

test('D1 worker rejects over-budget snapshots before any replacement writes', async () => {
  const { importMigrationSnapshot, MIGRATION_TABLES, MIGRATION_COLUMNS } = await import('../../workers/d1-proxy/src/index.js');
  const sqlite = new DatabaseSync(':memory:');
  for (const table of MIGRATION_TABLES) {
    const columns = MIGRATION_COLUMNS[table].map((column) => `"${column}" TEXT`).join(', ');
    sqlite.exec(`CREATE TABLE "${table}" (${columns})`);
  }
  sqlite.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run(1, 'existing-user');
  const db = sqliteWorkerDb(sqlite);
  const oversized = { version: 1, tables: { users: [{ id: 2, name: 'x'.repeat(8 * 1024 * 1024) }] } };
  await assert.rejects(importMigrationSnapshot(db, oversized), /safe atomic-import size limit/);
  assert.equal(sqlite.prepare('SELECT id, name FROM users').get().name, 'existing-user');
  sqlite.close();
});

test('D1 worker rejects snapshots that exceed one atomic batch before deletion', async () => {
  const { importMigrationSnapshot, MIGRATION_TABLES, MIGRATION_COLUMNS } = await import('../../workers/d1-proxy/src/index.js');
  const sqlite = new DatabaseSync(':memory:');
  for (const table of MIGRATION_TABLES) {
    const columns = MIGRATION_COLUMNS[table].map((column) => `"${column}" TEXT`).join(', ');
    sqlite.exec(`CREATE TABLE "${table}" (${columns})`);
  }
  sqlite.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run(1, 'existing-user');
  const db = sqliteWorkerDb(sqlite);
  // 1 バッチ上限（1,000 ステートメント）を超える件数。DELETE も含めて数える。
  const tooManyStatements = { version: 1, tables: { dm_e2e_keys: Array.from({ length: 1100 }, (_, id) => ({ user_id: id + 2 })) } };
  await assert.rejects(importMigrationSnapshot(db, tooManyStatements), /atomic-import statement limit/);
  assert.equal(sqlite.prepare('SELECT id, name FROM users').get().name, 'existing-user');
  sqlite.close();
});

// 実際の D1 マイグレーションで作ったスキーマ。外部キーと CASCADE が実際に効く。
function createWorkerSchema(sqlite) {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '../../workers/d1-proxy/migrations');
  for (const file of fs.readdirSync(dir).filter((name) => /^\d+_.+\.sql$/.test(name)).sort()) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    let current = '';
    let inString = false;
    for (let index = 0; index < sql.length; index += 1) {
      const ch = sql[index];
      current += ch;
      if (!inString && ch === "'") { inString = true; continue; }
      if (inString) {
        if (ch === "'" && sql[index + 1] === "'") { current += sql[index + 1]; index += 1; continue; }
        if (ch === "'") inString = false;
        continue;
      }
      if (ch !== ';') continue;
      // トリガー本体の END; では分割しない。
      if (/CREATE\s+TRIGGER/i.test(current) && /\bBEGIN\b/i.test(current)) {
        const ends = (current.replace(/--[^\n]*/g, '').match(/^\s*END\s*;?\s*$/gim) || []).length;
        if (ends === 0) continue;
      }
      if (current.replace(/--[^\n]*/g, '').trim()) sqlite.exec(current);
      current = '';
    }
    if (current.replace(/--[^\n]*/g, '').trim()) sqlite.exec(current);
  }
}

test('D1 replacement does not cascade-delete snapshot tables into tables it does not contain', async () => {
  const { importMigrationSnapshot } = await import('../../workers/d1-proxy/src/index.js');
  const sqlite = new DatabaseSync(':memory:');
  createWorkerSchema(sqlite);
  const insert = (table, row) => {
    const columns = Object.keys(row);
    sqlite.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
      .run(...columns.map((column) => row[column]));
  };
  insert('users', { id: 1, name: 'u', handle: 'h' });
  insert('posts', { id: 10, user_id: 1, content: 'p', created_at: '2026-01-01' });
  insert('polls', { id: 900, post_id: 10, user_id: 1, title: 'q', options: '[]', created_at: '2026-01-01' });
  insert('poll_votes', { id: 901, poll_id: 900, user_id: 1, option_id: 1, created_at: '2026-01-01' });
  insert('post_feedback', { user_id: 1, post_id: 10, kind: 'not_interested', created_at: '2026-01-01' });
  insert('community_notes', { post_id: 10, user_id: 1, content: 'n', sources: '[]', status: 'limited', created_at: '2026-01-01', updated_at: '2026-01-01' });
  const count = (table) => sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const db = sqliteWorkerDb(sqlite);

  // 修正前のスナップショット（polls 等を知らない）。users/posts は空で置換する。
  const report = await importMigrationSnapshot(db, {
    version: 1,
    mod_logs_present: false,
    tables: { users: [], posts: [] },
  });
  // 親行が消えるため、polls / poll_votes / post_feedback / community_notes は連鎖削除される。
  // これは「黙って消える」のではなく、結果として報告される。
  assert.equal(count('polls'), 0);
  assert.equal(count('poll_votes'), 0);
  assert.equal(count('post_feedback'), 0);
  assert.equal(count('community_notes'), 0);
  for (const table of ['polls', 'poll_votes', 'post_feedback', 'community_notes']) {
    assert.equal(report.cascaded_tables.includes(table), true, `${table} must be reported as cascaded`);
    assert.equal(report.preserved_tables.includes(table), false);
  }
  sqlite.close();
});

test('D1 replacement keeps tables that the snapshot omits and that no cascade reaches', async () => {
  const { importMigrationSnapshot } = await import('../../workers/d1-proxy/src/index.js');
  const sqlite = new DatabaseSync(':memory:');
  createWorkerSchema(sqlite);
  sqlite.exec('CREATE TABLE independent_feature (id INTEGER PRIMARY KEY, note TEXT)');
  sqlite.exec('CREATE TABLE child_of_feature (id INTEGER PRIMARY KEY, feature_id INTEGER REFERENCES independent_feature(id) ON DELETE CASCADE)');
  sqlite.prepare('INSERT INTO independent_feature (id, note) VALUES (?, ?)').run(1, 'keep-me');
  sqlite.prepare('INSERT INTO child_of_feature (id, feature_id) VALUES (?, ?)').run(1, 1);
  const db = sqliteWorkerDb(sqlite);
  const report = await importMigrationSnapshot(db, { version: 2, tables_present: ['account_recovery_requests'], tables: { account_recovery_requests: [] } });
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM independent_feature').get().n, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM child_of_feature').get().n, 1);
  assert.equal(report.cascaded_tables.length, 0);
  assert.equal(report.preserved_tables.includes('independent_feature'), false);
  sqlite.close();
});

// version 2 の契約: tables_present が唯一の根拠。createSnapshot は省略テーブルにも
// 空配列のキーを作るため、キーの有無で判定するとファイル往復で全表が「含む」に化ける。
test('version 2 round-trip keeps omitted tables out of tables_present and out of the replacement', async () => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const dir = await fs.mkdtemp(path.join('/tmp/opencode', 'dmig-review-'));
  const file = path.join(dir, 'snapshot.json');
  const exported = createSnapshot('memory', { users: [{ id: 1, name: 'u' }] });
  assert.deepEqual(exported.tables_present, ['users']);
  await require('./DataMigrationService').writeSnapshot(file, exported);
  const reloaded = await require('./DataMigrationService').readSnapshot(file);
  assert.deepEqual(reloaded.tables_present, ['users']);
  assert.deepEqual(reloaded.tables.polls, []);
  await fs.rm(dir, { recursive: true, force: true });

  // 宛先の polls は保持される（キーだけある空配列は「含む」ではない）。
  const queries = [];
  const client = fakePostgresClient(queries);
  const pool = { async connect() { return client; } };
  const report = await importPostgresSnapshot(pool, reloaded, { replace: true });
  assert.equal(queries.includes('DELETE FROM "polls"'), false);
  assert.equal(report.preserved_tables.includes('polls'), true);
});

test('version 2 rejects rows for a table that tables_present omits instead of dropping them', () => {
  assert.throws(
    () => normalizeSnapshot({ version: 2, tables_present: ['users'], tables: { users: [], posts: [{ id: 1, user_id: 1, content: 'x' }] } }),
    /posts.*not listed in tables_present/,
  );
});

test('excluded tables are not reported as preserved by the PostgreSQL import', async () => {
  const queries = [];
  const client = fakePostgresClient(queries);
  const pool = { async connect() { return client; } };
  const report = await importPostgresSnapshot(pool, {
    version: 2, tables_present: ['users'], tables: { users: [] },
  }, { replace: true });
  const { EXCLUDED_TABLE_NAMES } = require('./DataMigrationSchema');
  assert.equal(report.preserved_tables.some((table) => EXCLUDED_TABLE_NAMES.includes(table)), false);
  assert.equal(report.excluded_tables.length > 0, true);
  assert.equal(report.excluded_tables.every((entry) => entry.reason), true);
});

test('D1 import reports transitively cascaded tables instead of claiming they were preserved', async () => {
  const { importMigrationSnapshot } = await import('../../workers/d1-proxy/src/index.js');
  const sqlite = new DatabaseSync(':memory:');
  createWorkerSchema(sqlite);
  const insert = (table, row) => {
    const columns = Object.keys(row);
    sqlite.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
      .run(...columns.map((column) => row[column]));
  };
  insert('users', { id: 1, name: 'u', handle: 'h' });
  insert('groups', { id: 'g1', owner_id: 1, name: 'g', visibility: 'open', created_at: '2026-01-01', updated_at: '2026-01-01' });
  insert('group_roles', { id: 'r1', group_id: 'g1', name: 'admin', permissions: '[]', is_system: 0, sort_order: 0, created_at: '2026-01-01', updated_at: '2026-01-01' });
  const db = sqliteWorkerDb(sqlite);
  const report = await importMigrationSnapshot(db, { version: 2, tables_present: ['users'], tables: { users: [] } });
  // groups は users の子、group_roles は groups の子。孫まで連鎖するので「保持」ではない。
  assert.equal(report.cascaded_tables.includes('groups'), true);
  assert.equal(report.cascaded_tables.includes('group_roles'), true);
  assert.equal(report.preserved_tables.includes('group_roles'), false);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM group_roles').get().n, 0);
  sqlite.close();
});

test('D1 import reports post_events as cleared separately from cascades', async () => {
	const { importMigrationSnapshot } = await import('../../workers/d1-proxy/src/index.js');
	const sqlite = new DatabaseSync(':memory:');
	createWorkerSchema(sqlite);
	sqlite.prepare("INSERT INTO post_events (event_type, status, available_at, created_at) VALUES ('test', 'pending', '2026-01-01', '2026-01-01')").run();
	const report = await importMigrationSnapshot(sqliteWorkerDb(sqlite), {
		version: 2, tables_present: ['groups'], tables: { groups: [] },
	});
	assert.deepEqual(report.cleared_tables, ['post_events']);
	assert.equal(report.cascaded_tables.includes('post_events'), false);
	assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM post_events').get().n, 0);
	sqlite.close();
});

test('D1 import omits post_events from cleared_tables when the destination table is absent', async () => {
	const { importMigrationSnapshot } = await import('../../workers/d1-proxy/src/index.js');
	const sqlite = new DatabaseSync(':memory:');
	createWorkerSchema(sqlite);
	sqlite.exec('DROP TABLE post_events');
	const report = await importMigrationSnapshot(sqliteWorkerDb(sqlite), {
		version: 2, tables_present: ['groups'], tables: { groups: [] },
	});
	assert.deepEqual(report.cleared_tables, []);
	sqlite.close();
});

test('D1 import still succeeds when the destination predates the post counter columns', async () => {
  const { importMigrationSnapshot } = await import('../../workers/d1-proxy/src/index.js');
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
  sqlite.exec('CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER, content TEXT, reply_to INTEGER, created_at TEXT)');
  sqlite.exec('CREATE TABLE likes (user_id INTEGER, post_id INTEGER, created_at TEXT)');
  sqlite.exec('CREATE TABLE stars (user_id INTEGER, post_id INTEGER, created_at TEXT)');
  sqlite.exec('CREATE TABLE reposts (user_id INTEGER, post_id INTEGER, created_at TEXT)');
  const db = sqliteWorkerDb(sqlite);
  const report = await importMigrationSnapshot(db, {
    version: 2, tables_present: ['users', 'posts'], tables: { users: [{ id: 1, name: 'u' }], posts: [{ id: 10, user_id: 1, content: 'p' }] },
  });
  assert.equal(report.imported_tables.includes('posts'), true);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM posts').get().n, 1);
  sqlite.close();
});

test('D1 replacement order deletes parents before children so foreign keys stay satisfied', () => {
  const { orderDeletions } = require('./DataMigrationOrder');
  const edges = [
    { child: 'polls', parent: 'users' },
    { child: 'poll_votes', parent: 'polls' },
    { child: 'posts', parent: 'users' },
    { child: 'likes', parent: 'posts' },
  ];
  const { deleteOrder, parentFirst } = orderDeletions(['users', 'posts', 'polls', 'poll_votes', 'likes'], edges);
  // 子より先に親。同じ階層内の順序は要件ではないため、位置関係だけを検証する。
  const before = (left, right) => deleteOrder.indexOf(left) < deleteOrder.indexOf(right);
  assert.equal(before('posts', 'users'), true);
  assert.equal(before('likes', 'posts'), true);
  assert.equal(before('poll_votes', 'polls'), true);
  assert.equal(before('polls', 'users'), true);
  assert.equal(parentFirst.length, 5);
  assert.deepEqual(new Set(deleteOrder), new Set(['users', 'posts', 'polls', 'poll_votes', 'likes']));
});

test('InMemory replacement preserves notes and reputation and reports them instead of dropping silently', async () => {
  const db = new InMemoryAdapter();
  const note = await db.createNote({ postId: 10, userId: 2, content: 'keep me' });
  db.reputationProfiles = new Map([[2, { writer: { score: 3, successes: 1 } }]]);
  const report = await db.importDataSnapshot(snapshot(), { replace: true });
  const kept = await db.getNote(note.id);
  assert.equal(kept?.content, 'keep me');
  assert.deepEqual(db.reputationProfiles.get(2), { writer: { score: 3, successes: 1 } });
  assert.equal(report.cascaded_tables.includes('community_notes'), false);
  assert.equal(report.preserved_tables.includes('community_notes'), true);
  assert.equal(report.excluded_tables.some((entry) => entry.table === 'community_notes'), true);
});

test('InMemory markGroupDmRead does not advance state_version while content updates do', async () => {
  const db = new InMemoryAdapter();
  const dm = await db.createGroupDm({ hostId: 1, member: [1, 2], title: 't' });
  await db.appendToGroupDm(dm.id, { id: 'm1', userid: 2, content: 'hi', time: '2026-01-01T00:00:00.000Z' }, 2);
  const beforeVersion = Number((await db.getGroupDm(dm.id)).state_version);
  await db.markGroupDmRead(dm.id, 1);
  const afterRead = await db.getGroupDm(dm.id);
  assert.equal(Number(afterRead.state_version), beforeVersion);
  await db.updateGroupDm(dm.id, { title: 'renamed' });
  const afterEdit = await db.getGroupDm(dm.id);
  assert.equal(Number(afterEdit.state_version), beforeVersion + 1);
});

test('D1 state_version trigger ignores unread-only and explicit-version updates but advances on content updates', async () => {
  const sqlite = new DatabaseSync(':memory:');
  createWorkerSchema(sqlite);
  sqlite.prepare("INSERT INTO users (id, name, handle) VALUES (1, 'u', 'h')").run();
  sqlite.prepare("INSERT INTO group_dms (id, host_id, title, member, post, unread, time, created_at, state_version) VALUES ('dm1', 1, 't', '[1,2]', '[]', '{\"_accepted\":[1,2],\"1\":3}', '2026-01-01', '2026-01-01', 5)").run();
  const version = () => sqlite.prepare("SELECT state_version FROM group_dms WHERE id='dm1'").get().state_version;
  // 既読マーク（unread の件数のみ）では進まない（集約列は D1 の group_dms には無い）。
  sqlite.prepare("UPDATE group_dms SET unread = '{\"_accepted\":[1,2],\"1\":0}' WHERE id='dm1'").run();
  assert.equal(version(), 5);
  // 明示的に世代を指定する更新（移行・復元）はその値を保持する。
  sqlite.prepare("UPDATE group_dms SET state_version = 42 WHERE id='dm1'").run();
  assert.equal(version(), 42);
  // 本文が変わる更新では1つ進む。
  sqlite.prepare("UPDATE group_dms SET post = '[{\"id\":\"m1\"}]' WHERE id='dm1'").run();
  assert.equal(version(), 43);
  sqlite.close();
});
