'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const migrationsDir = __dirname;
const migrationFiles = fs.readdirSync(migrationsDir)
  .filter((file) => /^\d+_.+\.sql$/.test(file))
  .sort();
const databaseAdapter = String(
  process.env.DB_ADAPTER || config.database.adapter || 'memory',
).toLowerCase();
const usePostgres = ['postgres', 'pg'].includes(databaseAdapter);
const useD1 = ['d1', 'cloudflare-d1'].includes(databaseAdapter);
const useMemory = ['memory', 'inmemory'].includes(databaseAdapter);
const connectionString =
  process.env.DATABASE_URL ||
  config.database.postgres.connectionString ||
  process.env.POSTGRES_URL;
const transactionRetries = Math.max(
  0,
  Math.min(10, Math.floor(Number(config.database.postgres.transactionRetries) || 5)),
);
const retryBaseDelayMs = Math.max(
  10,
  Math.min(5000, Math.floor(Number(config.database.postgres.retryBaseDelayMs) || 50)),
);

function runD1Migrations() {
  const target = String(process.env.D1_MIGRATION_TARGET || 'remote').toLowerCase();
  if (!['local', 'remote'].includes(target)) {
    throw new Error('D1_MIGRATION_TARGET must be local or remote');
  }
  const workerDir = path.resolve(__dirname, '../../workers/d1-proxy');
  console.log(`Nyaitter Migration Runner (Cloudflare D1: ${target})`);
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(
    npmCommand,
    ['--prefix', workerDir, 'run', `migrate:${target}`],
    { stdio: 'inherit', env: process.env },
  );
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

if (useD1) {
  try {
    runD1Migrations();
  } catch (error) {
    console.error('Migration failed:', error.message);
    process.exit(1);
  }
}

if (useMemory) {
  console.log('Nyaitter Migration Runner (InMemoryAdapter)');
  console.log('In-memory data is initialized at server startup. No persistent migrations are required.');
  process.exit(0);
}

if (!usePostgres) {
  console.error(`Migration failed: unsupported DB_ADAPTER "${databaseAdapter || '(empty)'}".`);
  process.exit(1);
}

console.log('Nyaitter Migration Runner (PostgreSQL)');
console.log('---------------------------');

if (!connectionString) {
  console.log('No DATABASE_URL found.');
  console.log('Please run the migrations manually, in filename order:');
  migrationFiles.forEach((file) => console.log(`psql $DATABASE_URL -f ${path.join(migrationsDir, file)}`));
  console.log('Or set the connection string and re-run this script (requires the pg package).');
  process.exit(0);
}

function isRetryableTransactionError(error) {
  return error?.code === '40001' || /restart transaction/i.test(error?.message || '');
}

async function waitForRetry(attempt) {
  const delay = Math.min(2000, retryBaseDelayMs * (2 ** Math.max(0, attempt - 1)));
  await new Promise((resolve) => setTimeout(resolve, delay));
}

function quoteSqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function applyMigration(client, file) {
  const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
  const transactionSql = [
    'BEGIN;',
    sql,
    `INSERT INTO nyaitter_schema_migrations (filename) VALUES (${quoteSqlLiteral(file)});`,
    'COMMIT;',
  ].join('\n');

  for (let attempt = 0; attempt <= transactionRetries; attempt += 1) {
    let started = false;
    try {
      // パラメーターを使わない単純クエリでは複数文を1往復で送信できる。
      // Migrationごとの原子性を保ちつつ、リモートDBへの4回の往復を1回へ削減する。
      started = true;
      await client.query(transactionSql);
      return;
    } catch (error) {
      if (started) {
        try {
          await client.query('ROLLBACK');
        } catch (_) {
          // Preserve the original migration error for the caller.
        }
      }
      if (!isRetryableTransactionError(error) || attempt >= transactionRetries) {
        throw new Error(`${file}: ${error.message}`);
      }
      await waitForRetry(attempt + 1);
    }
  }
}

async function run() {
  const { Client } = require('pg');
  const clientOptions = { connectionString };
  if (config.database.postgres.sslCa) {
    clientOptions.ssl = {
      ca: config.database.postgres.sslCa,
      rejectUnauthorized: true,
    };
  } else if (config.database.postgres.ssl === true) {
    clientOptions.ssl = { rejectUnauthorized: false };
  }
  const client = new Client(clientOptions);

  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS nyaitter_schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const appliedResult = await client.query(
      'SELECT filename FROM nyaitter_schema_migrations',
    );
    const applied = new Set(appliedResult.rows.map((row) => row.filename));

    for (const file of migrationFiles) {
      if (applied.has(file)) continue;
      console.log(`Applying ${file}...`);
      await applyMigration(client, file);
    }

    console.log('All pending migrations applied successfully.');
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error('Migration failed:', error.message);
  process.exit(1);
});
