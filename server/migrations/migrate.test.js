'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { after, test } = require('node:test');

const runner = path.join(__dirname, 'migrate.js');
const scratchRoot = '/tmp/opencode';
fs.mkdirSync(scratchRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchRoot, 'migration-runner-test-'));
const pgMock = path.join(scratch, 'mock-pg.cjs');
fs.writeFileSync(pgMock, `
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'child_process') {
    const childProcess = originalLoad.call(this, request, parent, isMain);
    return {
      ...childProcess,
      spawnSync(command, args, options) {
        if (process.env.MOCK_D1_MODE) {
          process.stdout.write('mocked spawn: ' + command + ' ' + args.join(' ') + '\\n');
          return { status: process.env.MOCK_D1_MODE === 'fail' ? 7 : 0, error: null };
        }
        return childProcess.spawnSync(command, args, options);
      },
    };
  }
  if (request === '../config' && parent?.filename === ${JSON.stringify(runner)}) {
    return { database: {
      adapter: process.env.DB_ADAPTER || 'memory',
      postgres: {
        connectionString: process.env.MOCK_CONFIG_DATABASE_URL || '',
        transactionRetries: 0,
        retryBaseDelayMs: 10,
        sslCa: '',
        ssl: false,
      },
    } };
  }
  if (request === 'pg') {
    return { Client: class {
      async connect() {
        if (process.env.MOCK_PG_MODE === 'fail') {
          throw new Error('simulated connection failure: ' + process.env.DATABASE_URL);
        }
      }
      async query(sql) {
        return /SELECT filename FROM nyaitter_schema_migrations/i.test(sql) ? { rows: [] } : { rows: [] };
      }
      async end() {}
    } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
`);

after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function run(args = [], extraEnv = {}) {
  const env = { ...process.env };
  delete env.DB_ADAPTER;
  delete env.DATABASE_URL;
  delete env.POSTGRES_URL;
  delete env.MOCK_PG_MODE;
  Object.assign(env, extraEnv);
  env.NODE_OPTIONS = [env.NODE_OPTIONS, `--require=${pgMock}`].filter(Boolean).join(' ');
  return spawnSync(process.execPath, [runner, ...args], {
    cwd: path.resolve(__dirname, '../..'),
    env,
    encoding: 'utf8',
  });
}

test('--help succeeds without a database configuration', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
});

test('D1 delegates without requiring a PostgreSQL URL', () => {
  const result = run([], { DB_ADAPTER: 'd1', MOCK_D1_MODE: 'success' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /mocked spawn: npm .*migrate:remote/);
  assert.doesNotMatch(result.stderr, /connection URL is configured/i);
});

test('unsupported adapters fail explicitly without attempting PostgreSQL', () => {
  const result = run([], { DB_ADAPTER: 'sqlite' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unsupported DB_ADAPTER "sqlite"/);
  assert.doesNotMatch(result.stderr, /connection URL is configured/i);
});

test('PostgreSQL without a connection URL fails explicitly', () => {
  const result = run([], { DB_ADAPTER: 'postgres', DATABASE_URL: '', POSTGRES_URL: '' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no connection URL is configured/i);
  assert.match(result.stderr, /No migrations were applied/);
  assert.doesNotMatch(result.stderr, /postgres:\/\//i);
});

test('a database connection failure exits nonzero', () => {
  const databaseUrl = 'postgres://example-user:top-secret@example.invalid/test';
  const result = run([], {
    DB_ADAPTER: 'postgres',
    DATABASE_URL: databaseUrl,
    MOCK_PG_MODE: 'fail',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /simulated connection failure/);
  assert.doesNotMatch(result.stderr, /top-secret|example-user/);
});

test('a simulated PostgreSQL run completes successfully', () => {
  const result = run(['--only', '1'], {
    DB_ADAPTER: 'postgres',
    DATABASE_URL: 'postgres://example.invalid/test',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Successfully applied 1 pending migration/);
});

test('Memory adapter keeps its intentional no-op success', () => {
  const result = run([], { DB_ADAPTER: 'memory' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No persistent migrations are required/);
});

test('InMemory alias keeps its intentional no-op success', () => {
  const result = run([], { DB_ADAPTER: 'inmemory' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No persistent migrations are required/);
});
