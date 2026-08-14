#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const migrationsDir = __dirname;
const migrationFiles = fs.readdirSync(migrationsDir)
  .filter((file) => /^\d+_.+\.sql$/.test(file))
  .sort();

console.log('Nyaitter Migration Runner');
console.log('---------------------------');

if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
  console.log('No DATABASE_URL found.');
  console.log('Please run the migrations manually, in filename order:');
  migrationFiles.forEach((file) => console.log(`psql $DATABASE_URL -f ${path.join(migrationsDir, file)}`));
  console.log('Or set DATABASE_URL and re-run this script (requires the pg package).');
  process.exit(0);
}

async function run() {
  const { Client } = require('pg');
  const client = new Client({
    connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
  });

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

      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      console.log(`Applying ${file}...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO nyaitter_schema_migrations (filename) VALUES ($1)',
          [file],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`${file}: ${error.message}`);
      }
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
