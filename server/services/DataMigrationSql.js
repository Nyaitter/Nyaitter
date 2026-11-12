'use strict';

const {
  TABLES,
  INSERT_ORDER,
  RESET_ORDER,
  TABLE_COLUMNS,
  ID_SEQUENCES,
  EXCLUDED_TABLES,
  EXCLUDED_TABLE_NAMES,
  specFor,
  transferableColumns,
} = require('./DataMigrationSchema');
const { normalizeSnapshot, createSnapshot, signSnapshot } = require('./DataMigrationService');
const { orderDeletions, tablesToClear } = require('./DataMigrationOrder');
const fs = require('fs');
const path = require('path');

// JSON(B) 列は PostgreSQL へは文字列で渡してキャストする。
const JSON_COLUMNS = new Set([
  'external_profile', 'settings', 'block', 'attachments', 'tags', 'stage_settings', 'post', 'unread', 'target',
  'target_snapshot', 'excluded_admin_ids', 'resolution', 'permissions', 'provider_profile', 'options', 'scopes',
  'latest_message', 'response_message',
]);
const ARRAY_COLUMNS = new Set(['participants', 'member']);
const DATE_COLUMNS = new Set([
  'created_at', 'updated_at', 'tags_generated_at', 'expires_at', 'last_used_at', 'decided_at', 'consumed_at',
  'sent_at', 'read_at', 'time', 'assigned_at', 'resolved_at', 'claimed_at', 'log_time', 'deleted_at', 'joined_at',
  'responded_at', 'reviewed_at', 'wait_until', 'started_at', 'last_notified_at', 'scheduled_at', 'retired_at',
  'age_estimated_at',
]);

function quoteIdentifier(identifier) {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error(`Invalid migration identifier: ${identifier}`);
  return `"${identifier}"`;
}

function valueForColumn(column, value) {
  if (value == null) return null;
  if (JSON_COLUMNS.has(column)) return JSON.stringify(value);
  if (column === 'expiration_time') return new Date(Number(value));
  if (DATE_COLUMNS.has(column)) return value;
  if (ARRAY_COLUMNS.has(column)) return Array.isArray(value) ? value.map(Number) : [];
  return value;
}

function placeholderForColumn(column, index) {
  if (JSON_COLUMNS.has(column)) return `$${index}::jsonb`;
  return `$${index}`;
}

