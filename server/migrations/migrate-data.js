#!/usr/bin/env node
'use strict';

const os = require('os');
const path = require('path');
const {
  normalizeAdapterName,
  createAdapter,
  writeSnapshot,
  readSnapshot,
} = require('../services/DataMigrationService');
const { requestOperatorCommand } = require('../utils/operatorControl');

function usage() {
  console.log(`Nyaitter Data Migration

Usage:
  npm run migrate:data -- --from <adapter> --to <adapter> --replace --output <snapshot.json>
  npm run migrate:data -- --from <adapter> --output <snapshot.json>
  npm run migrate:data -- --to <adapter> --input <snapshot.json> --replace

Adapters:
  memory, postgres, d1

Connection settings:
  NYAITTER_DATA_SOURCE_DATABASE_URL
  NYAITTER_DATA_SOURCE_D1_WORKER_URL
  NYAITTER_DATA_SOURCE_D1_WORKER_TOKEN
  NYAITTER_DATA_DESTINATION_DATABASE_URL
  NYAITTER_DATA_DESTINATION_D1_WORKER_URL
  NYAITTER_DATA_DESTINATION_D1_WORKER_TOKEN

InMemory source or destination:
  NYAITTER_DATA_SOURCE_OPERATOR_SOCKET
  NYAITTER_DATA_DESTINATION_OPERATOR_SOCKET

The destination is replaced only when --replace is supplied. Keep the output snapshot until the new database is verified.`);
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') values.help = true;
    else if (argument === '--replace') values.replace = true;
    else if (argument.startsWith('--')) {
      const key = argument.slice(2);
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      values[key] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return values;
}

function countTables(snapshot) {
  const counts = Object.fromEntries(Object.entries(snapshot.tables).map(([table, rows]) => [table, rows.length]));
  // スナップショットに含まれないテーブルは宛先で保持される。「0件になる」と誤解しないよう比較対象から外す。
  const included = Array.isArray(snapshot.tables_present) ? snapshot.tables_present : null;
  if (included) {
    for (const table of Object.keys(counts)) if (!included.includes(table)) delete counts[table];
  } else if (snapshot.mod_logs_present === false) {
    delete counts.mod_logs;
  }
  return counts;
}

function sameCounts(left, right) {
  return Object.keys(left).every((table) => Number(left[table] || 0) === Number(right[table] || 0));
}

// 件数比較の詳細。不一致になったテーブルと、比較しなかったテーブルを分けて返す。
function compareCounts(sourceCounts, destinationCounts, snapshot) {
  const mismatched = [];
  const compared = [];
  for (const [table, count] of Object.entries(sourceCounts)) {
    compared.push(table);
    if (Number(count || 0) !== Number(destinationCounts[table] || 0)) {
      mismatched.push({ table, source: Number(count || 0), destination: Number(destinationCounts[table] || 0) });
    }
  }
  const included = Array.isArray(snapshot?.tables_present) ? snapshot.tables_present : null;
  const preserved = included ? Object.keys(destinationCounts).filter((table) => !included.includes(table)) : [];
  return { mismatched, compared, preserved };
}

function socketFor(prefix) {
  return process.env[`NYAITTER_DATA_${prefix}_OPERATOR_SOCKET`] || undefined;
}

async function exportFromAdapter(adapterName, snapshotFile) {
  if (adapterName === 'memory') {
    const response = await requestOperatorCommand(
      { action: 'export-data', filePath: snapshotFile },
      { socketPath: socketFor('SOURCE') },
    );
    if (!response?.ok) throw new Error(response?.error || 'Unable to export InMemory data');
    return readSnapshot(snapshotFile);
  }
  const adapter = createAdapter(adapterName, 'NYAITTER_DATA_SOURCE');
  await adapter.connect();
  try {
    const snapshot = await adapter.exportDataSnapshot();
    await writeSnapshot(snapshotFile, snapshot);
    return readSnapshot(snapshotFile);
  } finally {
    await adapter.disconnect();
  }
}

async function importToAdapter(adapterName, snapshot, snapshotFile) {
  if (adapterName === 'memory') {
    const response = await requestOperatorCommand(
      { action: 'import-data', filePath: snapshotFile, replace: true },
      { socketPath: socketFor('DESTINATION') },
    );
    if (!response?.ok) throw new Error(response?.error || 'Unable to import InMemory data');
    return response.counts || {};
  }
  const adapter = createAdapter(adapterName, 'NYAITTER_DATA_DESTINATION');
  await adapter.connect();
  try {
    return await adapter.importDataSnapshot(snapshot, { replace: true });
  } finally {
    await adapter.disconnect();
  }
}

async function exportFromDestination(adapterName, snapshotFile) {
  if (adapterName === 'memory') {
    const response = await requestOperatorCommand(
      { action: 'export-data', filePath: snapshotFile },
      { socketPath: socketFor('DESTINATION') },
    );
    if (!response?.ok) throw new Error(response?.error || 'Unable to verify InMemory data');
    return readSnapshot(snapshotFile);
  }
  const adapter = createAdapter(adapterName, 'NYAITTER_DATA_DESTINATION');
  await adapter.connect();
  try {
    const snapshot = await adapter.exportDataSnapshot();
    await writeSnapshot(snapshotFile, snapshot);
    return readSnapshot(snapshotFile);
  } finally {
    await adapter.disconnect();
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const from = args.from ? normalizeAdapterName(args.from) : null;
  const to = args.to ? normalizeAdapterName(args.to) : null;
  const input = args.input ? path.resolve(args.input) : null;
  const output = args.output ? path.resolve(args.output) : null;

  if (!from && !input) throw new Error('Specify --from or --input');
  if (!to && !output) throw new Error('Specify --to or --output');
  if (to && args.replace !== true) throw new Error('Destination replacement requires --replace');
  if (input && output && input === output) throw new Error('--input and --output must use different files');

  const snapshotFile = output || input || path.join(os.tmpdir(), `nyaitter-data-migration-${Date.now()}.json`);
  const snapshot = input ? await readSnapshot(input) : await exportFromAdapter(from, snapshotFile);
  const sourceCounts = countTables(snapshot);
  const preserved = snapshot.tables_present
    ? Object.keys(snapshot.tables).filter((table) => !snapshot.tables_present.includes(table))
    : [];
  const excludedTables = (snapshot.excluded_tables || []).map((entry) => entry.table);
  const skippedColumns = snapshot.skipped_columns || {};

  if (!to) {
    console.log(JSON.stringify({
      action: 'export',
      snapshot: snapshotFile,
      counts: sourceCounts,
      preserved,
      excluded_tables: excludedTables,
      skipped_columns: skippedColumns,
    }, null, 2));
    return;
  }

  const importReport = await importToAdapter(to, snapshot, snapshotFile);
  const verificationFile = path.join(os.tmpdir(), `nyaitter-data-migration-verify-${Date.now()}.json`);
  const destinationSnapshot = await exportFromDestination(to, verificationFile);
  const destinationCounts = countTables(destinationSnapshot);
  const comparison = compareCounts(sourceCounts, destinationCounts, snapshot);
  if (comparison.mismatched.length) {
    throw new Error(`Destination row-count verification failed: ${JSON.stringify({
      mismatched: comparison.mismatched,
      sourceCounts,
      destinationCounts,
    })}`);
  }
  console.log(JSON.stringify({
    action: 'migrate',
    from: from || snapshot.source_adapter,
    to,
    snapshot: snapshotFile,
    counts: destinationCounts,
    compared_tables: comparison.compared.length,
    // スナップショットに含めず宛先に残したテーブル。件数比較の対象外であることを明示する。
    preserved_tables: preserved,
    // 置換で親行が消えたため CASCADE で連鎖削除されたテーブル。
		cascaded_tables: importReport?.cascaded_tables || [],
		// 置換/CASCADE とは独立した移行処理で空にしたテーブル。
		cleared_tables: importReport?.cleared_tables || [],
    // 移行対象外と決めたテーブル（理由付き）。黙って落ちていないことを示す。
    excluded_tables: excludedTables,
    skipped_columns: skippedColumns,
    import_report: importReport,
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Data migration failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { countTables, sameCounts, compareCounts };
