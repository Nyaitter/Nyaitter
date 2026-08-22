'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const migrationsDir = __dirname;
const migrationFiles = fs.readdirSync(migrationsDir)
  .filter((file) => /^\d+_.+\.sql$/.test(file))
  .sort();

function resolveMigrationFile(input) {
  if (!input) return null;
  const cleaned = String(input).trim().replace(/^[\\/]+/, '').replace(/^.*[\\/]/, '');
  if (migrationFiles.includes(cleaned)) return cleaned;

  // Match by numeric prefix, e.g. "13" -> "013_add_post_counters.sql"
  const numMatch = cleaned.match(/^0*(\d+)$/);
  if (numMatch) {
    const num = parseInt(numMatch[1], 10);
    const matched = migrationFiles.find((f) => parseInt(f.split('_')[0], 10) === num);
    if (matched) return matched;
  }

  // Match by partial name / prefix
  const partial = migrationFiles.find((f) => f.toLowerCase().includes(cleaned.toLowerCase()));
  if (partial) return partial;

  return null;
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  const options = {
    targetFirst: [],
    only: [],
    upTo: null,
    help: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--only') {
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        const file = resolveMigrationFile(next);
        if (!file) throw new Error(`Unknown migration file for --only: "${next}"`);
        options.only.push(file);
        i += 1;
      }
    } else if (arg === '--target' || arg === '--file' || arg === '--first') {
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        const file = resolveMigrationFile(next);
        if (!file) throw new Error(`Unknown migration file for ${arg}: "${next}"`);
        options.targetFirst.push(file);
        i += 1;
      }
    } else if (arg === '--up-to' || arg === '--until') {
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        const file = resolveMigrationFile(next);
        if (!file) throw new Error(`Unknown migration file for ${arg}: "${next}"`);
        options.upTo = file;
        i += 1;
      }
    } else if (!arg.startsWith('--')) {
      // Positional argument: prioritize this migration first
      const file = resolveMigrationFile(arg);
      if (!file) throw new Error(`Unknown migration file: "${arg}"`);
      options.targetFirst.push(file);
    }
  }
  return options;
}

let cliOptions;
try {
  cliOptions = parseCliArgs();
} catch (err) {
  console.error(`Migration CLI error: ${err.message}`);
  process.exit(1);
}

if (cliOptions.help) {
  console.log(`Nyaitter Migration Runner

Usage:
  npm run migrate                           Run all pending migrations in sequential order
  npm run migrate -- <file|number>          Prioritize and run the specified migration first
  npm run migrate -- --target <file|num>    Prioritize and run the specified migration first
  npm run migrate -- --only <file|num>      Run ONLY the specified migration
  npm run migrate -- --up-to <file|num>     Run migrations up to the specified migration

Available migrations:
${migrationFiles.map((f) => `  - ${f}`).join('\n')}
`);
  process.exit(0);
}

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
console.log('==================================================');

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