// 移行先DBの実列を取得する。migration 未適用の列を INSERT して
// トランザクション全体を失敗させないため、実行時に交差を取る。
async function loadPostgresColumns(client) {
  const { rows } = await client.query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ANY($1::text[])`,
    [TABLES],
  );
  const byTable = new Map();
  for (const row of rows) {
    if (!byTable.has(row.table_name)) byTable.set(row.table_name, new Set());
    byTable.get(row.table_name).add(row.column_name);
  }
  return byTable;
}

function columnsFor(clientColumns, table) {
  const spec = specFor(table);
  if (!spec) return [];
  const available = clientColumns.get(table);
  if (!available) return [];
  const wanted = transferableColumns(table);
  return wanted.filter((column) => available.has(column));
}

// 移行先に存在しない列。呼び出し元が報告できるよう返す。
function missingColumns(clientColumns, table) {
  const available = clientColumns.get(table);
  if (!available) return [];
  return transferableColumns(table).filter((column) => !available.has(column));
}

async function tableExists(client, table) {
  const { rows } = await client.query('SELECT to_regclass($1) AS name', [quoteIdentifier(table)]);
  return Boolean(rows[0]?.name);
}

async function exportPostgresSnapshot(pool, adapterName) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const clientColumns = await loadPostgresColumns(client);
    const rowsByTable = {};
    const skipped = {};
    for (const table of TABLES) {
      const columns = columnsFor(clientColumns, table);
      if (!columns.length) {
        // テーブル自体が無い（migration 未適用）。キーを作らず「省略」として扱う。
        continue;
      }
      const { rows } = await client.query(`SELECT ${columns.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(table)}`);
      rowsByTable[table] = rows;
      const missing = missingColumns(clientColumns, table);
      if (missing.length) skipped[table] = missing;
    }
    const snapshot = createSnapshotWithDiagnostics(adapterName, rowsByTable, skipped);
    await client.query('COMMIT');
    return snapshot;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

function createSnapshotWithDiagnostics(adapterName, rowsByTable, skippedColumnsByTable) {
  const snapshot = createSnapshot(adapterName, rowsByTable);
  if (!skippedColumnsByTable || !Object.keys(skippedColumnsByTable).length) return snapshot;
  // 「このDBには無い列」を黙って落とさず、スナップショットに記録して報告できるようにする。
  // checksum はこの診断情報も含めて計算する。
  const { checksum: _checksum, ...unsigned } = snapshot;
  return signSnapshot({ ...unsigned, skipped_columns: skippedColumnsByTable });
}

// 派生列（カウンタ・集約キャッシュ）を移行先で再計算する。
// 投入値を使わないので、D1 のトリガーと二重計上にならず、既存のずれも自己修復する。
async function recomputeDerivedColumns(client, clientColumns) {
  const postsColumns = clientColumns.get('posts');
  if (postsColumns) {
    const assignments = [];
    if (postsColumns.has('like_count')) assignments.push('like_count = (SELECT COUNT(*)::int FROM likes WHERE likes.post_id = posts.id)');
    if (postsColumns.has('star_count')) assignments.push('star_count = (SELECT COUNT(*)::int FROM stars WHERE stars.post_id = posts.id)');
    if (postsColumns.has('repost_count')) assignments.push('repost_count = (SELECT COUNT(*)::int FROM reposts WHERE reposts.post_id = posts.id)');
    if (postsColumns.has('reply_count')) assignments.push('reply_count = (SELECT COUNT(*)::int FROM posts replies WHERE replies.reply_to = posts.id)');
    if (assignments.length) await client.query(`UPDATE posts SET ${assignments.join(', ')}`);
  }
  const groupDmColumns = clientColumns.get('group_dms');
  if (groupDmColumns?.has('message_count') && groupDmColumns.has('latest_message')) {
    await client.query(
      `UPDATE group_dms
          SET message_count = COALESCE(jsonb_array_length(post), 0),
              latest_message = CASE WHEN COALESCE(jsonb_array_length(post), 0) > 0 THEN post -> -1 ELSE NULL END`,
    );
  } else if (groupDmColumns?.has('message_count')) {
    await client.query('UPDATE group_dms SET message_count = COALESCE(jsonb_array_length(post), 0)');
  }
}

// 実際の外部キー関係を取得する。削除順と「置換で連鎖削除される表」の判定に使う。
async function loadPostgresForeignKeys(client) {
  const { rows } = await client.query(
    `SELECT
       tc.table_name AS child,
       ccu.table_name AS parent,
       rc.delete_rule AS on_delete
     FROM information_schema.table_constraints tc
     JOIN information_schema.constraint_column_usage ccu
       ON ccu.constraint_name = tc.constraint_name
      AND ccu.table_schema = tc.table_schema
     JOIN information_schema.referential_constraints rc
       ON rc.constraint_name = tc.constraint_name
      AND rc.constraint_schema = tc.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND tc.table_schema = current_schema()`,
  );
  return rows.map((row) => ({ child: row.child, parent: row.parent, onDelete: row.on_delete }));
}

function loadPostgresTriggerDeletes() {
  const directory = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(directory).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  const functions = new Map();
  const triggers = [];
  for (const file of files) {
    const sql = fs.readFileSync(path.join(directory, file), 'utf8');
    for (const match of sql.matchAll(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(\w+)\s*\(\)[\s\S]*?AS\s+\$\$([\s\S]*?)\$\$/gi)) {
      functions.set(match[1], match[2]);
    }
    for (const match of sql.matchAll(/CREATE\s+TRIGGER\s+\w+[\s\S]*?\bON\s+(\w+)[\s\S]*?EXECUTE\s+FUNCTION\s+(\w+)\s*\(/gi)) {
      triggers.push({ source: match[1], functionName: match[2] });
    }
  }
  const edges = [];
  for (const trigger of triggers) {
    const body = functions.get(trigger.functionName) || '';
    for (const match of body.matchAll(/\bDELETE\s+FROM\s+(\w+)/gi)) edges.push({ source: trigger.source, target: match[1] });
  }
  return edges;
}

function loadMigrationCascadeEdges() {
  const directory = path.join(__dirname, '..', 'migrations');
  const edges = [];
  for (const file of fs.readdirSync(directory).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
    const sql = fs.readFileSync(path.join(directory, file), 'utf8');
    for (const table of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?\w+"?)\s*\(([\s\S]*?)\);/gi)) {
      const child = table[1].replaceAll('"', '');
      for (const reference of table[2].matchAll(/REFERENCES\s+("?\w+"?)\s*\([^)]*\)([^,\n]*)(?:,|$)/gi)) {
        if (!/ON\s+DELETE\s+CASCADE/i.test(reference[2])) continue;
        edges.push({ source: reference[1].replaceAll('"', ''), target: child });
      }
      for (const reference of table[2].matchAll(/FOREIGN\s+KEY\s*\([^)]*\)\s+REFERENCES\s+("?\w+"?)\s*\([^)]*\)([^,\n]*)(?:,|$)/gi)) {
        if (!/ON\s+DELETE\s+CASCADE/i.test(reference[2])) continue;
        edges.push({ source: reference[1].replaceAll('"', ''), target: child });
      }
    }
  }
  return edges;
}

// スナップショットに含まれるテーブルと、そこからの CASCADE で消えるテーブルだけを空にする。
// 関係の無いテーブル（例: 独立した新機能表）は触らない。
async function resetPostgresDestination(client, plan) {
  const available = [...plan.clientColumns.keys()];
  const cascaded = tablesToClear(plan.includedTables, available, plan.foreignKeys, { scope: TABLES });
  const targets = [...plan.includedTables].filter((table) => plan.clientColumns.get(table)).concat(cascaded);
  const { deleteOrder } = orderDeletions(targets, plan.foreignKeys);
  for (const table of deleteOrder) await client.query(`DELETE FROM ${quoteIdentifier(table)}`);
  const staticEdges = [...loadMigrationCascadeEdges(), ...loadPostgresTriggerDeletes()];
  const staticCascade = new Set();
  const affected = new Set([...plan.includedTables, ...cascaded]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of staticEdges) {
      if (!affected.has(edge.source) || affected.has(edge.target)) continue;
      affected.add(edge.target);
      if (EXCLUDED_TABLE_NAMES.includes(edge.target)) staticCascade.add(edge.target);
      changed = true;
    }
  }
  const combined = [...new Set([...cascaded, ...staticCascade])];
  return { deleted: deleteOrder, cascaded: combined };
}

async function insertRows(client, table, rows, columns) {
  if (!columns || columns.length === 0 || rows.length === 0) return;
  const quotedColumns = columns.map(quoteIdentifier).join(', ');
  const placeholders = columns.map((column, index) => placeholderForColumn(column, index + 1)).join(', ');
  const statement = `INSERT INTO ${quoteIdentifier(table)} (${quotedColumns}) VALUES (${placeholders})`;
  for (const row of rows) {
    const values = columns.map((column) => valueForColumn(column, row[column]));
    await client.query(statement, values);
  }
}

async function restorePostReferences(client, rows) {
  for (const row of rows) {
    if (row.reply_to == null && row.repost_to == null) continue;
    await client.query(
      'UPDATE posts SET reply_to = $1, repost_to = $2 WHERE id = $3',
      [row.reply_to, row.repost_to, row.id],
    );
  }
}

async function resetIdentitySequences(pool) {
  // 連番の再設定はデータ置換トランザクションを確定した後に行う。
  for (const [table, sequenceName] of Object.entries(ID_SEQUENCES)) {
    try {
      const { rows } = await pool.query(`SELECT COALESCE(MAX(id), 0) AS max_id FROM ${quoteIdentifier(table)}`);
      const maxId = Math.max(0, Number(rows[0]?.max_id || 0));
      await pool.query('SELECT setval($1, $2, $3)', [sequenceName, maxId || 1, maxId > 0]);
    } catch (error) {
      console.warn(`[data-migration] Could not reset sequence for ${table}: ${error.message}`);
    }
  }
}

// 置換計画の検証。トランザクションを開く前に「安全に置換できるか」を判断する。
// - スナップショットが含むテーブルだけを対象にする（含まれないものは保持）。
// - データを入れるのに宛先にテーブルが無ければ、黙って抜けずに失敗する。
async function planPostgresImport(client, normalized) {
  const clientColumns = await loadPostgresColumns(client);
  const foreignKeys = await loadPostgresForeignKeys(client);
  const includedTables = new Set(normalized.tables_present);
  const missingTables = [];
  const skipped = {};
  for (const table of includedTables) {
    const rows = normalized.tables[table] || [];
    if (!clientColumns.get(table)) {
      if (rows.length) missingTables.push(table);
      continue;
    }
    const missing = missingColumns(clientColumns, table);
    if (table === 'group_dm_send_requests' && missing.length && rows.length) throw new Error('Destination is missing DM send request columns');
    if (missing.length && rows.length) skipped[table] = missing;
  }
  if (missingTables.length) {
    throw new Error(`Destination is missing tables required by the snapshot: ${missingTables.join(', ')}`);
  }
  return {
    clientColumns,
    foreignKeys,
    includedTables,
    preservedTables: TABLES.filter((table) => !includedTables.has(table)),
    skippedColumns: skipped,
  };
}

async function importPostgresSnapshot(pool, snapshot, { replace = false } = {}) {
  if (replace !== true) {
    throw new Error('Destination replacement requires replace=true');
  }
  const normalized = normalizeSnapshot(snapshot);
  if (normalized.tables.group_dms.length && !normalized.tables_present.includes('group_dm_send_requests')) throw new Error('DM snapshot is missing send request history');
  // 検証と実置換を同じトランザクション内で行う（途中で他プロセスが状態を変えない）。
  const client = await pool.connect();
  let plan;
  try {
    await client.query('BEGIN');
    plan = await planPostgresImport(client, normalized);
    plan.reset = await resetPostgresDestination(client, plan);
    for (const table of INSERT_ORDER) {
      if (!plan.includedTables.has(table)) continue;
      const columns = columnsFor(plan.clientColumns, table);
      const rows = table === 'posts'
        ? (normalized.tables.posts || []).map((row) => ({ ...row, reply_to: null, repost_to: null }))
        : (normalized.tables[table] || []);
      await insertRows(client, table, rows, columns);
    }
    await restorePostReferences(client, normalized.tables.posts || []);
    await recomputeDerivedColumns(client, plan.clientColumns);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
  // 連番の再設定は確定後。失敗してもデータ置換は完了しているため警告に留める。
  await resetIdentitySequences(pool);
  const imported = Object.fromEntries(TABLES.map((table) => [
    table,
    plan.includedTables.has(table) ? (normalized.tables[table] || []).length : null,
  ]));
  return {
    imported,
    imported_tables: TABLES.filter((table) => plan.includedTables.has(table)),
    // 除外表は「移行対象外」であって「保持した」わけではない。混ぜると
    // 「preserved_tables にあるから残っている」と読めてしまうため除く。
    preserved_tables: plan.preservedTables
      .filter((table) => !plan.reset.cascaded.includes(table))
      .filter((table) => !EXCLUDED_TABLE_NAMES.includes(table)),
    // 置換で親行が消えるため CASCADE で連鎖削除した従属テーブル（データは失われた）。
    cascaded_tables: plan.reset.cascaded,
    skipped_columns: plan.skippedColumns,
    // スナップショットに記録が無い旧形式でも、除外表があることを黙って隠さない。
    excluded_tables: (normalized.excluded_tables && normalized.excluded_tables.length)
      ? normalized.excluded_tables
      : EXCLUDED_TABLES.map((entry) => ({ table: entry.table, reason: entry.reason })),
  };
}

module.exports = {
  TABLE_COLUMNS,
  INSERT_ORDER,
  RESET_ORDER,
  ID_SEQUENCES,
  JSON_COLUMNS,
  ARRAY_COLUMNS,
  DATE_COLUMNS,
  exportPostgresSnapshot,
  importPostgresSnapshot,
  planPostgresImport,
  loadPostgresColumns,
  loadPostgresForeignKeys,
  columnsFor,
  missingColumns,
  recomputeDerivedColumns,
  tableExists,
};
