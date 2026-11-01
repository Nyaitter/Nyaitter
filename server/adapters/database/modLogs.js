'use strict';

const fields = ['actorType', 'actorId', 'action', 'targetType', 'targetId', 'result'];
const columns = ['actor_type', 'actor_id', 'action', 'target_type', 'target_id', 'result'];
const token = /^[a-z][a-z0-9_-]{0,47}$/;
const idPattern = /^[0-9]{1,20}$/;
function validField(key, value) {
  if (key === 'actorId' || key === 'targetId') return typeof value === 'string' && idPattern.test(value);
  if (key === 'actorType') return ['admin', 'automod', 'operator', 'system'].includes(value);
  if (key === 'result') return ['success', 'failure', 'skipped'].includes(value);
  return typeof value === 'string' && token.test(value);
}
function normalizeRecord(input, id, now = new Date()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Invalid mod log');
  const allowed = new Set([...fields, 'id', 'createdAt']);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new TypeError('Unsupported mod log field');
  const recordId = input.id ?? id;
  if (typeof recordId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(recordId)) throw new TypeError('Invalid mod log id');
  for (const field of fields) {
    if (field === 'actorId' && (input[field] === null || input[field] === undefined)) continue;
    if (!validField(field, input[field])) throw new TypeError('Invalid ' + field);
  }
  if (input.actorType === 'admin' && input.actorId == null) throw new TypeError('Admin actorId required');
  const createdAt = input.createdAt ?? now.toISOString();
  if (typeof createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt) || new Date(createdAt).toISOString() !== createdAt) throw new TypeError('Invalid createdAt');
  return { id: recordId, createdAt, actorType: input.actorType, actorId: input.actorId ?? null,
    action: input.action, targetType: input.targetType, targetId: input.targetId, result: input.result };
}
function normalizeFilters(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Invalid filters');
  const allowed = new Set([...fields, 'limit', 'beforeTime', 'beforeId', 'from', 'to']);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new TypeError('Unsupported filter');
  const out = {};
  for (const key of fields) if (input[key] !== undefined) {
    if (!validField(key, input[key])) throw new TypeError('Invalid ' + key);
    out[key] = input[key];
  }
  const limit = input.limit === undefined ? 50 : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (typeof input.limit === 'string' && !/^[0-9]+$/.test(input.limit))) throw new TypeError('Invalid limit');
  out.limit = limit;
  for (const key of ['beforeTime', 'from', 'to']) if (input[key] !== undefined) {
    if (typeof input[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input[key]) || new Date(input[key]).toISOString() !== input[key]) throw new TypeError('Invalid ' + key);
    out[key] = input[key];
  }
  if ((input.beforeTime === undefined) !== (input.beforeId === undefined)) throw new TypeError('Incomplete cursor');
  if (input.beforeId !== undefined) {
    if (typeof input.beforeId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.beforeId)) throw new TypeError('Invalid beforeId');
    out.beforeId = input.beforeId;
  }
  if (out.from && out.to && out.from > out.to) throw new TypeError('Invalid time range');
  return out;
}
function query(input, dialect) {
  const f = normalizeFilters(input), args = [], where = [];
  const bind = value => { args.push(value); return dialect === 'postgres' ? '$' + args.length : '?'; };
  fields.forEach((field, i) => { if (f[field] !== undefined) where.push(columns[i] + ' = ' + bind(f[field])); });
  if (f.from) where.push('created_at >= ' + bind(f.from));
  if (f.to) where.push('created_at <= ' + bind(f.to));
  if (f.beforeTime) where.push('(created_at < ' + bind(f.beforeTime) + ' OR (created_at = ' + bind(f.beforeTime) + ' AND id < ' + bind(f.beforeId) + '))');
  return { sql: 'SELECT * FROM mod_logs' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY created_at DESC, id DESC LIMIT ' + bind(f.limit + 1), args, limit: f.limit };
}
function mapRow(row) { return { id: row.id, createdAt: row.created_at, actorType: row.actor_type, actorId: row.actor_id, action: row.action, targetType: row.target_type, targetId: row.target_id, result: row.result }; }
function sameRecord(a, b) { return a.id === b.id && a.createdAt === b.createdAt && fields.every(key => a[key] === b[key]); }
function page(rows, limit) { const more = rows.length > limit; const logs = rows.slice(0, limit); const last = logs[logs.length - 1]; return { logs, nextCursor: more ? { beforeTime: last.createdAt, beforeId: last.id } : null }; }
module.exports = { fields, normalizeRecord, normalizeFilters, query, mapRow, page, sameRecord };