function formatProgressBar(current, total, width = 18) {
  const ratio = total > 0 ? Math.min(1, Math.max(0, current / total)) : 1;
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  const percent = String(Math.round(ratio * 100)).padStart(3, ' ');
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${percent}%`;
}

function splitSqlStatements(sql) {
  const statements = [];
  let current = '';
  let inSingleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;
  let inDollarQuote = false;
  let dollarTag = '';

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const nextChar = sql[i + 1];

    if (inLineComment) {
      current += char;
      if (char === '\n') inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      current += char;
      if (char === '*' && nextChar === '/') {
        current += nextChar;
        i += 1;
        inBlockComment = false;
      }
      continue;
    }

    if (inSingleQuote) {
      current += char;
      if (char === "'") {
        if (nextChar === "'") {
          current += nextChar;
          i += 1;
        } else {
          inSingleQuote = false;
        }
      }
      continue;
    }

    if (inDollarQuote) {
      current += char;
      if (char === '$' && sql.slice(i, i + dollarTag.length) === dollarTag) {
        current += dollarTag.slice(1);
        i += dollarTag.length - 1;
        inDollarQuote = false;
        dollarTag = '';
      }
      continue;
    }

    if (char === '-' && nextChar === '-') {
      inLineComment = true;
      current += char + nextChar;
      i += 1;
      continue;
    }

    if (char === '/' && nextChar === '*') {
      inBlockComment = true;
      current += char + nextChar;
      i += 1;
      continue;
    }

    if (char === "'") {
      inSingleQuote = true;
      current += char;
      continue;
    }

    if (char === '$') {
      const match = sql.slice(i).match(/^(\$[a-zA-Z0-9_]*\$)/);
      if (match) {
        dollarTag = match[1];
        inDollarQuote = true;
        current += dollarTag;
        i += dollarTag.length - 1;
        continue;
      }
    }

    if (char === ';') {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = '';
      continue;
    }

    current += char;
  }

  const trailing = current.trim();
  if (trailing) statements.push(trailing);

  return statements;
}

async function applyMigration(client, file) {
  const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
  const statements = splitSqlStatements(sql);

  for (let attempt = 0; attempt <= transactionRetries; attempt += 1) {
    let started = false;
    try {
      started = true;
      await client.query('BEGIN');
      for (const statement of statements) {
        await client.query(statement);
      }
      await client.query(
        `INSERT INTO nyaitter_schema_migrations (filename) VALUES (${quoteSqlLiteral(file)})`,
      );
      await client.query('COMMIT');
      return;
    } catch (error) {
      if (started) {
        try {
          await client.query('ROLLBACK');
        } catch (_) {}
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

  const startTime = Date.now();
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

    let executionPlan = [];
    if (cliOptions.only.length > 0) {
      executionPlan = [...new Set(cliOptions.only)];
    } else if (cliOptions.upTo) {
      const upToIndex = migrationFiles.indexOf(cliOptions.upTo);
      const scoped = migrationFiles.slice(0, upToIndex + 1);
      const prioritized = cliOptions.targetFirst.filter((f) => scoped.includes(f));
      const remaining = scoped.filter((f) => !prioritized.includes(f));
      executionPlan = [...new Set([...prioritized, ...remaining])];
    } else if (cliOptions.targetFirst.length > 0) {
      const prioritized = [...new Set(cliOptions.targetFirst)];
      const remaining = migrationFiles.filter((f) => !prioritized.includes(f));
      executionPlan = [...prioritized, ...remaining];
    } else {
      executionPlan = [...migrationFiles];
    }

    const totalCount = executionPlan.length;
    const pendingCount = executionPlan.filter((f) => !applied.has(f)).length;

    if (cliOptions.only.length > 0) {
      console.log(`Execution mode: ONLY specified migration(s) [${cliOptions.only.join(', ')}]`);
    } else if (cliOptions.targetFirst.length > 0) {
      console.log(`Execution mode: PRIORITIZING [${cliOptions.targetFirst.join(', ')}] first`);
    } else if (cliOptions.upTo) {
      console.log(`Execution mode: UP TO [${cliOptions.upTo}]`);
    }

    console.log(`Discovered ${totalCount} migration(s) in queue (Applied: ${totalCount - pendingCount}, Pending: ${pendingCount})\n`);

    let appliedCount = 0;
    for (let index = 0; index < totalCount; index += 1) {
      const file = executionPlan[index];
      const stepIndex = index + 1;
      const stepPrefix = `[${String(stepIndex).padStart(String(totalCount).length, ' ')}/${totalCount}] ${formatProgressBar(stepIndex, totalCount)}`;

      if (applied.has(file)) {
        console.log(`${stepPrefix} ⏩  ${file} (already applied)`);
        continue;
      }

      process.stdout.write(`${stepPrefix} 🚀 Applying ${file}... `);
      const stepStart = Date.now();
      try {
        await applyMigration(client, file);
        const stepDuration = Date.now() - stepStart;
        appliedCount += 1;
        process.stdout.write(`✓ [${stepDuration}ms]\n`);
      } catch (error) {
        process.stdout.write(`✗ FAILED\n`);
        throw error;
      }
    }

    const totalDuration = Date.now() - startTime;
    console.log('--------------------------------------------------');
    if (appliedCount > 0) {
      console.log(`✨ Successfully applied ${appliedCount} pending migration(s) in ${totalDuration}ms.`);
    } else {
      console.log(`✅ All target migrations are up to date (${totalCount}/${totalCount} verified in ${totalDuration}ms).`);
    }
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error('\n❌ Migration failed:', error.message);
  process.exit(1);
});
