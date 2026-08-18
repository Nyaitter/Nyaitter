#!/usr/bin/env node
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
const useCockroach = ['cockroach', 'cockroachdb', 'cockroachdb-cloud'].includes(databaseAdapter);
const usePostgres = ['postgres', 'pg'].includes(databaseAdapter) || useCockroach;
const useD1 = ['d1', 'cloudflare-d1'].includes(databaseAdapter);
const useMemory = ['memory', 'inmemory'].includes(databaseAdapter);
const connectionString = useCockroach
  ? process.env.COCKROACH_DATABASE_URL || config.database.cockroach.connectionString || process.env.DATABASE_URL
  : process.env.DATABASE_URL || config.database.postgres.connectionString || process.env.POSTGRES_URL;
const transactionRetries = Math.max(
  0,
  Math.min(10, Math.floor(Number(process.env.COCKROACH_TRANSACTION_RETRIES || config.database.cockroach.transactionRetries) || 5)),
);
const retryBaseDelayMs = Math.max(
  10,
  Math.min(5000, Math.floor(Number(process.env.COCKROACH_RETRY_BASE_DELAY_MS || config.database.cockroach.retryBaseDelayMs) || 50)),
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

console.log(`Nyaitter Migration Runner (${useCockroach ? 'CockroachDB' : 'PostgreSQL'})`);
console.log('---------------------------');

if (!connectionString) {
  const connectionVariable = useCockroach
    ? 'COCKROACH_DATABASE_URL or DATABASE_URL'
    : 'DATABASE_URL';
  console.log(`No ${connectionVariable} found.`);
  const manualConnectionVariable = useCockroach
    ? 'COCKROACH_DATABASE_URL'
    : 'DATABASE_URL';
  console.log('Please run the migrations manually, in filename order:');
  migrationFiles.forEach((file) => console.log(`psql $${manualConnectionVariable} -f ${path.join(migrationsDir, file)}`));
  console.log('Or set the connection string and re-run this script (requires the pg package).');
  process.exit(0);
}

function getMigrationSql(filename) {
  const sql = fs.readFileSync(path.join(migrationsDir, filename), 'utf8');
  if (!useCockroach || filename !== '008_optimize_high_volume_post_reads.sql') {
    return sql;
  }
  // CockroachDBにはトライグラム索引が組み込まれているため、PostgreSQL拡張の宣言だけを除く。
  return sql.replace(/^\s*CREATE EXTENSION IF NOT EXISTS pg_trgm;\s*$/mi, '');
}

function isRetryableTransactionError(error) {
  return error?.code === '40001' || /restart transaction/i.test(error?.message || '');
}

async function waitForRetry(attempt) {
  const delay = Math.min(2000, retryBaseDelayMs * (2 ** Math.max(0, attempt - 1)));
  await new Promise((resolve) => setTimeout(resolve, delay));
}

async function applyMigration(client, file) {
  const sql = getMigrationSql(file);
  const maximumAttempts = useCockroach ? transactionRetries : 0;

  for (let attempt = 0; attempt <= maximumAttempts; attempt += 1) {
    let started = false;
    try {
      await client.query('BEGIN');
      started = true;
      await client.query(sql);
      await client.query(
        'INSERT INTO nyaitter_schema_migrations (filename) VALUES ($1)',
        [file],
      );
      await client.query('COMMIT');
      return;
    } catch (error) {
      if (started) {
        try {
          await client.query('ROLLBACK');
        } catch (_) {
          // Preserve the original migration error for the caller.
        }
      }
      if (!useCockroach || !isRetryableTransactionError(error) || attempt >= maximumAttempts) {
        throw new Error(`${file}: ${error.message}`);
      }
      await waitForRetry(attempt + 1);
    }
  }
}

async function run() {
  const { Client } = require('pg');
  const client = new Client(
    useCockroach
      ? {
          connectionString,
          ssl: config.database.cockroach.sslCa
            ? { ca: config.database.cockroach.sslCa, rejectUnauthorized: true }
            : { rejectUnauthorized: true },
        }
      : { connectionString },
  );

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
