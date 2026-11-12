'use strict';

const { createHmac } = require('node:crypto');

function userId(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('Invalid user ID');
  return value;
}

function integer(value, minimum, name) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`Invalid ${name}`);
  return value;
}

function text(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`Missing ${name}`);
  return value;
}

function ids(values) {
  if (!Array.isArray(values)) throw new TypeError('Expected user IDs');
  return [...new Set(values.map(userId))];
}

function timestamp(value) {
  text(value, 'timestamp');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new TypeError('Expected a canonical UTC timestamp');
  return value;
}

function priorityFunction(selectionKey, noteKey, domain) {
  if (!(typeof selectionKey === 'string' || Buffer.isBuffer(selectionKey)) || Buffer.byteLength(selectionKey) < 32) throw new TypeError('A private selection key of at least 32 bytes is required');
  text(noteKey, 'note key');
  return id => createHmac('sha256', selectionKey).update(JSON.stringify([domain, noteKey, id])).digest('hex');
}

function comparePriority(a, b) {
  return a.priority < b.priority ? -1 : a.priority > b.priority ? 1 : a.id - b.id;
}

function heapPush(heap, item, compare) {
  heap.push(item);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compare(heap[parent], heap[index]) <= 0) break;
    [heap[parent], heap[index]] = [heap[index], heap[parent]];
    index = parent;
  }
}

function heapDown(heap, compare) {
  let index = 0;
  while (index * 2 + 1 < heap.length) {
    let child = index * 2 + 1;
    if (child + 1 < heap.length && compare(heap[child + 1], heap[child]) < 0) child++;
    if (compare(heap[index], heap[child]) <= 0) break;
    [heap[index], heap[child]] = [heap[child], heap[index]];
    index = child;
  }
}

function heapPop(heap, compare) {
  const first = heap[0];
  const last = heap.pop();
  if (heap.length) { heap[0] = last; heapDown(heap, compare); }
  return first;
}

function normalizeEdges(edges) {
  if (!Array.isArray(edges)) throw new TypeError('Expected relationship edges');
  const unique = new Map();
  for (const edge of edges) {
    if (!Array.isArray(edge) || edge.length !== 2) throw new TypeError('Invalid relationship edge');
    const a = userId(edge[0]), b = userId(edge[1]);
    if (a !== b) unique.set(`${Math.min(a, b)}:${Math.max(a, b)}`, [Math.min(a, b), Math.max(a, b)]);
  }
  return [...unique.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function selectIndependentVoters({ candidateIds, excludedIds = [], edges, selectionKey, noteKey }) {
  const priorities = priorityFunction(selectionKey, noteKey, 'independent-votes:v1');
  const excluded = new Set(ids(excludedIds));
  const candidates = ids(candidateIds).sort((a, b) => a - b);
  const normalizedEdges = normalizeEdges(edges);
  const disqualified = new Set(excluded);
  for (const [a, b] of normalizedEdges) {
    if (excluded.has(a)) disqualified.add(b);
    if (excluded.has(b)) disqualified.add(a);
  }
  const active = new Set(candidates.filter(id => !disqualified.has(id)));
  const neighbors = new Map([...active].map(id => [id, new Set()]));
  for (const [a, b] of normalizedEdges) {
    if (active.has(a) && active.has(b)) { neighbors.get(a).add(b); neighbors.get(b).add(a); }
  }
  const degrees = new Map([...neighbors].map(([id, linked]) => [id, linked.size]));
  const ranked = new Map([...active].map(id => [id, { id, priority: priorities(id) }]));
  const queue = [];
  const compare = (a, b) => a.degree - b.degree || comparePriority(a, b);
  for (const id of active) heapPush(queue, { ...ranked.get(id), degree: degrees.get(id) }, compare);
  const selected = [];
  while (active.size) {
    const entry = heapPop(queue, compare);
    if (!active.has(entry.id) || entry.degree !== degrees.get(entry.id)) continue;
    const chosen = entry.id;
    selected.push(chosen);
    const removed = [chosen, ...neighbors.get(chosen)].filter(id => active.has(id));
    for (const id of removed) active.delete(id);
    const changed = new Set();
    for (const id of removed) for (const other of neighbors.get(id)) if (active.has(other)) {
      degrees.set(other, degrees.get(other) - 1);
      changed.add(other);
    }
    for (const id of changed) heapPush(queue, { ...ranked.get(id), degree: degrees.get(id) }, compare);
  }
  return selected.sort((a, b) => a - b);
}

function sampleNoteCandidates({ candidateIds, excludedIds = [], limit, selectionKey, noteKey }) {
  integer(limit, 0, 'candidate limit');
  const priorities = priorityFunction(selectionKey, noteKey, 'note-candidates:v1');
  const excluded = new Set(ids(excludedIds));
  const candidates = ids(candidateIds);
  const heap = [];
  const compare = (a, b) => comparePriority(b, a);
  for (const id of candidates) {
    if (!limit || excluded.has(id)) continue;
    const item = { id, priority: priorities(id) };
    if (heap.length < limit) {
      heapPush(heap, item, compare);
    } else if (comparePriority(item, heap[0]) < 0) {
      heap[0] = item;
      heapDown(heap, compare);
    }
  }
  return heap.sort(comparePriority).map(item => item.id);
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function uniqueByUser(rows, name) {
  if (!Array.isArray(rows)) throw new TypeError(`Expected ${name}`);
  const byUser = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') throw new TypeError(`Invalid ${name}`);
    const id = userId(row.userId);
    if (byUser.has(id)) throw new TypeError(`Duplicate ${name}`);
    byUser.set(id, row);
  }
  return byUser;
}

const snapshots = new WeakSet();

// 根拠参照は信頼できる保存層から受け取り、ここでは署名や過去の事実を検証しない。
function createVoteSnapshot({ noteId, noteAuthorId, postAuthorId, ratingVersion, sourceVersion, capturedAt, ratings, admissions, relations, revocations = [] }) {
  userId(noteId); userId(noteAuthorId); userId(postAuthorId);
  integer(ratingVersion, 0, 'rating version');
  text(sourceVersion, 'source version');
  const capture = timestamp(capturedAt);
  const byUser = uniqueByUser(ratings, 'ratings');
  const byAdmission = uniqueByUser(admissions, 'admissions');
  const byRevocation = uniqueByUser(revocations, 'revocations');
  if (byAdmission.size !== byUser.size || [...byAdmission.keys()].some(id => !byUser.has(id))) throw new TypeError('Incomplete admission evidence');
  if ([...byRevocation.keys()].some(id => !byUser.has(id))) throw new TypeError('Unknown revoked vote');
  if (!relations || relations.basis !== 'admission-evidence' || relations.complete !== true) throw new TypeError('Complete admission-time relationship evidence is required');
  const covered = ids(relations.coveredUserIds);
  const coveredSet = new Set(covered);
  if ([...byUser.keys(), noteAuthorId, postAuthorId].some(id => !coveredSet.has(id))) throw new TypeError('Incomplete relationship coverage');
  const edges = normalizeEdges(relations.edges);
  if (edges.some(([a, b]) => !coveredSet.has(a) || !coveredSet.has(b))) throw new TypeError('Relationship edge outside coverage');
  const votes = [];
  for (const [id, row] of byUser) {
    integer(row.revision, 1, 'vote revision');
    if (typeof row.helpful !== 'boolean' || !Number.isFinite(row.weight) || row.weight < 1 || row.weight > 1.5) throw new TypeError('Invalid vote');
    const castAt = timestamp(row.castAt);
    if (Date.parse(castAt) > Date.parse(capture)) throw new TypeError('Vote is newer than snapshot');
    const admission = byAdmission.get(id);
    if (admission.noteId !== noteId || admission.revision !== row.revision || typeof admission.authorized !== 'boolean'
      || timestamp(admission.admittedAt) !== castAt) throw new TypeError('Vote admission mismatch');
    const evidenceRef = text(admission.evidenceRef, 'admission evidence reference');
    const revoked = byRevocation.get(id);
    let revocation = null;
    if (revoked) {
      if (revoked.noteId !== noteId || revoked.revision !== row.revision
        || !['moderation', 'voter-withdrawal', 'account-deletion'].includes(revoked.kind)) throw new TypeError('Invalid vote revocation');
      const revokedAt = timestamp(revoked.revokedAt);
      if (Date.parse(revokedAt) < Date.parse(castAt) || Date.parse(revokedAt) > Date.parse(capture)) throw new TypeError('Revocation outside snapshot');
      revocation = { kind: revoked.kind, evidenceRef: text(revoked.evidenceRef, 'revocation evidence reference'), authorityRef: text(revoked.authorityRef, 'revocation authority'), revokedAt };
    }
    votes.push({ userId: id, helpful: row.helpful, weight: row.weight, revision: row.revision, castAt, admission: { authorized: admission.authorized, evidenceRef }, revocation });
  }
  const snapshot = freeze({ schemaVersion: 1, noteId, noteAuthorId, postAuthorId, ratingVersion, sourceVersion, capturedAt: capture,
    relations: { basis: relations.basis, version: text(relations.version, 'relationship version'), evidenceRef: text(relations.evidenceRef, 'relationship evidence reference'), coveredUserIds: covered.sort((a, b) => a - b), edges },
    votes: votes.sort((a, b) => a.userId - b.userId) });
  snapshots.add(snapshot);
  return snapshot;
}

function summarizeIndependentVotes(snapshot, { selectionKey, noteKey, maxWeight }) {
  if (!snapshots.has(snapshot)) throw new TypeError('Expected a validated vote snapshot');
  if (!Number.isFinite(maxWeight) || maxWeight < 1 || maxWeight > 1.5) throw new TypeError('Invalid maximum weight');
  const eligible = snapshot.votes.filter(vote => vote.admission.authorized && !vote.revocation);
  const selectedUserIds = selectIndependentVoters({ candidateIds: eligible.map(vote => vote.userId), excludedIds: [snapshot.noteAuthorId, snapshot.postAuthorId], edges: snapshot.relations.edges, selectionKey, noteKey });
  const selected = new Set(selectedUserIds);
  let helpfulCount = 0, totalWeight = 0, helpfulWeight = 0;
  for (const vote of eligible) {
    if (!selected.has(vote.userId)) continue;
    const weight = Math.min(maxWeight, vote.weight);
    totalWeight += weight;
    if (vote.helpful) { helpfulCount++; helpfulWeight += weight; }
  }
  const count = selectedUserIds.length;
  return { noteId: snapshot.noteId, ratingVersion: snapshot.ratingVersion, sourceVersion: snapshot.sourceVersion, relationVersion: snapshot.relations.version,
    selectedUserIds, count, helpfulCount, totalWeight, helpfulWeight, ratio: count ? helpfulCount / count : 0, weightedRatio: totalWeight ? helpfulWeight / totalWeight : 0 };
}

function computeNotePenalty({ notes, mode, unitPenalty, cap }) {
  if (!Array.isArray(notes) || !['per-note', 'per-issue'].includes(mode)) throw new TypeError('Invalid penalty input');
  if (![unitPenalty, cap].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) throw new TypeError('Invalid penalty range');
  const seen = new Set(), issues = new Set(), missingNoteIds = [];
  let publicCount = 0;
  for (const note of notes) {
    userId(note.id);
    if (seen.has(note.id)) throw new TypeError('Duplicate note');
    seen.add(note.id);
    if (note.status !== 'public') continue;
    publicCount++;
    if (mode === 'per-issue') {
      if (typeof note.issueKey !== 'string' || !note.issueKey.trim() || typeof note.issueEvidenceRef !== 'string' || !note.issueEvidenceRef.trim()) missingNoteIds.push(note.id);
      else issues.add(note.issueKey);
    }
  }
  if (missingNoteIds.length) return { ready: false, penalty: null, publicCount, issueCount: null, missingNoteIds: missingNoteIds.sort((a, b) => a - b) };
  return { ready: true, penalty: Math.min(cap, unitPenalty * (mode === 'per-note' ? publicCount : issues.size)), publicCount, issueCount: mode === 'per-issue' ? issues.size : null, missingNoteIds: [] };
}

module.exports = { selectIndependentVoters, sampleNoteCandidates, createVoteSnapshot, summarizeIndependentVotes, computeNotePenalty };
