import postSearchQuery from '../../../server/utils/postSearchQuery.js';
import modLogs from '../../../server/adapters/database/modLogs.js';
import reputationStorage from '../../../server/adapters/database/reputation.js';
import reportReputation from '../../../server/adapters/database/reportReputation.js';
import dataMigrationSchema from '../../../server/services/DataMigrationSchema.js';
import dataMigrationOrder from '../../../server/services/DataMigrationOrder.js';
const { buildPostSearchSql } = postSearchQuery;
const {
	TABLE_SPECS,
	INSERT_ORDER,
	RESET_ORDER,
	EXCLUDED_TABLES,
} = dataMigrationSchema;
const { orderDeletions } = dataMigrationOrder;

function json(data, status = 200, headers = {}) {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': 'no-store',
			...headers,
		},
	});
}

function badRequest(message = 'Bad Request') {
	return json({ error: message }, 400);
}

function unauthorized(message = 'Unauthorized') {
	return json({ error: message }, 401);
}

function notFound(message = 'Not Found') {
	return json({ error: message }, 404);
}

function internalError(error) {
	console.error('[d1-proxy] Internal Error:', error);
	// D1/SQLiteの詳細や内部実装を呼び出し元へ露出しない。
	return json({ error: 'Internal Server Error' }, 500);
}

function formatNyaitterId(id) {
	const num = Number(id);
	if (!Number.isSafeInteger(num) || num < 0) return '#0000';
	return `#${String(num).padStart(4, '0')}`;
}

async function secureTokenEqual(provided, expected) {
	const enc = new TextEncoder();
	const [a, b] = await Promise.all([
		crypto.subtle.digest('SHA-256', enc.encode(String(provided))),
		crypto.subtle.digest('SHA-256', enc.encode(String(expected))),
	]);
	const aBytes = new Uint8Array(a);
	const bBytes = new Uint8Array(b);
	let diff = 0;
	for (let i = 0; i < aBytes.length; i += 1) {
		diff |= aBytes[i] ^ bBytes[i];
	}
	return diff === 0;
}

function encodePostCursor(post) {
	if (!post) return null;
	const id = Number(post.id ?? post.i);
	if (!Number.isInteger(id) || id <= 0) return null;
	const rawDate = post.createdAt ?? post.created_at ?? post.c;
	const parsedDate = rawDate ? new Date(rawDate) : null;
	if (!parsedDate || Number.isNaN(parsedDate.getTime())) return null;

	const payload = JSON.stringify([parsedDate.toISOString(), id]);
	if (typeof Buffer !== 'undefined') {
		return Buffer.from(payload, 'utf8').toString('base64url');
	}
	return btoa(payload).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodePostCursor(cursor) {
	if (!cursor || typeof cursor !== 'string') return null;
	try {
		let raw;
		if (typeof Buffer !== 'undefined') {
			raw = Buffer.from(cursor.trim(), 'base64url').toString('utf8');
		} else {
			const b64 = cursor.trim().replace(/-/g, '+').replace(/_/g, '/');
			raw = atob(b64);
		}
		let createdAt = null;
		let id = null;

		if (raw.startsWith('[') && raw.endsWith(']')) {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed) && parsed.length >= 2) {
				createdAt = parsed[0];
				id = Number(parsed[1]);
			}
		} else if (raw.startsWith('{') && raw.endsWith('}')) {
			const parsed = JSON.parse(raw);
			createdAt = parsed.c || parsed.createdAt || parsed.created_at;
			id = Number(parsed.i || parsed.id);
		} else if (raw.includes('_')) {
			const parts = raw.split('_');
			createdAt = parts[0];
			id = Number(parts[1]);
		}

		if (!createdAt || !Number.isInteger(id) || id <= 0) return null;
		const parsedDate = new Date(createdAt);
		if (Number.isNaN(parsedDate.getTime())) return null;

		return {
			createdAt: parsedDate.toISOString(),
			id,
		};
	} catch {
		return null;
	}
}

// Fail-closed: when AUTH_TOKEN is not configured the proxy must refuse all
// requests. A token that was never set must never be treated as "no auth".
async function requireAuth(request, env) {
	const expected = env.AUTH_TOKEN;
	if (!expected) {
		return false;
	}
	const authHeader = request.headers.get('Authorization') || '';
	const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
	if (!token) {
		return false;
	}
	return secureTokenEqual(token, expected);
}

function parseJsonSafe(value, fallback = null) {
	if (!value) return fallback;
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value);
	} catch (_) {
		return fallback;
	}
}

function normalizePostTags(value) {
	const rawTags = parseJsonSafe(value, Array.isArray(value) ? value : []);
	if (!Array.isArray(rawTags)) return [];
	return [...new Set(rawTags
		.map((tag) => String(tag || '').trim().toLocaleLowerCase('ja-JP'))
		.filter((tag) => tag.length > 0 && tag.length <= 48))]
		.slice(0, 10);
}

function normalizePostEventRow(row) {
	if (!row) return null;
	let payload = {};
	try {
		payload = typeof row.payload === 'object' && row.payload !== null ? row.payload : JSON.parse(row.payload || '{}');
	} catch (_) {
		payload = {};
	}
	return {
		id: Number(row.id),
		event_type: row.event_type,
		post_id: row.post_id == null ? null : Number(row.post_id),
		payload,
		status: row.status,
		attempts: Number(row.attempts || 0),
		worker_id: row.worker_id || null,
		available_at: row.available_at,
		locked_at: row.locked_at || null,
		processed_at: row.processed_at || null,
		last_error: row.last_error || null,
		created_at: row.created_at,
	};
}

function calculateStringSimilarity(str1, str2) {
	const s1 = String(str1 || '').trim().toLowerCase().replace(/^[#＃]/, '');
	const s2 = String(str2 || '').trim().toLowerCase().replace(/^[#＃]/, '');
	if (s1 === s2) return 1.0;
	if (!s1 || !s2) return 0.0;

	const len1 = s1.length;
	const len2 = s2.length;
	const maxLen = Math.max(len1, len2);
	const minLen = Math.min(len1, len2);

	const isSubstring = s1.includes(s2) || s2.includes(s1);
	const substringSim = isSubstring ? minLen / maxLen : 0;

	const d = Array.from({ length: len1 + 1 }, () => new Array(len2 + 1).fill(0));
	for (let i = 0; i <= len1; i++) d[i][0] = i;
	for (let j = 0; j <= len2; j++) d[0][j] = j;

	for (let i = 1; i <= len1; i++) {
		for (let j = 1; j <= len2; j++) {
			const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
			d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
		}
	}
	const levSim = 1 - d[len1][len2] / maxLen;

	let diceSim = 0;
	if (len1 >= 2 && len2 >= 2) {
		const bg1 = new Map();
		for (let i = 0; i < len1 - 1; i++) {
			const bg = s1.slice(i, i + 2);
			bg1.set(bg, (bg1.get(bg) || 0) + 1);
		}
		let intersection = 0;
		for (let i = 0; i < len2 - 1; i++) {
			const bg = s2.slice(i, i + 2);
			if (bg1.has(bg) && bg1.get(bg) > 0) {
				intersection++;
				bg1.set(bg, bg1.get(bg) - 1);
			}
		}
		diceSim = (2 * intersection) / ((len1 - 1) + (len2 - 1));
	}

	return Math.max(substringSim, levSim, diceSim);
}

function isFuzzyMatch(text, query, threshold = 0.8) {
	const target = String(text || '').trim().toLowerCase();
	const q = String(query || '').trim().toLowerCase().replace(/^[#＃]/, '');
	if (!target || !q) return false;
	if (target.includes(q)) return true;

	const qLen = q.length;
	if (qLen <= 1) return false;

	for (const windowLen of [qLen, qLen - 1, qLen + 1]) {
		if (windowLen <= 0 || windowLen > target.length) continue;
		for (let i = 0; i <= target.length - windowLen; i++) {
			const sub = target.slice(i, i + windowLen);
			const sim = calculateStringSimilarity(sub, q);
			if (sim >= threshold) return true;
		}
	}

	return false;
}

function createAttachmentReplacementMap(replacements) {
	const replacementMap = new Map();
	for (const replacement of Array.isArray(replacements) ? replacements : []) {
		const sourceKey = typeof replacement?.sourceKey === 'string' ? replacement.sourceKey : null;
		const destinationKey = typeof replacement?.destinationKey === 'string' ? replacement.destinationKey : null;
		if (!sourceKey || !destinationKey) continue;
		replacementMap.set(sourceKey, { destinationKey, url: replacement.url ?? null });
	}
	return replacementMap;
}

function rewriteAttachmentReferences(attachments, replacementMap) {
	if (!Array.isArray(attachments) || replacementMap.size === 0) {
		return { attachments: Array.isArray(attachments) ? attachments : [], changed: false };
	}
	let changed = false;
	const rewritten = attachments.map((attachment) => {
		if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) return attachment;
		const sourceKey = typeof attachment.id === 'string'
			? attachment.id
			: (typeof attachment.key === 'string' ? attachment.key : null);
		const replacement = sourceKey ? replacementMap.get(sourceKey) : null;
		if (!replacement) return attachment;
		changed = true;
		const next = { ...attachment };
		if (typeof attachment.id === 'string') next.id = replacement.destinationKey;
		if (typeof attachment.key === 'string') next.key = replacement.destinationKey;
		if (Object.prototype.hasOwnProperty.call(next, 'url')) next.url = replacement.url;
		return next;
	});
	return { attachments: rewritten, changed };
}

function formatD1PollRow(poll, voteRows = [], currentUserId = null) {
	if (!poll) return null;
	const isExpired = Boolean(poll.expires_at && new Date(poll.expires_at) <= new Date()) || Boolean(poll.closed);
	let rawOptions = [];
	try {
		rawOptions = typeof poll.options === 'string' ? JSON.parse(poll.options) : (poll.options || []);
	} catch (_) {
		rawOptions = [];
	}

	const votes = voteRows || [];
	const totalVotesCount = votes.length;
	const voterIds = new Set(votes.map((v) => Number(v.user_id)));
	const totalVotersCount = voterIds.size;

	const myVotes = [];
	let myOtherText = null;
	const votesByOption = new Map();
	let otherCount = 0;
	const otherVotes = [];

	for (const v of votes) {
		const optId = Number(v.option_id);
		const vUserId = Number(v.user_id);
		if (currentUserId != null && vUserId === Number(currentUserId)) {
			myVotes.push(optId);
			if (optId === -1 && v.other_text) {
				myOtherText = v.other_text;
			}
		}

		if (optId === -1) {
			otherCount += 1;
			if (v.other_text) {
				otherVotes.push({
					user_id: vUserId,
					text: v.other_text,
					created_at: v.created_at,
				});
			}
		} else {
			votesByOption.set(optId, (votesByOption.get(optId) || 0) + 1);
		}
	}

	const hasVoted = currentUserId != null && myVotes.length > 0;
	const showResultsBeforeVoting = Boolean(poll.show_results_before_voting);

	const formattedOptions = rawOptions.map((opt) => {
		const count = votesByOption.get(Number(opt.id)) || 0;
		const percentage = totalVotesCount > 0 ? Math.round((count / totalVotesCount) * 100) : 0;
		return {
			id: Number(opt.id),
			text: String(opt.text || ''),
			votes_count: count,
			percentage,
		};
	});

	return {
		id: poll.id,
		post_id: poll.post_id,
		user_id: poll.user_id,
		title: poll.title,
		options: formattedOptions,
		allow_multiple: Boolean(poll.allow_multiple),
		allow_other: Boolean(poll.allow_other),
		show_results_before_voting: showResultsBeforeVoting,
		other_votes_count: otherCount,
		other_percentage: totalVotesCount > 0 ? Math.round((otherCount / totalVotesCount) * 100) : 0,
		other_votes: isExpired || hasVoted || showResultsBeforeVoting ? otherVotes : [],
		total_votes: totalVotesCount,
		total_voters: totalVotersCount,
		my_votes: myVotes,
		my_other_text: myOtherText,
		has_voted: hasVoted,
		expires_at: poll.expires_at || null,
		is_expired: isExpired,
		closed: Boolean(poll.closed),
		created_at: poll.created_at,
	};
}

// 移行テーブル/列の定義はサーバー側の唯一の情報源（DataMigrationSchema）から取る。
// D1 とサーバーで列リストを二重管理すると必ずずれ、移行先で静かにデータが消える。
const MIGRATION_TABLES = TABLE_SPECS.map((spec) => spec.table);
const MIGRATION_COLUMNS = Object.fromEntries(TABLE_SPECS.map((spec) => [spec.table, spec.columns]));
const MIGRATION_INSERT_ORDER = INSERT_ORDER.slice();
const MIGRATION_RESET_ORDER = RESET_ORDER.slice();
// 派生列はコピーしない。D1 はトリガーでカウンタを維持しており、値を入れたうえで
// トリガーが加算すると二重計上になるため、投入後に実データから再計算する。
const MIGRATION_DERIVED_COLUMNS = Object.fromEntries(
	TABLE_SPECS.filter((spec) => spec.derived?.length).map((spec) => [spec.table, spec.derived]),
);
const MIGRATION_JSON_COLUMNS = new Set([
	'external_profile', 'settings', 'block', 'attachments', 'tags', 'stage_settings', 'participants', 'member', 'post',
	'unread', 'target', 'target_snapshot', 'excluded_admin_ids', 'resolution', 'permissions', 'options', 'scopes',
	'provider_profile', 'latest_message', 'response_message',
]);
const MIGRATION_BOOLEAN_COLUMNS = new Set([
	'verify', 'admin', 'admin_request_excluded', 'shadow', 'mask', 'lock', 'announcement', 'group_announcement',
	'is_system', 'read', 'clicked', 'allow_multiple', 'allow_other', 'show_results_before_voting', 'closed',
	'closed_notified',
]);
// Keep a replacement within documented D1 per-script binding limits and leave
// headroom for runtime overhead. A multi-batch import would lose atomicity.
const MIGRATION_MAX_BINDINGS = 5000;
// D1's batch API caps a batch at 1,000 prepared statements. Keep this explicit
// so replacements that cannot fit in one atomic batch are rejected pre-delete.
const MIGRATION_MAX_STATEMENTS = 1000;
const MIGRATION_MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const SUPPORTED_SNAPSHOT_VERSIONS = [1, 2];
// 移行対象外（意図的）。スナップショットに記録して報告する。
const MIGRATION_EXCLUDED_TABLES = EXCLUDED_TABLES.map((entry) => ({ table: entry.table, reason: entry.reason }));

function migrationValue(column, value) {
	if (column === 'admin_request_excluded' && value == null) return 0;
	if (value == null) return null;
	// エクスポートはD1の生値をそのまま返すため、JSON列が既に文字列の場合は再エンコードしない。
	if (MIGRATION_JSON_COLUMNS.has(column)) return typeof value === 'string' ? value : JSON.stringify(value);
	if (MIGRATION_BOOLEAN_COLUMNS.has(column)) return value ? 1 : 0;
	return value;
}

function safeMigrationIdentifier(value) {
	return /^[a-z_][a-z0-9_]*$/.test(value) ? value : null;
}

// 実スキーマの外部キー関係（削除順と CASCADE 連鎖の判定に使う）。
async function migrationForeignKeyEdges(db) {
	const { results } = await db.prepare(
		`SELECT m.name AS child, f."table" AS parent, f.on_delete AS on_delete
		   FROM sqlite_master m, pragma_foreign_key_list(m.name) f
		  WHERE m.type = 'table'`,
	).all();
	return (results || []).map((row) => ({ child: row.child, parent: row.parent, onDelete: row.on_delete }));
}

async function tableColumnNames(db, table) {
	const identifier = safeMigrationIdentifier(table);
	if (!identifier) return [];
	const { results } = await db.prepare(`PRAGMA table_info(${identifier})`).all();
	return (results || []).map((row) => row.name);
}

// 実際に存在する列だけを返す。migration 未適用の列を INSERT して
// バッチ全体を失敗させないため（欠落は結果として報告する）。
async function migrationColumnsFor(db, table) {
	const declared = MIGRATION_COLUMNS[table] || [];
	const derived = new Set(MIGRATION_DERIVED_COLUMNS[table] || []);
	const available = new Set(await tableColumnNames(db, table));
	return declared.filter((column) => available.has(column) && !derived.has(column));
}

// 派生列（カウンタ・集約キャッシュ）を実データから再計算する。
// 投入値を使わないのでトリガーと二重計上にならず、既存のずれも自己修復する。
// 派生列（カウンタ・集約キャッシュ）を実データから再計算する。
// 投入値を使わないのでトリガーと二重計上にならず、既存のずれも自己修復する。
// 宛先に列が無い（migration 0008 未適用など）場合は文を作らない。
// 作ってしまうとバッチ全体が失敗し、置換が巻き戻って「スナップショットに無い表だけ保持」
// ではなく「何も移行されない」状態になる。
async function derivedRepairStatements(db) {
	const statements = [];
	const postColumns = new Set(await tableColumnNames(db, 'posts'));
	if (postColumns.size && ['like_count', 'star_count', 'repost_count', 'reply_count'].every((column) => postColumns.has(column))) {
		statements.push(db.prepare(
			`UPDATE posts SET
				like_count = (SELECT COUNT(*) FROM likes WHERE likes.post_id = posts.id),
				star_count = (SELECT COUNT(*) FROM stars WHERE stars.post_id = posts.id),
				repost_count = (SELECT COUNT(*) FROM reposts WHERE reposts.post_id = posts.id),
				reply_count = (SELECT COUNT(*) FROM posts replies WHERE replies.reply_to = posts.id)`,
		));
	}
	const groupDmColumns = new Set(await tableColumnNames(db, 'group_dms'));
	if (groupDmColumns.has('message_count') && groupDmColumns.has('latest_message')) {
		// post は JSON 文字列で保持されているため TEXT 版の JSON 関数を使う。
		statements.push(db.prepare(
			`UPDATE group_dms SET
				message_count = COALESCE(json_array_length(post), 0),
				latest_message = CASE WHEN COALESCE(json_array_length(post), 0) > 0 THEN json_extract(post, '$[' || (json_array_length(post) - 1) || ']') ELSE NULL END`,
		));
	} else if (groupDmColumns.has('message_count')) {
		statements.push(db.prepare('UPDATE group_dms SET message_count = COALESCE(json_array_length(post), 0)'));
	}
	return statements;
}

async function exportMigrationSnapshot(db) {
	const tables = {};
	const skippedColumns = {};
	const queries = [];
	const queryTables = [];
	// D1 自身のスナップショットは常に version 2 なので、excluded_tables も必ず付ける。
	// 付け忘れると受け手が「除外表の記録が無い旧ファイル」として扱い、CLI の
	// excluded_tables が空になって「黙って落ちた」のか区別できなくなる。
	const excludedTables = MIGRATION_EXCLUDED_TABLES.map((entry) => ({ table: entry.table, reason: entry.reason }));
	for (const table of MIGRATION_TABLES) {
		if (table === 'mod_logs' && !(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mod_logs'").first())) { tables[table] = []; continue; }
		const available = await tableColumnNames(db, table);
		if (!available.length) continue;
		const columns = MIGRATION_COLUMNS[table].filter((column) => available.includes(column));
		const missing = MIGRATION_COLUMNS[table].filter((column) => !available.includes(column));
		if (missing.length) skippedColumns[table] = missing;
		queries.push(db.prepare(`SELECT ${columns.map((column) => safeMigrationIdentifier(column)).join(', ')} FROM ${table}`));
		queryTables.push(table);
	}
	const results = queries.length ? await db.batch(queries) : [];
	for (let i = 0; i < queryTables.length; i++) tables[queryTables[i]] = results[i].results || [];
	return {
		version: 2,
		created_at: new Date().toISOString(),
		source_adapter: 'd1',
		// 実際に含むテーブル。ここに無いテーブルは宛先で保持される。
		tables_present: Object.keys(tables),
		mod_logs_present: Object.prototype.hasOwnProperty.call(tables, 'mod_logs'),
		excluded_tables: excludedTables,
		...(Object.keys(skippedColumns).length ? { skipped_columns: skippedColumns } : {}),
		tables,
	};
}

function migrationIncludedTables(snapshot) {
	const present = new Set();
	const declared = Array.isArray(snapshot?.tables_present) ? snapshot.tables_present : null;
	// version 2 は tables_present が唯一の根拠。tables にだけあるキー（省略）を
	// ここで含めてしまうと、サーバー側 createSnapshot が全表のキーを作るため
	// 省略したはずのテーブルが宛先で空に上書きされる。
	const explicit = Number(snapshot?.version) >= 2 && declared !== null;
	if (explicit) {
		for (const table of declared) if (MIGRATION_TABLES.includes(table)) present.add(table);
		// tables_present に載っていない表の行は黙って捨てない。
		for (const table of MIGRATION_TABLES) {
			if (present.has(table)) continue;
			const rows = snapshot?.tables?.[table];
			if (Array.isArray(rows) && rows.length) {
				throw new Error(`Migration snapshot table ${table} has rows but is not listed in tables_present`);
			}
		}
	} else {
		for (const table of MIGRATION_TABLES) {
			if (Object.prototype.hasOwnProperty.call(snapshot?.tables || {}, table)) present.add(table);
		}
	}
	// 後方互換: mod_logs_present === false は「保持」を意味する。
	if (snapshot?.mod_logs_present === false) present.delete('mod_logs');
	return present;
}

async function importMigrationSnapshot(db, snapshot) {
	if (!snapshot || !SUPPORTED_SNAPSHOT_VERSIONS.includes(Number(snapshot.version)) || !snapshot.tables || typeof snapshot.tables !== 'object') {
		throw new Error('Invalid migration snapshot');
	}
	const snapshotBytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
	if (snapshotBytes > MIGRATION_MAX_SNAPSHOT_BYTES) {
		throw new Error(`Migration snapshot exceeds the safe atomic-import size limit (${MIGRATION_MAX_SNAPSHOT_BYTES} bytes)`);
	}
	const included = migrationIncludedTables(snapshot);
	if (included.has('group_dms') && snapshot.tables.group_dms?.length && !included.has('group_dm_send_requests')) throw new Error('DM snapshot is missing send request history');
	const modLogs = included.has('mod_logs') ? (snapshot.tables.mod_logs ?? []) : [];
	if (!Array.isArray(modLogs)) throw new Error('Invalid mod_logs snapshot');
	const modLogIds = new Set();
	for (const row of modLogs) {
		if (!row || typeof row.id !== 'string' || !row.id || modLogIds.has(row.id) ||
			['created_at', 'actor_type', 'action', 'target_type', 'target_id', 'result'].some(key => typeof row[key] !== 'string' || !row[key]) ||
			(row.actor_id != null && typeof row.actor_id !== 'string')) throw new Error('Invalid or duplicate mod log in migration snapshot');
		modLogIds.add(row.id);
	}
	const hasModLogs = Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mod_logs'").first());
	if (!hasModLogs && modLogs.length) throw new Error('Destination requires mod_logs migration');
	if (!hasModLogs) included.delete('mod_logs');
	// データを入れるのに宛先テーブルが無ければ、黙って抜けずに失敗する。
	const missingTables = [];
	for (const table of included) {
		const rows = Array.isArray(snapshot.tables[table]) ? snapshot.tables[table] : [];
		if (rows.length && !(await tableColumnNames(db, table)).length) missingTables.push(table);
	}
	if (missingTables.length) {
		throw new Error(`Destination is missing tables required by the snapshot: ${missingTables.join(', ')}`);
	}

	const columnsByTable = {};
	const skippedColumns = {};
	for (const table of MIGRATION_INSERT_ORDER) {
		if (!included.has(table)) continue;
		const columns = await migrationColumnsFor(db, table);
		columnsByTable[table] = columns;
		const missing = (MIGRATION_COLUMNS[table] || []).filter((column) => !columns.includes(column)
			&& !(MIGRATION_DERIVED_COLUMNS[table] || []).includes(column));
		if (table === 'group_dm_send_requests' && missing.length && snapshot.tables[table]?.length) throw new Error('Destination is missing DM send request columns');
		if (missing.length) skippedColumns[table] = missing;
	}

	const statements = [];
	let bindingCount = 0;
	const addStatement = (sql, values = []) => {
		if (statements.length >= MIGRATION_MAX_STATEMENTS) {
			throw new Error(`Migration snapshot exceeds the safe atomic-import statement limit (${MIGRATION_MAX_STATEMENTS})`);
		}
		bindingCount += values.length;
		if (bindingCount > MIGRATION_MAX_BINDINGS) {
			throw new Error(`Migration snapshot exceeds the safe atomic-import binding limit (${MIGRATION_MAX_BINDINGS})`);
		}
		statements.push(db.prepare(sql).bind(...values));
	};
	// スナップショットに含まれるテーブルと、そこからの CASCADE で消えるテーブルだけを空にする。
	// 関係の無いテーブルは残す。旧スナップショットが知らない新テーブルも、
	// 参照先が消えない限り保持される。
	// 連鎖は推移的に辿る（posts → groups → group_roles / spaces → space_channels、の様に
	// 孫以降も消える）。一段だけだと実削除と報告が食い違う。
	const foreignKeys = await migrationForeignKeyEdges(db);
	const cascaded = [];
	const cascadeStack = [...included];
	while (cascadeStack.length) {
		const parent = cascadeStack.pop();
		for (const edge of foreignKeys) {
			if (edge.parent !== parent || edge.child === parent) continue;
			if (String(edge.onDelete || '').toUpperCase() !== 'CASCADE') continue;
			if (included.has(edge.child) || cascaded.includes(edge.child)) continue;
			if (!(await tableColumnNames(db, edge.child)).length) continue;
			cascaded.push(edge.child);
			cascadeStack.push(edge.child);
		}
	}
	const deleteTargets = [...included].concat(cascaded.filter((table) => !included.has(table)));
	// SQLite は文ごとに外部キーを即時検査するため、親（参照される側）から消す。
	const { parentFirst } = orderDeletions(deleteTargets, foreignKeys);
	for (const table of parentFirst) {
		addStatement(`DELETE FROM ${table}`);
	}
	for (const table of MIGRATION_INSERT_ORDER) {
		if (!included.has(table)) continue;
		const columns = columnsByTable[table];
		if (!columns.length) continue;
		const rows = Array.isArray(snapshot.tables[table]) ? snapshot.tables[table] : [];
		for (const originalRow of rows) {
			const row = table === 'posts'
				? { ...originalRow, reply_to: null, repost_to: null }
				: originalRow;
			const placeholders = columns.map(() => '?').join(', ');
			addStatement(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
				columns.map((column) => migrationValue(column, row[column])));
		}
	}
	for (const row of (included.has('posts') ? (snapshot.tables.posts || []) : [])) {
		if (row.reply_to == null && row.repost_to == null) continue;
		addStatement('UPDATE posts SET reply_to = ?, repost_to = ? WHERE id = ?', [row.reply_to ?? null, row.repost_to ?? null, row.id]);
	}
	// 派生カウンタは投入後に再計算する（D1のトリガーは reply_to を後から UPDATE しても
	// 加算しないため、返信数の復帰はここでしか行えない）。
	if (included.has('posts')) {
		for (const statement of await derivedRepairStatements(db)) {
			if (statements.length >= MIGRATION_MAX_STATEMENTS) {
				throw new Error(`Migration snapshot exceeds the safe atomic-import statement limit (${MIGRATION_MAX_STATEMENTS})`);
			}
			statements.push(statement);
		}
	}
	// post_events は移行対象外。D1 のトリガーが投稿投入時に作る合成イベントを
	// 残すと、移行直後に過去投稿の通知が一斉生成されるため、最後に空にする。
	const clearedTables = [];
	if (await tableColumnNames(db, 'post_events').then((columns) => columns.length > 0)) {
		if (statements.length >= MIGRATION_MAX_STATEMENTS) {
			throw new Error(`Migration snapshot exceeds the safe atomic-import statement limit (${MIGRATION_MAX_STATEMENTS})`);
		}
		// 投稿を入れるとトリガーが post_events を作るため、投入後は必ず空にする
		// （残すと移行直後に過去投稿の通知が一斉生成される）。
		statements.push(db.prepare('DELETE FROM post_events'));
		clearedTables.push('post_events');
	}
	// D1 batch is a transaction; keep every delete, insert and reference repair
	// in this one batch so failures cannot leave a partially replaced snapshot.
	if (statements.length) await db.batch(statements);
	return {
		counts: Object.fromEntries(MIGRATION_TABLES.map((table) => [table,
			included.has(table) && Array.isArray(snapshot.tables[table]) ? snapshot.tables[table].length : null])),
		imported_tables: MIGRATION_INSERT_ORDER.filter((table) => included.has(table)),
		preserved_tables: MIGRATION_TABLES.filter((table) => !included.has(table) && !cascaded.includes(table)),
		// 置換で親行が消えるため CASCADE で連鎖削除した従属テーブル（データは失われた）。
		cascaded_tables: cascaded,
		// 置換/CASCADE とは独立した移行処理で空にしたテーブル。
		cleared_tables: clearedTables,
		skipped_columns: skippedColumns,
		excluded_tables: Array.isArray(snapshot.excluded_tables) ? snapshot.excluded_tables : MIGRATION_EXCLUDED_TABLES,
	};
}

function normalizeBlockUserId(value) {
	if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
		return null;
	}
	const id = Number(value);
	return Number.isInteger(id) && id >= 0 ? id : null;
}

function normalizeBlockList(value, ownerUserId = null) {
	const ownerId = normalizeBlockUserId(ownerUserId);
	if (!Array.isArray(value)) return [];
	return [...new Set(value
		.map(normalizeBlockUserId)
		.filter((id) => id !== null && id !== ownerId))]
		.sort((left, right) => left - right);
}

function normalizeUserRow(row) {
	if (!row) return null;
	return {
		id: row.id,
		account_operation: row.account_operation || null,
		scid: row.scid || null,
		name: row.name || '',
		handle: row.handle || formatNyaitterId(row.id),
		nyaitter_address: row.nyaitter_address || null,
		auth_provider: row.auth_provider || 'local',
		provider_domain: row.provider_domain || null,
		external_id: row.external_id || null,
		external_profile: parseJsonSafe(row.external_profile, null),
		uuid: row.uuid || null,
		settings: parseJsonSafe(row.settings, {}),
		bio: row.bio || '',
		me: row.bio || '',
		header_image: row.header_image || null,
		icon_data: row.icon_data || null,
		verify: Boolean(row.verify),
		admin: Boolean(row.admin),
		admin_request_excluded: Boolean(row.admin_request_excluded),
		freeze: row.freeze || null,
		shadow: Boolean(row.shadow),
		block: normalizeBlockList(parseJsonSafe(row.block, []), row.id),
		age_estimate: row.age_estimate != null ? Number(row.age_estimate) : null,
		age_source: row.age_source || null,
		age_estimated_at: row.age_estimated_at || null,
		age_samples: Math.max(0, Number(row.age_samples) || 0),
		created_at: row.created_at,
	};
}

function normalizeAuthProviderRow(row) {
	if (!row) return null;
	return {
		id: row.id,
		userId: row.user_id,
		provider: row.provider,
		providerUserId: row.provider_user_id,
		providerProfile: parseJsonSafe(row.provider_profile, {}),
		createdAt: row.created_at || null,
	};
}

function normalizeGroupRow(row) {
	if (!row) return null;
	const ownerId = Number(row.owner_id);
	return {
		id: String(row.id), ownerId, owner_id: ownerId, name: row.name || '', description: row.description || '',
		iconData: row.icon_data ?? null, icon_data: row.icon_data ?? null, headerImage: row.header_image ?? null,
		header_image: row.header_image ?? null, visibility: row.visibility || 'open',
		memberCount: Number(row.member_count) || 0, member_count: Number(row.member_count) || 0,
		deletedAt: row.deleted_at ?? null, deleted_at: row.deleted_at ?? null, createdAt: row.created_at ?? null,
		created_at: row.created_at ?? null, updatedAt: row.updated_at ?? null, updated_at: row.updated_at ?? null,
	};
}

function normalizeGroupRoleRow(row) {
	if (!row) return null;
	const permissions = parseJsonSafe(row.permissions, []);
	return { id: String(row.id), groupId: String(row.group_id), group_id: String(row.group_id), name: row.name || '',
		permissions: Array.isArray(permissions) ? permissions.map(String) : [], isSystem: Boolean(row.is_system), is_system: Boolean(row.is_system),
		sortOrder: Number(row.sort_order) || 0, sort_order: Number(row.sort_order) || 0,
		createdAt: row.created_at ?? null, created_at: row.created_at ?? null, updatedAt: row.updated_at ?? null, updated_at: row.updated_at ?? null };
}

function normalizeGroupMembershipRow(row) {
	if (!row) return null;
	return { groupId: String(row.group_id), group_id: String(row.group_id), userId: Number(row.user_id), user_id: Number(row.user_id),
		roleId: row.role_id ?? null, role_id: row.role_id ?? null, status: row.status || 'active',
		joinedAt: row.joined_at ?? null, joined_at: row.joined_at ?? null, updatedAt: row.updated_at ?? null, updated_at: row.updated_at ?? null };
}

function normalizeGroupInviteRow(row) {
	if (!row) return null;
	return { id: String(row.id), groupId: String(row.group_id), group_id: String(row.group_id), inviterId: Number(row.inviter_id), inviter_id: Number(row.inviter_id),
		inviteeId: Number(row.invitee_id), invitee_id: Number(row.invitee_id), status: row.status || 'pending',
		createdAt: row.created_at ?? null, created_at: row.created_at ?? null, respondedAt: row.responded_at ?? null, responded_at: row.responded_at ?? null };
}

function normalizeGroupJoinRequestRow(row) {
	if (!row) return null;
	return { id: String(row.id), groupId: String(row.group_id), group_id: String(row.group_id), userId: Number(row.user_id), user_id: Number(row.user_id),
		status: row.status || 'pending', reviewedBy: row.reviewed_by ?? null, reviewed_by: row.reviewed_by ?? null,
		createdAt: row.created_at ?? null, created_at: row.created_at ?? null, reviewedAt: row.reviewed_at ?? null, reviewed_at: row.reviewed_at ?? null };
}

function normalizeSpaceRow(row) {
	if (!row) return null;
	return {
        stage_settings: row.stage_settings || null,
		id: String(row.id), ownerId: Number(row.owner_id), owner_id: Number(row.owner_id),
		name: row.name || '', description: row.description || '',
		iconData: row.icon_data ?? null, icon_data: row.icon_data ?? null,
		headerImage: row.header_image ?? null, header_image: row.header_image ?? null,
		visibility: row.visibility || 'public',
		groupId: row.group_id ?? null, group_id: row.group_id ?? null,
		memberCount: Number(row.member_count) || 0, member_count: Number(row.member_count) || 0,
		createdAt: row.created_at ?? null, created_at: row.created_at ?? null,
		updatedAt: row.updated_at ?? null, updated_at: row.updated_at ?? null,
	};
}

function normalizeSpaceChannelRow(row) {
	if (!row) return null;
	return {
		id: String(row.id), spaceId: String(row.space_id), space_id: String(row.space_id),
		name: row.name || '', kind: row.kind || 'text',
		sortOrder: Number(row.sort_order) || 0, sort_order: Number(row.sort_order) || 0,
		createdAt: row.created_at ?? null, created_at: row.created_at ?? null,
	};
}

function normalizeSpaceMemberRow(row) {
	if (!row) return null;
	return {
		spaceId: String(row.space_id), space_id: String(row.space_id),
		userId: Number(row.user_id), user_id: Number(row.user_id),
		role: row.role || 'member', joinedAt: row.joined_at ?? null, joined_at: row.joined_at ?? null,
	};
}

function normalizeSpaceMessageRow(row) {
	if (!row) return null;
	return {
		id: Number(row.id), spaceId: String(row.space_id), space_id: String(row.space_id),
		channelId: String(row.channel_id), channel_id: String(row.channel_id),
		userId: Number(row.user_id), user_id: Number(row.user_id),
		content: row.content || '', createdAt: row.created_at ?? null, created_at: row.created_at ?? null,
	};
}

function normalizePostRow(row) {
	if (!row) return null;
	return {
		id: row.id,
		userId: row.user_id,
		user_id: row.user_id,
		content: row.content || '',
		tags: normalizePostTags(row.tags),
		tagsGeneratedAt: row.tags_generated_at || null,
		tags_generated_at: row.tags_generated_at || null,
		attachments: parseJsonSafe(row.attachments, []),
		mask: Boolean(row.mask),
		lock: Boolean(row.lock),
		ageRating: Number(row.age_rating ?? row.ageRating ?? 0) || 0,
		age_rating: Number(row.age_rating ?? row.ageRating ?? 0) || 0,
		announcement: Boolean(row.announcement),
		groupId: row.group_id ?? null,
		group_id: row.group_id ?? null,
		groupAnnouncement: Boolean(row.group_announcement),
		group_announcement: Boolean(row.group_announcement),
		replyTo: row.reply_to || null,
		reply_to: row.reply_to || null,
		repostTo: row.repost_to || null,
		repost_to: row.repost_to || null,
		...(row.like_count !== undefined ? { like_count: Number(row.like_count) || 0 } : {}),
		...(row.star_count !== undefined ? { star_count: Number(row.star_count) || 0 } : {}),
		...(row.repost_count !== undefined ? { repost_count: Number(row.repost_count) || 0 } : {}),
		...(row.reply_count !== undefined ? { reply_count: Number(row.reply_count) || 0 } : {}),
		...(row.recommendation_penalty !== undefined ? { recommendation_penalty: Number(row.recommendation_penalty) || 0 } : {}),
		...(row.liked_by_me !== undefined ? { liked_by_me: Boolean(row.liked_by_me) } : {}),
		...(row.starred_by_me !== undefined ? { starred_by_me: Boolean(row.starred_by_me) } : {}),
		author: row.author_id != null
			? normalizeUserRow({
				id: row.author_id,
				name: row.author_name,
				scid: row.author_scid,
				handle: row.author_handle,
				icon_data: row.author_icon_data,
				bio: row.author_bio,
				header_image: row.author_header_image,
				verify: row.author_verify,
				admin: row.author_admin,
				shadow: row.author_shadow,
				settings: row.author_settings,
				block: row.author_block,
				created_at: row.author_created_at,
			})
			: null,
		createdAt: row.created_at,
		created_at: row.created_at,
	};
}

// 一覧レスポンス用。投稿本体を返す場合だけ、本人リアクションを1クエリで付与する。
// 件数はpostsの非正規化カウンターをそのまま利用し、一覧ごとの集計クエリを発生させない。
async function attachInlinePostMetrics(db, rows, currentUserId) {
	const posts = Array.isArray(rows) ? rows : [];
	const viewerId = Number(currentUserId);
	if (!Number.isSafeInteger(viewerId) || viewerId <= 0 || posts.length === 0) return posts;

	const ids = [...new Set(posts.map((row) => Number(row?.id)).filter((id) => Number.isSafeInteger(id) && id > 0))];
	if (ids.length === 0) return posts;
	const placeholders = ids.map(() => '?').join(', ');
	const { results } = await db.prepare(
		`SELECT post_id, 'like' AS kind FROM likes
		 WHERE user_id = ? AND post_id IN (${placeholders})
		 UNION ALL
		 SELECT post_id, 'star' AS kind FROM stars
		 WHERE user_id = ? AND post_id IN (${placeholders})`
	).bind(viewerId, ...ids, viewerId, ...ids).all();
	const liked = new Set();
	const starred = new Set();
	for (const row of results || []) {
		if (row.kind === 'like') liked.add(Number(row.post_id));
		if (row.kind === 'star') starred.add(Number(row.post_id));
	}
	return posts.map((row) => ({
		...row,
		liked_by_me: liked.has(Number(row.id)),
		starred_by_me: starred.has(Number(row.id)),
	}));
}

async function adjustUserKeywordAffinitiesForTags(db, userId, tags, delta) {
	const normalizedDelta = Number(delta);
	const normalizedTags = normalizePostTags(tags);
	if (!Number.isFinite(normalizedDelta) || normalizedDelta === 0 || normalizedTags.length === 0) return;
	const now = new Date().toISOString();
	const statements = normalizedTags.map((keyword) => db.prepare(
		`INSERT INTO user_keyword_affinities (user_id, keyword, score, updated_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(user_id, keyword) DO UPDATE SET
		 score = MAX(0, user_keyword_affinities.score + excluded.score),
		 updated_at = excluded.updated_at`,
	).bind(Number(userId), keyword, normalizedDelta, now));
	if (statements.length > 0) await db.batch(statements);
	await db.prepare('DELETE FROM user_keyword_affinities WHERE user_id = ? AND score <= 0')
		.bind(Number(userId)).run();
}

async function adjustUserKeywordAffinities(db, userId, postId, delta) {
	const post = await db.prepare('SELECT tags FROM posts WHERE id = ?').bind(Number(postId)).first();
	await adjustUserKeywordAffinitiesForTags(db, userId, post?.tags, delta);
}

function normalizeGroupDmRow(row, viewerId = null) {
	if (!row) return null;
	const member = parseJsonSafe(row.member, []);
	const unread = parseJsonSafe(row.unread, {});
	const post = parseJsonSafe(row.post, []);
	const res = {
		id: row.id,
		state_version: String(row.state_version),
		host_id: row.host_id,
		title: row.title || '',
		member: Array.isArray(member) ? member.map(Number) : [],
		unread,
		post: Array.isArray(post) ? post : [],
		time: row.time,
		created_at: row.created_at,
	};
	if (viewerId != null) {
		res.unread_count = Number(unread[viewerId] ?? unread[String(viewerId)] ?? 0);
	}
	return res;
}

function normalizeModerationReportRow(row) {
	if (!row) return null;
	return {
		id: Number(row.id),
		reporterUserId: Number(row.reporter_user_id),
		targetKind: row.target_kind,
		targetId: String(row.target_id),
		description: row.description || '',
		targetSnapshot: parseJsonSafe(row.target_snapshot, {}),
		assignmentType: row.assignment_type || 'report',
		status: row.status,
		assignedAdminId: row.assigned_admin_id == null ? null : Number(row.assigned_admin_id),
		assignedAt: row.assigned_at || null,
		excludedAdminIds: Array.isArray(parseJsonSafe(row.excluded_admin_ids, []))
			? parseJsonSafe(row.excluded_admin_ids, []).map(Number).filter(Number.isInteger)
			: [],
		resolution: row.resolution ? parseJsonSafe(row.resolution, null) : null,
		createdAt: row.created_at,
		resolvedAt: row.resolved_at || null,
		claimedAt: row.claimed_at || null,
	};
}

export default {
	async fetch(request, env, ctx) {
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: {
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
					'Access-Control-Allow-Headers': 'Content-Type, Authorization',
				},
			});
		}

		if (!(await requireAuth(request, env))) {
			return unauthorized('Authentication required');
		}

		const db = env.DB;
		if (!db) {
			return internalError(new Error('D1 binding DB is not configured'));
		}

		const url = new URL(request.url);
		const pathname = url.pathname;
		const method = request.method;

					try {
				if (method === 'POST' && pathname === '/mod-logs') {
					let row; try { row = modLogs.normalizeRecord(await request.json(), crypto.randomUUID()); } catch (_) { return badRequest('Invalid mod log'); }
					const inserted = await db.prepare('INSERT INTO mod_logs (id, created_at, actor_type, actor_id, action, target_type, target_id, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING RETURNING id').bind(row.id, row.createdAt, row.actorType, row.actorId, row.action, row.targetType, row.targetId, row.result).first();
					if (!inserted) {
						const existing = await db.prepare('SELECT * FROM mod_logs WHERE id = ?').bind(row.id).first();
						if (!existing || !modLogs.sameRecord(modLogs.mapRow(existing), row)) throw new Error('Mod log ID conflict');
					}
					return json(row);
				}
				if (method === 'POST' && pathname === '/mod-logs/search') {
					let q; try { q = modLogs.query(await request.json(), 'sqlite'); } catch (_) { return badRequest('Invalid filters'); }
					const rows = await db.prepare(q.sql).bind(...q.args).all();
					return json(modLogs.page(rows.results.map(modLogs.mapRow), q.limit));
				}
				if (method === 'GET' && pathname === '/migration/snapshot') {
					return json(await exportMigrationSnapshot(db));
				}
				if (method === 'GET' && pathname === '/migration/dm-send-requests-v1') {
					await db.prepare('SELECT dm_id, sender_id, request_id, request_hash, response_message FROM group_dm_send_requests LIMIT 0').all();
					return json({ supported: true });
				}

				if (method === 'POST' && pathname === '/migration/snapshot/import') {
					const body = await request.json();
					if (body?.replace !== true) return badRequest('replace must be true');
					return json(await importMigrationSnapshot(db, body.snapshot));
				}

				if (method === 'POST' && pathname === '/sessions') {

				const body = await request.json();
				const userId = Number(body.userId);
				const token = body.token || crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
				const sessionId = body.sessionId || crypto.randomUUID();
				const expiresAt = body.expiresAt || new Date(Date.now() + 30 * 86400000).toISOString();
				const ipHash = body.ipHash || null;
				const ipMasked = body.ipMasked || '不明なIPアドレス';
				const userAgent = body.userAgent || '不明な端末';
				const createdAt = new Date().toISOString();

				await db.prepare(
					`INSERT INTO sessions (session_id, token, user_id, ip_hash, ip_masked, user_agent, expires_at, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
				).bind(sessionId, token, userId, ipHash, ipMasked, userAgent, expiresAt, createdAt).run();

				return json({
					session_id: sessionId,
					token,
					user_id: userId,
					ip_hash: ipHash,
					ip_masked: ipMasked,
					user_agent: userAgent,
					expires_at: expiresAt,
					created_at: createdAt,
				});
			}

			if (method === 'GET' && pathname.startsWith('/sessions/token/')) {
				const token = decodeURIComponent(pathname.slice('/sessions/token/'.length));
				const now = new Date().toISOString();
				const row = await db.prepare(
					`SELECT * FROM sessions WHERE token = ? AND expires_at > ? LIMIT 1`
				).bind(token, now).first();

				if (!row) {
					// Clean up expired sessions asynchronously
					ctx?.waitUntil?.(db.prepare('DELETE FROM sessions WHERE token = ? AND expires_at <= ?').bind(token, now).run());
					return json(null);
				}
				return json(row);
			}

			if (method === 'GET' && pathname.startsWith('/sessions/token-user/')) {
				const token = decodeURIComponent(pathname.slice('/sessions/token-user/'.length));
				const now = new Date().toISOString();
				const row = await db.prepare(
					`SELECT s.session_id, s.token, s.user_id, s.ip_hash, s.ip_masked,
							s.user_agent, s.expires_at, s.created_at,
							u.*
					 FROM sessions s INNER JOIN users u ON u.id = s.user_id
					 WHERE s.token = ? AND s.expires_at > ? LIMIT 1`
				).bind(token, now).first();
				if (!row) {
					ctx?.waitUntil?.(db.prepare('DELETE FROM sessions WHERE token = ? AND expires_at <= ?').bind(token, now).run());
					return json(null);
				}
				return json({
					session: {
						session_id: row.session_id,
						token: row.token,
						user_id: row.user_id,
						expires_at: row.expires_at,
						created_at: row.created_at,
						ip_hash: row.ip_hash,
						ip_masked: row.ip_masked,
						user_agent: row.user_agent,
					},
					user: normalizeUserRow(row),
				});
			}

			if (method === 'POST' && pathname === '/sessions/users-by-tokens') {
				const body = await request.json().catch(() => ({}));
				const tokens = Array.isArray(body?.tokens) ? body.tokens.map(String).filter(Boolean) : [];
				if (tokens.length === 0) return json([]);
				const placeholders = tokens.map(() => '?').join(',');
				const now = new Date().toISOString();
				const { results } = await db.prepare(
					`SELECT s.session_id, s.token, s.user_id, s.ip_hash, s.ip_masked,
							s.user_agent, s.expires_at, s.created_at,
							u.*
					 FROM sessions s INNER JOIN users u ON u.id = s.user_id
					 WHERE s.token IN (${placeholders}) AND s.expires_at > ?`
				).bind(...tokens, now).all();
				return json((results || []).map((row) => ({
					session: {
						id: row.session_id,
						token: row.token,
						userId: row.user_id,
						expiresAt: row.expires_at,
						createdAt: row.created_at,
						ipHash: row.ip_hash,
						ipMasked: row.ip_masked,
						userAgent: row.user_agent,
					},
					user: normalizeUserRow(row),
				})));
			}

			if (method === 'POST' && pathname === '/sessions/invalidate') {
				const body = await request.json();
				const token = String(body.token || '');
				const res = await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
				return json({ success: res.meta.changes > 0 });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/sessions$/)) {
				const userId = Number(pathname.split('/')[2]);
				const now = new Date().toISOString();
				const { results } = await db.prepare(
					`SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC`
				).bind(userId, now).all();
				return json(results || []);
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/sessions\/invalidate-all$/)) {
				const userId = Number(pathname.split('/')[2]);
				const res = await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
				return json({ count: res.meta.changes });
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/sessions\/invalidate-ip$/)) {
				const userId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const ipHash = String(body.ipHash || '');
				const res = await db.prepare('DELETE FROM sessions WHERE user_id = ? AND ip_hash = ?').bind(userId, ipHash).run();
				return json({ count: res.meta.changes });
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/trusted-ips$/)) {
				const userId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const ipHash = String(body.ipHash);
				const ipMasked = String(body.ipMasked || '不明なIPアドレス');
				const now = new Date().toISOString();

				await db.prepare(
					`INSERT INTO trusted_login_ips (user_id, ip_hash, ip_masked, created_at, last_used_at)
					 VALUES (?, ?, ?, ?, ?)
					 ON CONFLICT(user_id, ip_hash) DO UPDATE SET ip_masked = excluded.ip_masked, last_used_at = excluded.last_used_at`
				).bind(userId, ipHash, ipMasked, now, now).run();

				return json({ userId, ipHash, ipMasked, createdAt: now, lastUsedAt: now });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/trusted-ips\/count$/)) {
				const userId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT COUNT(*) as count FROM trusted_login_ips WHERE user_id = ?').bind(userId).first();
				return json({ count: Number(row?.count || 0) });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/trusted-ips\/([^/]+)$/)) {
				const parts = pathname.split('/');
				const userId = Number(parts[2]);
				const ipHash = decodeURIComponent(parts[4]);
				const row = await db.prepare('SELECT * FROM trusted_login_ips WHERE user_id = ? AND ip_hash = ?').bind(userId, ipHash).first();
				if (!row) return json(null);
				return json({ userId: row.user_id, ipHash: row.ip_hash, ipMasked: row.ip_masked, createdAt: row.created_at, lastUsedAt: row.last_used_at });
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/trusted-ips\/([^/]+)\/revoke$/)) {
				const parts = pathname.split('/');
				const userId = Number(parts[2]);
				const ipHash = decodeURIComponent(parts[4]);
				const res = await db.prepare('DELETE FROM trusted_login_ips WHERE user_id = ? AND ip_hash = ?').bind(userId, ipHash).run();
				return json({ success: res.meta.changes > 0 });
			}

			if (method === 'POST' && pathname === '/login-approvals') {
				const body = await request.json();
				const id = body.id || crypto.randomUUID();
				const userId = Number(body.userId);
				const ipHash = body.ipHash || null;
				const ipMasked = body.ipMasked || '不明なIPアドレス';
				const userAgent = body.userAgent || '不明な端末';
				const pollTokenHash = String(body.pollTokenHash);
				const authProvider = body.authProvider ? String(body.authProvider).toLowerCase() : null;
				const expiresAt = body.expiresAt || new Date(Date.now() + 10 * 60000).toISOString();
				const createdAt = new Date().toISOString();

				await db.prepare(
					`INSERT INTO login_approvals (id, user_id, ip_hash, ip_masked, user_agent, auth_provider, poll_token_hash, status, expires_at, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
				).bind(id, userId, ipHash, ipMasked, userAgent, authProvider, pollTokenHash, expiresAt, createdAt).run();

				return json({ id, userId, ipHash, ipMasked, userAgent, authProvider, pollTokenHash, status: 'pending', expiresAt, createdAt });
			}

			if (method === 'GET' && pathname.match(/^\/login-approvals\/([^/]+)$/)) {
				const id = decodeURIComponent(pathname.split('/')[2]);
				const now = new Date().toISOString();
				await db.prepare("UPDATE login_approvals SET status = 'expired' WHERE id = ? AND status = 'pending' AND expires_at <= ?").bind(id, now).run();
				const row = await db.prepare('SELECT * FROM login_approvals WHERE id = ?').bind(id).first();
				return json(row || null);
			}

			if (method === 'POST' && pathname.match(/^\/login-approvals\/([^/]+)\/poll$/)) {
				const id = decodeURIComponent(pathname.split('/')[2]);
				const body = await request.json();
				const now = new Date().toISOString();
				await db.prepare("UPDATE login_approvals SET status = 'expired' WHERE id = ? AND status = 'pending' AND expires_at <= ?").bind(id, now).run();
				const row = await db.prepare('SELECT * FROM login_approvals WHERE id = ? AND poll_token_hash = ?').bind(id, String(body.pollTokenHash)).first();
				return json(row || null);
			}

			if (method === 'POST' && pathname.match(/^\/login-approvals\/([^/]+)\/decision$/)) {
				const id = decodeURIComponent(pathname.split('/')[2]);
				const body = await request.json();
				const userId = Number(body.userId);
				const decision = body.decision === 'approve' ? 'approved' : 'denied';
				const now = new Date().toISOString();

				const res = await db.prepare(
					`UPDATE login_approvals SET status = ?, decided_at = ?
					 WHERE id = ? AND user_id = ? AND status = 'pending' AND expires_at > ?`
				).bind(decision, now, id, userId, now).run();

				if (res.meta.changes > 0) {
					const row = await db.prepare('SELECT * FROM login_approvals WHERE id = ?').bind(id).first();
					return json(row);
				}
				const existing = await db.prepare('SELECT * FROM login_approvals WHERE id = ?').bind(id).first();
				return json(existing && Number(existing.user_id) === userId ? existing : null);
			}

			if (method === 'POST' && pathname.match(/^\/login-approvals\/([^/]+)\/consume$/)) {
				const id = decodeURIComponent(pathname.split('/')[2]);
				const body = await request.json();
				const now = new Date().toISOString();

				const res = await db.prepare(
					`UPDATE login_approvals SET status = 'consumed', consumed_at = ?
					 WHERE id = ? AND poll_token_hash = ? AND status = 'approved' AND expires_at > ?`
				).bind(now, id, String(body.pollTokenHash), now).run();
				// changes=0 は「既に消費済み」「トークン不一致」「承認後に期限切れ」。
				// 行を返すと同じ poll token で2つ目のセッションが発行される（Postgres は RETURNING で null）。
				if (res.meta.changes === 0) return json(null);

				const row = await db.prepare('SELECT * FROM login_approvals WHERE id = ?').bind(id).first();
				return json(row || null);
			}

			if (method === 'POST' && pathname === '/account-recovery') {
				const body = await request.json();
				const id = body.id || crypto.randomUUID();
				const userId = Number(body.userId);
				const ipHash = String(body.ipHash);
				const ipMasked = body.ipMasked || '不明なIPアドレス';
				const userAgent = body.userAgent || '不明な端末';
				const authProvider = String(body.authProvider || '').toLowerCase();
				const requestTokenHash = String(body.requestTokenHash);
				const trustScore = Number(body.trustScore || 0);
				const waitUntil = body.waitUntil;
				const now = new Date().toISOString();

				try {
					await db.prepare(
						`INSERT INTO account_recovery_requests
						 (id, user_id, ip_hash, ip_masked, user_agent, auth_provider, request_token_hash, status, trust_score, wait_until, started_at, last_notified_at, notified_count)
						 VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?, 1)`
					).bind(id, userId, ipHash, ipMasked, userAgent, authProvider, requestTokenHash, trustScore, waitUntil, now, now).run();
				} catch (error) {
					if (/unique|constraint/i.test(String(error?.message || ''))) {
						return json({ error: 'account_recovery_in_progress' }, 409);
					}
					throw error;
				}

				const row = await db.prepare('SELECT * FROM account_recovery_requests WHERE id = ?').bind(id).first();
				return json(row || null);
			}

			if (method === 'GET' && pathname === '/account-recovery/waiting') {
				// 復旧を完了できる token/ip_hash は一覧の呼び出し側が読まない列なので返さない。
				// 述語と並び順は PG と同じく SQL 側で選ぶ。絞り込みを外へ出すと、LIMIT で
				// 切り落とされた行に期限到来の依頼が埋もれて自動承認が進まない。
				const mode = url.searchParams.get('mode');
				const cutoffTime = new Date(url.searchParams.get('cutoff') || '').getTime();
				if (!Number.isFinite(cutoffTime)) return badRequest('Invalid account recovery cutoff');

				let sql = '';
				if (mode === 'due') {
					sql = `SELECT id, user_id, status, wait_until, started_at, last_notified_at, notified_count
						 FROM account_recovery_requests
						 WHERE status = 'waiting' AND wait_until <= ?
						 ORDER BY wait_until ASC
						 LIMIT 50`;
				} else if (mode === 'notify') {
					sql = `SELECT id, user_id, status, wait_until, started_at, last_notified_at, notified_count
						 FROM account_recovery_requests
						 WHERE status = 'waiting' AND (last_notified_at IS NULL OR last_notified_at <= ?)
						 ORDER BY started_at ASC
						 LIMIT 50`;
				} else {
					return badRequest('Invalid account recovery mode');
				}

				const { results } = await db.prepare(sql).bind(new Date(cutoffTime).toISOString()).all();
				return json(results || []);
			}

			if (method === 'POST' && pathname === '/account-recovery/active') {
				const body = await request.json();
				const userId = Number(body.userId);
				const ipHash = String(body.ipHash);
				const row = await db.prepare(
					"SELECT * FROM account_recovery_requests WHERE user_id = ? AND ip_hash = ? AND status = 'waiting' ORDER BY started_at DESC LIMIT 1"
				).bind(userId, ipHash).first();
				return json(row || null);
			}

			if (method === 'GET' && pathname === '/account-recovery/open') {
				const userId = Number(url.searchParams.get('userId'));
				if (!Number.isSafeInteger(userId) || userId <= 0) return badRequest('Invalid user id');
				const row = await db.prepare(
					"SELECT * FROM account_recovery_requests WHERE user_id = ? AND status IN ('waiting', 'approved') ORDER BY started_at DESC LIMIT 1"
				).bind(userId).first();
				return json(row || null);
			}

			if (method === 'POST' && pathname.match(/^\/account-recovery\/([^/]+)\/token-check$/)) {
				const id = decodeURIComponent(pathname.split('/')[2]);
				const body = await request.json();
				const row = await db.prepare('SELECT * FROM account_recovery_requests WHERE id = ? AND request_token_hash = ?').bind(id, String(body.requestTokenHash)).first();
				return json(row || null);
			}

			if (method === 'POST' && pathname.match(/^\/account-recovery\/([^/]+)\/token$/)) {
				const id = decodeURIComponent(pathname.split('/')[2]);
				const body = await request.json();
				const res = await db.prepare("UPDATE account_recovery_requests SET request_token_hash = ? WHERE id = ? AND status = 'waiting'").bind(String(body.requestTokenHash), id).run();
				// Postgres の RETURNING と同じ契約にする。適用できなかった場合は行を返さない。
				if (res.meta.changes === 0) return json(null);
				const row = await db.prepare('SELECT * FROM account_recovery_requests WHERE id = ?').bind(id).first();
				return json(row || null);
			}

			if (method === 'POST' && pathname.match(/^\/account-recovery\/([^/]+)\/notified$/)) {
				const id = decodeURIComponent(pathname.split('/')[2]);
				const body = await request.json();
				const notifiedAt = body.notifiedAt || new Date().toISOString();
				await db.prepare('UPDATE account_recovery_requests SET last_notified_at = ?, notified_count = notified_count + 1 WHERE id = ?').bind(notifiedAt, id).run();
				return json({ success: true });
			}

			if (method === 'POST' && pathname.match(/^\/account-recovery\/([^/]+)\/decision$/)) {
				const id = decodeURIComponent(pathname.split('/')[2]);
				const body = await request.json();
				if (body.decision !== 'approve' && body.decision !== 'block') {
					return badRequest('Invalid recovery decision');
				}
				const userId = Number(body.userId);
				const status = body.decision === 'approve' ? 'approved' : 'blocked';
				const now = new Date().toISOString();
				const res = await db.prepare(
					"UPDATE account_recovery_requests SET status = ?, decided_at = ?, decided_by = 'user' WHERE id = ? AND user_id = ? AND (status = 'waiting' OR (status = 'approved' AND ? = 'blocked'))"
				).bind(status, now, id, userId, status).run();
				const row = await db.prepare('SELECT * FROM account_recovery_requests WHERE id = ?').bind(id).first();
				if (res.meta.changes > 0) return json(row);
				return json(row && Number(row.user_id) === userId ? row : null);
			}

			if (method === 'POST' && pathname.match(/^\/account-recovery\/([^/]+)\/expire$/)) {
				const id = decodeURIComponent(pathname.split('/')[2]);
				await db.prepare(
					"UPDATE account_recovery_requests SET status = 'expired', decided_at = COALESCE(decided_at, datetime('now')) WHERE id = ? AND status = 'approved'"
				).bind(id).run();
				const row = await db.prepare('SELECT * FROM account_recovery_requests WHERE id = ?').bind(id).first();
				return json(row || null);
			}

			if (method === 'POST' && pathname.match(/^\/account-recovery\/([^/]+)\/approve-due$/)) {
				const id = decodeURIComponent(pathname.split('/')[2]);
				const body = await request.json();
				const now = new Date().toISOString();
				const res = await db.prepare(
					"UPDATE account_recovery_requests SET status = 'approved', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'waiting' AND wait_until <= ?"
				).bind(now, String(body.decidedBy || 'timeout'), id, now).run();
				// 待機中/期限未到達の行を「承認済み」として返すと、呼び出し側が誤って承認扱いする。
				if (res.meta.changes === 0) return json(null);
				const row = await db.prepare('SELECT * FROM account_recovery_requests WHERE id = ?').bind(id).first();
				return json(row || null);
			}

			if (method === 'POST' && pathname.match(/^\/account-recovery\/([^/]+)\/consume$/)) {
				const id = decodeURIComponent(pathname.split('/')[2]);
				const body = await request.json();
				const now = new Date().toISOString();
				const res = await db.prepare(
					"UPDATE account_recovery_requests SET status = 'consumed', consumed_at = ? WHERE id = ? AND request_token_hash = ? AND status = 'approved'"
				).bind(now, id, String(body.requestTokenHash)).run();
				// changes=0 は「すでに消費済み」または「トークン不一致」。行を返すと同一トークンで
				// 並列 poll した側も成功してしまい、単一使用が破れる（Postgres は RETURNING で null）。
				if (res.meta.changes === 0) return json(null);
				const row = await db.prepare('SELECT * FROM account_recovery_requests WHERE id = ?').bind(id).first();
				return json(row || null);
			}

			if (method === 'GET' && pathname.match(/^\/account-recovery\/([^/]+)$/)) {
				const id = decodeURIComponent(pathname.split('/')[2]);
				const row = await db.prepare('SELECT * FROM account_recovery_requests WHERE id = ?').bind(id).first();
				return json(row || null);
			}

			if (method === 'POST' && pathname === '/blocked-login-ips') {
				const body = await request.json();
				const userId = Number(body.userId);
				const ipHash = String(body.ipHash);
				const ipMasked = body.ipMasked || '不明なIPアドレス';
				const reason = body.reason ?? null;
				const sourceRecoveryId = body.sourceRecoveryId ?? null;
				const now = new Date().toISOString();

				await db.prepare(
					`INSERT INTO blocked_login_ips (user_id, ip_hash, ip_masked, reason, source_recovery_id, created_at)
					 VALUES (?, ?, ?, ?, ?, ?)
					 ON CONFLICT(user_id, ip_hash) DO UPDATE SET ip_masked = excluded.ip_masked, reason = excluded.reason, source_recovery_id = excluded.source_recovery_id`
				).bind(userId, ipHash, ipMasked, reason, sourceRecoveryId, now).run();

				return json({ userId, ipHash, ipMasked, reason, sourceRecoveryId, createdAt: now });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/blocked-login-ips\/([^/]+)$/)) {
				const parts = pathname.split('/');
				const userId = Number(parts[2]);
				const ipHash = decodeURIComponent(parts[4]);
				const row = await db.prepare('SELECT * FROM blocked_login_ips WHERE user_id = ? AND ip_hash = ?').bind(userId, ipHash).first();
				if (!row) return json(null);
				return json({
					userId: Number(row.user_id),
					ipHash: row.ip_hash,
					ipMasked: row.ip_masked,
					reason: row.reason,
					sourceRecoveryId: row.source_recovery_id,
					createdAt: row.created_at,
				});
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/blocked-login-ips$/)) {
				const userId = Number(pathname.split('/')[2]);
				const { results } = await db.prepare('SELECT * FROM blocked_login_ips WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all();
				return json((results || []).map((row) => ({
					userId: Number(row.user_id),
					ipHash: row.ip_hash,
					ipMasked: row.ip_masked,
					reason: row.reason,
					sourceRecoveryId: row.source_recovery_id,
					createdAt: row.created_at,
				})));
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/blocked-login-ips\/([^/]+)\/unblock$/)) {
				const parts = pathname.split('/');
				const userId = Number(parts[2]);
				const ipHash = decodeURIComponent(parts[4]);
				const res = await db.prepare('DELETE FROM blocked_login_ips WHERE user_id = ? AND ip_hash = ?').bind(userId, ipHash).run();
				return json({ success: res.meta.changes > 0 });
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/bot-tokens$/)) {
				const userId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const tokenId = String(body.tokenId);
				const tokenHash = String(body.tokenHash);
				const name = String(body.name || '');
				const createdAt = new Date().toISOString();

				await db.prepare(
					`INSERT INTO bot_tokens (token_id, token_hash, user_id, name, created_at)
					 VALUES (?, ?, ?, ?, ?)`
				).bind(tokenId, tokenHash, userId, name, createdAt).run();

				return json({ tokenId, tokenHash, userId, name, createdAt, lastUsedAt: null });
			}

			if (method === 'GET' && pathname.startsWith('/bot-tokens/')) {
				const tokenId = decodeURIComponent(pathname.slice('/bot-tokens/'.length));
				const row = await db.prepare('SELECT * FROM bot_tokens WHERE token_id = ?').bind(tokenId).first();
				return json(row ? { tokenId: row.token_id, tokenHash: row.token_hash, userId: row.user_id, name: row.name, createdAt: row.created_at, lastUsedAt: row.last_used_at } : null);
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/bot-tokens$/)) {
				const userId = Number(pathname.split('/')[2]);
				const { results } = await db.prepare('SELECT * FROM bot_tokens WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all();
				return json((results || []).map((r) => ({ tokenId: r.token_id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at })));
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/bot-tokens\/([^/]+)\/revoke$/)) {
				const parts = pathname.split('/');
				const userId = Number(parts[2]);
				const tokenId = decodeURIComponent(parts[4]);
				const res = await db.prepare('DELETE FROM bot_tokens WHERE user_id = ? AND token_id = ?').bind(userId, tokenId).run();
				return json({ success: res.meta.changes > 0 });
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/authorized-apps$/)) {
				const userId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const now = new Date().toISOString();
				const scopes = JSON.stringify(Array.isArray(body.scopes) ? body.scopes : []);
				await db.prepare(
					`INSERT INTO authorized_apps (user_id, app_id, app_token_hash, app_name, app_icon_url, scopes, access_token_id, access_token_hash, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(user_id, app_id, app_token_hash) DO UPDATE SET
					   app_name = excluded.app_name,
					   app_icon_url = excluded.app_icon_url,
					   scopes = excluded.scopes,
					   access_token_id = COALESCE(excluded.access_token_id, authorized_apps.access_token_id),
					   access_token_hash = COALESCE(excluded.access_token_hash, authorized_apps.access_token_hash),
					   updated_at = excluded.updated_at`
				).bind(userId, String(body.appId), String(body.appTokenHash), String(body.appName || ''), body.appIconUrl || null, scopes, body.accessTokenId || null, body.accessTokenHash || null, now, now).run();
				const row = await db.prepare('SELECT * FROM authorized_apps WHERE user_id = ? AND app_id = ? AND app_token_hash = ?')
					.bind(userId, String(body.appId), String(body.appTokenHash)).first();
				return json(row ? { ...row, scopes: parseJsonSafe(row.scopes, []) } : null);
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/authorized-apps\/lookup$/)) {
				const userId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT * FROM authorized_apps WHERE user_id = ? AND app_id = ? AND app_token_hash = ?')
					.bind(userId, url.searchParams.get('appId') || '', url.searchParams.get('appTokenHash') || '').first();
				return json(row ? { ...row, scopes: parseJsonSafe(row.scopes, []) } : null);
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/authorized-apps$/)) {
				const userId = Number(pathname.split('/')[2]);
				const { results } = await db.prepare('SELECT * FROM authorized_apps WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all();
				return json((results || []).map((row) => ({ ...row, scopes: parseJsonSafe(row.scopes, []) })));
			}

			if (method === 'GET' && pathname.match(/^\/authorized-apps\/by-token\/([^/]+)$/)) {
				const accessTokenId = decodeURIComponent(pathname.split('/')[3]);
				const row = await db.prepare('SELECT * FROM authorized_apps WHERE access_token_id = ?').bind(accessTokenId).first();
				return json(row ? { ...row, scopes: parseJsonSafe(row.scopes, []) } : null);
			}

			if (method === 'GET' && pathname.match(/^\/authorized-apps\/(\d+)$/)) {
				const id = Number(pathname.split('/')[2]);
				const userId = url.searchParams.has('userId') ? Number(url.searchParams.get('userId')) : null;
				const row = userId === null
					? await db.prepare('SELECT * FROM authorized_apps WHERE id = ?').bind(id).first()
					: await db.prepare('SELECT * FROM authorized_apps WHERE id = ? AND user_id = ?').bind(id, userId).first();
				return json(row ? { ...row, scopes: parseJsonSafe(row.scopes, []) } : null);
			}

			if (method === 'POST' && pathname.match(/^\/authorized-apps\/(\d+)\/scopes$/)) {
				const id = Number(pathname.split('/')[2]);
				const body = await request.json();
				const now = new Date().toISOString();
				const scopes = JSON.stringify(Array.isArray(body.scopes) ? body.scopes : []);
				if (body.userId !== undefined) {
					await db.prepare('UPDATE authorized_apps SET scopes = ?, access_token_id = ?, access_token_hash = ?, updated_at = ? WHERE id = ? AND user_id = ?')
						.bind(scopes, body.accessTokenId || null, body.accessTokenHash || null, now, id, Number(body.userId)).run();
				} else {
					await db.prepare('UPDATE authorized_apps SET scopes = ?, access_token_id = ?, access_token_hash = ?, updated_at = ? WHERE id = ?')
						.bind(scopes, body.accessTokenId || null, body.accessTokenHash || null, now, id).run();
				}
				const row = await db.prepare('SELECT * FROM authorized_apps WHERE id = ?').bind(id).first();
				return json(row ? { ...row, scopes: parseJsonSafe(row.scopes, []) } : null);
			}

			if (method === 'POST' && pathname.match(/^\/authorized-apps\/(\d+)\/last-used$/)) {
				const id = Number(pathname.split('/')[2]);
				await db.prepare('UPDATE authorized_apps SET last_used_at = ? WHERE id = ?').bind(new Date().toISOString(), id).run();
				return json({ success: true });
			}

			if (method === 'POST' && pathname.match(/^\/authorized-apps\/(\d+)\/delete$/)) {
				const id = Number(pathname.split('/')[2]);
				const userId = url.searchParams.has('userId') ? Number(url.searchParams.get('userId')) : null;
				const res = userId === null
					? await db.prepare('DELETE FROM authorized_apps WHERE id = ?').bind(id).run()
					: await db.prepare('DELETE FROM authorized_apps WHERE id = ? AND user_id = ?').bind(id, userId).run();
				return json({ success: res.meta.changes > 0 });
			}

			if (method === 'POST' && pathname.match(/^\/bot-tokens\/([^/]+)\/last-used$/)) {
				const tokenId = decodeURIComponent(pathname.split('/')[2]);
				const now = new Date().toISOString();
				await db.prepare('UPDATE bot_tokens SET last_used_at = ? WHERE token_id = ?').bind(now, tokenId).run();
				return json({ success: true });
			}

			if (method === 'GET' && pathname.startsWith('/users/scid/')) {
				const scid = decodeURIComponent(pathname.slice('/users/scid/'.length));
				const row = await db.prepare('SELECT * FROM users WHERE LOWER(scid) = LOWER(?) LIMIT 1').bind(scid).first();
				return json(normalizeUserRow(row));
			}

			if (method === 'GET' && pathname.startsWith('/users/address/')) {
				const address = decodeURIComponent(pathname.slice('/users/address/'.length));
				const row = await db.prepare('SELECT * FROM users WHERE nyaitter_address = ? LIMIT 1').bind(address).first();
				return json(normalizeUserRow(row));
			}

			if (method === 'GET' && pathname.match(/^\/users\/external\/([^/]+)\/([^/]+)$/)) {
				const authProvider = decodeURIComponent(pathname.split('/')[3]);
				const externalId = decodeURIComponent(pathname.split('/')[4]);
				if (!authProvider || !externalId) return json(null);
				const row = await db.prepare('SELECT * FROM users WHERE LOWER(auth_provider) = LOWER(?) AND external_id = ? LIMIT 1')
					.bind(authProvider, externalId).first();
				return json(normalizeUserRow(row));
			}

			if (method === 'GET' && pathname.match(/^\/users\/auth-provider\/([^/]+)\/([^/]+)$/)) {
				const provider = decodeURIComponent(pathname.split('/')[3]).toLowerCase();
				const providerUserId = decodeURIComponent(pathname.split('/')[4]).trim();
				if (!provider || !providerUserId) return json(null);

				// Postgres実装と同じ優先順: 紐づけテーブル → scid → usersのprimary列。
				let row = await db.prepare(
					`SELECT u.* FROM users u
					 JOIN user_auth_providers p ON p.user_id = u.id
					 WHERE LOWER(p.provider) = LOWER(?) AND LOWER(p.provider_user_id) = LOWER(?)
					 LIMIT 1`
				).bind(provider, providerUserId).first();
				if (!row && (provider === 'scratch' || provider === 'local')) {
					row = await db.prepare('SELECT * FROM users WHERE LOWER(scid) = LOWER(?) LIMIT 1').bind(providerUserId).first();
				}
				if (!row) {
					row = await db.prepare('SELECT * FROM users WHERE LOWER(auth_provider) = LOWER(?) AND external_id = ? LIMIT 1')
						.bind(provider, providerUserId).first();
				}
				return json(normalizeUserRow(row));
			}

			if (method === 'POST' && pathname === '/users/external') {
				const body = await request.json();
				const providerDomain = body.providerDomain;
				const externalId = String(body.externalId);
				const profile = body.profile || {};
				const address = `#${externalId}@${providerDomain}`;

				let row = await db.prepare('SELECT * FROM users WHERE nyaitter_address = ? LIMIT 1').bind(address).first();
				if (row) return json(normalizeUserRow(row));

				const handle = formatNyaitterId(externalId);
				const countRow = await db.prepare('SELECT COUNT(*) as count FROM users').first();
				const count = Number(countRow?.count || 0);
				const digits = Math.max(4, String(Math.max(count, 1)).length);
				let id = null;
				for (let attempt = 0; attempt < 20 && id === null; attempt += 1) {
					const candidate = Math.floor(Math.random() * (10 ** digits));
					const collision = await db.prepare('SELECT 1 FROM users WHERE id = ? LIMIT 1').bind(candidate).first();
					if (collision) continue;
					const retired = await db.prepare('SELECT 1 FROM retired_user_ids WHERE id = ? LIMIT 1').bind(candidate).first();
					if (!retired) id = candidate;
				}
				if (id === null) return badRequest('Could not allocate unique Nyaitter ID');
				const now = new Date().toISOString();

				await db.prepare(
						`INSERT INTO users (id, scid, name, handle, nyaitter_address, auth_provider, provider_domain, external_id, external_profile, block, bio, header_image, icon_data, created_at)
								 VALUES (?, ?, ?, ?, ?, 'nyaitter', ?, ?, ?, ?, ?, ?, ?, ?)`

					).bind(
						id, profile.scid || null, profile.name || handle, handle, address, providerDomain, externalId,
						JSON.stringify(profile.external_profile || profile),
						JSON.stringify(normalizeBlockList(profile.block, id)),
						profile.bio || profile.me || '', profile.header_image || null,
						profile.icon_data || null, now
					).run();

				const created = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
				return json(normalizeUserRow(created));
			}

			if (method === 'POST' && pathname === '/users') {
				const userData = await request.json();
				const provider = userData.auth_provider || 'local';

				for (let attempt = 0; attempt < 20; attempt += 1) {
					const countRow = await db.prepare('SELECT COUNT(*) as count FROM users').first();
					const count = Number(countRow?.count || 0);
					const digits = Math.max(4, String(Math.max(count, 1)).length);
						const id = Math.floor(Math.random() * (10 ** digits));
						const retired = await db.prepare('SELECT 1 FROM retired_user_ids WHERE id = ? LIMIT 1').bind(id).first();
						if (retired) continue;
						const handle = provider === 'nyaitter' && userData.external_id != null
							? formatNyaitterId(userData.external_id)
							: formatNyaitterId(id);

					const address = userData.nyaitter_address || null;
					const now = new Date().toISOString();

					try {
						await db.prepare(
								`INSERT INTO users (id, scid, name, handle, nyaitter_address, auth_provider, provider_domain, external_id, external_profile, uuid, settings, block, bio, header_image, icon_data, created_at)
									 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

						).bind(
															id, userData.scid || null, userData.name || userData.scid || handle, handle, address,

							provider, userData.provider_domain || null, userData.external_id || null,
							userData.external_profile ? JSON.stringify(userData.external_profile) : null,
							userData.uuid || null, userData.settings ? JSON.stringify(userData.settings) : '{}',
							JSON.stringify(normalizeBlockList(userData.block, id)),
							userData.bio || userData.me || '', userData.header_image || null,
							userData.icon_data || null, now
						).run();

						const created = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
						return json(normalizeUserRow(created));
					} catch (err) {
						if (String(err).includes('UNIQUE') || String(err).includes('PRIMARY KEY')) continue;
						throw err;
					}
				}
				return badRequest('Could not allocate unique Nyaitter ID');
			}

			if (method === 'GET' && pathname === '/users/search') {
				const q = url.searchParams.get('q') || '';
				const limit = Math.min(Number(url.searchParams.get('limit') || 20), 100);
				const decodedCursor = decodePostCursor(url.searchParams.get('cursor'));
				const withNextCursor = url.searchParams.get('withNextCursor') === 'true';
				const queryPattern = `%${q.toLowerCase()}%`;
				const digits = q.replace(/^#/, '').replace(/\D/g, '');
				const fetchLimit = limit + 1;

				let query;
				let bindings;
				if (decodedCursor) {
					query = `SELECT id, name, scid, handle, nyaitter_address, auth_provider, provider_domain, external_id, icon_data, bio, header_image, created_at
						 FROM users
						 WHERE id > ? AND (
						    LOWER(COALESCE(scid, '')) LIKE ?
						    OR LOWER(COALESCE(name, '')) LIKE ?
						    OR LOWER(COALESCE(handle, '')) LIKE ?
						    OR LOWER(COALESCE(bio, '')) LIKE ?
						    OR CAST(id AS TEXT) LIKE ?
						 )
						 ORDER BY id ASC LIMIT ?`;
					bindings = [decodedCursor.id, queryPattern, queryPattern, queryPattern, queryPattern, digits ? `%${digits}%` : queryPattern, fetchLimit];
				} else {
					const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);
					query = `SELECT id, name, scid, handle, nyaitter_address, auth_provider, provider_domain, external_id, icon_data, bio, header_image, created_at
						 FROM users
						 WHERE LOWER(COALESCE(scid, '')) LIKE ?
						    OR LOWER(COALESCE(name, '')) LIKE ?
						    OR LOWER(COALESCE(handle, '')) LIKE ?
						    OR LOWER(COALESCE(bio, '')) LIKE ?
						    OR CAST(id AS TEXT) LIKE ?
						 ORDER BY id ASC LIMIT ? OFFSET ?`;
					bindings = [queryPattern, queryPattern, queryPattern, queryPattern, digits ? `%${digits}%` : queryPattern, fetchLimit, offset];
				}

				const { results } = await db.prepare(query).bind(...bindings).all();
				const rows = results || [];
				const hasMore = rows.length > limit;
				const slice = rows.slice(0, limit);
				const lastRow = slice.length > 0 ? slice[slice.length - 1] : null;
				const nextCursor = hasMore && lastRow
					? encodePostCursor({ id: Number(lastRow.id), created_at: lastRow.created_at || new Date(0).toISOString() })
					: null;
				const users = slice.map(normalizeUserRow);

				if (withNextCursor) {
					return json({
						users,
						has_more: hasMore,
						next_cursor: nextCursor,
					});
				}
				return json(users);
			}

			if (method === 'POST' && pathname === '/users/batch') {
				const body = await request.json();
				const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isSafeInteger) : [];
				if (ids.length === 0) return json([]);

				const placeholders = ids.map(() => '?').join(', ');
				const columns = body.projection === 'post_author'
					? 'id, auth_provider, external_id, name, scid, icon_data, bio, header_image, verify, admin, settings, block, shadow'
					: '*';
				const { results } = await db.prepare(
					`SELECT ${columns} FROM users WHERE id IN (${placeholders})`
				).bind(...ids).all();

				return json((results || []).map(normalizeUserRow));
			}

			if (method === 'GET' && pathname === '/users') {
				const { results } = await db.prepare('SELECT * FROM users ORDER BY id ASC').all();
				return json((results || []).map(normalizeUserRow));
			}

			if (method === 'GET' && pathname === '/users/imposters') {
				const { results } = await db.prepare(`SELECT * FROM users
					WHERE auth_provider = 'imposter'
					   OR (settings IS NOT NULL AND json_valid(settings) = 1 AND json_extract(settings, '$.imposter') IS NOT NULL)
					ORDER BY id ASC`).all();
				return json((results || []).map(normalizeUserRow));
			}

							if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/account-operation\/begin$/)) {
					const userId = Number(pathname.split('/')[2]);
					const body = await request.json();
					const operation = String(body.operation || '');
					if (!['deleting'].includes(operation)) return badRequest('Invalid account operation');
					const result = await db.prepare(
						`UPDATE users SET account_operation = ?
						 WHERE id = ? AND auth_provider <> 'nyaitter' AND account_operation IS NULL`
					).bind(operation, userId).run();
					if (result.meta.changes === 0) return json(null);
					return json(normalizeUserRow(await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first()));
				}

				if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/account-operation\/finish$/)) {
					const userId = Number(pathname.split('/')[2]);
					const body = await request.json();
					const operation = String(body.operation || '');
					const result = await db.prepare('UPDATE users SET account_operation = NULL WHERE id = ? AND account_operation = ?')
						.bind(userId, operation).run();
					if (result.meta.changes === 0) return json(null);
					return json(normalizeUserRow(await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first()));
				}

					if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/account\/attachments$/)) {
						const userId = Number(pathname.split('/')[2]);
						const { results } = await db.prepare('SELECT attachments FROM posts WHERE user_id = ?').bind(userId).all();
						const keys = new Set();
						for (const row of results || []) {
							for (const attachment of parseJsonSafe(row.attachments, [])) {
								const key = attachment?.id || attachment?.key;
								if (typeof key === 'string' && key.startsWith('attachments/')) keys.add(key);
							}
						}
						return json([...keys]);
					}

				if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/account\/delete$/)) {
					const userId = Number(pathname.split('/')[2]);
					const user = await db.prepare("SELECT id FROM users WHERE id = ? AND account_operation = 'deleting'").bind(userId).first();
					if (!user) return json({ success: false });
					const { results: posts } = await db.prepare('SELECT id FROM posts WHERE user_id = ?').bind(userId).all();
					const postIds = (posts || []).map((row) => Number(row.id));
					const { results: channels } = await db.prepare('SELECT * FROM dm_channels WHERE participants LIKE ?').bind(`%${userId}%`).all();
					const { results: groups } = await db.prepare('SELECT * FROM group_dms WHERE host_id = ? OR member LIKE ?').bind(userId, `%${userId}%`).all();
					const { results: users } = await db.prepare('SELECT id, block FROM users WHERE block LIKE ?').bind(`%${userId}%`).all();
					const statements = [];
					if (postIds.length > 0) {
						const placeholders = postIds.map(() => '?').join(',');
						statements.push(db.prepare(`UPDATE posts SET repost_to = NULL WHERE repost_to IN (${placeholders})`).bind(...postIds));
					}
					for (const channel of channels || []) {
						const participants = parseJsonSafe(channel.participants, []).map(Number).filter((id) => id !== userId);
						if (participants.length < 2) statements.push(db.prepare('DELETE FROM dm_channels WHERE id = ?').bind(channel.id));
						else statements.push(db.prepare('UPDATE dm_channels SET participants = ? WHERE id = ?').bind(JSON.stringify(participants), channel.id));
					}
					for (const group of groups || []) {
						const members = parseJsonSafe(group.member, []).map(Number).filter((id) => id !== userId);
						if (members.length === 0) statements.push(db.prepare('DELETE FROM group_dms WHERE id = ?').bind(group.id));
						else {
							const messages = parseJsonSafe(group.post, []).filter((message) => Number(message?.userid) !== userId);
							const unread = { ...parseJsonSafe(group.unread, {}) }; delete unread[String(userId)];
							if (Array.isArray(unread._accepted)) unread._accepted = unread._accepted.filter((id) => Number(id) !== userId);
							const hostId = Number(group.host_id) === userId ? members[0] : Number(group.host_id);
							statements.push(db.prepare('UPDATE group_dms SET host_id = ?, member = ?, post = ?, unread = ? WHERE id = ?')
								.bind(hostId, JSON.stringify(members), JSON.stringify(messages), JSON.stringify(unread), group.id));
						}
					}
					for (const candidate of users || []) {
						const block = normalizeBlockList(parseJsonSafe(candidate.block, []).filter((id) => Number(id) !== userId), candidate.id);
						statements.push(db.prepare('UPDATE users SET block = ? WHERE id = ?').bind(JSON.stringify(block), candidate.id));
					}
					statements.push(
						db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
						db.prepare('DELETE FROM bot_tokens WHERE user_id = ?').bind(userId),
						db.prepare('DELETE FROM trusted_login_ips WHERE user_id = ?').bind(userId),
						db.prepare('DELETE FROM login_approvals WHERE user_id = ?').bind(userId),
						db.prepare('DELETE FROM account_recovery_requests WHERE user_id = ?').bind(userId),
						db.prepare('DELETE FROM blocked_login_ips WHERE user_id = ?').bind(userId),
						db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').bind(userId),
						db.prepare('DELETE FROM post_feedback WHERE user_id = ?').bind(userId),
						db.prepare('DELETE FROM moderation_reports WHERE reporter_user_id = ?').bind(userId),
						db.prepare('DELETE FROM post_age_estimates WHERE user_id = ?').bind(userId),
						db.prepare('INSERT OR IGNORE INTO retired_user_ids (id, retired_at) VALUES (?, ?)').bind(userId, new Date().toISOString()),
						db.prepare('DELETE FROM users WHERE id = ?').bind(userId),
					);
					await db.batch(statements);
					return json({ success: true });
				}

				if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/status$/)) {

				const userId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT shadow FROM users WHERE id = ?').bind(userId).first();
				return json(row ? { shadow: Boolean(row.shadow) } : null);
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/status$/)) {
				const userId = Number(pathname.split('/')[2]);
				const body = await request.json();
				// shadow が指定されていない場合は現状を返すだけ（未指定を false と解釈して上書きしない）。
				if (body.shadow === undefined) {
					const row = await db.prepare('SELECT shadow FROM users WHERE id = ?').bind(userId).first();
					return json(row ? { shadow: Boolean(row.shadow) } : null);
				}
				const shadow = Boolean(body.shadow);
				await db.prepare('UPDATE users SET shadow = ? WHERE id = ?').bind(shadow ? 1 : 0, userId).run();
				return json({ shadow });
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/auth-identity$/)) {
				const userId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const sets = [];
				const values = [];

				if (body.scid !== undefined) {
					sets.push('scid = ?');
					values.push(body.scid == null ? null : String(body.scid));
				}
				if (body.auth_provider !== undefined) {
					sets.push('auth_provider = ?');
					values.push(body.auth_provider == null ? null : String(body.auth_provider).toLowerCase());
				}
				if (body.external_id !== undefined) {
					sets.push('external_id = ?');
					values.push(body.external_id == null ? null : String(body.external_id));
				}
				if (body.external_profile !== undefined) {
					sets.push('external_profile = ?');
					values.push(body.external_profile == null ? null : JSON.stringify(body.external_profile));
				}
				if (body.provider_domain !== undefined) {
					sets.push('provider_domain = ?');
					values.push(body.provider_domain == null ? null : String(body.provider_domain));
				}

				if (sets.length === 0) return badRequest('No auth identity fields');
				values.push(userId);
				await db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
				const row = await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
				return json(normalizeUserRow(row));
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/auth-providers$/)) {
				const userId = Number(pathname.split('/')[2]);
				const { results } = await db.prepare('SELECT * FROM user_auth_providers WHERE user_id = ? ORDER BY id ASC').bind(userId).all();
				return json((results || []).map(normalizeAuthProviderRow));
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/auth-providers$/)) {
				const userId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const provider = String(body.provider || '').trim().toLowerCase();
				const providerUserId = body.providerUserId == null ? '' : String(body.providerUserId).trim();
				if (!provider || !providerUserId) return badRequest('Invalid auth provider');

				const providerProfile = JSON.stringify(body.providerProfile && typeof body.providerProfile === 'object' ? body.providerProfile : {});
				const existing = await db.prepare(
					'SELECT * FROM user_auth_providers WHERE user_id = ? AND LOWER(provider) = ? AND LOWER(provider_user_id) = LOWER(?) LIMIT 1'
				).bind(userId, provider, providerUserId).first();

				if (existing) {
					await db.prepare('UPDATE user_auth_providers SET provider_profile = ? WHERE id = ?').bind(providerProfile, existing.id).run();
					const updated = await db.prepare('SELECT * FROM user_auth_providers WHERE id = ?').bind(existing.id).first();
					return json(normalizeAuthProviderRow(updated));
				}

				const conflict = await db.prepare(
					'SELECT id FROM user_auth_providers WHERE LOWER(provider) = ? AND LOWER(provider_user_id) = LOWER(?) LIMIT 1'
				).bind(provider, providerUserId).first();
				if (conflict) return json({ error: 'auth_provider_already_linked' }, 409);

				const createdAt = body.createdAt ? String(body.createdAt) : new Date().toISOString();
				const inserted = await db.prepare(
					'INSERT INTO user_auth_providers (user_id, provider, provider_user_id, provider_profile, created_at) VALUES (?, ?, ?, ?, ?)'
				).bind(userId, provider, providerUserId, providerProfile, createdAt).run();
				if (provider === 'scratch') {
					// Postgres実装と同じく、primaryのscidが未設定のときだけ補完する。
					await db.prepare('UPDATE users SET scid = COALESCE(scid, ?) WHERE id = ?').bind(providerUserId, userId).run();
				}
				const row = await db.prepare('SELECT * FROM user_auth_providers WHERE id = ?').bind(inserted.meta.last_row_id).first();
				return json(normalizeAuthProviderRow(row));
			}

			if (method === 'DELETE' && pathname.match(/^\/users\/(\d+)\/auth-providers$/)) {
				const userId = Number(pathname.split('/')[2]);
				const url = new URL(request.url);
				const provider = String(url.searchParams.get('provider') || '').trim().toLowerCase();
				const providerUserId = url.searchParams.get('providerUserId');
				if (!provider) return badRequest('Invalid auth provider');

				if (providerUserId) {
					await db.prepare('DELETE FROM user_auth_providers WHERE user_id = ? AND LOWER(provider) = ? AND LOWER(provider_user_id) = LOWER(?)')
						.bind(userId, provider, providerUserId).run();
				} else {
					await db.prepare('DELETE FROM user_auth_providers WHERE user_id = ? AND LOWER(provider) = ?')
						.bind(userId, provider).run();
				}
				if (provider === 'scratch') {
					await db.prepare('UPDATE users SET scid = NULL WHERE id = ?').bind(userId).run();
				}
				return json({ success: true });
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/admin-request-exclusion$/)) {
				const userId = Number(pathname.split('/')[2]);
				const body = await request.json();
				if (typeof body.excluded !== 'boolean') return badRequest('Invalid excluded value');
				const result = await db.prepare('UPDATE users SET admin_request_excluded = ? WHERE id = ? AND admin = 1').bind(body.excluded ? 1 : 0, userId).run();
				if (!result.meta.changes) return json(null);
				return json(normalizeUserRow(await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first()));
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/profile$/)) {
				const userId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const sets = [];
				const values = [];

				if (body.name !== undefined) { sets.push('name = ?'); values.push(body.name); }
				if (body.bio !== undefined) { sets.push('bio = ?'); values.push(body.bio); }
				else if (body.me !== undefined) { sets.push('bio = ?'); values.push(body.me); }
				if (body.header_image !== undefined) { sets.push('header_image = ?'); values.push(body.header_image); }
				if (body.icon_data !== undefined) { sets.push('icon_data = ?'); values.push(body.icon_data); }
				if (body.settings !== undefined) { sets.push('settings = ?'); values.push(JSON.stringify(body.settings || {})); }
				if (body.block !== undefined) { sets.push('block = ?'); values.push(JSON.stringify(normalizeBlockList(body.block, userId))); }
				if (body.verify !== undefined) { sets.push('verify = ?'); values.push(body.verify ? 1 : 0); }
				if (body.freeze !== undefined) { sets.push('freeze = ?'); values.push(body.freeze || null); }
				if (body.admin !== undefined) { sets.push('admin = ?'); values.push(body.admin ? 1 : 0); }
				if (body.shadow !== undefined) { sets.push('shadow = ?'); values.push(body.shadow ? 1 : 0); }

				if (sets.length > 0) {
					values.push(userId);
					await db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
				}
				const row = await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
				return json(normalizeUserRow(row));
			}

				if (method === 'POST' && pathname === '/users/age-estimates') {
					const body = await request.json();
					const ids = [...new Set((Array.isArray(body.ids) ? body.ids : [])
						.map(Number)
						.filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, 1000);
					if (ids.length === 0) return json({ users: [] });
					const placeholders = ids.map(() => '?').join(', ');
					const { results } = await db.prepare(
						`SELECT id, age_estimate FROM users WHERE id IN (${placeholders})`,
					).bind(...ids).all();
					return json({
						users: (results || []).map((row) => ({
							id: Number(row.id),
							age_estimate: row.age_estimate == null ? null : Number(row.age_estimate),
						})),
					});
				}

				if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/age-estimates$/)) {
					const userId = Number(pathname.split('/')[2]);
					const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 50), 500));
					const { results } = await db.prepare(
						'SELECT band FROM post_age_estimates WHERE user_id = ? ORDER BY created_at DESC, post_id DESC LIMIT ?',
					).bind(userId, limit).all();
					return json({ bands: (results || []).map((row) => row.band) });
				}

				if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/age-estimate$/)) {
					const userId = Number(pathname.split('/')[2]);
					const body = await request.json();
					const sets = [];
					const values = [];
					if (body.ageEstimate !== undefined) {
						const estimate = body.ageEstimate == null ? null : Number(body.ageEstimate);
						if (estimate != null && (!Number.isFinite(estimate) || estimate < 0 || estimate > 120)) return badRequest('Invalid age estimate');
						sets.push('age_estimate = ?'); values.push(estimate);
					}
					if (body.ageSource !== undefined) {
						if (body.ageSource != null && !['post', 'ondevice', 'api'].includes(body.ageSource)) return badRequest('Invalid age source');
						sets.push('age_source = ?'); values.push(body.ageSource || null);
					}
					if (body.ageSamples !== undefined) { sets.push('age_samples = ?'); values.push(Math.max(0, Number(body.ageSamples) || 0)); }
					if (body.ageEstimatedAt !== undefined) { sets.push('age_estimated_at = ?'); values.push(body.ageEstimatedAt == null ? null : String(body.ageEstimatedAt)); }
					if (sets.length > 0) {
						values.push(userId);
						await db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
					}
					const row = await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
					return json(normalizeUserRow(row));
				}

				if (method === 'GET' && pathname.match(/^\/users\/(\d+)$/)) {
					const userId = Number(pathname.split('/')[2]);
					const row = await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
					return json(normalizeUserRow(row));
				}

				if (method === 'POST' && pathname === '/moderation-reports') {
					const body = await request.json();
					const reporterUserId = Number(body.reporterUserId);
					const targetKind = String(body.targetKind || '');
					const targetId = ['dm', 'dm_message'].includes(targetKind)
						? String(body.targetId || '').trim()
						: Number(body.targetId);
					const description = String(body.description || '');
					const assignmentType = ['freeze_appeal', 'verification_application'].includes(body.assignmentType)
						? body.assignmentType
						: 'report';
					const validTargetId = ['dm', 'dm_message'].includes(targetKind)
						? targetId.length > 0 && targetId.length <= 256
						: Number.isInteger(targetId);
					if (!Number.isInteger(reporterUserId) || !validTargetId || !['user', 'post', 'dm', 'dm_message'].includes(targetKind)) {
						return badRequest('Invalid moderation report');
					}
					const now = body.createdAt || new Date().toISOString();
					const hasExplicitId = body.id != null && Number.isSafeInteger(Number(body.id)) && Number(body.id) > 0;
					let createdId;
					if (hasExplicitId) {
						createdId = Number(body.id);
						await db.prepare(
							`INSERT INTO moderation_reports
								(id, reporter_user_id, target_kind, target_id, description, target_snapshot, assignment_type, status, excluded_admin_ids, created_at)
							 VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', '[]', ?)`
						).bind(
							createdId,
							reporterUserId,
							targetKind,
							targetId,
							description,
							JSON.stringify(body.targetSnapshot || {}),
							assignmentType,
							now,
						).run();
					} else {
						const result = await db.prepare(
							`INSERT INTO moderation_reports
								(reporter_user_id, target_kind, target_id, description, target_snapshot, assignment_type, status, excluded_admin_ids, created_at)
							 VALUES (?, ?, ?, ?, ?, ?, 'pending', '[]', ?)`
						).bind(
							reporterUserId,
							targetKind,
							targetId,
							description,
							JSON.stringify(body.targetSnapshot || {}),
							assignmentType,
							now,
						).run();
						createdId = result.meta.last_row_id;
					}
					const row = await db.prepare('SELECT * FROM moderation_reports WHERE id = ?').bind(createdId).first();
					return json(normalizeModerationReportRow(row), 201);
				}

				if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/moderation-appeal\/open$/)) {
					const userId = Number(pathname.split('/')[2]);
					const row = await db.prepare(
						`SELECT * FROM moderation_reports
						 WHERE reporter_user_id = ? AND assignment_type = 'freeze_appeal' AND status <> 'resolved'
						 ORDER BY created_at DESC LIMIT 1`
					).bind(userId).first();
					return json(normalizeModerationReportRow(row));
				}

				if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/moderation-verification\/open$/)) {
					const userId = Number(pathname.split('/')[2]);
					const row = await db.prepare(
						`SELECT * FROM moderation_reports
						 WHERE reporter_user_id = ? AND assignment_type = 'verification_application' AND status <> 'resolved'
						 ORDER BY created_at DESC LIMIT 1`
					).bind(userId).first();
					return json(normalizeModerationReportRow(row));
				}

				if (method === 'POST' && pathname === '/moderation-reports/admin-workloads') {
					const body = await request.json();
					const excluded = [...new Set((Array.isArray(body.excludedAdminIds) ? body.excludedAdminIds : [])
						.map(Number)
						.filter(Number.isInteger))];
					const placeholders = excluded.map(() => '?').join(', ');
					const exclusionClause = excluded.length > 0 ? `AND u.id NOT IN (${placeholders})` : '';
					const { results } = await db.prepare(
						`SELECT u.id AS admin_id, COUNT(r.id) AS active_count
						 FROM users u
						 LEFT JOIN moderation_reports r ON r.assigned_admin_id = u.id AND r.status = 'assigned'
						 WHERE u.admin = 1 AND u.admin_request_excluded = 0 AND COALESCE(u.freeze, '') = '' ${exclusionClause}
						 GROUP BY u.id`
					).bind(...excluded).all();
					return json((results || []).map((row) => ({
						adminId: Number(row.admin_id),
						activeCount: Number(row.active_count || 0),
					})));
				}

				if (method === 'POST' && pathname === '/moderation-reports/overdue') {
					const body = await request.json();
					const cutoff = String(body.cutoff || '');
					// lease: 最近 claim した行は管理者が作業中。スイープ側で除外しないと再割り当てが二重対応を生む。
					const claimStaleBefore = body.claimStaleBefore == null || body.claimStaleBefore === ''
						? null
						: String(body.claimStaleBefore);
					const claimClause = claimStaleBefore ? 'AND (claimed_at IS NULL OR claimed_at <= ?)' : '';
					const bindings = claimStaleBefore ? [cutoff, claimStaleBefore] : [cutoff];
					const { results } = await db.prepare(
						`SELECT * FROM moderation_reports
						 WHERE status = 'assigned' AND assigned_at IS NOT NULL AND assigned_at <= ?
						 ${claimClause}
						 ORDER BY assigned_at ASC`
					).bind(...bindings).all();
					return json((results || []).map(normalizeModerationReportRow));
				}

				if (method === 'POST' && pathname === '/moderation-reports/unassigned') {
					const body = await request.json();
					const limit = Math.max(1, Math.min(Number(body.limit) || 100, 100));
					const { results } = await db.prepare(
						`SELECT * FROM moderation_reports
						 WHERE status = 'pending' ORDER BY created_at ASC, id ASC LIMIT ?`
					).bind(limit).all();
					return json((results || []).map(normalizeModerationReportRow));
				}

				if (method === 'GET' && pathname.match(/^\/moderation-reports\/admin\/(\d+)$/)) {
					const adminId = Number(pathname.split('/')[3]);
					const status = url.searchParams.get('status') || 'assigned';
					const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 50), 100));
					const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
					const { results } = await db.prepare(
						`SELECT * FROM moderation_reports
						 WHERE assigned_admin_id = ? AND (? = '' OR status = ?)
						 ORDER BY COALESCE(assigned_at, created_at) DESC, id DESC LIMIT ? OFFSET ?`
					).bind(adminId, status, status, limit, offset).all();
					return json((results || []).map(normalizeModerationReportRow));
				}

				if (method === 'GET' && pathname.match(/^\/moderation-reports\/(\d+)$/)) {
					const reportId = Number(pathname.split('/')[2]);
					const row = await db.prepare('SELECT * FROM moderation_reports WHERE id = ?').bind(reportId).first();
					return json(normalizeModerationReportRow(row));
				}

				if (method === 'POST' && pathname.match(/^\/moderation-reports\/(\d+)\/assign$/)) {
					const reportId = Number(pathname.split('/')[2]);
					const body = await request.json();
					const existing = await db.prepare('SELECT * FROM moderation_reports WHERE id = ?').bind(reportId).first();
					if (!existing || existing.status === 'resolved') return json(null);
					if (Object.prototype.hasOwnProperty.call(body, 'expectedAdminId') && Number(existing.assigned_admin_id) !== Number(body.expectedAdminId)) {
						return json(null);
					}
					const excluded = [...new Set((Array.isArray(body.excludedAdminIds) ? body.excludedAdminIds : parseJsonSafe(existing.excluded_admin_ids, []))
						.map(Number)
						.filter(Number.isInteger))];
					const assignedAt = body.assignedAt || new Date().toISOString();
					// SELECT 時点の lease を信用しない: 読み取り後の再claimを無条件 UPDATE が潰して二重対応になるため、assign 自体を CAS にする。
					const claimStaleBefore = body.claimStaleBefore == null || body.claimStaleBefore === ''
						? null
						: String(body.claimStaleBefore);
					const claimClause = claimStaleBefore ? ' AND (claimed_at IS NULL OR claimed_at <= ?)' : '';
					const bindings = [Number(body.adminId), assignedAt, JSON.stringify(excluded), reportId, Number(body.adminId)];
					if (claimStaleBefore) bindings.push(claimStaleBefore);
					const result = await db.prepare(
						`UPDATE moderation_reports
						 SET status = 'assigned', assigned_admin_id = ?, assigned_at = ?, excluded_admin_ids = ?, claimed_at = NULL
						 WHERE id = ? AND status <> 'resolved' AND EXISTS (SELECT 1 FROM users WHERE id = ? AND admin = 1 AND admin_request_excluded = 0 AND COALESCE(freeze, '') = '')${claimClause}`
					).bind(...bindings).run();
					// changes 0 = CAS 失敗。再SELECT して行を返すとサービス側は奪取成功と誤認する。
					if (result.meta.changes === 0) return json(null);
					const row = await db.prepare('SELECT * FROM moderation_reports WHERE id = ?').bind(reportId).first();
					return json(normalizeModerationReportRow(row));
				}

				if (method === 'POST' && pathname.match(/^\/moderation-reports\/(\d+)\/claim$/)) {
					const reportId = Number(pathname.split('/')[2]);
					const body = await request.json();
					// lease の更新でありロックではない: 現担当者なら何度でも成功させる（freshness 条件を置かない）。
					// 呼び出し側が時刻を寄越さないと NULL になって lease が常に切れている事になるので現在時刻に倒す。
					const claimedAt = typeof body.claimedAt === 'string' && body.claimedAt
						? body.claimedAt
						: new Date().toISOString();
					const result = await db.prepare(
						`UPDATE moderation_reports
						 SET claimed_at = ?
						 WHERE id = ? AND status = 'assigned' AND assigned_admin_id = ?`
					).bind(claimedAt, reportId, Number(body.adminId)).run();
					if (result.meta.changes === 0) return json(null);
					const row = await db.prepare('SELECT * FROM moderation_reports WHERE id = ?').bind(reportId).first();
					return json(normalizeModerationReportRow(row));
				}

				if (method === 'POST' && pathname.match(/^\/moderation-reports\/(\d+)\/resolve$/)) {
					const reportId = Number(pathname.split('/')[2]);
					const body = await request.json();
					const now = new Date().toISOString();
					const result = await db.prepare(
						`UPDATE moderation_reports
						 SET status = 'resolved', resolution = ?, resolved_at = ?, claimed_at = NULL
						 WHERE id = ? AND assigned_admin_id = ? AND status = 'assigned'`
					).bind(JSON.stringify(body.resolution || {}), now, reportId, Number(body.adminId)).run();
					if (result.meta.changes === 0) return json(null);
					const row = await db.prepare('SELECT * FROM moderation_reports WHERE id = ?').bind(reportId).first();
					return json(normalizeModerationReportRow(row));
				}

				if (method === 'POST' && pathname.match(/^\/moderation-reports\/(\d+)\/delete$/)) {
					const reportId = Number(pathname.split('/')[2]);
					const result = await db.prepare('DELETE FROM moderation_reports WHERE id = ?').bind(reportId).run();
					return json({ success: result.meta.changes > 0 });
				}

				if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/follow$/)) {
				const followingId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const followerId = Number(body.followerId);

				const existing = await db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?').bind(followerId, followingId).first();
				if (existing) {
					await db.prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?').bind(followerId, followingId).run();
					return json({ following: false });
				}
				const now = new Date().toISOString();
				await db.prepare('INSERT INTO follows (follower_id, following_id, created_at) VALUES (?, ?, ?)').bind(followerId, followingId, now).run();
				return json({ following: true });
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/block$/)) {
				const targetUserId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const userId = Number(body.userId);
				if (!userId || !targetUserId) {
					return json({ error: 'Invalid user id' }, 400);
				}
				if (userId === targetUserId) {
					return json({ error: 'Cannot block yourself' }, 400);
				}

				const user = await db.prepare('SELECT id, block FROM users WHERE id = ?').bind(userId).first();
				if (!user) {
					return json({ error: 'User not found' }, 404);
				}

				let currentBlock = [];
				try {
					currentBlock = Array.isArray(user.block) ? user.block : JSON.parse(user.block || '[]');
				} catch (_) {
					currentBlock = [];
				}
				currentBlock = Array.isArray(currentBlock)
					? currentBlock.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n !== userId)
					: [];

				const isBlocked = currentBlock.includes(targetUserId);
				const newBlock = isBlocked
					? currentBlock.filter((id) => id !== targetUserId)
					: [...currentBlock, targetUserId];
				const sortedBlock = [...new Set(newBlock)].sort((a, b) => a - b);

				await db.prepare('UPDATE users SET block = ? WHERE id = ?').bind(JSON.stringify(sortedBlock), userId).run();

				if (!isBlocked) {
					await db.prepare('DELETE FROM follows WHERE (follower_id = ? AND following_id = ?) OR (follower_id = ? AND following_id = ?)')
						.bind(userId, targetUserId, targetUserId, userId).run();
				}

				return json({
					blocked: !isBlocked,
					block: sortedBlock,
				});
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/is-following$/)) {
				const followingId = Number(pathname.split('/')[2]);
				const followerId = Number(url.searchParams.get('followerId'));
				const existing = await db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?').bind(followerId, followingId).first();
				return json({ following: Boolean(existing) });
			}

			if (method === 'POST' && pathname === '/users/follow-relationships') {
				const body = await request.json();
				const userId = Number(body?.userId);
				const candidateIds = [...new Set((Array.isArray(body?.candidateIds) ? body.candidateIds : [])
					.map(Number)
					.filter((id) => Number.isSafeInteger(id) && id >= 0 && id !== userId))].slice(0, 500);
				if (!Number.isSafeInteger(userId) || userId < 0 || candidateIds.length === 0) {
					return json({ following_ids: [], follower_ids: [] });
				}
				const placeholders = candidateIds.map(() => '?').join(', ');
				const { results } = await db.prepare(
					`SELECT following_id AS user_id, 'following' AS direction
					 FROM follows
					 WHERE follower_id = ? AND following_id IN (${placeholders})
					 UNION ALL
					 SELECT follower_id AS user_id, 'follower' AS direction
					 FROM follows
					 WHERE following_id = ? AND follower_id IN (${placeholders})`
				).bind(userId, ...candidateIds, userId, ...candidateIds).all();
				const following_ids = [];
				const follower_ids = [];
				for (const row of results || []) {
					if (row.direction === 'following') following_ids.push(Number(row.user_id));
					if (row.direction === 'follower') follower_ids.push(Number(row.user_id));
				}
				return json({ following_ids, follower_ids });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/following$/)) {
				const userId = Number(pathname.split('/')[2]);
				const limit = Math.min(Number(url.searchParams.get('limit') || 100), 500);
				const decodedCursor = decodePostCursor(url.searchParams.get('cursor'));
				const withNextCursor = url.searchParams.get('withNextCursor') === 'true';
				const fetchLimit = limit + 1;
				let query;
				let bindings;

				if (decodedCursor) {
					query = `SELECT u.*, f.created_at AS follow_created_at
						 FROM follows f JOIN users u ON u.id = f.following_id
						 WHERE f.follower_id = ? AND (f.created_at < ? OR (f.created_at = ? AND f.following_id < ?))
						 ORDER BY f.created_at DESC, f.following_id DESC LIMIT ?`;
					bindings = [userId, decodedCursor.createdAt, decodedCursor.createdAt, decodedCursor.id, fetchLimit];
				} else {
					const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);
					query = `SELECT u.*, f.created_at AS follow_created_at
						 FROM follows f JOIN users u ON u.id = f.following_id
						 WHERE f.follower_id = ?
						 ORDER BY f.created_at DESC, f.following_id DESC LIMIT ? OFFSET ?`;
					bindings = [userId, fetchLimit, offset];
				}

				const { results } = await db.prepare(query).bind(...bindings).all();
				const rows = results || [];
				const hasMore = rows.length > limit;
				const slice = rows.slice(0, limit);
				const lastRow = slice.length > 0 ? slice[slice.length - 1] : null;
				const nextCursor = hasMore && lastRow
					? encodePostCursor({ id: Number(lastRow.id), created_at: lastRow.follow_created_at })
					: null;
				const users = slice.map(normalizeUserRow);

				if (withNextCursor) {
					return json({
						users,
						has_more: hasMore,
						next_cursor: nextCursor,
					});
				}
				return json(users);
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/followers$/)) {
				const userId = Number(pathname.split('/')[2]);
				const limit = Math.min(Number(url.searchParams.get('limit') || 100), 500);
				const decodedCursor = decodePostCursor(url.searchParams.get('cursor'));
				const withNextCursor = url.searchParams.get('withNextCursor') === 'true';
				const fetchLimit = limit + 1;
				let query;
				let bindings;

				if (decodedCursor) {
					query = `SELECT u.*, f.created_at AS follow_created_at
						 FROM follows f JOIN users u ON u.id = f.follower_id
						 WHERE f.following_id = ? AND (f.created_at < ? OR (f.created_at = ? AND f.follower_id < ?))
						 ORDER BY f.created_at DESC, f.follower_id DESC LIMIT ?`;
					bindings = [userId, decodedCursor.createdAt, decodedCursor.createdAt, decodedCursor.id, fetchLimit];
				} else {
					const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);
					query = `SELECT u.*, f.created_at AS follow_created_at
						 FROM follows f JOIN users u ON u.id = f.follower_id
						 WHERE f.following_id = ?
						 ORDER BY f.created_at DESC, f.follower_id DESC LIMIT ? OFFSET ?`;
					bindings = [userId, fetchLimit, offset];
				}

				const { results } = await db.prepare(query).bind(...bindings).all();
				const rows = results || [];
				const hasMore = rows.length > limit;
				const slice = rows.slice(0, limit);
				const lastRow = slice.length > 0 ? slice[slice.length - 1] : null;
				const nextCursor = hasMore && lastRow
					? encodePostCursor({ id: Number(lastRow.id), created_at: lastRow.follow_created_at })
					: null;
				const users = slice.map(normalizeUserRow);

				if (withNextCursor) {
					return json({
						users,
						has_more: hasMore,
						next_cursor: nextCursor,
					});
				}
				return json(users);
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/following\/count$/)) {
				const userId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT COUNT(*) as count FROM follows WHERE follower_id = ?').bind(userId).first();
				return json({ count: Number(row?.count || 0) });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/followers\/count$/)) {
				const userId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT COUNT(*) as count FROM follows WHERE following_id = ?').bind(userId).first();
				return json({ count: Number(row?.count || 0) });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/profile-stats$/)) {
				const userId = Number(pathname.split('/')[2]);
				const row = await db.prepare(
					`SELECT
						(SELECT COUNT(*) FROM follows WHERE follower_id = ?) AS following_count,
						(SELECT COUNT(*) FROM follows WHERE following_id = ?) AS follower_count,
						(SELECT COUNT(*) FROM posts WHERE user_id = ?) AS post_count,
						(SELECT COUNT(*) FROM posts
						 WHERE user_id = ?
						   AND json_array_length(CASE WHEN json_valid(attachments) = 1 THEN attachments ELSE '[]' END) > 0) AS media_count,
						(SELECT post_id FROM pinned_posts WHERE user_id = ? ORDER BY created_at DESC LIMIT 1) AS pinned_post_id`,
				).bind(userId, userId, userId, userId, userId).first();
				return json({
					following_count: Number(row?.following_count || 0),
					follower_count: Number(row?.follower_count || 0),
					post_count: Number(row?.post_count || 0),
					media_count: Number(row?.media_count || 0),
					pinned_post_id: row?.pinned_post_id == null ? null : Number(row.pinned_post_id),
				});
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/following\/ids$/)) {
				const userId = Number(pathname.split('/')[2]);
				const { results } = await db.prepare('SELECT following_id FROM follows WHERE follower_id = ?').bind(userId).all();
				return json((results || []).map((r) => r.following_id));
			}

			// ==================== Groups ====================
			if (method === 'POST' && pathname === '/groups/user-badges-batch') {
				const body = await request.json().catch(() => ({}));
				const userIds = Array.isArray(body?.user_ids) ? body.user_ids.map(Number).filter(Number.isInteger) : [];
				if (userIds.length === 0) return json({ badges: {} });
				const placeholders = userIds.map(() => '?').join(',');
				const query = `
					SELECT gm.user_id, g.id AS group_id, g.name, g.icon_data, gm.joined_at
					FROM group_memberships gm
					JOIN groups g ON g.id = gm.group_id
					WHERE gm.user_id IN (${placeholders})
					  AND gm.status = 'active'
					  AND g.deleted_at IS NULL
					  AND g.icon_data IS NOT NULL
					  AND g.icon_data <> ''
					  AND g.visibility IN ('open', 'open_invite')
					ORDER BY gm.user_id, gm.joined_at DESC, g.created_at DESC
				`;
				const { results } = await db.prepare(query).bind(...userIds).all();
				const badges = {};
				userIds.forEach((id) => { badges[id] = []; });
				for (const row of results || []) {
					const uid = Number(row.user_id);
					if (!badges[uid]) badges[uid] = [];
					if (badges[uid].length < 5) {
						badges[uid].push({
							id: String(row.group_id),
							name: row.name || '',
							icon_data: row.icon_data,
						});
					}
				}
				return json({ badges });
			}

			if (method === 'GET' && pathname === '/groups') {
				const rawVisibility = String(url.searchParams.get('visibility') || 'open,open_invite');
				const visibility = rawVisibility.split(',').map((value) => value.trim()).filter(Boolean);
				if (visibility.length === 0) return json([]);
				const query = String(url.searchParams.get('query') || '').trim().toLowerCase();
				const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 20), 100));
				const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
				const placeholders = visibility.map(() => '?').join(', ');
				const parameters = [...visibility];
				let sql = `SELECT g.*, (SELECT COUNT(*) FROM group_memberships gm WHERE gm.group_id = g.id AND gm.status = 'active') AS member_count FROM groups g WHERE g.deleted_at IS NULL AND g.visibility IN (${placeholders})`;
				if (query) { sql += ' AND (LOWER(g.name) LIKE ? OR LOWER(g.description) LIKE ?)'; parameters.push(`%${query}%`, `%${query}%`); }
				sql += ' ORDER BY g.created_at DESC, g.id DESC LIMIT ? OFFSET ?';
				parameters.push(limit, offset);
				const { results } = await db.prepare(sql).bind(...parameters).all();
				return json((results || []).map(normalizeGroupRow));
			}

			if (method === 'POST' && pathname === '/groups') {
				const body = await request.json();
				const id = String(body.id || '').trim();
				const ownerId = Number(body.ownerId ?? body.owner_id);
				const name = String(body.name || '').trim();
				const visibility = String(body.visibility || 'open');
				if (!id || !Number.isInteger(ownerId) || ownerId < 0 || !name || name.length > 100 || !['open', 'private', 'invite', 'open_invite'].includes(visibility)) return badRequest('Invalid group');
				const description = String(body.description || '');
				if (description.length > 2000) return badRequest('Invalid description');
				const now = body.createdAt || new Date().toISOString();
				await db.prepare(`INSERT INTO groups (id, owner_id, name, description, icon_data, header_image, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
					.bind(id, ownerId, name, description, body.iconData ?? body.icon_data ?? null, body.headerImage ?? body.header_image ?? null, visibility, now, now).run();
				const row = await db.prepare(`SELECT g.*, 0 AS member_count FROM groups g WHERE g.id = ?`).bind(id).first();
				return json(normalizeGroupRow(row));
			}

			if (method === 'GET' && pathname.match(/^\/groups\/[^/]+$/)) {
				const groupId = decodeURIComponent(pathname.split('/')[2]);
				const row = await db.prepare(`SELECT g.*, (SELECT COUNT(*) FROM group_memberships gm WHERE gm.group_id = g.id AND gm.status = 'active') AS member_count FROM groups g WHERE g.id = ? AND g.deleted_at IS NULL`).bind(groupId).first();
				return row ? json(normalizeGroupRow(row)) : notFound('Group not found');
			}

			if (method === 'PATCH' && pathname.match(/^\/groups\/[^/]+\/owner$/)) {
				const groupId = decodeURIComponent(pathname.split('/')[2]);
				const body = await request.json();
				const newOwnerId = Number(body.newOwnerId ?? body.new_owner_id);
				if (!Number.isInteger(newOwnerId) || newOwnerId < 0) return badRequest('Invalid new owner');
				await db.prepare('UPDATE groups SET owner_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').bind(newOwnerId, new Date().toISOString(), groupId).run();
				const row = await db.prepare(`SELECT g.*, (SELECT COUNT(*) FROM group_memberships gm WHERE gm.group_id = g.id AND gm.status = 'active') AS member_count FROM groups g WHERE g.id = ? AND g.deleted_at IS NULL`).bind(groupId).first();
				return row ? json(normalizeGroupRow(row)) : notFound('Group not found');
			}

			if (method === 'PATCH' && pathname.match(/^\/groups\/[^/]+$/)) {
				const groupId = decodeURIComponent(pathname.split('/')[2]);
				const body = await request.json();
				const fields = [['name', 'name'], ['description', 'description'], ['iconData', 'icon_data'], ['icon_data', 'icon_data'], ['headerImage', 'header_image'], ['header_image', 'header_image'], ['visibility', 'visibility']];
				const sets = []; const values = []; const assigned = new Set();
				for (const [key, column] of fields) {
					if (body[key] === undefined || assigned.has(column)) continue;
					assigned.add(column);
					const value = body[key] == null && ['icon_data', 'header_image'].includes(column) ? null : String(body[key]);
					if (column === 'name' && (!value || value.length > 100)) return badRequest('Invalid group name');
					if (column === 'description' && value.length > 2000) return badRequest('Invalid description');
					if (column === 'visibility' && !['open', 'private', 'invite', 'open_invite'].includes(value)) return badRequest('Invalid visibility');
					sets.push(`${column} = ?`); values.push(value);
				}
				if (sets.length === 0) return badRequest('No editable fields');
				sets.push('updated_at = ?'); values.push(new Date().toISOString(), groupId);
				await db.prepare(`UPDATE groups SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`).bind(...values).run();
				const row = await db.prepare(`SELECT g.*, (SELECT COUNT(*) FROM group_memberships gm WHERE gm.group_id = g.id AND gm.status = 'active') AS member_count FROM groups g WHERE g.id = ? AND g.deleted_at IS NULL`).bind(groupId).first();
				return row ? json(normalizeGroupRow(row)) : notFound('Group not found');
			}

			if (method === 'DELETE' && pathname.match(/^\/groups\/[^/]+$/)) {
				const groupId = decodeURIComponent(pathname.split('/')[2]);
				const now = new Date().toISOString();
				await db.batch([
					db.prepare('UPDATE groups SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').bind(now, now, groupId),
					db.prepare('UPDATE posts SET repost_to = NULL WHERE repost_to IN (SELECT id FROM posts WHERE group_id = ?)').bind(groupId),
					db.prepare('DELETE FROM likes WHERE post_id IN (SELECT id FROM posts WHERE group_id = ?)').bind(groupId),
					db.prepare('DELETE FROM stars WHERE post_id IN (SELECT id FROM posts WHERE group_id = ?)').bind(groupId),
					db.prepare('DELETE FROM reposts WHERE post_id IN (SELECT id FROM posts WHERE group_id = ?)').bind(groupId),
					db.prepare('DELETE FROM pinned_posts WHERE post_id IN (SELECT id FROM posts WHERE group_id = ?)').bind(groupId),
					db.prepare('DELETE FROM posts WHERE group_id = ?').bind(groupId),
				]);
				const row = await db.prepare('SELECT * FROM groups WHERE id = ?').bind(groupId).first();
				return row ? json(normalizeGroupRow(row)) : notFound('Group not found');
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/groups$/)) {
				const userId = Number(pathname.split('/')[2]);
				const status = String(url.searchParams.get('status') || 'active');
				const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 100), 200));
				const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
				const { results } = await db.prepare(`SELECT g.*, gm.role_id AS membership_role_id, gm.status AS membership_status, gm.joined_at AS membership_joined_at,
					(SELECT COUNT(*) FROM group_memberships count_gm WHERE count_gm.group_id = g.id AND count_gm.status = 'active') AS member_count
					FROM group_memberships gm JOIN groups g ON g.id = gm.group_id WHERE gm.user_id = ? AND gm.status = ? AND g.deleted_at IS NULL
					ORDER BY gm.joined_at DESC, g.created_at DESC LIMIT ? OFFSET ?`).bind(userId, status, limit, offset).all();
				return json((results || []).map((row) => ({ ...normalizeGroupRow(row), membership: normalizeGroupMembershipRow({ group_id: row.id, user_id: userId, role_id: row.membership_role_id, status: row.membership_status, joined_at: row.membership_joined_at }) })));
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/mutual-groups$/)) {
				const userId1 = Number(pathname.split('/')[2]);
				const userId2 = Number(url.searchParams.get('targetUserId') || 0);
				const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 100), 200));
				const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
				if (!userId1 || !userId2) return json([]);
				const { results } = await db.prepare(`SELECT g.*,
					(SELECT COUNT(*) FROM group_memberships count_gm WHERE count_gm.group_id = g.id AND count_gm.status = 'active') AS member_count
					FROM groups g
					JOIN group_memberships gm1 ON gm1.group_id = g.id AND gm1.user_id = ? AND gm1.status = 'active'
					JOIN group_memberships gm2 ON gm2.group_id = g.id AND gm2.user_id = ? AND gm2.status = 'active'
					WHERE g.deleted_at IS NULL
					ORDER BY g.created_at DESC LIMIT ? OFFSET ?`).bind(userId1, userId2, limit, offset).all();
				return json((results || []).map(normalizeGroupRow));
			}

			// ==================== Spaces ====================
			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/spaces$/)) {
				const userId = Number(pathname.split('/')[2]);
				const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 50), 100));
				const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
				const { results } = await db.prepare(
					`SELECT s.*, sm.role AS membership_role, sm.joined_at AS membership_joined_at,
						 (SELECT COUNT(*) FROM space_members count_sm WHERE count_sm.space_id = s.id) AS member_count
					 FROM space_members sm JOIN spaces s ON s.id = sm.space_id
					 WHERE sm.user_id = ?
					 ORDER BY s.created_at DESC, s.id DESC LIMIT ? OFFSET ?`
				).bind(userId, limit, offset).all();
				return json((results || []).map((row) => ({
					...normalizeSpaceRow(row),
					membership: normalizeSpaceMemberRow({ space_id: row.id, user_id: userId, role: row.membership_role, joined_at: row.membership_joined_at }),
				})));
			}

			if (method === 'GET' && pathname === '/spaces/count') {
				const ownerId = Number(url.searchParams.get('ownerId') || 0);
				const row = await db.prepare('SELECT COUNT(*) AS count FROM spaces WHERE owner_id = ?').bind(ownerId).first();
				return json({ count: Number(row?.count || 0) });
			}

			if (method === 'POST' && pathname === '/spaces/channels') {
				const body = await request.json();
				const id = String(body.id || '').trim();
				const spaceId = String(body.spaceId ?? body.space_id ?? '').trim();
				const name = String(body.name || '').trim();
				const kind = String(body.kind || 'text');
				if (!id || !spaceId || !name || name.length > 50 || !['text', 'voice'].includes(kind)) return badRequest('Invalid channel');
				const sortOrder = Number(body.sortOrder ?? body.sort_order) || 0;
				const now = body.createdAt || new Date().toISOString();
				await db.prepare('INSERT INTO space_channels (id, space_id, name, kind, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)')
					.bind(id, spaceId, name, kind, sortOrder, now).run();
				const row = await db.prepare('SELECT * FROM space_channels WHERE id = ?').bind(id).first();
				return json(normalizeSpaceChannelRow(row));
			}

			if (method === 'GET' && pathname.match(/^\/spaces\/channels\/([^/]+)$/)) {
				const channelId = decodeURIComponent(pathname.split('/')[3]);
				const row = await db.prepare('SELECT * FROM space_channels WHERE id = ?').bind(channelId).first();
				return json(normalizeSpaceChannelRow(row));
			}

			if (method === 'PATCH' && pathname.match(/^\/spaces\/channels\/([^/]+)$/)) {
				const channelId = decodeURIComponent(pathname.split('/')[3]);
				const body = await request.json();
				const sets = [];
				const values = [];
				if (body.name !== undefined) { sets.push('name = ?'); values.push(String(body.name).trim()); }
				if (body.kind !== undefined) {
					const kind = String(body.kind);
					if (!['text', 'voice'].includes(kind)) return badRequest('Invalid channel kind');
					sets.push('kind = ?'); values.push(kind);
				}
				if (body.sortOrder !== undefined || body.sort_order !== undefined) { sets.push('sort_order = ?'); values.push(Number(body.sortOrder ?? body.sort_order) || 0); }
				if (sets.length === 0) return badRequest('No channel fields');
				values.push(channelId);
				await db.prepare(`UPDATE space_channels SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
				const row = await db.prepare('SELECT * FROM space_channels WHERE id = ?').bind(channelId).first();
				return json(normalizeSpaceChannelRow(row));
			}

			if (method === 'DELETE' && pathname.match(/^\/spaces\/channels\/([^/]+)$/)) {
				const channelId = decodeURIComponent(pathname.split('/')[3]);
				const info = await db.prepare('DELETE FROM space_channels WHERE id = ?').bind(channelId).run();
				return json({ deleted: Number(info?.meta?.changes || 0) > 0 });
			}

			if (method === 'GET' && pathname === '/spaces') {
				const query = String(url.searchParams.get('query') || '').trim().toLowerCase();
				const includePrivate = url.searchParams.get('include_private') === 'true';
				const groupIds = String(url.searchParams.get('group_ids') || '').split(',').map((value) => value.trim()).filter(Boolean);
				const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 20), 100));
				const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
				const clauses = groupIds.length ? [] : includePrivate ? [] : ["s.visibility = 'public'"];
				const parameters = [];
				if (groupIds.length) {
					clauses.push(`s.group_id IN (${groupIds.map(() => '?').join(', ')})`);
					parameters.push(...groupIds);
				}
				if (query) { clauses.push('(LOWER(s.name) LIKE ? OR LOWER(s.description) LIKE ?)'); parameters.push(`%${query}%`, `%${query}%`); }
				const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
				parameters.push(limit, offset);
				const { results } = await db.prepare(
					`SELECT s.*, (SELECT COUNT(*) FROM space_members sm WHERE sm.space_id = s.id) AS member_count
					 FROM spaces s ${where}
					 ORDER BY s.created_at DESC, s.id DESC LIMIT ? OFFSET ?`
				).bind(...parameters).all();
				return json((results || []).map(normalizeSpaceRow));
			}

			if (method === 'POST' && pathname === '/spaces') {
				const body = await request.json();
				const id = String(body.id || '').trim();
				const ownerId = Number(body.ownerId ?? body.owner_id);
				const name = String(body.name || '').trim();
				const visibility = String(body.visibility || 'public');
				if (!id || !Number.isInteger(ownerId) || ownerId < 0 || !name || name.length > 50 || !['public', 'private', 'group'].includes(visibility)) return badRequest('Invalid space');
				const description = String(body.description || '');
				if (description.length > 2000) return badRequest('Invalid description');
				const now = body.createdAt || new Date().toISOString();
				await db.prepare(
					'INSERT INTO spaces (id, owner_id, name, description, icon_data, header_image, visibility, group_id, created_at, updated_at, stage_settings) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
				).bind(id, ownerId, name, description, body.iconData ?? body.icon_data ?? null, body.headerImage ?? body.header_image ?? null, visibility, body.groupId ?? body.group_id ?? null, now, now, body.stage_settings || null).run();
				const row = await db.prepare('SELECT s.*, 0 AS member_count FROM spaces s WHERE s.id = ?').bind(id).first();
				return json(normalizeSpaceRow(row));
			}

			if (method === 'GET' && pathname.match(/^\/spaces\/([^/]+)$/)) {
				const spaceId = decodeURIComponent(pathname.split('/')[2]);
				const row = await db.prepare(
					`SELECT s.*, (SELECT COUNT(*) FROM space_members sm WHERE sm.space_id = s.id) AS member_count
					 FROM spaces s WHERE s.id = ? LIMIT 1`
				).bind(spaceId).first();
				return json(normalizeSpaceRow(row));
			}

			if (method === 'PATCH' && pathname.match(/^\/spaces\/([^/]+)$/)) {
				const spaceId = decodeURIComponent(pathname.split('/')[2]);
				const body = await request.json();
				const sets = [];
				const values = [];
				if (body.name !== undefined) { sets.push('name = ?'); values.push(String(body.name).trim()); }
				if (body.description !== undefined) { sets.push('description = ?'); values.push(String(body.description || '')); }
				if (body.stage_settings !== undefined) { sets.push('stage_settings = ?'); values.push(body.stage_settings); }
				if (body.iconData !== undefined || body.icon_data !== undefined) { sets.push('icon_data = ?'); values.push(body.iconData ?? body.icon_data ?? null); }
				if (body.headerImage !== undefined || body.header_image !== undefined) { sets.push('header_image = ?'); values.push(body.headerImage ?? body.header_image ?? null); }
				if (body.visibility !== undefined) {
					const visibility = String(body.visibility);
					if (!['public', 'private', 'group'].includes(visibility)) return badRequest('Invalid visibility');
					sets.push('visibility = ?'); values.push(visibility);
				}
				if (body.groupId !== undefined || body.group_id !== undefined) { sets.push('group_id = ?'); values.push(body.groupId ?? body.group_id ?? null); }
				if (sets.length === 0) return badRequest('No space fields');
				sets.push('updated_at = ?');
				values.push(new Date().toISOString(), spaceId);
				await db.prepare(`UPDATE spaces SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
				const row = await db.prepare(
					`SELECT s.*, (SELECT COUNT(*) FROM space_members sm WHERE sm.space_id = s.id) AS member_count
					 FROM spaces s WHERE s.id = ? LIMIT 1`
				).bind(spaceId).first();
				return json(normalizeSpaceRow(row));
			}

			if (method === 'DELETE' && pathname.match(/^\/spaces\/([^/]+)$/)) {
				const spaceId = decodeURIComponent(pathname.split('/')[2]);
				const info = await db.prepare('DELETE FROM spaces WHERE id = ?').bind(spaceId).run();
				return json({ deleted: Number(info?.meta?.changes || 0) > 0 });
			}

			if (method === 'GET' && pathname.match(/^\/spaces\/([^/]+)\/channels$/)) {
				const spaceId = decodeURIComponent(pathname.split('/')[2]);
				const { results } = await db.prepare('SELECT * FROM space_channels WHERE space_id = ? ORDER BY sort_order ASC, created_at ASC').bind(spaceId).all();
				return json((results || []).map(normalizeSpaceChannelRow));
			}

			if (method === 'GET' && pathname.match(/^\/spaces\/([^/]+)\/members$/)) {
				const spaceId = decodeURIComponent(pathname.split('/')[2]);
				const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 100), 200));
				const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
				const { results } = await db.prepare('SELECT * FROM space_members WHERE space_id = ? ORDER BY joined_at ASC LIMIT ? OFFSET ?')
					.bind(spaceId, limit, offset).all();
				return json((results || []).map(normalizeSpaceMemberRow));
			}

			if (method === 'GET' && pathname.match(/^\/spaces\/([^/]+)\/members\/(\d+)$/)) {
				const spaceId = decodeURIComponent(pathname.split('/')[2]);
				const userId = Number(pathname.split('/')[4]);
				const row = await db.prepare('SELECT * FROM space_members WHERE space_id = ? AND user_id = ? LIMIT 1').bind(spaceId, userId).first();
				return json(normalizeSpaceMemberRow(row));
			}

			if (method === 'POST' && pathname.match(/^\/spaces\/([^/]+)\/member-count$/)) {
				const spaceId = decodeURIComponent(pathname.split('/')[2]);
				await db.prepare('UPDATE spaces SET updated_at = ? WHERE id = ?').bind(new Date().toISOString(), spaceId).run();
				const row = await db.prepare('SELECT COUNT(*) AS count FROM space_members WHERE space_id = ?').bind(spaceId).first();
				return json({ memberCount: Number(row?.count || 0), member_count: Number(row?.count || 0) });
			}

			if (method === 'POST' && pathname.match(/^\/spaces\/([^/]+)\/members$/)) {
				const spaceId = decodeURIComponent(pathname.split('/')[2]);
				const body = await request.json();
				const userId = Number(body.userId ?? body.user_id);
				if (!Number.isInteger(userId) || userId < 0) return badRequest('Invalid member');
				const role = String(body.role || 'member');
				if (!['owner', 'member'].includes(role)) return badRequest('Invalid role');
				const now = body.joinedAt || new Date().toISOString();
				await db.prepare(
					`INSERT INTO space_members (space_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)
					 ON CONFLICT (space_id, user_id) DO UPDATE SET role = EXCLUDED.role`
				).bind(spaceId, userId, role, now).run();
				const row = await db.prepare('SELECT * FROM space_members WHERE space_id = ? AND user_id = ? LIMIT 1').bind(spaceId, userId).first();
				return json(normalizeSpaceMemberRow(row));
			}

			if (method === 'DELETE' && pathname.match(/^\/spaces\/([^/]+)\/members\/(\d+)$/)) {
				const spaceId = decodeURIComponent(pathname.split('/')[2]);
				const userId = Number(pathname.split('/')[4]);
				const info = await db.prepare('DELETE FROM space_members WHERE space_id = ? AND user_id = ?').bind(spaceId, userId).run();
				return json({ removed: Number(info?.meta?.changes || 0) > 0 });
			}

			if (method === 'GET' && pathname.match(/^\/spaces\/channels\/([^/]+)\/messages$/)) {
				const channelId = decodeURIComponent(pathname.split('/')[3]);
				const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 50), 100));
				const beforeIdRaw = url.searchParams.get('before_id');
				const parameters = [channelId];
				let beforeClause = '';
				if (beforeIdRaw != null && Number.isFinite(Number(beforeIdRaw))) {
					parameters.push(Number(beforeIdRaw));
					beforeClause = 'AND id < ?';
				}
				parameters.push(limit);
				const { results } = await db.prepare(
					`SELECT * FROM space_messages WHERE channel_id = ? ${beforeClause} ORDER BY id DESC LIMIT ?`
				).bind(...parameters).all();
				return json((results || []).map(normalizeSpaceMessageRow));
			}

			if (method === 'POST' && pathname.match(/^\/spaces\/channels\/([^/]+)\/messages$/)) {
				const channelId = decodeURIComponent(pathname.split('/')[3]);
				const body = await request.json();
				const spaceId = String(body.spaceId ?? body.space_id ?? '').trim();
				const userId = Number(body.userId ?? body.user_id);
				const content = String(body.content || '').trim();
				if (!spaceId || !Number.isInteger(userId) || userId < 0 || !content || content.length > 2000) return badRequest('Invalid message');
				const now = body.createdAt || new Date().toISOString();
				const info = await db.prepare('INSERT INTO space_messages (space_id, channel_id, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)')
					.bind(spaceId, channelId, userId, content, now).run();
				const row = await db.prepare('SELECT * FROM space_messages WHERE id = ?').bind(info.meta.last_row_id).first();
				return json(normalizeSpaceMessageRow(row));
			}

			if (method === 'GET' && pathname.match(/^\/spaces\/messages\/(\d+)$/)) {
				const messageId = Number(pathname.split('/')[3]);
				const row = await db.prepare('SELECT * FROM space_messages WHERE id = ? LIMIT 1').bind(messageId).first();
				return json(normalizeSpaceMessageRow(row));
			}

			if (method === 'DELETE' && pathname.match(/^\/spaces\/messages\/(\d+)$/)) {
				const messageId = Number(pathname.split('/')[3]);
				const info = await db.prepare('DELETE FROM space_messages WHERE id = ?').bind(messageId).run();
				return json({ deleted: Number(info?.meta?.changes || 0) > 0 });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/bootstrap$/)) {
				const userId = Number(pathname.split('/')[2]);
				const notifLimit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 200), 200));

				const [
					followsRes,
					likesRes,
					starsRes,
					pinnedRes,
					notifsRes,
					unreadCountRes,
					badgesRes,
				] = await db.batch([
					db.prepare('SELECT following_id FROM follows WHERE follower_id = ? ORDER BY created_at DESC, following_id ASC').bind(userId),
					db.prepare('SELECT post_id FROM likes WHERE user_id = ? ORDER BY created_at DESC').bind(userId),
					db.prepare('SELECT post_id FROM stars WHERE user_id = ? ORDER BY created_at DESC').bind(userId),
					db.prepare('SELECT post_id FROM pinned_posts WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').bind(userId),
					db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').bind(userId, notifLimit),
					db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND read = 0').bind(userId),
					db.prepare(`SELECT g.id, g.name, g.icon_data
						FROM group_memberships gm
						JOIN groups g ON g.id = gm.group_id
						WHERE gm.user_id = ? AND gm.status = 'active'
						  AND g.deleted_at IS NULL AND g.icon_data IS NOT NULL AND g.icon_data <> ''
						  AND g.visibility IN ('open', 'open_invite')
						ORDER BY gm.joined_at DESC, g.created_at DESC
						LIMIT 5`).bind(userId),
				]);

				const notifications = (notifsRes?.results || []).map((r) => ({
					id: Number(r.id),
					userId: Number(r.user_id),
					user_id: Number(r.user_id),
					type: r.type,
					fromUserId: r.from_user_id != null ? Number(r.from_user_id) : null,
					from_user_id: r.from_user_id != null ? Number(r.from_user_id) : null,
					postId: r.post_id != null ? Number(r.post_id) : null,
					post_id: r.post_id != null ? Number(r.post_id) : null,
					target: parseJson(r.target, null),
					message: r.message || null,
					read: Boolean(r.read),
					clicked: Boolean(r.clicked),
					createdAt: toIsoString(r.created_at),
					created_at: toIsoString(r.created_at),
				}));

				return json({
					follow: (followsRes?.results || []).map((r) => Number(r.following_id)).filter(Number.isInteger),
					like: (likesRes?.results || []).map((r) => Number(r.post_id)).filter(Number.isInteger),
					star: (starsRes?.results || []).map((r) => Number(r.post_id)).filter(Number.isInteger),
					pin: pinnedRes?.results?.[0]?.post_id != null ? Number(pinnedRes.results[0].post_id) : null,
					unreadCount: Number(unreadCountRes?.results?.[0]?.count || 0),
					group_badges: (badgesRes?.results || []).map((gb) => ({
						id: String(gb.id),
						name: String(gb.name || ''),
						icon_data: gb.icon_data,
					})),
					notifications,
				});
			}

			if (method === 'GET' && pathname.match(/^\/groups\/[^/]+\/roles$/)) {
				const groupId = decodeURIComponent(pathname.split('/')[2]);
				const { results } = await db.prepare('SELECT * FROM group_roles WHERE group_id = ? ORDER BY sort_order ASC, name ASC, id ASC').bind(groupId).all();
				return json((results || []).map(normalizeGroupRoleRow));
			}

			if (method === 'POST' && pathname.match(/^\/groups\/[^/]+\/roles$/)) {
				const groupId = decodeURIComponent(pathname.split('/')[2]); const body = await request.json(); const id = String(body.id || '').trim(); const name = String(body.name || '').trim();
				if (!id || !name || name.length > 50 || !Array.isArray(body.permissions)) return badRequest('Invalid role');
				const now = body.createdAt || new Date().toISOString();
				await db.prepare('INSERT INTO group_roles (id, group_id, name, permissions, is_system, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
					.bind(id, groupId, name, JSON.stringify(body.permissions.map(String)), body.isSystem ? 1 : 0, Number(body.sortOrder) || 0, now, now).run();
				return json(normalizeGroupRoleRow(await db.prepare('SELECT * FROM group_roles WHERE id = ?').bind(id).first()));
			}

			if (method === 'PATCH' && pathname.match(/^\/group-roles\/[^/]+$/)) {
				const roleId = decodeURIComponent(pathname.split('/')[2]); const body = await request.json(); const sets = []; const values = [];
				if (body.name !== undefined) { const name = String(body.name).trim(); if (!name || name.length > 50) return badRequest('Invalid role name'); sets.push('name = ?'); values.push(name); }
				if (body.permissions !== undefined) { if (!Array.isArray(body.permissions)) return badRequest('Invalid permissions'); sets.push('permissions = ?'); values.push(JSON.stringify(body.permissions.map(String))); }
				if (body.sortOrder !== undefined || body.sort_order !== undefined) { sets.push('sort_order = ?'); values.push(Number(body.sortOrder ?? body.sort_order) || 0); }
				if (sets.length === 0) return badRequest('No editable fields');
				sets.push('updated_at = ?'); values.push(new Date().toISOString(), roleId);
				await db.prepare(`UPDATE group_roles SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
				const row = await db.prepare('SELECT * FROM group_roles WHERE id = ?').bind(roleId).first(); return row ? json(normalizeGroupRoleRow(row)) : notFound('Group role not found');
			}

			if (method === 'DELETE' && pathname.match(/^\/group-roles\/[^/]+$/)) {
				const roleId = decodeURIComponent(pathname.split('/')[2]); const row = await db.prepare('SELECT * FROM group_roles WHERE id = ?').bind(roleId).first();
				if (!row) return notFound('Group role not found'); await db.prepare('DELETE FROM group_roles WHERE id = ?').bind(roleId).run(); return json(normalizeGroupRoleRow(row));
			}

			if (method === 'GET' && pathname.match(/^\/groups\/[^/]+\/members\/\d+$/)) {
				const [, , encodedGroupId, , rawUserId] = pathname.split('/'); const row = await db.prepare('SELECT * FROM group_memberships WHERE group_id = ? AND user_id = ?').bind(decodeURIComponent(encodedGroupId), Number(rawUserId)).first();
				return row ? json(normalizeGroupMembershipRow(row)) : notFound('Group membership not found');
			}

			if (method === 'GET' && pathname.match(/^\/groups\/[^/]+\/members$/)) {
				const groupId = decodeURIComponent(pathname.split('/')[2]); const status = url.searchParams.get('status'); const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 100), 200)); const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
				const stmt = status ? db.prepare('SELECT * FROM group_memberships WHERE group_id = ? AND status = ? ORDER BY joined_at ASC, user_id ASC LIMIT ? OFFSET ?').bind(groupId, status, limit, offset) : db.prepare('SELECT * FROM group_memberships WHERE group_id = ? ORDER BY joined_at ASC, user_id ASC LIMIT ? OFFSET ?').bind(groupId, limit, offset);
				const { results } = await stmt.all(); return json((results || []).map(normalizeGroupMembershipRow));
			}

			if (method === 'POST' && pathname.match(/^\/groups\/[^/]+\/members$/)) {
				const groupId = decodeURIComponent(pathname.split('/')[2]); const body = await request.json(); const userId = Number(body.userId ?? body.user_id);
				if (!Number.isInteger(userId) || userId < 0) return badRequest('Invalid user'); const now = body.updatedAt || new Date().toISOString();
				await db.prepare(`INSERT INTO group_memberships (group_id, user_id, role_id, status, joined_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
					ON CONFLICT(group_id, user_id) DO UPDATE SET role_id=excluded.role_id, status=excluded.status, joined_at=excluded.joined_at, updated_at=excluded.updated_at`)
					.bind(groupId, userId, body.roleId ?? body.role_id ?? null, String(body.status || 'active'), body.joinedAt ?? body.joined_at ?? null, now).run();
				return json(normalizeGroupMembershipRow(await db.prepare('SELECT * FROM group_memberships WHERE group_id = ? AND user_id = ?').bind(groupId, userId).first()));
			}

			if (method === 'PATCH' && pathname.match(/^\/groups\/[^/]+\/members\/\d+$/)) {
				const [, , encodedGroupId, , rawUserId] = pathname.split('/'); const groupId = decodeURIComponent(encodedGroupId); const userId = Number(rawUserId); const body = await request.json(); const sets = []; const values = [];
				if (body.roleId !== undefined || body.role_id !== undefined) { sets.push('role_id = ?'); values.push(body.roleId ?? body.role_id ?? null); }
				if (body.status !== undefined) { sets.push('status = ?'); values.push(String(body.status)); }
				if (body.joinedAt !== undefined || body.joined_at !== undefined) { sets.push('joined_at = ?'); values.push(body.joinedAt ?? body.joined_at ?? null); }
				if (sets.length === 0) return badRequest('No editable fields'); sets.push('updated_at = ?'); values.push(new Date().toISOString(), groupId, userId);
				await db.prepare(`UPDATE group_memberships SET ${sets.join(', ')} WHERE group_id = ? AND user_id = ?`).bind(...values).run(); const row = await db.prepare('SELECT * FROM group_memberships WHERE group_id = ? AND user_id = ?').bind(groupId, userId).first(); return row ? json(normalizeGroupMembershipRow(row)) : notFound('Group membership not found');
			}

			if (method === 'POST' && pathname.match(/^\/groups\/[^/]+\/invites$/)) {
				const groupId = decodeURIComponent(pathname.split('/')[2]); const body = await request.json(); const id = String(body.id || '').trim(); const inviterId = Number(body.inviterId ?? body.inviter_id); const inviteeId = Number(body.inviteeId ?? body.invitee_id);
				if (!id || !Number.isInteger(inviterId) || !Number.isInteger(inviteeId)) return badRequest('Invalid invite'); const now = body.createdAt || new Date().toISOString();
				await db.prepare('INSERT INTO group_invites (id, group_id, inviter_id, invitee_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, groupId, inviterId, inviteeId, String(body.status || 'pending'), now).run(); return json(normalizeGroupInviteRow(await db.prepare('SELECT * FROM group_invites WHERE id = ?').bind(id).first()));
			}

			if (method === 'GET' && pathname === '/group-invites') {
				const groupId = url.searchParams.get('groupId'); const inviteeId = url.searchParams.get('inviteeId'); const status = url.searchParams.get('status'); const clauses = []; const values = [];
				if (groupId) { clauses.push('group_id = ?'); values.push(groupId); } if (inviteeId != null) { clauses.push('invitee_id = ?'); values.push(Number(inviteeId)); } if (status) { clauses.push('status = ?'); values.push(status); }
				if (!clauses.length) return json([]); values.push(Math.max(1, Math.min(Number(url.searchParams.get('limit') || 100), 200)), Math.max(0, Number(url.searchParams.get('offset') || 0)));
				const { results } = await db.prepare(`SELECT * FROM group_invites WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(...values).all(); return json((results || []).map(normalizeGroupInviteRow));
			}

			if (method === 'GET' && pathname.match(/^\/group-invites\/[^/]+$/)) {
				const row = await db.prepare('SELECT * FROM group_invites WHERE id = ?').bind(decodeURIComponent(pathname.split('/')[2])).first(); return row ? json(normalizeGroupInviteRow(row)) : notFound('Group invite not found');
			}

			if (method === 'PATCH' && pathname.match(/^\/group-invites\/[^/]+$/)) {
				const inviteId = decodeURIComponent(pathname.split('/')[2]); const body = await request.json(); const sets = []; const values = [];
				if (body.status !== undefined) { sets.push('status = ?'); values.push(String(body.status)); } if (body.respondedAt !== undefined || body.responded_at !== undefined) { sets.push('responded_at = ?'); values.push(body.respondedAt ?? body.responded_at ?? null); } else if (body.status && body.status !== 'pending') sets.push(`responded_at = '${new Date().toISOString()}'`);
				if (!sets.length) return badRequest('No editable fields'); values.push(inviteId); await db.prepare(`UPDATE group_invites SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run(); const row = await db.prepare('SELECT * FROM group_invites WHERE id = ?').bind(inviteId).first(); return row ? json(normalizeGroupInviteRow(row)) : notFound('Group invite not found');
			}

			if (method === 'POST' && pathname.match(/^\/groups\/[^/]+\/join-requests$/)) {
				const groupId = decodeURIComponent(pathname.split('/')[2]); const body = await request.json(); const id = String(body.id || '').trim(); const userId = Number(body.userId ?? body.user_id); if (!id || !Number.isInteger(userId)) return badRequest('Invalid join request'); const now = body.createdAt || new Date().toISOString();
				await db.prepare('INSERT INTO group_join_requests (id, group_id, user_id, status, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, groupId, userId, String(body.status || 'pending'), now).run(); return json(normalizeGroupJoinRequestRow(await db.prepare('SELECT * FROM group_join_requests WHERE id = ?').bind(id).first()));
			}

			if (method === 'GET' && pathname === '/group-join-requests') {
				const groupId = url.searchParams.get('groupId'); const userId = url.searchParams.get('userId'); const status = url.searchParams.get('status'); const clauses = []; const values = [];
				if (groupId) { clauses.push('group_id = ?'); values.push(groupId); } if (userId != null) { clauses.push('user_id = ?'); values.push(Number(userId)); } if (status) { clauses.push('status = ?'); values.push(status); } if (!clauses.length) return json([]);
				values.push(Math.max(1, Math.min(Number(url.searchParams.get('limit') || 100), 200)), Math.max(0, Number(url.searchParams.get('offset') || 0))); const { results } = await db.prepare(`SELECT * FROM group_join_requests WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(...values).all(); return json((results || []).map(normalizeGroupJoinRequestRow));
			}

			if (method === 'GET' && pathname.match(/^\/group-join-requests\/[^/]+$/)) { const row = await db.prepare('SELECT * FROM group_join_requests WHERE id = ?').bind(decodeURIComponent(pathname.split('/')[2])).first(); return row ? json(normalizeGroupJoinRequestRow(row)) : notFound('Group join request not found'); }

			if (method === 'PATCH' && pathname.match(/^\/group-join-requests\/[^/]+$/)) {
				const requestId = decodeURIComponent(pathname.split('/')[2]); const body = await request.json(); const sets = []; const values = [];
				if (body.status !== undefined) { sets.push('status = ?'); values.push(String(body.status)); } if (body.reviewedBy !== undefined || body.reviewed_by !== undefined) { sets.push('reviewed_by = ?'); values.push(body.reviewedBy ?? body.reviewed_by ?? null); } if (body.reviewedAt !== undefined || body.reviewed_at !== undefined) { sets.push('reviewed_at = ?'); values.push(body.reviewedAt ?? body.reviewed_at ?? null); } else if (body.status && body.status !== 'pending') sets.push(`reviewed_at = '${new Date().toISOString()}'`);
				if (!sets.length) return badRequest('No editable fields'); values.push(requestId); await db.prepare(`UPDATE group_join_requests SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run(); const row = await db.prepare('SELECT * FROM group_join_requests WHERE id = ?').bind(requestId).first(); return row ? json(normalizeGroupJoinRequestRow(row)) : notFound('Group join request not found');
			}

			if (method === 'GET' && pathname.match(/^\/groups\/[^/]+\/(posts|announcements)$/)) {
				const groupId = decodeURIComponent(pathname.split('/')[2]); const onlyAnnouncements = pathname.endsWith('/announcements'); const subType = url.searchParams.get('subType') === 'replies_only' ? 'replies_only' : 'posts_only'; const order = ['oldest', 'recommended'].includes(url.searchParams.get('order')) ? url.searchParams.get('order') : 'latest'; const orderSql = order === 'oldest' ? 'created_at ASC, id ASC' : order === 'recommended' ? '(COALESCE(like_count,0)*2 + COALESCE(star_count,0)*3 + COALESCE(repost_count,0)*4 + COALESCE(reply_count,0)) DESC, created_at DESC, id DESC' : 'created_at DESC, id DESC'; const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 30), 100)); const offset = Math.max(0, Number(url.searchParams.get('offset') || 0)); const beforeId = order === 'latest' ? (Number(url.searchParams.get('beforeId')) || null) : null; const authorId = Number.isInteger(Number(url.searchParams.get('authorId'))) && Number(url.searchParams.get('authorId')) >= 0 ? Number(url.searchParams.get('authorId')) : null;
				const decodedCursor = order === 'latest' ? decodePostCursor(url.searchParams.get('cursor')) : null;
				const clauses = ['group_id = ?']; const values = [groupId]; if (onlyAnnouncements) clauses.push('group_announcement = 1'); else clauses.push(subType === 'replies_only' ? 'reply_to IS NOT NULL' : 'reply_to IS NULL'); if (authorId != null) { clauses.push('user_id = ?'); values.push(authorId); }
				if (decodedCursor) { clauses.push('(created_at < ? OR (created_at = ? AND id < ?))'); values.push(decodedCursor.createdAt, decodedCursor.createdAt, decodedCursor.id); } else if (beforeId) { clauses.push('id < ?'); values.push(beforeId); }
				values.push(limit + 1); let offsetSql = ''; if (!beforeId && !decodedCursor) { values.push(offset); offsetSql = ' OFFSET ?'; }
				const { results } = await db.prepare(`SELECT id, created_at FROM posts WHERE ${clauses.join(' AND ')} ORDER BY ${orderSql} LIMIT ?${offsetSql}`).bind(...values).all(); const rows = results || []; const selectedRows = rows.slice(0, limit); const ids = selectedRows.map((row) => Number(row.id)); const lastRow = selectedRows.length > 0 ? selectedRows[selectedRows.length - 1] : null; const nextCursor = order === 'latest' && rows.length > limit && lastRow ? (encodePostCursor(lastRow) || ids.at(-1) || null) : null; return json({ ids, has_more: rows.length > limit, next_cursor: nextCursor, use_offset_pagination: order !== 'latest' });
			}

			if (method === 'GET' && pathname === '/group-posts/search') {
				const searchFilters = url.searchParams.get('searchFilters'); const userId = Number(url.searchParams.get('userId')); const query = String(url.searchParams.get('query') || '').trim().toLowerCase(); if (!Number.isInteger(userId) || (!query && !searchFilters)) return json({ ids: [], has_more: false, next_cursor: null }); const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 30), 100)); const offset = Math.max(0, Number(url.searchParams.get('offset') || 0)); const beforeId = Number(url.searchParams.get('beforeId')) || null;
				const decodedCursor = decodePostCursor(url.searchParams.get('cursor'));
				const values = searchFilters ? [userId] : [userId, `%${query}%`]; const clauses = ["gm.user_id = ?", "gm.status = 'active'", ...(searchFilters ? buildPostSearchSql(JSON.parse(searchFilters), { dialect: 'sqlite', values, alias: 'p' }).clauses : ['LOWER(p.content) LIKE ?'])];
				if (decodedCursor) { clauses.push('(p.created_at < ? OR (p.created_at = ? AND p.id < ?))'); values.push(decodedCursor.createdAt, decodedCursor.createdAt, decodedCursor.id); } else if (beforeId) { clauses.push('p.id < ?'); values.push(beforeId); }
				values.push(limit + 1); let offsetSql = ''; if (!beforeId && !decodedCursor) { values.push(offset); offsetSql = ' OFFSET ?'; }
				const { results } = await db.prepare(`SELECT p.id, p.created_at FROM posts p JOIN group_memberships gm ON gm.group_id = p.group_id WHERE ${clauses.join(' AND ')} ORDER BY p.created_at DESC, p.id DESC LIMIT ?${offsetSql}`).bind(...values).all(); const rows = results || []; const selectedRows = rows.slice(0, limit); const ids = selectedRows.map((row) => Number(row.id)); const lastRow = selectedRows.length > 0 ? selectedRows[selectedRows.length - 1] : null; const nextCursor = rows.length > limit && lastRow ? (encodePostCursor(lastRow) || ids.at(-1) || null) : null; return json({ ids, has_more: rows.length > limit, next_cursor: nextCursor });
			}

			if (method === 'GET' && pathname === '/posts/scheduled/due') {
				const now = new Date(url.searchParams.get('now') || Date.now()).toISOString();
				const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 100));
				const { results } = await db.prepare('SELECT * FROM posts WHERE scheduled_at IS NOT NULL AND scheduled_at <= ? ORDER BY scheduled_at ASC LIMIT ?').bind(now, limit).all();
				return json((results || []).map(normalizePostRow));
			}
			if (method === 'POST' && /^\/posts\/\d+\/publish-scheduled$/.test(pathname)) {
				const postId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const now = new Date(body.now || Date.now()).toISOString();
				const published = await db.prepare('UPDATE posts SET scheduled_at = NULL, created_at = ? WHERE id = ? AND scheduled_at IS NOT NULL AND scheduled_at <= ? RETURNING *').bind(now, postId, now).first();
				if (published?.reply_to) await db.prepare('UPDATE posts SET reply_count = reply_count + 1 WHERE id = ?').bind(published.reply_to).run();
				if (published?.repost_to) await db.prepare('UPDATE posts SET repost_count = repost_count + 1 WHERE id = ?').bind(published.repost_to).run();
				if (published) await adjustUserKeywordAffinitiesForTags(db, Number(published.user_id), normalizePostTags(published.tags), 1);
				return json(published ? normalizePostRow(published) : null);
			}
			if (method === 'POST' && pathname === '/posts') {
				const postData = await request.json();
				const userId = Number(postData.userId);
				const content = postData.content || '';
				const attachments = postData.attachments ? JSON.stringify(postData.attachments) : null;
				const mask = postData.mask ? 1 : 0;
				const lock = postData.lock ? 1 : 0;
				const announcement = postData.announcement ? 1 : 0;
				const replyTo = (postData.replyTo ?? postData.reply_to ?? postData.reply_id) ? Number(postData.replyTo ?? postData.reply_to ?? postData.reply_id) : null;
				const repostTo = (postData.repostTo ?? postData.repost_to ?? postData.repost_id) ? Number(postData.repostTo ?? postData.repost_to ?? postData.repost_id) : null;
				const normalizedTags = normalizePostTags(postData.tags);
				const tags = JSON.stringify(normalizedTags);
				const tagsGeneratedAt = postData.tagsGeneratedAt || null;
				const groupId = postData.groupId ?? postData.group_id ?? null;
				const groupAnnouncement = postData.groupAnnouncement ?? postData.group_announcement ? 1 : 0;
				const scheduledAt = postData.scheduledAt ?? null;
				const now = postData.createdAt ? new Date(postData.createdAt).toISOString() : new Date().toISOString();
				const hasExplicitId = postData.id != null && Number.isSafeInteger(Number(postData.id)) && Number(postData.id) > 0;

				let createdId;
				if (hasExplicitId) {
					createdId = Number(postData.id);
					await db.prepare(
						`INSERT INTO posts (id, user_id, content, attachments, mask, lock, announcement, reply_to, repost_to, tags, tags_generated_at, group_id, group_announcement, created_at, scheduled_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
					).bind(createdId, userId, content, attachments, mask, lock, announcement, replyTo, repostTo, tags, tagsGeneratedAt, groupId, groupAnnouncement, now, scheduledAt).run();
				} else {
					const res = await db.prepare(
						`INSERT INTO posts (user_id, content, attachments, mask, lock, announcement, reply_to, repost_to, tags, tags_generated_at, group_id, group_announcement, created_at, scheduled_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
					).bind(userId, content, attachments, mask, lock, announcement, replyTo, repostTo, tags, tagsGeneratedAt, groupId, groupAnnouncement, now, scheduledAt).run();
					createdId = res.meta.last_row_id;
				}

				const created = await db.prepare('SELECT * FROM posts WHERE id = ?').bind(createdId).first();
				if (!scheduledAt) await adjustUserKeywordAffinitiesForTags(db, userId, normalizedTags, 1);
				return json(normalizePostRow(created));
			}

			if (method === 'POST' && pathname === '/post-events/enqueue') {
				const body = await request.json();
				const eventType = String(body.eventType || body.event_type || '');
				if (!eventType) return badRequest('eventType is required');
				const postId = body.postId != null || body.post_id != null ? Number(body.postId ?? body.post_id) : null;
				const payload = typeof body.payload === 'object' && body.payload !== null ? JSON.stringify(body.payload) : String(body.payload || '{}');
				const availableAt = body.availableAt || body.available_at || new Date().toISOString();
				const now = new Date().toISOString();

				const res = await db.prepare(
					`INSERT INTO post_events (event_type, post_id, payload, available_at, created_at)
					 VALUES (?, ?, ?, ?, ?)`
				).bind(eventType, postId, payload, availableAt, now).run();

				const createdId = res.meta.last_row_id;
				const created = await db.prepare('SELECT * FROM post_events WHERE id = ?').bind(createdId).first();
				return json(normalizePostEventRow(created));
			}

			if (method === 'POST' && pathname === '/post-events/claim') {
				const body = await request.json();
				const safeLimit = Math.max(1, Math.min(Number(body.limit || 50), 500));
				const workerId = body.workerId != null ? String(body.workerId) : null;
				const now = new Date().toISOString();
				const stale = new Date(Date.now() - 60000).toISOString();

				const rows = await db.prepare(
					`UPDATE post_events
					 SET status = 'processing', attempts = attempts + 1, locked_at = ?, worker_id = ?
					 WHERE id IN (
						 SELECT id FROM post_events
						 WHERE (status = 'pending' AND available_at <= ?)
						    OR (status = 'processing' AND locked_at < ?)
						 ORDER BY available_at ASC, id ASC
						 LIMIT ?
					 )
					 RETURNING *`
				).bind(now, workerId, now, stale, safeLimit).all();

				return json((rows.results || []).map(normalizePostEventRow));
			}

			if (method === 'POST' && pathname.match(/^\/post-events\/(\d+)\/complete$/)) {
				const eventId = Number(pathname.split('/')[2]);
				const res = await db.prepare(
					`UPDATE post_events
					 SET status = 'completed', locked_at = NULL, processed_at = datetime('now'), last_error = NULL
					 WHERE id = ? AND status = 'processing'`
				).bind(eventId).run();
				return json({ success: res.meta.changes > 0 });
			}

			if (method === 'POST' && pathname.match(/^\/post-events\/(\d+)\/fail$/)) {
				const eventId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const retryAt = body.retryAt || body.retry_at || null;
				const errorMessage = String(body.error || 'Unknown error').slice(0, 2000);

				let res;
				if (retryAt) {
					res = await db.prepare(
						`UPDATE post_events
						 SET status = 'pending', available_at = ?, locked_at = NULL, last_error = ?
						 WHERE id = ? AND status = 'processing'`
					).bind(new Date(retryAt).toISOString(), errorMessage, eventId).run();
				} else {
					res = await db.prepare(
						`UPDATE post_events
						 SET status = 'failed', locked_at = NULL, last_error = ?
						 WHERE id = ? AND status = 'processing'`
					).bind(errorMessage, eventId).run();
				}
				return json({ success: res.meta.changes > 0 });
			}

			if (method === 'POST' && pathname === '/posts/batch') {
				const body = await request.json();
				const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isSafeInteger) : [];
				if (ids.length === 0) return json([]);

				const placeholders = ids.map(() => '?').join(', ');
				const { results } = await db.prepare(`SELECT * FROM posts WHERE id IN (${placeholders})`).bind(...ids).all();
				return json((results || []).map(normalizePostRow));
			}

			if (method === 'POST' && pathname === '/posts/metrics/batch') {
				const body = await request.json();
				const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isSafeInteger) : [];
				const currentUserId = body.currentUserId != null ? Number(body.currentUserId) : null;
				if (ids.length === 0) return json([]);

				const requestedValues = ids.map(() => '(?)').join(', ');
				const viewerColumns = currentUserId
					? `EXISTS (SELECT 1 FROM likes viewer_likes WHERE viewer_likes.post_id = requested.id AND viewer_likes.user_id = ?) AS liked_by_me,
						EXISTS (SELECT 1 FROM stars viewer_stars WHERE viewer_stars.post_id = requested.id AND viewer_stars.user_id = ?) AS starred_by_me`
					: '0 AS liked_by_me, 0 AS starred_by_me';
				const bindings = currentUserId
					? [...ids, currentUserId, currentUserId]
					: ids;
				const { results } = await db.prepare(
					`WITH requested(id) AS (VALUES ${requestedValues}),
						like_counts AS (
							SELECT likes.post_id, COUNT(*) AS count
							FROM likes JOIN requested ON requested.id = likes.post_id
							GROUP BY likes.post_id
						), star_counts AS (
							SELECT stars.post_id, COUNT(*) AS count
							FROM stars JOIN requested ON requested.id = stars.post_id
							GROUP BY stars.post_id
						), repost_counts AS (
							SELECT reposts.post_id, COUNT(*) AS count
							FROM reposts JOIN requested ON requested.id = reposts.post_id
							GROUP BY reposts.post_id
						), reply_counts AS (
							SELECT posts.reply_to AS post_id, COUNT(*) AS count
							FROM posts JOIN requested ON requested.id = posts.reply_to
							GROUP BY posts.reply_to
						)
						SELECT requested.id AS post_id,
							COALESCE(like_counts.count, 0) AS like_count,
							COALESCE(star_counts.count, 0) AS star_count,
							COALESCE(repost_counts.count, 0) AS repost_count,
							COALESCE(reply_counts.count, 0) AS reply_count,
							${viewerColumns}
						FROM requested
						LEFT JOIN like_counts ON like_counts.post_id = requested.id
						LEFT JOIN star_counts ON star_counts.post_id = requested.id
						LEFT JOIN repost_counts ON repost_counts.post_id = requested.id
						LEFT JOIN reply_counts ON reply_counts.post_id = requested.id`
				).bind(...bindings).all();

				const metricsById = new Map((results || []).map((row) => [Number(row.post_id), {
					post_id: Number(row.post_id),
					like_count: Number(row.like_count) || 0,
					star_count: Number(row.star_count) || 0,
					repost_count: Number(row.repost_count) || 0,
					reply_count: Number(row.reply_count) || 0,
					liked_by_me: Boolean(row.liked_by_me),
					starred_by_me: Boolean(row.starred_by_me),
				}]));
				const metrics = ids.map((id) => metricsById.get(id) || {
					post_id: id,
					like_count: 0,
					star_count: 0,
					repost_count: 0,
					reply_count: 0,
					liked_by_me: false,
					starred_by_me: false,
				});
				return json(metrics);
			}

			if (method === 'POST' && pathname === '/posts/reactions/batch') {
				const body = await request.json();
				const ids = [...new Set((Array.isArray(body.ids) ? body.ids : [])
					.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
				const currentUserId = Number(body.currentUserId);
				if (ids.length === 0 || !Number.isSafeInteger(currentUserId) || currentUserId <= 0) return json([]);
				const requestedValues = ids.map(() => '(?)').join(', ');
				const { results } = await db.prepare(
					`WITH requested(post_id) AS (VALUES ${requestedValues})
					 SELECT requested.post_id,
						EXISTS (SELECT 1 FROM likes WHERE post_id = requested.post_id AND user_id = ?) AS liked_by_me,
						EXISTS (SELECT 1 FROM stars WHERE post_id = requested.post_id AND user_id = ?) AS starred_by_me
					 FROM requested`,
				).bind(...ids, currentUserId, currentUserId).all();
				return json(results || []);
			}

			if (method === 'POST' && pathname.match(/^\/posts\/(\d+)$/)) {
				const postId = Number(pathname.split('/')[2]);
				const fields = await request.json();
				const existing = fields.tags !== undefined
					? await db.prepare('SELECT user_id, tags FROM posts WHERE id = ?').bind(postId).first()
					: null;
				const sets = [];
				const values = [];

				if (fields.content !== undefined) { sets.push('content = ?'); values.push(fields.content); }
				if (fields.tags !== undefined) { sets.push('tags = ?'); values.push(JSON.stringify(normalizePostTags(fields.tags))); }
				if (fields.tagsGeneratedAt !== undefined) { sets.push('tags_generated_at = ?'); values.push(fields.tagsGeneratedAt || null); }
				if (fields.attachments !== undefined) { sets.push('attachments = ?'); values.push(fields.attachments ? JSON.stringify(fields.attachments) : null); }
				if (fields.mask !== undefined) { sets.push('mask = ?'); values.push(fields.mask ? 1 : 0); }
				if (fields.lock !== undefined) { sets.push('lock = ?'); values.push(fields.lock ? 1 : 0); }
				if (fields.age_rating !== undefined || fields.ageRating !== undefined) { sets.push('age_rating = ?'); values.push(Number(fields.ageRating ?? fields.age_rating ?? 0) || 0); }

				if (sets.length > 0) {
					values.push(postId);
					await db.prepare(`UPDATE posts SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
				}
				const row = await db.prepare('SELECT * FROM posts WHERE id = ?').bind(postId).first();
				if (row && existing) {
					await adjustUserKeywordAffinitiesForTags(db, existing.user_id, existing.tags, -1);
					await adjustUserKeywordAffinitiesForTags(db, existing.user_id, row.tags, 1);
				}
				return json(normalizePostRow(row));
			}

			if (method === 'POST' && pathname.match(/^\/posts\/(\d+)\/age-estimate$/)) {
				const postId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const userId = Number(body.userId);
				const band = typeof body.band === 'string' ? body.band : '';
				const AGE_BAND_VALUES = ['under13', '13-15', '16-17', '18-24', '25-34', '35over'];
				if (!Number.isSafeInteger(userId) || userId <= 0 || !AGE_BAND_VALUES.includes(band)) return badRequest('Invalid age estimate');
				const post = await db.prepare('SELECT user_id FROM posts WHERE id = ?').bind(postId).first();
				if (!post || Number(post.user_id) !== userId) return badRequest('Age estimate author mismatch');
				await db.prepare(
					'INSERT INTO post_age_estimates (post_id, user_id, band, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(post_id) DO UPDATE SET user_id = excluded.user_id, band = excluded.band, created_at = excluded.created_at',
				).bind(postId, userId, band, new Date().toISOString()).run();
				return json({ success: true });
			}

			if (method === 'POST' && pathname.match(/^\/posts\/(\d+)\/delete$/)) {
				const postId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const userId = Number(body.userId);

				const post = await db.prepare('SELECT user_id FROM posts WHERE id = ?').bind(postId).first();
				if (!post || Number(post.user_id) !== userId) {
					return json({ success: false });
				}
				await db.prepare('DELETE FROM likes WHERE post_id = ?').bind(postId).run();
				await db.prepare('DELETE FROM stars WHERE post_id = ?').bind(postId).run();
				await db.prepare('DELETE FROM reposts WHERE post_id = ?').bind(postId).run();
				await db.prepare('DELETE FROM pinned_posts WHERE post_id = ?').bind(postId).run();
				await db.prepare('DELETE FROM post_feedback WHERE post_id = ?').bind(postId).run();
				await db.prepare('DELETE FROM post_age_estimates WHERE post_id = ?').bind(postId).run();
				await db.prepare('DELETE FROM posts WHERE id = ?').bind(postId).run();
				return json({ success: true });
			}

			if (method === 'POST' && pathname.match(/^\/posts\/(\d+)\/admin-delete$/)) {
				const postId = Number(pathname.split('/')[2]);
				await db.prepare('DELETE FROM likes WHERE post_id = ?').bind(postId).run();
				await db.prepare('DELETE FROM stars WHERE post_id = ?').bind(postId).run();
				await db.prepare('DELETE FROM reposts WHERE post_id = ?').bind(postId).run();
				await db.prepare('DELETE FROM pinned_posts WHERE post_id = ?').bind(postId).run();
				await db.prepare('DELETE FROM post_feedback WHERE post_id = ?').bind(postId).run();
				await db.prepare('DELETE FROM post_age_estimates WHERE post_id = ?').bind(postId).run();
				await db.prepare('DELETE FROM posts WHERE id = ?').bind(postId).run();
				return json({ success: true });
			}

			if (method === 'GET' && pathname === '/posts/recent') {
				const limit = Math.min(Number(url.searchParams.get('limit') || 30), 100);
				const { results } = await db.prepare('SELECT * FROM posts WHERE group_id IS NULL AND reply_to IS NULL ORDER BY created_at DESC, id DESC LIMIT ?').bind(limit).all();
				return json((results || []).map(normalizePostRow));
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/posts$/)) {
				const userId = Number(pathname.split('/')[2]);
				const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100);
				const { results } = await db.prepare('SELECT * FROM posts WHERE user_id = ? AND group_id IS NULL ORDER BY created_at DESC, id DESC LIMIT ?').bind(userId, limit).all();
				return json((results || []).map(normalizePostRow));
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/scheduled$/)) {
				const userId = Number(pathname.split('/')[2]);
				const now = url.searchParams.get('now') || new Date().toISOString();
				const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 50), 1), 100);
				const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);
				const { results } = await db.prepare('SELECT * FROM posts WHERE user_id = ? AND group_id IS NULL AND scheduled_at IS NOT NULL AND scheduled_at > ? ORDER BY scheduled_at ASC LIMIT ? OFFSET ?').bind(userId, now, limit, offset).all();
				return json((results || []).map(normalizePostRow));
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/post-subscribers$/)) {
				const authorUserId = Number(pathname.split('/')[2]);
				const { results } = await db.prepare(
					`SELECT u.id AS id, subscriber.value AS mode
					 FROM users u, json_each(CASE WHEN json_valid(u.settings) = 1
						 THEN json_extract(u.settings, '$.user_notifications') ELSE NULL END) AS subscriber
					 WHERE subscriber.key = ? AND subscriber.value IN ('important', 'media', 'all')`
				).bind(String(authorUserId)).all();
				return json((results || []).map((row) => ({
					userId: Number(row.id),
					mode: row.mode,
				})));
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/audit-counters$/)) {
				const userId = Number(pathname.split('/')[2]);
				const row = await db.prepare(
					`SELECT
						(SELECT COUNT(*) FROM follows WHERE following_id = ?) AS follower_count,
						(SELECT COUNT(*) FROM follows WHERE follower_id = ?) AS following_count,
						(SELECT COUNT(*) FROM posts WHERE user_id = ? AND repost_to IS NULL) AS post_count`
				).bind(userId, userId, userId).first();
				return json({
					userId,
					followerCount: Number(row?.follower_count || 0),
					followingCount: Number(row?.following_count || 0),
					postCount: Number(row?.post_count || 0),
				});
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/keyword-affinity$/)) {
				const userId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const delta = Number(body.delta);
				await adjustUserKeywordAffinitiesForTags(db, userId, body.tags, Number.isFinite(delta) ? delta : 1);
				return json({ success: true });
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/post-feedback$/)) {
				const userId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const postId = Number(body.postId ?? body.post_id);
				const kind = String(body.kind || 'not_interested');
				if (!Number.isInteger(postId) || postId <= 0) return badRequest('postId is required');
				await db.prepare(
					`INSERT INTO post_feedback (user_id, post_id, kind, created_at)
					 VALUES (?, ?, ?, ?)
					 ON CONFLICT(user_id, post_id, kind) DO NOTHING`
				).bind(userId, postId, kind, new Date().toISOString()).run();
				return json({ success: true });
			}

			if (method === 'POST' && pathname.match(/^\/posts\/(\d+)\/audit-counters$/)) {
				const postId = Number(pathname.split('/')[2]);
				await db.prepare(
					`UPDATE posts
					 SET like_count = (SELECT COUNT(*) FROM likes WHERE post_id = ?),
					     star_count = (SELECT COUNT(*) FROM stars WHERE post_id = ?),
					     repost_count = (SELECT COUNT(*) FROM reposts WHERE post_id = ?),
					     reply_count = (SELECT COUNT(*) FROM posts WHERE reply_to = ?)
					 WHERE id = ?`
				).bind(postId, postId, postId, postId, postId).run();
				const row = await db.prepare('SELECT * FROM posts WHERE id = ?').bind(postId).first();
				return json(normalizePostRow(row));
			}

			if (method === 'POST' && pathname === '/posts/timeline/ids') {
				const body = await request.json();
				const tab = body.tab || 'foryou';
				const followIds = Array.isArray(body.followIds) ? body.followIds.map(Number).filter(Number.isSafeInteger) : [];
				const viewerId = body.viewerId != null && Number.isSafeInteger(Number(body.viewerId))
					? Number(body.viewerId)
					: null;
				const includePosts = body.includePosts === true;
				const limit = Math.min(Number(body.limit || 30), 100);
				const decodedCursor = body.cursorCreatedAt && body.cursorId
					? { createdAt: body.cursorCreatedAt, id: Number(body.cursorId) }
					: decodePostCursor(body.cursor);
				const beforeId = Number.isSafeInteger(Number(body.beforeId)) && Number(body.beforeId) > 0
					? Number(body.beforeId)
					: null;
				const offset = (beforeId == null && !decodedCursor) ? Number(body.offset || 0) : 0;

				let results = [];
				if (tab === 'following') {
					let queryRes;
					if (followIds.length > 0) {
						const placeholders = followIds.map(() => '?').join(', ');
						if (decodedCursor) {
							queryRes = await db.prepare(
								`SELECT ${includePosts ? '*' : 'id'} FROM posts WHERE user_id IN (${placeholders}) AND group_id IS NULL AND reply_to IS NULL AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`
							).bind(...followIds, decodedCursor.createdAt, decodedCursor.createdAt, decodedCursor.id, limit + 1).all();
						} else if (beforeId != null) {
							queryRes = await db.prepare(
								`SELECT ${includePosts ? '*' : 'id'} FROM posts WHERE user_id IN (${placeholders}) AND group_id IS NULL AND reply_to IS NULL AND id < ? ORDER BY created_at DESC, id DESC LIMIT ?`
							).bind(...followIds, beforeId, limit + 1).all();
						} else {
							queryRes = await db.prepare(
								`SELECT ${includePosts ? '*' : 'id'} FROM posts WHERE user_id IN (${placeholders}) AND group_id IS NULL AND reply_to IS NULL ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
							).bind(...followIds, limit + 1, offset).all();
						}
					} else if (viewerId != null && viewerId > 0) {
						const where = `user_id IN (SELECT following_id FROM follows WHERE follower_id = ?) AND group_id IS NULL AND reply_to IS NULL`;
						if (decodedCursor) {
							queryRes = await db.prepare(
								`SELECT ${includePosts ? '*' : 'id'} FROM posts WHERE ${where} AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`
							).bind(viewerId, decodedCursor.createdAt, decodedCursor.createdAt, decodedCursor.id, limit + 1).all();
						} else if (beforeId != null) {
							queryRes = await db.prepare(
								`SELECT ${includePosts ? '*' : 'id'} FROM posts WHERE ${where} AND id < ? ORDER BY created_at DESC, id DESC LIMIT ?`
							).bind(viewerId, beforeId, limit + 1).all();
						} else {
							queryRes = await db.prepare(
								`SELECT ${includePosts ? '*' : 'id'} FROM posts WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
							).bind(viewerId, limit + 1, offset).all();
						}
					} else {
						return json({ ids: [], has_more: false });
					}
					results = queryRes.results || [];
				} else if (tab === 'announce') {
					let queryRes;
					if (decodedCursor) {
						queryRes = await db.prepare(
							`SELECT ${includePosts ? '*' : 'id'} FROM posts WHERE group_id IS NULL AND announcement = 1 AND reply_to IS NULL AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`
						).bind(decodedCursor.createdAt, decodedCursor.createdAt, decodedCursor.id, limit + 1).all();
					} else if (beforeId != null) {
						queryRes = await db.prepare(
							`SELECT ${includePosts ? '*' : 'id'} FROM posts WHERE group_id IS NULL AND announcement = 1 AND reply_to IS NULL AND id < ? ORDER BY created_at DESC, id DESC LIMIT ?`
						).bind(beforeId, limit + 1).all();
					} else {
						queryRes = await db.prepare(
							`SELECT ${includePosts ? '*' : 'id'} FROM posts WHERE group_id IS NULL AND announcement = 1 AND reply_to IS NULL ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
						).bind(limit + 1, offset).all();
					}
					results = queryRes.results || [];
				} else {
					let queryRes;
					if (decodedCursor) {
						queryRes = await db.prepare(
							`SELECT ${includePosts ? '*' : 'id'} FROM posts WHERE (group_id IS NULL OR EXISTS (SELECT 1 FROM group_memberships gm WHERE gm.group_id = posts.group_id AND gm.user_id = ? AND gm.status = 'active')) AND reply_to IS NULL AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`
						).bind(viewerId ?? -1, decodedCursor.createdAt, decodedCursor.createdAt, decodedCursor.id, limit + 1).all();
					} else if (beforeId != null) {
						queryRes = await db.prepare(
							`SELECT ${includePosts ? '*' : 'id'} FROM posts WHERE (group_id IS NULL OR EXISTS (SELECT 1 FROM group_memberships gm WHERE gm.group_id = posts.group_id AND gm.user_id = ? AND gm.status = 'active')) AND reply_to IS NULL AND id < ? ORDER BY created_at DESC, id DESC LIMIT ?`
						).bind(viewerId ?? -1, beforeId, limit + 1).all();
					} else {
						queryRes = await db.prepare(
							`SELECT ${includePosts ? '*' : 'id'} FROM posts WHERE (group_id IS NULL OR EXISTS (SELECT 1 FROM group_memberships gm WHERE gm.group_id = posts.group_id AND gm.user_id = ? AND gm.status = 'active')) AND reply_to IS NULL ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
						).bind(viewerId ?? -1, limit + 1, offset).all();
					}
					results = queryRes.results || [];
				}

				const selectedRows = results.slice(0, limit);
				const hydratedRows = includePosts
					? await attachInlinePostMetrics(db, selectedRows, viewerId)
					: selectedRows;
				const ids = selectedRows.map((r) => r.id);
				const lastRow = selectedRows.length > 0 ? selectedRows[selectedRows.length - 1] : null;
				const nextCursor = results.length > limit && lastRow
					? (encodePostCursor(lastRow) || ids[ids.length - 1])
					: null;
				return json({
					ids,
					...(includePosts ? { posts: hydratedRows.map(normalizePostRow) } : {}),
					has_more: results.length > limit,
					next_cursor: nextCursor,
				});
			}

				if (method === 'GET' && pathname === '/posts/recommended/candidates') {
					// 採点は Node.js サーバー側で行うため、ここでは候補行だけを軽量に返す。
					const windowSize = Math.min(Math.max(Number(url.searchParams.get('limit') || 240), 1), 800);
					const candidateLimit = windowSize + 1;
					const decodedCursor = decodePostCursor(url.searchParams.get('cursor'));
					const beforeId = Number.isSafeInteger(Number(url.searchParams.get('beforeId'))) && Number(url.searchParams.get('beforeId')) > 0
						? Number(url.searchParams.get('beforeId'))
						: null;
					const offset = (beforeId == null && !decodedCursor) ? Math.max(Number(url.searchParams.get('offset') || 0), 0) : 0;
					// Postgres/インメモリと揃え、閲覧者が参加中のグループ投稿も候補に入れる（自投稿は除く）。
					// 未ログインは -1 に正規化すると EXISTS も != も自然に不成立／成立になり、分岐が要らない。
					const rawViewerId = Number(url.searchParams.get('viewerId'));
					const scopeViewerId = Number.isSafeInteger(rawViewerId) && rawViewerId > 0 ? rawViewerId : -1;
					const membershipExists = "(p.group_id IS NULL OR EXISTS (SELECT 1 FROM group_memberships gm WHERE gm.group_id = p.group_id AND gm.user_id = ? AND gm.status = 'active'))";
					const candidateHead = `${membershipExists} AND p.reply_to IS NULL AND p.user_id != ?`;
					const viewerBindings = [scopeViewerId, scopeViewerId];
					const candidateWhere = decodedCursor
						? `${candidateHead} AND (p.created_at < ? OR (p.created_at = ? AND p.id < ?))`
						: (beforeId != null ? `${candidateHead} AND p.id < ?` : candidateHead);
					const useOffset = !decodedCursor && beforeId == null;
					const bindings = [...viewerBindings, ...(decodedCursor
						? [decodedCursor.createdAt, decodedCursor.createdAt, decodedCursor.id, candidateLimit]
						: (beforeId != null ? [beforeId, candidateLimit] : [candidateLimit, offset]))];
					const query = `SELECT p.id, p.user_id, p.created_at, p.tags,
							COALESCE(p.like_count, 0) AS like_count,
							COALESCE(p.star_count, 0) AS star_count,
							COALESCE(p.repost_count, 0) AS repost_count
						FROM posts p
						WHERE ${candidateWhere}
						ORDER BY p.created_at DESC, p.id DESC
						LIMIT ?${useOffset ? ' OFFSET ?' : ''}`;
					const { results } = await db.prepare(query).bind(...bindings).all();
					const rows = results || [];
					const hasMore = rows.length > windowSize;
					const posts = rows.slice(0, windowSize).map((row) => ({
						id: Number(row.id),
						user_id: Number(row.user_id),
						created_at: row.created_at,
						tags: normalizePostTags(row.tags),
						like_count: Number(row.like_count) || 0,
						star_count: Number(row.star_count) || 0,
						repost_count: Number(row.repost_count) || 0,
					}));
					const last = posts.length > 0 ? posts[posts.length - 1] : null;
					return json({
						ids: posts.map((post) => post.id),
						posts,
						has_more: hasMore,
						next_cursor: hasMore && last ? encodePostCursor({ id: last.id, created_at: last.created_at }) : null,
						next_offset: offset + posts.length,
						use_offset_pagination: useOffset,
					});
				}

				if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/recommendation-profile$/)) {
					const profileUserId = Number(pathname.split('/')[2]);
					const [affinityRows, followRows, reactedRows, feedbackRows, extendedRows, userRow] = await Promise.all([
						db.prepare('SELECT keyword, score, updated_at FROM user_keyword_affinities WHERE user_id = ? ORDER BY score DESC LIMIT 200').bind(profileUserId).all(),
						db.prepare('SELECT following_id FROM follows WHERE follower_id = ? ORDER BY created_at DESC LIMIT 500').bind(profileUserId).all(),
						db.prepare(`SELECT post_id FROM (
								(SELECT post_id, created_at FROM likes WHERE user_id = ? ORDER BY created_at DESC LIMIT 100)
								UNION ALL
								(SELECT post_id, created_at FROM stars WHERE user_id = ? ORDER BY created_at DESC LIMIT 100)
								UNION ALL
								(SELECT post_id, created_at FROM reposts WHERE user_id = ? ORDER BY created_at DESC LIMIT 100)
							) _r`).bind(profileUserId, profileUserId, profileUserId).all(),
						db.prepare(`SELECT pf.post_id, p.user_id AS author_id, p.tags
							FROM post_feedback pf JOIN posts p ON p.id = pf.post_id
							WHERE pf.user_id = ? AND pf.kind = 'not_interested'
							ORDER BY pf.created_at DESC LIMIT 500`).bind(profileUserId).all(),
						db.prepare(`SELECT DISTINCT f2.following_id AS user_id
							FROM follows f1 JOIN follows f2 ON f2.follower_id = f1.following_id
							WHERE f1.follower_id = ? AND f2.following_id <> ? LIMIT 1000`).bind(profileUserId, profileUserId).all(),
						db.prepare('SELECT block FROM users WHERE id = ?').bind(profileUserId).first(),
					]);
					const affinities = (affinityRows.results || []).map((row) => ({
						keyword: row.keyword,
						score: Number(row.score) || 0,
						updated_at: row.updated_at,
					}));
					const follows = (followRows.results || []).map((row) => Number(row.following_id)).filter(Number.isSafeInteger);
					const reacted = [...new Set((reactedRows.results || []).map((row) => Number(row.post_id)).filter(Number.isSafeInteger))];
					const dislikedPostIds = [];
					const dislikedAuthorsSet = new Set();
					const dislikedAuthorCounts = {};
					const negativeTagCounts = {};
					for (const row of feedbackRows.results || []) {
						dislikedPostIds.push(Number(row.post_id));
						const authorId = Number(row.author_id);
						if (Number.isSafeInteger(authorId)) {
							dislikedAuthorsSet.add(authorId);
							dislikedAuthorCounts[authorId] = (dislikedAuthorCounts[authorId] || 0) + 1;
						}
						for (const tag of normalizePostTags(row.tags)) {
							negativeTagCounts[tag] = (negativeTagCounts[tag] || 0) + 1;
						}
					}
					const extendedFollows = (extendedRows.results || []).map((row) => Number(row.user_id)).filter(Number.isSafeInteger);
					let blockedAuthors = [];
					const parsedBlock = parseJsonSafe(userRow?.block, []);
					if (Array.isArray(parsedBlock)) blockedAuthors = parsedBlock.map(Number).filter(Number.isSafeInteger);
					return json({
						affinities,
						follows,
						extendedFollows,
						reacted,
						dislikedPostIds,
						dislikedAuthors: [...dislikedAuthorsSet],
						dislikedAuthorCounts,
						negativeTagCounts,
						blockedAuthors,
					});
				}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/post-ids$/)) {
				const userId = Number(pathname.split('/')[2]);
				const order = ['oldest','recommended'].includes(url.searchParams.get('order')) ? url.searchParams.get('order') : 'latest';
				const orderSql = order === 'oldest' ? 'created_at ASC, id ASC' : order === 'recommended' ? '(COALESCE(like_count,0)*2 + COALESCE(star_count,0)*3 + COALESCE(repost_count,0)*4 + COALESCE(reply_count,0)) DESC, created_at DESC, id DESC' : 'created_at DESC, id DESC';
				const subType = url.searchParams.get('subType') || 'all';
				const includePosts = url.searchParams.get('includePosts') === 'true';
				const limit = Math.min(Number(url.searchParams.get('limit') || 30), 100);
				const decodedCursor = order === 'latest' ? decodePostCursor(url.searchParams.get('cursor')) : null;
				const beforeId = order === 'latest' && Number.isSafeInteger(Number(url.searchParams.get('beforeId'))) && Number(url.searchParams.get('beforeId')) > 0
					? Number(url.searchParams.get('beforeId'))
					: null;
				const offset = (beforeId == null && !decodedCursor) ? Number(url.searchParams.get('offset') || 0) : 0;

				let sql = `SELECT ${includePosts ? '*' : 'id, created_at'} FROM posts WHERE user_id = ? AND group_id IS NULL`;
				const bindings = [userId];
				if (subType === 'posts_only') sql += ' AND reply_to IS NULL';
				if (subType === 'replies_only') sql += ' AND reply_to IS NOT NULL';
				if (decodedCursor) {
					sql += ' AND (created_at < ? OR (created_at = ? AND id < ?))';
					bindings.push(decodedCursor.createdAt, decodedCursor.createdAt, decodedCursor.id);
				} else if (beforeId != null) {
					sql += ' AND id < ?';
					bindings.push(beforeId);
				}
				sql += (decodedCursor || beforeId != null)
					? ` ORDER BY ${orderSql} LIMIT ?`
					: ` ORDER BY ${orderSql} LIMIT ? OFFSET ?`;
				bindings.push(limit + 1);
				if (!decodedCursor && beforeId == null) bindings.push(offset);

				const { results } = await db.prepare(sql).bind(...bindings).all();
				const rows = results || [];
				const ids = rows.slice(0, limit).map((r) => r.id);
				const selectedRows = rows.slice(0, limit);
				const hydratedRows = includePosts
					? await attachInlinePostMetrics(db, selectedRows, viewerId)
					: selectedRows;
				const posts = includePosts ? hydratedRows.map(normalizePostRow) : null;
				const lastRow = selectedRows.length > 0 ? selectedRows[selectedRows.length - 1] : null;
				const nextCursor = order === 'latest' && rows.length > limit && lastRow
					? (encodePostCursor(lastRow) || ids[ids.length - 1])
					: null;
				return json({
					ids,
					use_offset_pagination: order !== 'latest',
					...(posts ? { posts } : {}),
					has_more: rows.length > limit,
					next_cursor: nextCursor,
				});
			}

			if (method === 'GET' && pathname === '/posts/search/ids') {
				const q = url.searchParams.get('q') || '';
				const includePosts = url.searchParams.get('includePosts') === 'true';
				const viewerIdParam = url.searchParams.get('viewerId');
				const viewerId = viewerIdParam !== null && Number.isSafeInteger(Number(viewerIdParam))
					? Number(viewerIdParam)
					: null;
				const limit = Math.min(Number(url.searchParams.get('limit') || 30), 100);
				const decodedCursor = decodePostCursor(url.searchParams.get('cursor'));
				const beforeId = Number.isSafeInteger(Number(url.searchParams.get('beforeId'))) && Number(url.searchParams.get('beforeId')) > 0
					? Number(url.searchParams.get('beforeId'))
					: null;
				const offset = (beforeId == null && !decodedCursor) ? Number(url.searchParams.get('offset') || 0) : 0;
                const searchFilters = url.searchParams.get('searchFilters');
                if (searchFilters) {
                    const values = [];
                    const { clauses } = buildPostSearchSql(JSON.parse(searchFilters), { dialect: 'sqlite', values });
                    clauses.unshift('group_id IS NULL');
                    if (decodedCursor) {
                        clauses.push('(created_at < ? OR (created_at = ? AND id < ?))');
                        values.push(decodedCursor.createdAt, decodedCursor.createdAt, decodedCursor.id);
                    } else if (beforeId != null) {
                        clauses.push('id < ?'); values.push(beforeId);
                    }
                    values.push(limit + 1, offset);
                    const { results = [] } = await db.prepare(`SELECT * FROM posts WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).bind(...values).all();
                    const selected = results.slice(0, limit);
                    const ids = selected.map(row => row.id);
                    const posts = includePosts ? (await attachInlinePostMetrics(db, selected, viewerId)).map(normalizePostRow) : null;
                    return json({ ids, ...(posts ? { posts } : {}), has_more: results.length > limit,
                        next_cursor: results.length > limit && selected.length ? encodePostCursor(selected[selected.length - 1]) : null });
                }
				if (!q.trim()) return json({ ids: [], has_more: false, next_cursor: null });

				const fetchLimit = Math.max(200, (offset + limit) * 3);
				const { results } = decodedCursor
					? await db.prepare(
						'SELECT id, content, tags, created_at FROM posts WHERE group_id IS NULL AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?'
					).bind(decodedCursor.createdAt, decodedCursor.createdAt, decodedCursor.id, fetchLimit).all()
					: (beforeId != null
						? await db.prepare(
							'SELECT id, content, tags, created_at FROM posts WHERE group_id IS NULL AND id < ? ORDER BY created_at DESC, id DESC LIMIT ?'
						).bind(beforeId, fetchLimit).all()
						: await db.prepare(
							'SELECT id, content, tags, created_at FROM posts WHERE group_id IS NULL ORDER BY created_at DESC, id DESC LIMIT ?'
						).bind(fetchLimit).all());

				const rows = results || [];
				const matched = [];
				for (const row of rows) {
					const content = String(row.content || '').toLowerCase();
					const tags = normalizePostTags(row.tags);
					if (
						isFuzzyMatch(content, q, 0.8) ||
						tags.some((tag) => isFuzzyMatch(String(tag), q, 0.8))
					) {
						matched.push(row);
					}
				}

				const matchedSlice = matched.slice(offset, offset + limit);
				const ids = matchedSlice.map((r) => r.id);
				let posts = null;
				if (includePosts && ids.length > 0) {
					const placeholders = ids.map(() => '?').join(', ');
					const postRows = await db.prepare(`SELECT * FROM posts WHERE id IN (${placeholders})`).bind(...ids).all();
					const hydratedRows = await attachInlinePostMetrics(db, postRows.results || [], viewerId);
					const postMap = new Map(hydratedRows.map((row) => [Number(row.id), row]));
					posts = ids.map((id) => postMap.get(Number(id))).filter(Boolean).map(normalizePostRow);
				}
				const lastMatched = matchedSlice.length > 0 ? matchedSlice[matchedSlice.length - 1] : null;
				const nextCursor = matched.length > offset + limit && lastMatched
					? (encodePostCursor(lastMatched) || ids[ids.length - 1])
					: null;
				return json({
					ids,
					...(posts ? { posts } : {}),
					has_more: matched.length > offset + limit,
					next_cursor: nextCursor,
				});
			}

			if (method === 'GET' && pathname === '/posts/search') {
				const q = url.searchParams.get('q') || '';
				const limit = Math.min(Number(url.searchParams.get('limit') || 20), 100);
				if (!q.trim()) return json([]);

				const fetchLimit = Math.max(200, limit * 3);
				const { results } = await db.prepare(
					'SELECT * FROM posts WHERE group_id IS NULL ORDER BY created_at DESC, id DESC LIMIT ?'
				).bind(fetchLimit).all();

				const rows = results || [];
				const matched = [];
				for (const row of rows) {
					const content = String(row.content || '').toLowerCase();
					const tags = normalizePostTags(row.tags);
					if (
						isFuzzyMatch(content, q, 0.8) ||
						tags.some((tag) => isFuzzyMatch(String(tag), q, 0.8))
					) {
						matched.push(normalizePostRow(row));
						if (matched.length >= limit) break;
					}
				}

				return json(matched);
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/reply-ids$/)) {
				const parentPostId = Number(pathname.split('/')[2]);
				const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100);
				const decodedCursor = decodePostCursor(url.searchParams.get('cursor'));
				const offset = !decodedCursor ? Number(url.searchParams.get('offset') || 0) : 0;

				const { results } = decodedCursor
					? await db.prepare(
						'SELECT id, created_at FROM posts WHERE reply_to = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?'
					).bind(parentPostId, decodedCursor.createdAt, decodedCursor.createdAt, decodedCursor.id, limit + 1).all()
					: await db.prepare(
						'SELECT id, created_at FROM posts WHERE reply_to = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?'
					).bind(parentPostId, limit + 1, offset).all();

				const rows = results || [];
				const selectedRows = rows.slice(0, limit);
				const ids = selectedRows.map((r) => r.id);
				const lastRow = selectedRows.length > 0 ? selectedRows[selectedRows.length - 1] : null;
				const nextCursor = rows.length > limit && lastRow
					? (encodePostCursor(lastRow) || ids[ids.length - 1])
					: null;
				return json({
					ids,
					has_more: rows.length > limit,
					next_cursor: nextCursor,
				});
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/thread-reply-ids$/)) {
				const parentPostId = Number(pathname.split('/')[2]);
				const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100);
				const offset = Number(url.searchParams.get('offset') || 0);

				const { results } = await db.prepare(
					`WITH RECURSIVE reply_tree(id, reply_to, depth) AS (
						SELECT id, reply_to, 0 FROM posts WHERE reply_to = ?
						UNION ALL
						SELECT p.id, p.reply_to, rt.depth + 1 FROM posts p
						JOIN reply_tree rt ON p.reply_to = rt.id
						WHERE rt.depth < 10
					)
					SELECT id FROM reply_tree LIMIT ? OFFSET ?`
				).bind(parentPostId, limit + 1, offset).all();

				const rows = results || [];
				return json({
					ids: rows.slice(0, limit).map((r) => r.id),
					has_more: rows.length > limit,
				});
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/detail$/)) {
				const postId = Number(pathname.split('/')[2]);
				const currentUserId = url.searchParams.get('currentUserId') ? Number(url.searchParams.get('currentUserId')) : null;
				const viewerId = currentUserId ? currentUserId : null;

				// 詳細画面で必要な関連情報を単一クエリへ集約し、WorkerとD1間の逐次往復をなくす。
				const detail = await db.prepare(
					`SELECT p.*,
						author.id AS author_id,
						author.name AS author_name,
						author.scid AS author_scid,
						author.handle AS author_handle,
						author.icon_data AS author_icon_data,
						author.bio AS author_bio,
						author.header_image AS author_header_image,
						author.verify AS author_verify,
						author.admin AS author_admin,
						author.settings AS author_settings,
						author.block AS author_block,
						author.created_at AS author_created_at, author.shadow AS author_shadow,
						COALESCE((SELECT COUNT(*) FROM likes WHERE post_id = p.id), 0) AS like_count,
						COALESCE((SELECT COUNT(*) FROM stars WHERE post_id = p.id), 0) AS star_count,
						EXISTS(SELECT 1 FROM likes WHERE user_id = ? AND post_id = p.id) AS liked_by_me,
						EXISTS(SELECT 1 FROM stars WHERE user_id = ? AND post_id = p.id) AS starred_by_me,
						parent.id AS parent_id,
						parent.content AS parent_content,
						parent_author.id AS parent_author_id,
						parent_author.name AS parent_author_name
					 FROM posts p
					 LEFT JOIN users author ON author.id = p.user_id
					 LEFT JOIN posts parent ON parent.id = p.reply_to
					 LEFT JOIN users parent_author ON parent_author.id = parent.user_id
					 WHERE p.id = ?`
				).bind(viewerId, viewerId, postId).first();
				if (!detail) return json(null);

				const parentPost = detail.parent_id == null
					? null
					: {
						id: detail.parent_id,
						content: detail.parent_content ? String(detail.parent_content).substring(0, 100) : '',
						author: detail.parent_author_id == null
							? null
							: { id: detail.parent_author_id, name: detail.parent_author_name || '' },
					};

				const normalized = normalizePostRow(detail);
				return json({
					...normalized,
					author: normalized.author,
					like_count: Number(detail.like_count || 0),
					star_count: Number(detail.star_count || 0),
					liked_by_me: Boolean(detail.liked_by_me),
					starred_by_me: Boolean(detail.starred_by_me),
					parent_post: parentPost,
				});
			}

			if (method === 'GET' && pathname === '/posts/trending') {
				const limit = Math.min(Number(url.searchParams.get('limit') || 20), 100);
				const { results } = await db.prepare(
					`SELECT p.*,
					   (COALESCE(p.like_count, 0) +
					    COALESCE(p.star_count, 0) * 2 +
					    COALESCE(p.repost_count, 0) * 3) as score
					 FROM posts p
					 WHERE p.group_id IS NULL AND p.reply_to IS NULL
					   AND p.created_at >= datetime('now', '-3 days')
					 ORDER BY score DESC, p.created_at DESC
					 LIMIT ?`
				).bind(limit).all();
				return json((results || []).map(normalizePostRow));
			}

			if (method === 'GET' && pathname === '/posts/trending-hashtags') {
				const limit = Math.min(Number(url.searchParams.get('limit') || 10), 50);
				const type = String(url.searchParams.get('type') || '').trim().toLowerCase();
				const isSummary = url.searchParams.get('summary') === 'true' || url.searchParams.get('detailed') === 'true';
				const { results } = await db.prepare(
					"SELECT user_id, content, tags FROM posts WHERE group_id IS NULL AND created_at >= datetime('now', '-3 days') ORDER BY created_at DESC LIMIT 500"
				).all();
				const hashtagUsers = new Map();
				const tagUsers = new Map();
				const wordUsers = new Map();

				for (const row of results || []) {
					const userId = row.user_id || 'anonymous';
					const content = row.content || '';
					const hashtagMatches = content.match(/(?:#|＃)([\p{L}\p{N}_-]{1,48})/gu) || [];
					const postHashtags = new Set(
						hashtagMatches
							.map((m) => m.replace(/^[#＃]/, '').toLowerCase())
							.filter((tag) => tag.length > 2)
					);

					for (const tag of postHashtags) {
						const fullTag = `#${tag}`;
						if (!hashtagUsers.has(fullTag)) hashtagUsers.set(fullTag, new Set());
						hashtagUsers.get(fullTag).add(userId);
					}

					const tags = normalizePostTags(row.tags);
					const postWords = new Set(
						tags
							.map((rawTag) => String(rawTag || '').trim().toLowerCase().replace(/^[#＃]/, ''))
							.filter((tag) => tag.length > 2 && !postHashtags.has(tag))
					);

					for (const word of postWords) {
						if (!wordUsers.has(word)) wordUsers.set(word, new Set());
						wordUsers.get(word).add(userId);
					}

					// tags: 「単語より1段階広い範囲」
					const sanitizedContent = content
						.replace(/https?:\/\/[^\s]+/giu, ' ')
						.replace(/@[\p{L}\p{N}_-]+/giu, ' ')
						.replace(/[#＃][\p{L}\p{N}_-]+/gu, ' ');
					const phraseMatches = sanitizedContent.match(/([\p{Script=Han}\p{Script=Katakana}a-zA-Z0-9_-]{2,10}(?:の[\p{Script=Han}\p{Script=Katakana}a-zA-Z0-9_-]{2,10}|[\p{Script=Han}\p{Script=Katakana}a-zA-Z0-9_-]{2,10}))/gu) || [];
					const postCompoundTags = new Set(
						phraseMatches
							.map((p) => p.trim().toLowerCase().replace(/^[#＃]/, ''))
							.filter((tag) => tag.length >= 3 && tag.length <= 30 && !postHashtags.has(tag) && !postWords.has(tag))
					);

					for (const tag of postCompoundTags) {
						if (!tagUsers.has(tag)) tagUsers.set(tag, new Set());
						tagUsers.get(tag).add(userId);
					}
				}

				const calculateTagSimilarity = (str1, str2) => {
					const s1 = String(str1 || '').trim().toLowerCase().replace(/^[#＃]/, '');
					const s2 = String(str2 || '').trim().toLowerCase().replace(/^[#＃]/, '');
					if (s1 === s2) return 1.0;
					if (!s1 || !s2) return 0.0;

					const len1 = s1.length;
					const len2 = s2.length;
					const maxLen = Math.max(len1, len2);
					const minLen = Math.min(len1, len2);

					const isSubstring = s1.includes(s2) || s2.includes(s1);
					const substringSim = isSubstring ? minLen / maxLen : 0;

					const d = Array.from({ length: len1 + 1 }, () => new Array(len2 + 1).fill(0));
					for (let i = 0; i <= len1; i++) d[i][0] = i;
					for (let j = 0; j <= len2; j++) d[0][j] = j;
					for (let i = 1; i <= len1; i++) {
						for (let j = 1; j <= len2; j++) {
							const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
							d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
						}
					}
					const levSim = 1 - d[len1][len2] / maxLen;

					let diceSim = 0;
					if (len1 >= 2 && len2 >= 2) {
						const bg1 = new Map();
						for (let i = 0; i < len1 - 1; i++) {
							const bg = s1.slice(i, i + 2);
							bg1.set(bg, (bg1.get(bg) || 0) + 1);
						}
						const bg2 = new Map();
						for (let i = 0; i < len2 - 1; i++) {
							const bg = s2.slice(i, i + 2);
							bg2.set(bg, (bg2.get(bg) || 0) + 1);
						}
						let intersection = 0;
						for (const [bg, count1] of bg1.entries()) {
							if (bg2.has(bg)) intersection += Math.min(count1, bg2.get(bg));
						}
						diceSim = (2 * intersection) / ((len1 - 1) + (len2 - 1));
					}

					return Math.max(substringSim, levSim, diceSim);
				};

				const mapToMergedSortedList = (userMap, threshold = 0.75) => {
					const sorted = Array.from(userMap.entries())
						.sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0], 'ja'));

					const clusters = [];
					for (const [tag, users] of sorted) {
						let merged = false;
						for (const cluster of clusters) {
							const isBothHashtags = cluster.representative.startsWith('#') && tag.startsWith('#');
							const isBothNonHashtags = !cluster.representative.startsWith('#') && !tag.startsWith('#');
							if (isBothHashtags || isBothNonHashtags) {
								const sim = calculateTagSimilarity(cluster.representative, tag);
								if (sim > threshold) {
									for (const u of users) cluster.users.add(u);
									merged = true;
									break;
								}
							}
						}
						if (!merged) {
							clusters.push({ representative: tag, users: new Set(users) });
						}
					}

					return clusters
						.sort((a, b) => b.users.size - a.users.size || a.representative.localeCompare(b.representative, 'ja'))
						.slice(0, limit)
						.map((c) => ({ tag_name: c.representative, occurrence_count: c.users.size }));
				};

				const hashtagsList = mapToMergedSortedList(hashtagUsers);
				const wordsList = mapToMergedSortedList(wordUsers);
				const tagsList = mapToMergedSortedList(tagUsers);

				if (type === 'hashtags') return json(hashtagsList);
				if (type === 'words') return json(wordsList);
				if (type === 'tags') return json(tagsList.length > 0 ? tagsList : wordsList);

				const mergedUsers = new Map();
				for (const [k, set] of hashtagUsers) {
					if (!mergedUsers.has(k)) mergedUsers.set(k, new Set());
					for (const u of set) mergedUsers.get(k).add(u);
				}
				for (const [k, set] of wordUsers) {
					if (!mergedUsers.has(k)) mergedUsers.set(k, new Set());
					for (const u of set) mergedUsers.get(k).add(u);
				}
				for (const [k, set] of tagUsers) {
					if (!mergedUsers.has(k)) mergedUsers.set(k, new Set());
					for (const u of set) mergedUsers.get(k).add(u);
				}
				const trendsList = mapToMergedSortedList(mergedUsers);

				if (isSummary) {
					return json({
						trends: trendsList,
						hashtags: hashtagsList,
						tags: tagsList.length > 0 ? tagsList : wordsList,
						words: wordsList,
					});
				}

				return json(trendsList);
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/posts\/count$/)) {
				const userId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT COUNT(*) as count FROM posts WHERE user_id = ?').bind(userId).first();
				return json({ count: Number(row?.count || 0) });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/media\/count$/)) {
				const userId = Number(pathname.split('/')[2]);
				const row = await db.prepare(
					`SELECT COUNT(*) AS count FROM posts
					 WHERE user_id = ?
					   AND json_valid(attachments)
					   AND json_type(attachments) = 'array'
					   AND json_array_length(attachments) > 0`
				).bind(userId).first();
				return json({ count: Number(row?.count || 0) });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/media$/)) {
				const userId = Number(pathname.split('/')[2]);
				const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 15), 1), 100);
				const decodedCursor = decodePostCursor(url.searchParams.get('cursor'));
				const offset = !decodedCursor ? Math.max(Number(url.searchParams.get('offset') || 0), 0) : 0;
				const type = url.searchParams.get('type');

				const clauses = [
					'p.user_id = ?',
					'json_valid(p.attachments)',
					"json_type(p.attachments) = 'array'",
				];
				const values = [userId];
				if (type && (type === 'image' || type === 'video')) {
					clauses.push("COALESCE(json_extract(attachment.value, '$.type'), 'file') = ?");
					values.push(type);
				}
				if (decodedCursor) {
					if (decodedCursor.position != null) {
						clauses.push('(p.created_at < ? OR (p.created_at = ? AND p.id < ?) OR (p.created_at = ? AND p.id = ? AND CAST(attachment.key AS INTEGER) >= ?))');
						values.push(decodedCursor.createdAt, decodedCursor.createdAt, decodedCursor.id, decodedCursor.createdAt, decodedCursor.id, decodedCursor.position);
					} else {
						clauses.push('(p.created_at < ? OR (p.created_at = ? AND p.id < ?))');
						values.push(decodedCursor.createdAt, decodedCursor.createdAt, decodedCursor.id);
					}
				}

				values.push(limit + 1);
				let offsetSql = '';
				if (!decodedCursor) {
					values.push(offset);
					offsetSql = ' OFFSET ?';
				}

				const { results } = await db.prepare(
					`SELECT p.id AS post_id,
						p.created_at,
						CAST(attachment.key AS INTEGER) AS position,
						json_extract(attachment.value, '$.id') AS file_id,
						COALESCE(json_extract(attachment.value, '$.type'), 'file') AS file_type
					 FROM posts p
					 CROSS JOIN json_each(p.attachments) AS attachment
					 WHERE ${clauses.join(' AND ')}
					 ORDER BY p.created_at DESC, p.id DESC, CAST(attachment.key AS INTEGER) ASC
					 LIMIT ?${offsetSql}`
				).bind(...values).all();

				const rows = results || [];
				const selectedRows = rows.slice(0, limit);
				const lastRow = selectedRows.length > 0 ? selectedRows[selectedRows.length - 1] : null;
				const nextCursor = rows.length > limit && lastRow
					? encodePostCursor({ createdAt: lastRow.created_at, id: lastRow.post_id, position: lastRow.position + 1 })
					: null;

				return json(selectedRows.map((row) => ({
					post_id: Number(row.post_id),
					file_id: row.file_id,
					file_type: row.file_type || 'file',
					type: row.file_type || 'file',
				})), 200, nextCursor ? { 'X-Next-Cursor': nextCursor } : {});
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/replies\/count$/)) {
				const postId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT COUNT(*) as count FROM posts WHERE reply_to = ?').bind(postId).first();
				return json({ count: Number(row?.count || 0) });
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)$/)) {
				const postId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT * FROM posts WHERE id = ?').bind(postId).first();
				return json(normalizePostRow(row));
			}

			if (method === 'POST' && pathname.match(/^\/posts\/(\d+)\/like$/)) {
				const postId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const userId = Number(body.userId);

				const existing = await db.prepare('SELECT 1 FROM likes WHERE user_id = ? AND post_id = ?').bind(userId, postId).first();
				if (existing) {
					await db.prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?').bind(userId, postId).run();
					await adjustUserKeywordAffinities(db, userId, postId, -1);
				} else {
					const now = new Date().toISOString();
					await db.prepare('INSERT INTO likes (user_id, post_id, created_at) VALUES (?, ?, ?)').bind(userId, postId, now).run();
					await adjustUserKeywordAffinities(db, userId, postId, 1);
				}
				const countRow = await db.prepare('SELECT COUNT(*) as count FROM likes WHERE post_id = ?').bind(postId).first();
				return json({ liked: !existing, count: Number(countRow?.count || 0) });
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/likes\/count$/)) {
				const postId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT COUNT(*) as count FROM likes WHERE post_id = ?').bind(postId).first();
				return json({ count: Number(row?.count || 0) });
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/likes\/check$/)) {
				const postId = Number(pathname.split('/')[2]);
				const userId = Number(url.searchParams.get('userId'));
				const row = await db.prepare('SELECT 1 FROM likes WHERE user_id = ? AND post_id = ?').bind(userId, postId).first();
				return json({ liked: Boolean(row) });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/likes\/ids$/)) {
				const userId = Number(pathname.split('/')[2]);
				const { results } = await db.prepare('SELECT post_id FROM likes WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all();
				return json((results || []).map((r) => r.post_id));
			}

			if (method === 'POST' && pathname.match(/^\/posts\/(\d+)\/star$/)) {
				const postId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const userId = Number(body.userId);

				const existing = await db.prepare('SELECT 1 FROM stars WHERE user_id = ? AND post_id = ?').bind(userId, postId).first();
				if (existing) {
					await db.prepare('DELETE FROM stars WHERE user_id = ? AND post_id = ?').bind(userId, postId).run();
					await adjustUserKeywordAffinities(db, userId, postId, -3);
				} else {
					const now = new Date().toISOString();
					await db.prepare('INSERT INTO stars (user_id, post_id, created_at) VALUES (?, ?, ?)').bind(userId, postId, now).run();
					await adjustUserKeywordAffinities(db, userId, postId, 3);
				}
				const countRow = await db.prepare('SELECT COUNT(*) as count FROM stars WHERE post_id = ?').bind(postId).first();
				return json({ starred: !existing, count: Number(countRow?.count || 0) });
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/stars\/count$/)) {
				const postId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT COUNT(*) as count FROM stars WHERE post_id = ?').bind(postId).first();
				return json({ count: Number(row?.count || 0) });
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/stars\/check$/)) {
				const postId = Number(pathname.split('/')[2]);
				const userId = Number(url.searchParams.get('userId'));
				const row = await db.prepare('SELECT 1 FROM stars WHERE user_id = ? AND post_id = ?').bind(userId, postId).first();
				return json({ starred: Boolean(row) });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/stars\/ids$/)) {
				const userId = Number(pathname.split('/')[2]);
				const { results } = await db.prepare('SELECT post_id FROM stars WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all();
				return json((results || []).map((r) => r.post_id));
			}

			if (method === 'POST' && pathname.match(/^\/posts\/(\d+)\/pin$/)) {
				const postId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const userId = Number(body.userId);

				const post = await db.prepare('SELECT user_id FROM posts WHERE id = ?').bind(postId).first();
				if (!post || Number(post.user_id) !== userId) {
					return badRequest('Cannot pin a post you do not own');
				}

				const existing = await db.prepare('SELECT 1 FROM pinned_posts WHERE user_id = ? AND post_id = ?').bind(userId, postId).first();
				if (existing) {
					await db.prepare('DELETE FROM pinned_posts WHERE user_id = ? AND post_id = ?').bind(userId, postId).run();
					return json({ pinned: false });
				}
				const now = new Date().toISOString();
				await db.prepare('INSERT INTO pinned_posts (user_id, post_id, created_at) VALUES (?, ?, ?)').bind(userId, postId, now).run();
				return json({ pinned: true });
			}

			if (method === 'POST' && pathname.match(/^\/posts\/(\d+)\/dislike$/)) {
				const postId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const userId = Number(body.userId);
				await adjustUserKeywordAffinities(db, userId, postId, -15);
				await db.prepare(
					`INSERT INTO post_feedback (user_id, post_id, kind, created_at)
					 VALUES (?, ?, 'not_interested', ?)
					 ON CONFLICT(user_id, post_id, kind) DO NOTHING`,
				).bind(userId, postId, new Date().toISOString()).run();
				return json({ success: true });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/pinned$/)) {
				const userId = Number(pathname.split('/')[2]);
				const { results } = await db.prepare(
					`SELECT p.* FROM posts p JOIN pinned_posts pp ON pp.post_id = p.id
					 WHERE pp.user_id = ? ORDER BY pp.created_at DESC`
				).bind(userId).all();
				return json((results || []).map(normalizePostRow));
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/pinned\/id$/)) {
				const userId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT post_id FROM pinned_posts WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').bind(userId).first();
				return json({ postId: row?.post_id || null });
			}

			if (method === 'POST' && pathname.match(/^\/posts\/(\d+)\/repost$/)) {
				const postId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const userId = Number(body.userId);

				const original = await db.prepare('SELECT * FROM posts WHERE id = ?').bind(postId).first();
				if (!original) return notFound('Post not found');

				const existing = await db.prepare('SELECT 1 FROM reposts WHERE user_id = ? AND post_id = ?').bind(userId, postId).first();
				if (existing) return badRequest('Already reposted');

				const now = new Date().toISOString();
				await db.prepare('INSERT INTO reposts (user_id, post_id, created_at) VALUES (?, ?, ?)').bind(userId, postId, now).run();

				// 純粋なリポスト行は content を空文字・attachments を NULL のまま保つ。
				// 元投稿の本文/添付を複製するとクライアントに引用ポストとして扱われるため。
				const res = await db.prepare(
					`INSERT INTO posts (user_id, content, attachments, mask, lock, repost_to, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`
				).bind(userId, '', null, original.mask, original.lock, postId, now).run();

				const created = await db.prepare('SELECT * FROM posts WHERE id = ?').bind(res.meta.last_row_id).first();
				return json(normalizePostRow(created));
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/reposts$/)) {
				const userId = Number(pathname.split('/')[2]);
				const { results } = await db.prepare(
					`SELECT p.* FROM posts p JOIN reposts r ON r.post_id = p.repost_to
					 WHERE r.user_id = ? ORDER BY r.created_at DESC`
				).bind(userId).all();
				return json((results || []).map(normalizePostRow));
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/reposts$/)) {
				const postId = Number(pathname.split('/')[2]);
				const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100);
				const { results } = await db.prepare(
					`SELECT u.id AS user_id, u.name, u.handle, u.icon_data, u.verify, u.admin, u.bio, r.created_at AS reposted_at FROM reposts r
					 JOIN users u ON u.id = r.user_id WHERE r.post_id = ? ORDER BY r.created_at DESC LIMIT ?`
				).bind(postId, limit).all();
				return json((results || []).map((row) => ({
					user_id: Number(row.user_id),
					id: Number(row.user_id),
					name: row.name,
					handle: row.handle,
					icon_data: row.icon_data,
					verify: Boolean(row.verify),
					admin: Boolean(row.admin),
					bio: row.bio,
					reposted_at: row.reposted_at ?? null,
				})));
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/reposts\/count$/)) {
				const postId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT COUNT(*) as count FROM reposts WHERE post_id = ?').bind(postId).first();
				return json({ count: Number(row?.count || 0) });
			}

			if (method === 'GET' && pathname === '/dm/list') {
				const userId = Number(url.searchParams.get('userId'));
				const { results } = await db.prepare(
					`SELECT * FROM dm_channels WHERE EXISTS (
						SELECT 1 FROM json_each(dm_channels.participants)
						WHERE CAST(json_each.value AS INTEGER) = ?
					 )`,
				).bind(userId).all();
				return json(results || []);
			}

			if (method === 'POST' && pathname === '/dm/channel') {
				const body = await request.json();
				const u1 = Math.min(Number(body.userId1), Number(body.userId2));
				const u2 = Math.max(Number(body.userId1), Number(body.userId2));
				const channelId = `${u1}:${u2}`;

				const existing = await db.prepare('SELECT * FROM dm_channels WHERE id = ?').bind(channelId).first();
				if (existing) return json(existing);

				const now = new Date().toISOString();
				await db.prepare('INSERT INTO dm_channels (id, participants, created_at) VALUES (?, ?, ?)').bind(channelId, JSON.stringify([u1, u2]), now).run();
				return json({ id: channelId, participants: [u1, u2], created_at: now });
			}

			if (method === 'GET' && pathname.startsWith('/dm/messages/')) {
				const channelId = decodeURIComponent(pathname.slice('/dm/messages/'.length));
				const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100);
				const offset = Number(url.searchParams.get('offset') || 0);

				const { results } = await db.prepare('SELECT * FROM dm_messages WHERE channel_id = ? ORDER BY sent_at DESC LIMIT ? OFFSET ?').bind(channelId, limit, offset).all();
				return json(results || []);
			}

			if (method === 'POST' && pathname === '/dm/messages') {
				const body = await request.json();
				const channelId = String(body.channelId);
				const senderId = Number(body.senderId);
				const content = String(body.content || '');
				const now = body.sentAt ? new Date(body.sentAt).toISOString() : new Date().toISOString();
				const hasExplicitId = body.id != null && Number.isSafeInteger(Number(body.id)) && Number(body.id) > 0;

				let createdId;
				if (hasExplicitId) {
					createdId = Number(body.id);
					await db.prepare('INSERT INTO dm_messages (id, channel_id, sender_id, content, sent_at) VALUES (?, ?, ?, ?, ?)').bind(createdId, channelId, senderId, content, now).run();
				} else {
					const res = await db.prepare('INSERT INTO dm_messages (channel_id, sender_id, content, sent_at) VALUES (?, ?, ?, ?)').bind(channelId, senderId, content, now).run();
					createdId = res.meta.last_row_id;
				}

				const row = await db.prepare('SELECT * FROM dm_messages WHERE id = ?').bind(createdId).first();
				return json(row ? {
					id: Number(row.id),
					channelId: row.channel_id,
					channel_id: row.channel_id,
					senderId: Number(row.sender_id),
					sender_id: Number(row.sender_id),
					content: row.content,
					sentAt: row.sent_at,
					sent_at: row.sent_at,
					readAt: row.read_at,
					read_at: row.read_at,
				} : null);
			}

			if (method === 'POST' && pathname === '/dm/read') {
				const body = await request.json();
				const channelId = String(body.channelId);
				const userId = Number(body.userId);
				const now = new Date().toISOString();
				await db.prepare('UPDATE dm_messages SET read_at = ? WHERE channel_id = ? AND sender_id != ? AND read_at IS NULL').bind(now, channelId, userId).run();
				return json({ success: true });
			}

			if (method === 'GET' && pathname === '/dm/unread') {
				const userId = Number(url.searchParams.get('userId'));
				const row = await db.prepare(
					`SELECT COUNT(*) AS count FROM dm_messages m
					 JOIN dm_channels c ON c.id = m.channel_id
					 WHERE EXISTS (
						SELECT 1 FROM json_each(c.participants)
						WHERE CAST(json_each.value AS INTEGER) = ?
					 ) AND m.sender_id != ? AND m.read_at IS NULL`
				).bind(userId, userId).first();
				return json({ count: Number(row?.count || 0) });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/group-dms$/)) {
				const userId = Number(pathname.split('/')[2]);
				const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 50), 100));
				const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
				const { results } = await db.prepare(
					`SELECT * FROM group_dms
					 WHERE host_id = ? OR EXISTS (
						SELECT 1 FROM json_each(group_dms.member)
						WHERE CAST(json_each.value AS INTEGER) = ?
					 )
					 ORDER BY time DESC LIMIT ? OFFSET ?`,
				).bind(userId, userId, limit, offset).all();
				return json((results || []).map((r) => normalizeGroupDmRow(r, userId)));
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/group-dms\/visibility$/)) {
				const userId = Number(pathname.split('/')[2]);
				const { results } = await db.prepare(
					`SELECT id, member, unread FROM group_dms
					 WHERE host_id = ? OR EXISTS (
						SELECT 1 FROM json_each(group_dms.member)
						WHERE CAST(json_each.value AS INTEGER) = ?
					 )`,
				).bind(userId, userId).all();
				return json((results || []).map((row) => ({
					id: row.id,
					member: parseJsonSafe(row.member, []),
					unread: parseJsonSafe(row.unread, {}),
				})));
			}

			if (method === 'GET' && pathname.match(/^\/group-dms\/([^/]+)$/)) {
				const dmId = decodeURIComponent(pathname.split('/')[2]);
				const row = await db.prepare('SELECT * FROM group_dms WHERE id = ?').bind(dmId).first();
				return json(normalizeGroupDmRow(row));
			}

			if (method === 'POST' && pathname === '/group-dms') {
				const body = await request.json();
				const id = crypto.randomUUID();
				const hostId = Number(body.hostId);
				const member = Array.isArray(body.member) ? body.member.map(Number) : [hostId];
				const accepted = Array.isArray(body.accepted) ? body.accepted.map(Number) : member;
				const title = String(body.title || '');
				const now = new Date().toISOString();

				await db.prepare(
					`INSERT INTO group_dms (id, host_id, title, member, post, unread, time, created_at)
					 VALUES (?, ?, ?, ?, '[]', ?, ?, ?)`
				).bind(id, hostId, title, JSON.stringify(member), JSON.stringify({ _accepted: accepted }), now, now).run();

				const row = await db.prepare('SELECT * FROM group_dms WHERE id = ?').bind(id).first();
				return json(normalizeGroupDmRow(row, hostId));
			}

			if (method === 'POST' && pathname.match(/^\/group-dms\/([^/]+)\/(update|update-history-guarded)$/)) {
				const dmId = decodeURIComponent(pathname.split('/')[2]);
				const updates = await request.json();
				if (pathname.endsWith('/update-history-guarded') && (!updates._expectedState || !Array.isArray(updates._expectedPost) || !Array.isArray(updates.post))) return badRequest('Expected DM state and history are required');
				const currentRow = await db.prepare('SELECT * FROM group_dms WHERE id = ?').bind(dmId).first();
				if (!currentRow) return notFound('Group DM not found');
				if (updates._expectedState) {
					const member = parseJsonSafe(currentRow.member, []).map(Number);
					const unread = parseJsonSafe(currentRow.unread, {});
					const accepted = Array.isArray(unread._accepted) ? unread._accepted.map(Number) : member;
					const expected = updates._expectedState;
					if (String(currentRow.state_version) !== String(expected.state_version) || Number(currentRow.host_id) !== Number(expected.host_id) || JSON.stringify(member) !== JSON.stringify(expected.member) || JSON.stringify(accepted) !== JSON.stringify(expected.accepted)) return json(null);
				}
				const sets = [];
				const values = [];

				if (updates.title !== undefined) { sets.push('title = ?'); values.push(updates.title); }
				if (updates.host_id !== undefined || updates.hostId !== undefined) { sets.push('host_id = ?'); values.push(Number(updates.host_id ?? updates.hostId)); }
				if (updates.member !== undefined) { sets.push('member = ?'); values.push(JSON.stringify(updates.member.map(Number))); }
				if (updates.post !== undefined) { sets.push('post = ?'); values.push(JSON.stringify(updates.post)); }
				if (updates.unread !== undefined) { sets.push('unread = ?'); values.push(JSON.stringify(updates.unread)); }
				if (updates.accepted !== undefined) {
					const unread = parseJsonSafe(currentRow.unread, {});
					unread._accepted = Array.isArray(updates.accepted) ? updates.accepted.map(Number) : [];
					sets.push('unread = ?'); values.push(JSON.stringify(unread));
				}
				if (updates.time !== undefined) { sets.push('time = ?'); values.push(updates.time); }

				if (sets.length > 0) {
					values.push(dmId);
					let condition = '';
					if (updates._expectedPost !== undefined) {
						condition = ' AND post = ?';
						values.push(JSON.stringify(updates._expectedPost));
					}
					if (updates._expectedState || updates.accepted !== undefined) {
						condition += ' AND host_id = ? AND member = ? AND unread IS ? AND state_version = ?';
						values.push(currentRow.host_id, currentRow.member, currentRow.unread, currentRow.state_version);
					}
					const result = await db.prepare(`UPDATE group_dms SET ${sets.join(', ')} WHERE id = ?${condition}`).bind(...values).run();
					if (!result.meta.changes) return json(null);
				}
				const row = await db.prepare('SELECT * FROM group_dms WHERE id = ?').bind(dmId).first();
				return json(normalizeGroupDmRow(row));
			}

			if (method === 'POST' && pathname.match(/^\/group-dms\/([^/]+)\/edit-message$/)) {
				const dmId = decodeURIComponent(pathname.split('/')[2]);
				const { messageId, userId, content } = await request.json();
				for (let attempt = 0; attempt < 20; attempt++) {
					const row = await db.prepare('SELECT * FROM group_dms WHERE id = ?').bind(dmId).first();
					if (!row) return json({ error: 'not_found' });
					const member = parseJsonSafe(row.member, []);
					if (!member.map(Number).includes(Number(userId))) return json({ error: 'forbidden' });
					const unread = parseJsonSafe(row.unread, {});
					const accepted = Array.isArray(unread._accepted) ? unread._accepted : member;
					if (!accepted.map(Number).includes(Number(userId))) return json({ error: 'forbidden' });
					const posts = parseJsonSafe(row.post, []);
					const index = posts.findIndex((item) => String(item.id) === String(messageId));
					if (index < 0) return json({ error: 'not_found' });
					const message = posts[index];
					if (Number(message.userid) !== Number(userId) || message.type !== 'user' || message.e2e || message.deleted || message.deleted_at) return json({ error: 'forbidden' });
					posts[index] = { ...message, content, edited_at: new Date().toISOString() };
					const result = await db.prepare('UPDATE group_dms SET post = ? WHERE id = ? AND post = ? AND member = ? AND unread IS ?').bind(JSON.stringify(posts), dmId, row.post, row.member, row.unread).run();
					if (result.meta.changes) return json({ message: posts[index], member: member.filter((id) => accepted.map(Number).includes(Number(id))) });
				}
				throw new Error('DM edit conflict');
			}

			if (method === 'POST' && pathname.match(/^\/group-dms\/([^/]+)\/messages-idempotent$/)) {
				const dmId = decodeURIComponent(pathname.split('/')[2]);
				const { message, senderId, expectedState, joinEvent, requestId, requestHash } = await request.json();
				if (!expectedState || senderId == null || !message || typeof requestId !== 'string' || typeof requestHash !== 'string') return json(null);
				const row = await db.prepare('SELECT * FROM group_dms WHERE id = ?').bind(dmId).first();
				if (!row) return json(null);
				const members = parseJsonSafe(row.member, []).map(Number);
				if (!members.includes(Number(senderId))) return json(null);
				const lookup = async () => db.prepare('SELECT request_hash, response_message FROM group_dm_send_requests WHERE dm_id = ? AND sender_id = ? AND request_id = ?').bind(dmId, Number(senderId), requestId).first();
				const replay = async (previous) => {
					if (previous.request_hash !== requestHash) return { idempotencyConflict: true };
					const current = await db.prepare('SELECT * FROM group_dms WHERE id = ?').bind(dmId).first();
					if (!current || !parseJsonSafe(current.member, []).map(Number).includes(Number(senderId))) return null;
					return { ...normalizeGroupDmRow(current, senderId), idempotencyReplay: parseJsonSafe(previous.response_message, null) };
				};
				const previous = await lookup();
				if (previous) return json(await replay(previous));
				const unread = parseJsonSafe(row.unread, {});
				const accepted = (Array.isArray(unread._accepted) ? unread._accepted : members).map(Number);
				if (String(row.state_version) !== String(expectedState.state_version) || Number(row.host_id) !== Number(expectedState.host_id) || JSON.stringify(members) !== JSON.stringify(expectedState.member) || JSON.stringify(accepted) !== JSON.stringify(expectedState.accepted)) return json(null);
				if (!accepted.includes(Number(senderId))) {
					if (!joinEvent) return json(null);
					unread._accepted = [...accepted, Number(senderId)];
				} else if (joinEvent) return json(null);
				const posts = parseJsonSafe(row.post, []);
				if (joinEvent) posts.push(joinEvent);
				posts.push(message);
				unread[String(senderId)] = 0;
				for (const member of members) if (member !== Number(senderId)) unread[String(member)] = Number(unread[String(member)] || 0) + (joinEvent ? 2 : 1);
				const token = crypto.randomUUID();
				const results = await db.batch([
					db.prepare(`INSERT INTO group_dm_send_requests (dm_id, sender_id, request_id, request_hash, response_message, attempt_token)
						SELECT ?, ?, ?, ?, ?, ? FROM group_dms WHERE id = ? AND post = ? AND unread IS ? AND member = ? AND host_id = ? AND state_version = ?
						ON CONFLICT (dm_id, sender_id, request_id) DO NOTHING`).bind(dmId, Number(senderId), requestId, requestHash, JSON.stringify(message), token, dmId, row.post, row.unread, row.member, row.host_id, row.state_version),
					db.prepare(`UPDATE group_dms SET post = ?, unread = ?, time = ? WHERE id = ? AND EXISTS
						(SELECT 1 FROM group_dm_send_requests WHERE dm_id = ? AND sender_id = ? AND request_id = ? AND attempt_token = ?)`).bind(JSON.stringify(posts), JSON.stringify(unread), message.time || new Date().toISOString(), dmId, dmId, Number(senderId), requestId, token),
				]);
				if (results[0].meta.changes) {
					const current = await db.prepare('SELECT * FROM group_dms WHERE id = ?').bind(dmId).first();
					return json(normalizeGroupDmRow(current, senderId));
				}
				const raced = await lookup();
				return json(raced ? await replay(raced) : null);
			}

			if (method === 'POST' && pathname.match(/^\/group-dms\/([^/]+)\/messages-guarded$/)) {
				const dmId = decodeURIComponent(pathname.split('/')[2]);
				const { message, senderId, expectedState, joinEvent } = await request.json();
				if (!expectedState || senderId == null || !message) return json(null);
				const row = await db.prepare('SELECT * FROM group_dms WHERE id = ?').bind(dmId).first();
				if (!row) return json(null);
				const members = parseJsonSafe(row.member, []).map(Number);
				const unread = parseJsonSafe(row.unread, {});
				const accepted = (Array.isArray(unread._accepted) ? unread._accepted : members).map(Number);
				if (!members.includes(Number(senderId)) || String(row.state_version) !== String(expectedState.state_version) || Number(row.host_id) !== Number(expectedState.host_id) || JSON.stringify(members) !== JSON.stringify(expectedState.member) || JSON.stringify(accepted) !== JSON.stringify(expectedState.accepted)) return json(null);
				if (!accepted.includes(Number(senderId))) {
					if (!joinEvent) return json(null);
					unread._accepted = [...accepted, Number(senderId)];
				} else if (joinEvent) return json(null);
				const posts = parseJsonSafe(row.post, []);
				if (joinEvent) posts.push(joinEvent);
				posts.push(message);
				unread[String(senderId)] = 0;
				for (const member of members) if (member !== Number(senderId)) unread[String(member)] = Number(unread[String(member)] || 0) + (joinEvent ? 2 : 1);
				const updated = await db.prepare('UPDATE group_dms SET post = ?, unread = ?, time = ? WHERE id = ? AND post = ? AND unread IS ? AND member = ? AND host_id = ? AND state_version = ? RETURNING *').bind(JSON.stringify(posts), JSON.stringify(unread), message.time || new Date().toISOString(), dmId, row.post, row.unread, row.member, row.host_id, row.state_version).first();
				if (updated) updated.state_version = (BigInt(updated.state_version) + 1n).toString();
				return json(normalizeGroupDmRow(updated, senderId));
			}

			if (method === 'POST' && pathname.match(/^\/group-dms\/([^/]+)\/messages$/)) {
				const dmId = decodeURIComponent(pathname.split('/')[2]);
				const body = await request.json();
				const message = body.message;
				const senderId = body.senderId != null ? Number(body.senderId) : null;

				for (let attempt = 0; attempt < 20; attempt++) {
				const row = await db.prepare('SELECT * FROM group_dms WHERE id = ?').bind(dmId).first();
				if (!row) return notFound('Group DM not found');

				const posts = parseJsonSafe(row.post, []);
				posts.push(message);
				const unread = parseJsonSafe(row.unread, {});
				const members = parseJsonSafe(row.member, []);

				if (senderId != null) {
					unread[String(senderId)] = 0;
					for (const m of members) {
						if (Number(m) !== senderId) {
							const k = String(m);
							unread[k] = Number(unread[k] || 0) + 1;
						}
					}
				}

				const time = message.time || new Date().toISOString();
				const result = await db.prepare('UPDATE group_dms SET post = ?, unread = ?, time = ? WHERE id = ? AND post = ? AND unread = ? AND member = ?').bind(JSON.stringify(posts), JSON.stringify(unread), time, dmId, row.post, row.unread, row.member).run();
				if (!result.meta.changes) continue;

				const updated = await db.prepare('SELECT * FROM group_dms WHERE id = ?').bind(dmId).first();
				return json(normalizeGroupDmRow(updated, senderId));
				}
				throw new Error('DM send conflict');
			}

			if (method === 'POST' && pathname.match(/^\/group-dms\/([^/]+)\/read$/)) {
				const dmId = decodeURIComponent(pathname.split('/')[2]);
				const body = await request.json();
				const userId = Number(body.userId);

				await db.prepare("UPDATE group_dms SET unread = json_set(COALESCE(unread, '{}'), '$.' || ?, 0) WHERE id = ?").bind(String(userId), dmId).run();
				return json({ success: true });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/group-dms\/unread-counts$/)) {
				const userId = Number(pathname.split('/')[2]);
				const { results } = await db.prepare(
					`SELECT id, member, unread FROM group_dms
					 WHERE host_id = ? OR EXISTS (
						SELECT 1 FROM json_each(group_dms.member)
						WHERE CAST(json_each.value AS INTEGER) = ?
					 )`,
				).bind(userId, userId).all();
				const counts = [];
				for (const r of results || []) {
					const members = parseJsonSafe(r.member, []);
					if (Array.isArray(members) && members.map(Number).includes(userId)) {
						const unread = parseJsonSafe(r.unread, {});
						counts.push({ dm_id: r.id, unread_count: Number(unread[String(userId)] || 0) });
					}
				}
				return json(counts);
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/group-dms\/unread-total$/)) {
				const userId = Number(pathname.split('/')[2]);
				const row = await db.prepare(
					`SELECT COALESCE(SUM(COALESCE(json_extract(unread, '$.' || ?), 0)), 0) AS total
					 FROM group_dms
					 WHERE host_id = ? OR EXISTS (
						SELECT 1 FROM json_each(group_dms.member)
						WHERE CAST(json_each.value AS INTEGER) = ?
					 )`,
				).bind(String(userId), userId, userId).first();
				return json({ total: Number(row?.total || 0) });
			}

			if (method === 'POST' && pathname.match(/^\/group-dms\/([^/]+)\/delete(?:-guarded)?$/)) {
				const dmId = decodeURIComponent(pathname.split('/')[2]);
				const bodyText = await request.text();
				const { expectedState } = bodyText ? (JSON.parse(bodyText) || {}) : {};
				if (pathname.endsWith('/delete-guarded') && !expectedState) return json({ success: false });
				let statement = db.prepare('DELETE FROM group_dms WHERE id = ?');
				let values = [dmId];
				if (expectedState) {
					const row = await db.prepare('SELECT host_id, member, unread, state_version FROM group_dms WHERE id = ?').bind(dmId).first();
					if (!row) return json({ success: false });
					const member = parseJsonSafe(row.member, []).map(Number);
					const unread = parseJsonSafe(row.unread, {});
					const accepted = Array.isArray(unread._accepted) ? unread._accepted.map(Number) : member;
					if (String(row.state_version) !== String(expectedState.state_version) || Number(row.host_id) !== Number(expectedState.host_id) || JSON.stringify(member) !== JSON.stringify(expectedState.member) || JSON.stringify(accepted) !== JSON.stringify(expectedState.accepted)) return json({ success: false });
					statement = db.prepare('DELETE FROM group_dms WHERE id = ? AND host_id = ? AND member = ? AND unread IS ? AND state_version = ?');
					values = [dmId, row.host_id, row.member, row.unread, row.state_version];
				}
				const res = await statement.bind(...values).run();
				return json({ success: res.meta.changes > 0 });
			}

			if (method === 'POST' && pathname.match(/^\/group-dms\/([^/]+)\/leave$/)) {
				const dmId = decodeURIComponent(pathname.split('/')[2]);
				const body = await request.json();
				const userId = Number(body.userId);

				const row = await db.prepare('SELECT host_id, member, unread, state_version FROM group_dms WHERE id = ?').bind(dmId).first();
				if (!row) return json({ success: false });

				const currentMembers = parseJsonSafe(row.member, []).map(Number);
				const unread = parseJsonSafe(row.unread, {});
				const accepted = Array.isArray(unread._accepted) ? unread._accepted.map(Number) : currentMembers;
				const expected = body.expectedState;
				if (!currentMembers.includes(userId) || (expected && (String(row.state_version) !== String(expected.state_version) || Number(row.host_id) !== Number(expected.host_id) || JSON.stringify(currentMembers) !== JSON.stringify(expected.member) || JSON.stringify(accepted) !== JSON.stringify(expected.accepted)))) return json({ success: false });
				const members = currentMembers.filter((id) => id !== userId);
				unread._accepted = accepted.filter((id) => id !== userId);
				delete unread[String(userId)];

				const result = await db.prepare('UPDATE group_dms SET member = ?, unread = ? WHERE id = ? AND host_id = ? AND member = ? AND unread IS ? AND state_version = ?').bind(JSON.stringify(members), JSON.stringify(unread), dmId, row.host_id, row.member, row.unread, row.state_version).run();
				return json({ success: result.meta.changes > 0 });
			}

			if (method === 'POST' && pathname === '/group-dms/find-by-members') {
				const body = await request.json();
				const target = Array.from(new Set(body.memberIds.map(Number))).sort((a, b) => a - b);
				if (target.length === 0) return json(null);
				const placeholders = target.map(() => '?').join(', ');
				const row = await db.prepare(
					`SELECT * FROM group_dms
					 WHERE json_array_length(member) = ?
					   AND (
						 SELECT COUNT(DISTINCT CAST(value AS INTEGER))
						 FROM json_each(group_dms.member)
						 WHERE CAST(value AS INTEGER) IN (${placeholders})
					   ) = ?
					 LIMIT 1`,
				).bind(target.length, ...target, target.length).first();
				return json(normalizeGroupDmRow(row));
			}

			// DM E2E暗号化用の公開鍵
			if (method === 'GET' && pathname === '/dm-e2e-keys') {
				const raw = String(url.searchParams.get('user_ids') || '');
				const ids = raw.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n >= 0);
				if (ids.length === 0) return json([]);
				const placeholders = ids.map(() => '?').join(',');
				const { results } = await db.prepare(
					`SELECT user_id, public_key FROM dm_e2e_keys WHERE user_id IN (${placeholders})`
				).bind(...ids).all();
				return json((results || []).map((r) => ({
					user_id: Number(r.user_id),
					public_key: String(r.public_key),
				})));
			}

			if (method === 'POST' && pathname === '/dm-e2e-keys') {
				const body = await request.json();
				const userId = Number(body.userId);
				const publicKey = String(body.publicKey || '');
				if (!Number.isInteger(userId) || userId < 0 || !publicKey) {
					return badRequest('userId and publicKey are required');
				}
				const now = new Date().toISOString();
				await db.prepare(
					`INSERT INTO dm_e2e_keys (user_id, public_key, created_at, updated_at)
					 VALUES (?, ?, ?, ?)
					 ON CONFLICT (user_id) DO UPDATE SET public_key = excluded.public_key, updated_at = excluded.updated_at`
				).bind(userId, publicKey, now, now).run();
				return json({ success: true });
			}

			if (method === 'POST' && pathname === '/notifications') {
				const body = await request.json();
				const userId = Number(body.userId);
				const type = String(body.type);
				const fromUserId = body.fromUserId != null ? Number(body.fromUserId) : (body.from_user_id != null ? Number(body.from_user_id) : null);
				const postId = body.postId != null ? Number(body.postId) : (body.target?.kind === 'post' ? Number(body.target.id) : null);
				const target = body.target ? JSON.stringify(body.target) : null;
				const message = typeof body.message === 'string' ? body.message : null;
				const now = body.createdAt ? new Date(body.createdAt).toISOString() : new Date().toISOString();
				const hasExplicitId = body.id != null && Number.isSafeInteger(Number(body.id)) && Number(body.id) > 0;

				let createdId;
				if (hasExplicitId) {
					createdId = Number(body.id);
					await db.prepare(
						`INSERT INTO notifications (id, user_id, type, from_user_id, post_id, target, message, read, clicked, created_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`
					).bind(createdId, userId, type, fromUserId, postId, target, message, now).run();
				} else {
					const res = await db.prepare(
						`INSERT INTO notifications (user_id, type, from_user_id, post_id, target, message, read, clicked, created_at)
						 VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`
					).bind(userId, type, fromUserId, postId, target, message, now).run();
					createdId = res.meta.last_row_id;
				}

				const row = await db.prepare('SELECT * FROM notifications WHERE id = ?').bind(createdId).first();
				return json(row ? {
					id: Number(row.id),
					userId: Number(row.user_id),
					user_id: Number(row.user_id),
					type: row.type,
					fromUserId: row.from_user_id != null ? Number(row.from_user_id) : null,
					from_user_id: row.from_user_id != null ? Number(row.from_user_id) : null,
					postId: row.post_id != null ? Number(row.post_id) : null,
					post_id: row.post_id != null ? Number(row.post_id) : null,
					target: parseJsonSafe(row.target, null),
					message: row.message || null,
					read: Boolean(row.read),
					clicked: Boolean(row.clicked),
					createdAt: row.created_at,
					created_at: row.created_at,
				} : null);
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/notifications$/)) {
				const userId = Number(pathname.split('/')[2]);
				const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
				const offset = Number(url.searchParams.get('offset') || 0);

				const { results } = await db.prepare(
					'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?'
				).bind(userId, limit, offset).all();

				return json((results || []).map((r) => ({
					...r,
					target: parseJsonSafe(r.target, null),
					read: Boolean(r.read),
					clicked: Boolean(r.clicked),
				})));
			}

			if (method === 'POST' && pathname.match(/^\/notifications\/(\d+)\/read$/)) {
				const id = Number(pathname.split('/')[2]);
				await db.prepare('UPDATE notifications SET read = 1 WHERE id = ?').bind(id).run();
				return json({ success: true });
			}

			if (method === 'POST' && pathname.match(/^\/notifications\/(\d+)\/click$/)) {
				const id = Number(pathname.split('/')[2]);
				await db.prepare('UPDATE notifications SET clicked = 1 WHERE id = ?').bind(id).run();
				return json({ success: true });
			}

			if (method === 'GET' && pathname.match(/^\/notifications\/(\d+)$/)) {
				const id = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT * FROM notifications WHERE id = ?').bind(id).first();
				return json(row ? { ...row, target: parseJsonSafe(row.target, null), read: Boolean(row.read), clicked: Boolean(row.clicked) } : null);
			}

			if (method === 'POST' && pathname.match(/^\/notifications\/(\d+)\/delete$/)) {
				const id = Number(pathname.split('/')[2]);
				const res = await db.prepare('DELETE FROM notifications WHERE id = ?').bind(id).run();
				return json({ success: res.meta.changes > 0 });
			}

					if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/notifications\/read-all$/)) {
						const userId = Number(pathname.split('/')[2]);
						await db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0').bind(userId).run();
						return json({ success: true });
					}

					if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/notifications\/click-all$/)) {
						const userId = Number(pathname.split('/')[2]);
						await db.prepare('UPDATE notifications SET read = 1, clicked = 1 WHERE user_id = ? AND (read = 0 OR clicked = 0)').bind(userId).run();
						return json({ success: true });
					}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/notifications\/unread-count$/)) {
				const userId = Number(pathname.split('/')[2]);
				const row = await db.prepare('SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND read = 0').bind(userId).first();
				return json({ count: Number(row?.count || 0) });
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/push-subscriptions$/)) {
				const userId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const endpoint = String(body.endpoint);
				const expirationTime = body.expirationTime != null ? Number(body.expirationTime) : null;
				const p256dh = String(body.keys?.p256dh || '');
				const auth = String(body.keys?.auth || '');
				const sessionToken = body.sessionToken != null ? String(body.sessionToken) : null;
				const now = new Date().toISOString();

				await db.prepare(
					`INSERT INTO push_subscriptions (user_id, endpoint, expiration_time, p256dh, auth, session_token, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(user_id, endpoint) DO UPDATE SET
					   expiration_time = excluded.expiration_time,
					   p256dh = excluded.p256dh,
					   auth = excluded.auth,
					   session_token = COALESCE(excluded.session_token, push_subscriptions.session_token),
					   updated_at = excluded.updated_at`
				).bind(userId, endpoint, expirationTime, p256dh, auth, sessionToken, now, now).run();

				return json({ userId, endpoint, expirationTime, keys: { p256dh, auth }, sessionToken });
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/push-subscriptions$/)) {
				const userId = Number(pathname.split('/')[2]);
				const { results } = await db.prepare('SELECT endpoint, expiration_time, p256dh, auth, session_token FROM push_subscriptions WHERE user_id = ?').bind(userId).all();
				return json((results || []).map((r) => ({
					endpoint: r.endpoint,
					expirationTime: r.expiration_time ? Number(r.expiration_time) : null,
					keys: { p256dh: r.p256dh, auth: r.auth },
					sessionToken: r.session_token || null,
				})));
			}

			if (method === 'POST' && pathname.match(/^\/users\/(\d+)\/push-subscriptions\/delete$/)) {
				const userId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const endpoint = String(body.endpoint);
				const res = await db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').bind(userId, endpoint).run();
				return json({ success: res.meta.changes > 0 });
			}

			if (method === 'GET' && pathname.startsWith('/ranking/')) {
				const type = decodeURIComponent(pathname.slice('/ranking/'.length));
				const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100);

				let sql = '';
				if (type === 'followers') {
					sql = `SELECT u.id AS user_id, u.name, u.scid, u.icon_data,
						   COUNT(f.follower_id) AS follower_count
						   FROM users u LEFT JOIN follows f ON f.following_id = u.id
						   GROUP BY u.id ORDER BY follower_count DESC, u.id ASC LIMIT ?`;
				} else if (type === 'posts') {
					sql = `SELECT u.id AS user_id, u.name, u.scid, u.icon_data,
						   COUNT(p.id) AS post_count
						   FROM users u LEFT JOIN posts p ON p.user_id = u.id
						   GROUP BY u.id ORDER BY post_count DESC, u.id ASC LIMIT ?`;
				} else if (type === 'likes') {
					sql = `SELECT u.id AS user_id, u.name, u.scid, u.icon_data,
						   COUNT(l.user_id) AS like_count
						   FROM users u
						   LEFT JOIN posts p ON p.user_id = u.id
						   LEFT JOIN likes l ON l.post_id = p.id
						   GROUP BY u.id ORDER BY like_count DESC, u.id ASC LIMIT ?`;
				} else if (type === 'stars') {
					sql = `SELECT u.id AS user_id, u.name, u.scid, u.icon_data,
						   COUNT(s.user_id) AS star_count
						   FROM users u
						   LEFT JOIN posts p ON p.user_id = u.id
						   LEFT JOIN stars s ON s.post_id = p.id
						   GROUP BY u.id ORDER BY star_count DESC, u.id ASC LIMIT ?`;
				} else {
					return badRequest('Invalid ranking type');
				}

				const { results } = await db.prepare(sql).bind(limit).all();
				return json(results || []);
			}

			if (method === 'GET' && pathname.match(/^\/users\/(\d+)\/ranking\/([^/]+)$/)) {
				const parts = pathname.split('/');
				const userId = Number(parts[2]);
				const type = decodeURIComponent(parts[4]);

				let sql = '';
				const metricField = type === 'followers' ? 'follower_count' : (type === 'posts' ? 'post_count' : (type === 'likes' ? 'like_count' : 'star_count'));

				if (type === 'followers') {
					sql = `SELECT rank, follower_count FROM (
						   SELECT u.id, COUNT(f.follower_id) AS follower_count,
						     ROW_NUMBER() OVER (ORDER BY COUNT(f.follower_id) DESC, u.id ASC) AS rank
						   FROM users u LEFT JOIN follows f ON f.following_id = u.id GROUP BY u.id
					) WHERE id = ?`;
				} else if (type === 'posts') {
					sql = `SELECT rank, post_count FROM (
						   SELECT u.id, COUNT(p.id) AS post_count,
						     ROW_NUMBER() OVER (ORDER BY COUNT(p.id) DESC, u.id ASC) AS rank
						   FROM users u LEFT JOIN posts p ON p.user_id = u.id GROUP BY u.id
					) WHERE id = ?`;
				} else if (type === 'likes') {
					sql = `SELECT rank, like_count FROM (
						   SELECT u.id, COUNT(l.user_id) AS like_count,
						     ROW_NUMBER() OVER (ORDER BY COUNT(l.user_id) DESC, u.id ASC) AS rank
						   FROM users u
						   LEFT JOIN posts p ON p.user_id = u.id
						   LEFT JOIN likes l ON l.post_id = p.id
						   GROUP BY u.id
					) WHERE id = ?`;
				} else if (type === 'stars') {
					sql = `SELECT rank, star_count FROM (
						   SELECT u.id, COUNT(s.user_id) AS star_count,
						     ROW_NUMBER() OVER (ORDER BY COUNT(s.user_id) DESC, u.id ASC) AS rank
						   FROM users u
						   LEFT JOIN posts p ON p.user_id = u.id
						   LEFT JOIN stars s ON s.post_id = p.id
						   GROUP BY u.id
					) WHERE id = ?`;
				} else {
					return badRequest('Invalid ranking type');
				}

				const row = await db.prepare(sql).bind(userId).first();
				return json(row || { rank: null, [metricField]: 0 });
			}

			if (method === 'POST' && pathname === '/logs') {
				const body = await request.json();
				const scratchId = body.scratch_id || '';
				const nyaitterId = body.nyaitter_id != null ? Number(body.nyaitter_id) : null;
				const maskedIpUuid = body.masked_ip_uuid || '';
				const logTime = new Date().toISOString();

				await db.prepare('INSERT INTO logs (scratch_id, nyaitter_id, masked_ip_uuid, log_time) VALUES (?, ?, ?, ?)').bind(scratchId, nyaitterId, maskedIpUuid, logTime).run();
				return json({ success: true });
			}

			if (method === 'GET' && pathname === '/logs') {
				const limit = Math.min(Number(url.searchParams.get('limit') || 20), 100);
				const offset = Number(url.searchParams.get('offset') || 0);
				const { results } = await db.prepare('SELECT * FROM logs ORDER BY log_time DESC LIMIT ? OFFSET ?').bind(limit, offset).all();
				return json(results || []);
			}

			// ==================== Polls ====================

			if (method === 'POST' && pathname === '/polls') {
				const body = await request.json();
				const pollId = Number(body.id) || Number(`${Date.now() % 1000000000}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`);
				const postId = Number(body.postId ?? body.post_id);
				const userId = Number(body.userId ?? body.user_id);
				const title = String(body.title || '').trim() || '投票';
				const options = JSON.stringify(body.options || []);
				const allowMultiple = body.allowMultiple || body.allow_multiple ? 1 : 0;
				const allowOther = body.allowOther || body.allow_other ? 1 : 0;
				const showResultsBeforeVoting = body.showResultsBeforeVoting !== false && body.show_results_before_voting !== false ? 1 : 0;
				const expiresAt = body.expiresAt || body.expires_at || null;
				const now = new Date().toISOString();

				await db.prepare(
					`INSERT INTO polls (id, post_id, user_id, title, options, allow_multiple, allow_other, show_results_before_voting, expires_at, closed, closed_notified, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`
				).bind(pollId, postId, userId, title, options, allowMultiple, allowOther, showResultsBeforeVoting, expiresAt, now).run();

				const created = await db.prepare('SELECT * FROM polls WHERE id = ?').bind(pollId).first();
				return json(formatD1PollRow(created, [], userId));
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/poll$/)) {
				const postId = Number(pathname.split('/')[2]);
				const currentUserId = url.searchParams.get('currentUserId') != null ? Number(url.searchParams.get('currentUserId')) : null;
				const poll = await db.prepare('SELECT * FROM polls WHERE post_id = ?').bind(postId).first();
				if (!poll) return json(null);
				const { results: voteRows } = await db.prepare('SELECT * FROM poll_votes WHERE poll_id = ?').bind(poll.id).all();
				return json(formatD1PollRow(poll, voteRows || [], currentUserId));
			}

			if (method === 'GET' && pathname.match(/^\/polls\/(\d+)$/)) {
				const pollId = Number(pathname.split('/')[2]);
				const currentUserId = url.searchParams.get('currentUserId') != null ? Number(url.searchParams.get('currentUserId')) : null;
				const poll = await db.prepare('SELECT * FROM polls WHERE id = ?').bind(pollId).first();
				if (!poll) return notFound('Poll not found');
				const { results: voteRows } = await db.prepare('SELECT * FROM poll_votes WHERE poll_id = ?').bind(poll.id).all();
				return json(formatD1PollRow(poll, voteRows || [], currentUserId));
			}

			if (method === 'GET' && pathname === '/polls/by-posts') {
				const rawPostIds = url.searchParams.get('postIds') || '';
				const currentUserId = url.searchParams.get('currentUserId') != null ? Number(url.searchParams.get('currentUserId')) : null;
				const postIds = rawPostIds.split(',').map(Number).filter(Number.isSafeInteger);
				if (postIds.length === 0) return json([]);

				const placeholders = postIds.map(() => '?').join(', ');
				const { results: polls } = await db.prepare(`SELECT * FROM polls WHERE post_id IN (${placeholders})`).bind(...postIds).all();
				if (!polls || polls.length === 0) return json([]);

				const pollIds = polls.map((p) => p.id);
				const pollPlaceholders = pollIds.map(() => '?').join(', ');
				const { results: allVotes } = await db.prepare(`SELECT * FROM poll_votes WHERE poll_id IN (${pollPlaceholders})`).bind(...pollIds).all();

				const votesByPoll = new Map();
				for (const v of allVotes || []) {
					if (!votesByPoll.has(v.poll_id)) votesByPoll.set(v.poll_id, []);
					votesByPoll.get(v.poll_id).push(v);
				}

				const formattedList = polls.map((p) => formatD1PollRow(p, votesByPoll.get(p.id) || [], currentUserId)).filter(Boolean);
				return json(formattedList);
			}

			if (method === 'POST' && pathname.match(/^\/polls\/(\d+)\/vote$/)) {
				const pollId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const userId = Number(body.userId ?? body.user_id);
				const poll = await db.prepare('SELECT * FROM polls WHERE id = ?').bind(pollId).first();
				if (!poll) return notFound('Poll not found');

				const isExpired = Boolean(poll.expires_at && new Date(poll.expires_at) <= new Date()) || Boolean(poll.closed);
				if (isExpired) return badRequest('この投票は既に終了しています');

				const optionIds = Array.isArray(body.optionIds) ? body.optionIds.map(Number) : [];
				const otherText = body.otherText ? String(body.otherText).trim().slice(0, 200) : null;
				const now = new Date().toISOString();

				// 既存の投票を削除
				await db.prepare('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?').bind(poll.id, userId).run();

				// 新規投票を挿入
				for (const optId of optionIds) {
					const voteId = Number(`${Date.now() % 1000000000}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`);
					await db.prepare(
						'INSERT INTO poll_votes (id, poll_id, user_id, option_id, other_text, created_at) VALUES (?, ?, ?, ?, ?, ?)'
					).bind(voteId, poll.id, userId, optId, optId === -1 ? otherText : null, now).run();
				}

				const { results: voteRows } = await db.prepare('SELECT * FROM poll_votes WHERE poll_id = ?').bind(poll.id).all();
				return json(formatD1PollRow(poll, voteRows || [], userId));
			}

			if (method === 'GET' && pathname === '/polls/expired-unnotified') {
				const now = new Date().toISOString();
				const { results } = await db.prepare('SELECT * FROM polls WHERE expires_at IS NOT NULL AND expires_at <= ? AND closed_notified = 0 LIMIT 50').bind(now).all();
				return json(results || []);
			}

			if (method === 'POST' && pathname.match(/^\/polls\/(\d+)\/mark-notified$/)) {
				const pollId = Number(pathname.split('/')[2]);
				await db.prepare('UPDATE polls SET closed_notified = 1 WHERE id = ?').bind(pollId).run();
				return json({ success: true });
			}

			if (method === 'GET' && pathname.match(/^\/polls\/(\d+)\/voters$/)) {
				const pollId = Number(pathname.split('/')[2]);
				const { results } = await db.prepare(
					`SELECT DISTINCT user_id
					 FROM poll_votes
					 WHERE poll_id = ?`
				).bind(pollId).all();
				return json((results || []).map((row) => Number(row.user_id)));
			}

			// ==================== Post Activities ====================

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/stars$/)) {
				const postId = Number(pathname.split('/')[2]);
				const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100);
				const { results } = await db.prepare(
					`SELECT u.id AS user_id, u.name, u.handle, u.icon_data, u.verify, u.admin, u.bio, s.created_at AS starred_at
					 FROM stars s
					 JOIN users u ON u.id = s.user_id
					 WHERE s.post_id = ?
					 ORDER BY s.created_at DESC LIMIT ?`
				).bind(postId, limit).all();
				return json((results || []).map((row) => ({
					user_id: Number(row.user_id),
					id: Number(row.user_id),
					name: row.name,
					handle: row.handle,
					icon_data: row.icon_data,
					verify: Boolean(row.verify),
					admin: Boolean(row.admin),
					bio: row.bio,
					starred_at: row.starred_at ?? null,
				})));
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/quotes$/)) {
				const postId = Number(pathname.split('/')[2]);
				const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100);
				const { results } = await db.prepare(
					`SELECT p.*
					 FROM posts p
					 WHERE p.repost_to = ? AND p.content != ''
					 ORDER BY p.created_at DESC LIMIT ?`
				).bind(postId, limit).all();
				return json((results || []).map(normalizePostRow));
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/likes$/)) {
				const postId = Number(pathname.split('/')[2]);
				const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100);
				const { results } = await db.prepare(
					`SELECT u.id AS user_id, u.name, u.handle, u.icon_data, u.verify, u.admin, u.bio, l.created_at AS liked_at
					 FROM likes l
					 JOIN users u ON u.id = l.user_id
					 WHERE l.post_id = ?
					 ORDER BY l.created_at DESC LIMIT ?`
				).bind(postId, limit).all();
				return json((results || []).map((row) => ({
					user_id: Number(row.user_id),
					id: Number(row.user_id),
					name: row.name,
					handle: row.handle,
					icon_data: row.icon_data,
					verify: Boolean(row.verify),
					admin: Boolean(row.admin),
					bio: row.bio,
					liked_at: row.liked_at ?? null,
				})));
			}

			// ==================== Community Notes ====================
			if (method==='POST' && pathname==='/reputation/selection-keys') {
				const body=await request.json();const ids=JSON.stringify((body.ids || []).map(Number).filter(id=>Number.isSafeInteger(id)&&id>0).slice(0,2000));
				const result=await db.batch([db.prepare('INSERT OR IGNORE INTO note_selection_identities(user_id,selection_key) SELECT id,lower(hex(randomblob(16))) FROM users WHERE id IN (SELECT value FROM json_each(?))').bind(ids),db.prepare('SELECT user_id,selection_key FROM note_selection_identities WHERE user_id IN (SELECT value FROM json_each(?))').bind(ids)]);
				return json(Object.fromEntries(result[1].results.map(r=>[Number(r.user_id),r.selection_key])));
			}
			if (method==='POST' && pathname==='/reputation/claim-reviewer-outcome') {
				const body=await request.json();const row=await db.prepare('SELECT note_id FROM reviewer_outcome_claims WHERE user_id=? AND author_id=? AND day=?').bind(Number(body.userId),Number(body.authorId),String(body.day)).first();
				return json(Number(row?.note_id)===Number(body.noteId));
			}
			if (method==='POST' && pathname==='/reputation/context') {
				const body=await request.json(); const ids=[...new Set((body.ids || []).map(Number).filter(id=>Number.isSafeInteger(id)&&id>0))].slice(0,502);
				if (!ids.length) return json({users:[],profiles:{},edges:[]});
				const slots='SELECT value FROM json_each(?)'; const encoded=JSON.stringify(ids);
				if (body.displayOnly === true) {
					const [users, profiles] = await db.batch([
						db.prepare('SELECT id,settings FROM users WHERE id IN (' + slots + ')').bind(encoded),
						db.prepare('SELECT user_id,dimension,score,successes FROM reputation_profiles WHERE user_id IN (' + slots + ')').bind(encoded),
					]);
					const byUser = {};
					for (const row of profiles.results) { byUser[row.user_id] ||= {}; Object.assign(byUser[row.user_id], reputationStorage.profileFromRows([row])); }
					return json({ users: users.results.map(user => ({ ...user, settings: parseJsonMaybe(user.settings, {}) })), profiles: byUser });
				}
				const [users,profiles,edges]=await db.batch([
				 db.prepare(`SELECT * FROM users WHERE id IN (${slots})`).bind(encoded),
				 db.prepare(reputationStorage.reputationProfileQuery('sqlite',true)).bind(encoded),
				 db.prepare(`SELECT follower_id AS a,following_id AS b FROM follows WHERE follower_id IN (${slots}) AND following_id IN (${slots}) UNION SELECT a.user_id,b.user_id FROM group_memberships a JOIN group_memberships b ON a.group_id=b.group_id WHERE a.user_id IN (${slots}) AND b.user_id IN (${slots}) AND a.status='active' AND b.status='active'`).bind(encoded,encoded,encoded,encoded)]);
				const byUser={}; for (const row of profiles.results) {byUser[row.user_id] ||= {};Object.assign(byUser[row.user_id],reputationStorage.profileFromRows([row]));}
				return json({users:users.results.map(u=>({...u,settings:parseJsonMaybe(u.settings,{}),block:parseJsonMaybe(u.block,[])})),profiles:byUser,edges:edges.results.map(r=>[Number(r.a),Number(r.b)])});
			}
			if(method==='POST'&&pathname==='/community-notes/relevance-context'){
				const body=await request.json(),ids=[...new Set((body.userIds||[]).map(Number).filter(id=>Number.isSafeInteger(id)&&id>0))].slice(0,102),authorId=Number(body.authorId);
				if(!Number.isSafeInteger(authorId)||authorId<=0||!ids.length)return json({users:[],followingByUser:{},sharedUserIds:[]});
				const encoded=JSON.stringify([...new Set([...ids,authorId])]),candidateIds=JSON.stringify(ids);
				const [users,relations]=await db.batch([
					db.prepare('SELECT * FROM users WHERE id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))').bind(encoded),
					db.prepare(`WITH candidates AS (SELECT CAST(value AS INTEGER) AS user_id FROM json_each(?)), counts AS (
						SELECT follower_id,COUNT(*) AS total FROM follows WHERE follower_id IN (SELECT CAST(value AS INTEGER) FROM json_each(?)) GROUP BY follower_id
					), overlaps AS (
						SELECT f.follower_id AS user_id,COUNT(*) AS total FROM follows f JOIN follows a ON a.following_id=f.following_id AND a.follower_id=? WHERE f.follower_id IN (SELECT CAST(value AS INTEGER) FROM json_each(?)) GROUP BY f.follower_id
					), shared AS (
						SELECT CAST(c.value AS INTEGER) AS user_id FROM json_each(?) c WHERE
						EXISTS(SELECT 1 FROM group_memberships a JOIN group_memberships b ON a.group_id=b.group_id WHERE a.user_id=CAST(c.value AS INTEGER) AND b.user_id=? AND a.status='active' AND b.status='active') OR
						EXISTS(SELECT 1 FROM dm_channels d WHERE EXISTS(SELECT 1 FROM json_each(d.participants) p WHERE CAST(p.value AS INTEGER)=CAST(c.value AS INTEGER)) AND EXISTS(SELECT 1 FROM json_each(d.participants) p WHERE CAST(p.value AS INTEGER)=?)) OR
						EXISTS(SELECT 1 FROM group_dms d WHERE EXISTS(SELECT 1 FROM json_each(d.member) p WHERE CAST(p.value AS INTEGER)=CAST(c.value AS INTEGER)) AND EXISTS(SELECT 1 FROM json_each(d.member) p WHERE CAST(p.value AS INTEGER)=?))
					), totals AS (SELECT candidates.user_id,COALESCE(user_count.total,0) AS user_total,COALESCE(author_count.total,0) AS author_total,COALESCE(overlaps.total,0) AS overlap,shared.user_id IS NOT NULL AS shared FROM candidates
						LEFT JOIN counts user_count ON user_count.follower_id=candidates.user_id LEFT JOIN counts author_count ON author_count.follower_id=? LEFT JOIN overlaps ON overlaps.user_id=candidates.user_id LEFT JOIN shared ON shared.user_id=candidates.user_id)
					SELECT * FROM totals`).bind(candidateIds,encoded,authorId,candidateIds,candidateIds,authorId,authorId,authorId,authorId),
				]);
				const relevanceByUser={},sharedUserIds=[];for(const row of relations.results||[]){const id=Number(row.user_id),union=Number(row.user_total)+Number(row.author_total)-Number(row.overlap),shared=Boolean(row.shared);if(shared)sharedUserIds.push(id);relevanceByUser[id]=(union?Number(row.overlap)/union:0)+(shared?0.2:0);}
				return json({users:(users.results||[]).map(user=>({...user,settings:parseJsonMaybe(user.settings,{}),block:parseJsonMaybe(user.block,[])})),relevanceByUser,sharedUserIds});
			}
			if (method==='POST' && pathname==='/reputation/claim-note-notification') {
				const body=await request.json(); const result=await db.prepare('UPDATE note_distribution SET notified=1 WHERE note_id=? AND user_id=? AND notified=0 AND tier<>0').bind(Number(body.noteId),Number(body.userId)).run();
				return json(result.meta.changes>0);
			}
			if (method==='POST' && pathname==='/reputation/claim-notice') {
				const body=await request.json(); const result=await db.prepare('INSERT OR IGNORE INTO reputation_notice_claims(notice_key) VALUES(?)').bind(String(body.key)).run();
				return json(result.meta.changes>0);
			}
			if (method==='POST' && pathname==='/reputation/release-note-notification') {
				const body=await request.json(); const result=await db.prepare('UPDATE note_distribution SET notified=0 WHERE note_id=? AND user_id=? AND notified=1').bind(Number(body.noteId),Number(body.userId)).run();
				return json(result.meta.changes>0);
			}
			if (method==='POST' && pathname==='/reputation/release-notice') {
				const body=await request.json(); const result=await db.prepare('DELETE FROM reputation_notice_claims WHERE notice_key=?').bind(String(body.key)).run();
				return json(result.meta.changes>0);
			}
			if (method==='GET' && /^\/community-notes\/\d+\/negative-reasons$/.test(pathname)) {
				const noteId=Number(pathname.split('/')[2]);
				const userIdsParam=url.searchParams.get('userIds');
				if (userIdsParam===null) {
					const rows=await db.prepare(`SELECT d.label_ja,COUNT(*) AS total FROM note_rating_reasons r JOIN note_reason_tag_defs d ON d.code=r.code JOIN note_ratings v ON v.note_id=r.note_id AND v.user_id=r.user_id WHERE r.note_id=? AND v.helpful=0 AND d.side='negative' GROUP BY d.label_ja ORDER BY total DESC,d.label_ja LIMIT 3`).bind(noteId).all();
					return json(rows.results.map(r=>r.label_ja));
				}
				const userIds=(userIdsParam==='' ? [] : userIdsParam.split(',').map(Number).filter(Number.isSafeInteger));
				if (!userIds.length) return json([]);
				const rows=await db.prepare(`SELECT d.label_ja,COUNT(*) AS total FROM note_rating_reasons r JOIN note_reason_tag_defs d ON d.code=r.code JOIN note_ratings v ON v.note_id=r.note_id AND v.user_id=r.user_id WHERE r.note_id=? AND r.user_id IN (${userIds.map(()=>'?').join(',')}) AND v.helpful=0 AND d.side='negative' GROUP BY d.label_ja ORDER BY total DESC,d.label_ja LIMIT 3`).bind(noteId,...userIds).all();
				return json(rows.results.map(r=>r.label_ja));
			}
			if (method === 'GET' && /^\/reputation\/\d+\/evidence$/.test(pathname)) {
				const prefix=url.searchParams.get('prefix') || '';
				const rows=await db.prepare('SELECT scope,event_key,dimension,amount,successes,day,metadata FROM reputation_events WHERE user_id=? AND substr(scope,1,?) = ? ORDER BY scope').bind(Number(pathname.split('/')[2]),prefix.length,prefix).all();
				return json(rows.results.map(r=>({...r,metadata:JSON.parse(r.metadata)})));
			}
			if (method === 'POST' && pathname === '/reputation/report') {
				const body=await request.json();
				try {return json(await reportReputation.applySqlite(db,body.reportId,body));}
				catch (error) {if ([400,404,409].includes(error.statusCode)) return json({error:error.message},error.statusCode);throw error;}
			}
			if (method === 'GET' && /^\/reputation\/\d+$/.test(pathname)) {
				const excludeScope=url.searchParams.get('excludeScope');
				const args=excludeScope===null?[Number(pathname.split('/')[2])]:[Number(pathname.split('/')[2]),excludeScope];
				const qualification=url.searchParams.get('trustBasis')==='1';
				const rows=await db.prepare(qualification?reputationStorage.trustBasisQuery('sqlite'):reputationStorage.reputationProfileQuery('sqlite',false,excludeScope!==null)).bind(...(qualification?[Number(pathname.split('/')[2]),excludeScope]:args)).all();
				return json(reputationStorage.profileFromRows(rows.results));
			}
			if (method === 'POST' && pathname === '/reputation/events') {
				const body=await request.json();
				const results=await db.batch(reputationStorage.sqliteReputationStatements(db,String(body.scope),body.events,body.evaluation));
				return json(body.evaluation ? results[body.evaluation.status==='deleted'?results.length-1:results.length-2].meta.changes>0 : true);
			}
			if (method === 'GET' && /^\/community-notes\/\d+\/review-data$/.test(pathname)) {
				const noteId=Number(pathname.split('/')[2]);
				const rows=await db.prepare('SELECT n.rating_version,r.user_id,r.helpful,r.created_at,r.updated_at,r.weight FROM community_notes n LEFT JOIN note_ratings r ON r.note_id=n.id WHERE n.id=? ORDER BY r.created_at,r.user_id').bind(noteId).all();
				return json(rows.results.length ? {version:Number(rows.results[0].rating_version),ratings:rows.results.filter(r=>r.user_id!=null).map(r=>({userId:Number(r.user_id),helpful:Boolean(r.helpful),createdAt:r.created_at,updatedAt:r.updated_at,weight:Number(r.weight)}))}:null);
			}
			if (method === 'GET' && /^\/community-notes\/\d+\/vote-evidence$/.test(pathname)) {
				const noteId=Number(pathname.split('/')[2]);
				const [ratings,admissions,note]=await db.batch([
					 db.prepare(`SELECT r.user_id,r.helpful,r.created_at,r.updated_at,r.weight,
						(SELECT revision FROM note_vote_admissions WHERE note_id=r.note_id AND user_id=r.user_id ORDER BY revision DESC LIMIT 1) AS revision,
						(SELECT admitted_at FROM note_vote_admissions WHERE note_id=r.note_id AND user_id=r.user_id ORDER BY revision DESC LIMIT 1) AS cast_at,
						(SELECT legacy FROM note_vote_admissions WHERE note_id=r.note_id AND user_id=r.user_id ORDER BY revision DESC LIMIT 1) AS vote_legacy
						FROM note_ratings r WHERE r.note_id=? ORDER BY r.user_id`).bind(noteId),
					db.prepare('SELECT user_id,revision,admitted_at,authorized,weight,evidence_ref,relation_manifest,legacy FROM note_vote_admissions WHERE note_id=? ORDER BY user_id,revision').bind(noteId),
					db.prepare('SELECT rating_version FROM community_notes WHERE id=?').bind(noteId),
				]);
				if (!note.results[0]) return json(null);
				return json({version:Number(note.results[0].rating_version),ratings:ratings.results.map(row=>({userId:Number(row.user_id),helpful:Boolean(row.helpful),weight:Number(row.weight),revision:row.vote_legacy||row.revision==null?null:Number(row.revision),castAt:row.vote_legacy?null:row.cast_at,createdAt:row.created_at,updatedAt:row.updated_at})),admissions:admissions.results.map(row=>({noteId,userId:Number(row.user_id),revision:Number(row.revision),admittedAt:row.admitted_at,authorized:Boolean(row.authorized),weight:Number(row.weight),evidenceRef:row.evidence_ref,relationManifest:parseJsonMaybe(row.relation_manifest,null),legacy:Boolean(row.legacy)}))});
			}
			if (method === 'POST' && pathname === '/community-notes/by-posts') {
				const body=await request.json(); const ids=[...new Set((body.ids || []).map(Number).filter(id=>Number.isSafeInteger(id)&&id>0))].slice(0,100);
				if (!ids.length) return json([]);
				const rows=await db.prepare(`SELECT * FROM community_notes WHERE post_id IN (${ids.map(()=>'?').join(',')})`).bind(...ids).all();
				return json(await Promise.all(rows.results.map(n=>formatCommunityNoteRow(n))));
			}
			if (method === 'GET' && /^\/posts\/\d+\/positive-users$/.test(pathname)) {
				const id=Number(pathname.split('/')[2]);
				const rows=await db.prepare('SELECT user_id FROM likes WHERE post_id=? UNION SELECT user_id FROM stars WHERE post_id=? ORDER BY user_id LIMIT ?').bind(id,id,Math.min(Number(url.searchParams.get('limit'))||200,500)).all();
				return json(rows.results.map(r=>Number(r.user_id)));
			}

			function parseJsonMaybe(value, fallback) {
				if (value == null) return fallback;
				if (typeof value === 'object') return value;
				try { return JSON.parse(value); } catch (_) { return fallback; }
			}

			async function communityNoteRatingsSummary(noteId, currentUserId = null) {
				const { results } = await db.prepare('SELECT helpful, user_id FROM note_ratings WHERE note_id = ?').bind(noteId).all();
				let helpfulCount = 0;
				let totalRatingCount = 0;
				let myRating = null;
				for (const r of results || []) {
					totalRatingCount += 1;
					if (Number(r.helpful) === 1 || r.helpful === true) helpfulCount += 1;
					if (currentUserId != null && Number(r.user_id) === Number(currentUserId)) myRating = (Number(r.helpful) === 1 || r.helpful === true);
				}
				return { helpfulCount, totalRatingCount, myRating };
			}

			async function communityNoteTagRows(noteId) {
				const { results } = await db.prepare('SELECT side, code FROM note_reason_tags WHERE note_id = ?').bind(noteId).all();
				return (results || []).map((r) => ({ side: r.side, code: r.code }));
			}

			async function formatCommunityNoteRow(note, currentUserId = null) {
				if (!note) return null;
				const summary = await communityNoteRatingsSummary(Number(note.id), currentUserId);
				const tags = await communityNoteTagRows(Number(note.id));
				const sources = parseJsonMaybe(note.sources, []);
				return {
					id: Number(note.id),
					postId: Number(note.post_id),
					distributionKey: note.distribution_key || `${note.post_id}:${note.user_id}`,
					userId: Number(note.user_id),
					content: note.content,
					sources: Array.isArray(sources) ? sources : [],
					status: note.status || 'limited',
					stage: Number(note.stage ?? 1) || 1,
					publishedAt: note.published_at ?? null,
					createdAt: note.created_at ?? null,
					updatedAt: note.updated_at ?? null,
					helpfulCount: summary.helpfulCount,
					totalRatingCount: summary.totalRatingCount,
					myRating: summary.myRating,
					reasons: tags,
				};
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/engaged-users$/)) {
				const postId = Number(pathname.split('/')[2]);
				const ids = new Set();
				try {
					const { results: likeRows } = await db.prepare('SELECT user_id FROM likes WHERE post_id = ?').bind(postId).all();
					for (const r of likeRows || []) ids.add(Number(r.user_id));
				} catch (_) {}
				try {
					const { results: starRows } = await db.prepare('SELECT user_id FROM stars WHERE post_id = ?').bind(postId).all();
					for (const r of starRows || []) ids.add(Number(r.user_id));
				} catch (_) {}
				try {
					const { results: repostRows } = await db.prepare('SELECT user_id FROM reposts WHERE post_id = ?').bind(postId).all();
					for (const r of repostRows || []) ids.add(Number(r.user_id));
				} catch (_) {}
				try {
					const { results: replyRows } = await db.prepare('SELECT user_id FROM posts WHERE reply_to = ?').bind(postId).all();
					for (const r of replyRows || []) ids.add(Number(r.user_id));
				} catch (_) {}
				return json([...ids].filter(Number.isSafeInteger));
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/engaged-users-page$/)) {
				const postId=Number(pathname.split('/')[2]);
				const afterUserId=Math.max(0,Number(url.searchParams.get('afterUserId'))||0);
				const limit=Math.min(500,Math.max(1,Number(url.searchParams.get('limit'))||500));
				const {results}=await db.prepare(`SELECT user_id FROM (
					SELECT user_id FROM likes WHERE post_id=?
					UNION SELECT user_id FROM stars WHERE post_id=?
					UNION SELECT user_id FROM reposts WHERE post_id=?
					UNION SELECT user_id FROM posts WHERE reply_to=?
				) engaged WHERE user_id>? ORDER BY user_id LIMIT ?`).bind(postId,postId,postId,postId,afterUserId,limit).all();
				return json((results||[]).map(row=>Number(row.user_id)).filter(Number.isSafeInteger));
			}

			if (method === 'GET' && pathname === '/note-reason-tags') {
				const side = url.searchParams.get('side');
				let sql = 'SELECT code, side, label_ja, description, sort_order FROM note_reason_tag_defs WHERE enabled = 1';
				const binds = [];
				if (side) { sql += ' AND side = ?'; binds.push(side); }
				sql += ' ORDER BY sort_order ASC, code ASC';
				const { results } = await db.prepare(sql).bind(...binds).all();
				return json((results || []).map((r) => ({
					code: r.code,
					side: r.side,
					label: r.label_ja,
					description: r.description ?? null,
					sortOrder: Number(r.sort_order) || 0,
				})));
			}

			if (method === 'POST' && pathname === '/community-notes') {
				const body = await request.json();
				const postId = Number(body.postId ?? body.post_id);
				const userId = Number(body.userId ?? body.userId);
				const content = String(body.content || '');
				// sources normalization
				let rawSources = body.sources || [];
				if (!Array.isArray(rawSources)) rawSources = [];
				const sources = [];
				const seen = new Set();
				for (const src of rawSources) {
					const url = String(src?.url || src || '').trim();
					const title = src?.title != null ? String(src.title).trim() : '';
					if (!url) continue;
					let parsed;
					try { parsed = new URL(url); } catch (_) { continue; }
					if (parsed.protocol !== 'https:') continue;
					if (seen.has(url)) continue;
					seen.add(url);
					sources.push({ url, title });
				}
				const status = String(body.status || 'limited');
				const dailyLimit = body.dailyLimit === undefined ? null : body.dailyLimit;
				if (dailyLimit !== null && (!Number.isInteger(dailyLimit) || dailyLimit < 1)) return json({error:'Invalid note daily limit'},400);
				const noteId = body.id != null ? Number(body.id) : Number(BigInt(`0x${crypto.randomUUID().replace(/-/g, '').slice(0, 13)}`) % 9007199254740991n);
				const now = new Date().toISOString();
				const creation = await db.batch([
					db.prepare(`INSERT INTO note_creation_claims(post_id,user_id,created_at) SELECT ?,?,? WHERE
					 NOT EXISTS(SELECT 1 FROM note_creation_claims WHERE post_id=? AND user_id=?) AND
					 (? IS NULL OR (SELECT COUNT(*) FROM note_creation_claims WHERE user_id=? AND created_at>=?)<?) AND
					 (SELECT COUNT(*) FROM community_notes WHERE post_id=?)<?`).bind(postId,userId,now,postId,userId,dailyLimit,userId,`${now.slice(0,10)}T00:00:00.000Z`,dailyLimit,postId,Number(body.postLimit)||20),
					db.prepare(
					`INSERT INTO community_notes (id, post_id, user_id, content, sources, status, created_at, updated_at,distribution_key)
					 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes()>0`
				).bind(noteId, postId, userId, content, JSON.stringify(sources), status, now, now,`${postId}:${userId}`)]);
				if (!creation[1].meta.changes) {
					const existingClaim = await db.prepare('SELECT 1 AS hit FROM note_creation_claims WHERE post_id=? AND user_id=?').bind(postId,userId).first();
					if (existingClaim) return json({error:'同じ投稿には一度だけノートを作成できます',code:'NOTE_ALREADY_EXISTS'},409);
					if (dailyLimit !== null) {
						const daily = await db.prepare('SELECT COUNT(*) AS cnt FROM note_creation_claims WHERE user_id=? AND created_at>=?').bind(userId,`${now.slice(0,10)}T00:00:00.000Z`).first();
						if (Number(daily?.cnt || 0) >= dailyLimit) return json({error:'本日のノート作成上限に達しました',code:'NOTE_DAILY_LIMIT'},429);
					}
					return json({error:'この投稿のノート上限に達しました',code:'NOTE_POST_LIMIT'},429);
				}

				// reasons
				const reasons = Array.isArray(body.reasons) ? body.reasons : [];
				for (const r of reasons) {
					const side = String(r?.side || '').trim();
					const code = String(r?.code || r || '').trim();
					if (!side || !code) continue;
					try {
						await db.prepare('INSERT OR IGNORE INTO note_reason_tag_defs (code, side, label_ja, sort_order, enabled) VALUES (?, ?, ?, 0, 1)').bind(code, side, code).run();
					} catch (_) {}
					try {
						await db.prepare('INSERT OR IGNORE INTO note_reason_tags (note_id, side, code) VALUES (?, ?, ?)').bind(noteId, side, code).run();
					} catch (_) {}
				}

				const note = await db.prepare('SELECT * FROM community_notes WHERE id = ?').bind(noteId).first();
				return json(await formatCommunityNoteRow(note, userId));
			}

			if (method === 'GET' && pathname.match(/^\/posts\/(\d+)\/notes$/)) {
				const postId = Number(pathname.split('/')[2]);
				const currentUserId = url.searchParams.get('currentUserId') != null ? Number(url.searchParams.get('currentUserId')) : null;
				const { results: notes } = await db.prepare('SELECT * FROM community_notes WHERE post_id = ? ORDER BY created_at DESC').bind(postId).all();
				const out = [];
				for (const n of notes || []) {
					out.push(await formatCommunityNoteRow(n, currentUserId));
				}
				return json(out);
			}

			if (method === 'GET' && pathname.match(/^\/community-notes\/(\d+)$/)) {
				const noteId = Number(pathname.split('/')[2]);
				const currentUserId = url.searchParams.get('currentUserId') != null ? Number(url.searchParams.get('currentUserId')) : null;
				const note = await db.prepare('SELECT * FROM community_notes WHERE id = ?').bind(noteId).first();
				if (!note) return notFound('Note not found');
				return json(await formatCommunityNoteRow(note, currentUserId));
			}

			if (method === 'GET' && pathname === '/community-notes/count') {
				const userId = Number(url.searchParams.get('userId'));
				const since = url.searchParams.get('since');
				if (!Number.isFinite(userId)) return badRequest('userId required');
				let sql = 'SELECT COUNT(*) AS cnt FROM community_notes WHERE user_id = ?';
				const binds = [userId];
				if (since) {
					sql += ' AND created_at >= ?';
					binds.push(since);
				}
				const row = await db.prepare(sql).bind(...binds).first();
				return json({ count: Number(row?.cnt || 0) });
			}

			if (method === 'POST' && pathname.match(/^\/community-notes\/(\d+)\/ratings$/)) {
				const noteId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const userId = Number(body.userId ?? body.user_id);
				const helpful = (body.helpful === true || body.helpful === 'true' || body.helpful === 1) ? 1 : 0;
				const now = new Date().toISOString();
				const savedWeight=Math.min(1.5,Math.max(1,Number(body.weight)||1));
				let reacceptLegacy=false;
				if (body.expectedRatingVersion != null) {
					const note=await db.prepare('SELECT n.rating_version,n.user_id,p.user_id AS post_author_id FROM community_notes n JOIN posts p ON p.id=n.post_id WHERE n.id=?').bind(noteId).first();
					if (!note || Number(note.rating_version)!==Number(body.expectedRatingVersion)) return json({error:'投票状態が同時に変更されました'},409);
					const manifest=body.relationManifest,covered=new Set(manifest?.coveredUserIds || []);
					if (manifest?.basis!=='admission-evidence'||manifest.complete!==true||!manifest.version||!manifest.evidenceRef||![userId,Number(note.user_id),Number(note.post_author_id)].every(id=>covered.has(id))) return json({error:'関係証跡が不完全です'},400);
					const prior=await db.prepare(`SELECT a.authorized,a.legacy FROM note_vote_admissions a JOIN note_ratings r ON r.note_id=a.note_id AND r.user_id=a.user_id
						WHERE a.note_id=? AND a.user_id=? ORDER BY a.revision DESC LIMIT 1`).bind(noteId,userId).first();
					reacceptLegacy=Boolean(prior&&(Number(prior.legacy)===1||Number(prior.authorized)!==1));
				}
				const results=await db.batch([db.prepare(`INSERT INTO note_ratings(note_id,user_id,helpful,created_at,updated_at,weight)
					 SELECT ?,?,?,?,?,? WHERE (EXISTS(SELECT 1 FROM note_ratings WHERE note_id=? AND user_id=?) OR (SELECT COUNT(*) FROM note_ratings WHERE note_id=?)<?)
					 AND (? IS NULL OR (SELECT rating_version FROM community_notes WHERE id=?)=?)
					 ON CONFLICT(note_id,user_id) DO UPDATE SET helpful=excluded.helpful,updated_at=excluded.updated_at WHERE note_ratings.helpful<>excluded.helpful OR ?`)
					 .bind(noteId,userId,helpful,now,now,savedWeight,noteId,userId,noteId,Number(body.maxRatings)||200,body.expectedRatingVersion ?? null,noteId,body.expectedRatingVersion ?? null,reacceptLegacy?1:0),
					db.prepare(`INSERT INTO note_vote_admissions(note_id,user_id,revision,admitted_at,authorized,weight,evidence_ref,relation_manifest,legacy)
					 SELECT ?,?,COALESCE(MAX(revision),0)+1,?, ?, (SELECT weight FROM note_ratings WHERE note_id=? AND user_id=?),
					 CASE WHEN ? THEN 'note:'||?||':vote:'||?||':revision:'||(COALESCE(MAX(revision),0)+1) ELSE NULL END,?,0
					 FROM note_vote_admissions WHERE note_id=? AND user_id=? HAVING changes()>0`)
					 .bind(noteId,userId,now,Boolean(body.relationManifest&&body.expectedRatingVersion!=null)?1:0,noteId,userId,Boolean(body.relationManifest&&body.expectedRatingVersion!=null)?1:0,noteId,userId,body.relationManifest == null ? null : JSON.stringify(body.relationManifest),noteId,userId)]);
				if (body.expectedRatingVersion!=null && !results[0].meta.changes) {
					const current=await db.prepare('SELECT rating_version FROM community_notes WHERE id=?').bind(noteId).first();
					if (Number(current?.rating_version)!==Number(body.expectedRatingVersion)) return json({error:'投票状態が同時に変更されました'},409);
				}
				const summary = await communityNoteRatingsSummary(noteId, userId);
				return json(summary);
			}

			if (method === 'POST' && pathname.match(/^\/community-notes\/(\d+)\/rating-reasons$/)) {
				const noteId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const userId = Number(body.userId ?? body.user_id);
				if (!Number.isFinite(userId)) return badRequest('userId required');
				const codes = [...new Set((Array.isArray(body.codes) ? body.codes : [])
					.map((c) => String(c || '').trim())
					.filter(Boolean))];
				const now = new Date().toISOString();
				await db.prepare('DELETE FROM note_rating_reasons WHERE note_id = ? AND user_id = ?').bind(noteId, userId).run();
				for (const code of codes) {
					try {
						await db.prepare('INSERT OR IGNORE INTO note_rating_reasons (note_id, user_id, code, created_at) VALUES (?, ?, ?, ?)').bind(noteId, userId, code, now).run();
					} catch (_) {}
				}
				return json({ success: true, codes });
			}

			if (method === 'GET' && pathname.match(/^\/community-notes\/(\d+)\/ratings-summary$/)) {
				const noteId = Number(pathname.split('/')[2]);
				const currentUserId = url.searchParams.get('currentUserId') != null ? Number(url.searchParams.get('currentUserId')) : null;
				const summary = await communityNoteRatingsSummary(noteId, currentUserId);
				return json(summary);
			}



			if (method === 'DELETE' && pathname.match(/^\/community-notes\/(\d+)$/)) {
				const noteId = Number(pathname.split('/')[2]);
				await db.prepare('DELETE FROM note_rating_reasons WHERE note_id = ?').bind(noteId).run();
				await db.prepare('DELETE FROM note_reason_tags WHERE note_id = ?').bind(noteId).run();
				await db.prepare('DELETE FROM note_ratings WHERE note_id = ?').bind(noteId).run();
				await db.prepare('DELETE FROM note_distribution WHERE note_id = ?').bind(noteId).run();
				await db.prepare('DELETE FROM note_vote_admissions WHERE note_id = ?').bind(noteId).run();
				const removed = await db.prepare('DELETE FROM community_notes WHERE id = ?').bind(noteId).run();
				return json({ success: (removed.meta?.changes || 0) > 0 });
			}

			if (method === 'PATCH' && pathname.match(/^\/community-notes\/(\d+)$/)) {
				const noteId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const sets = [];
				const vals = [];
				if (body.status != null) { sets.push('status = ?'); vals.push(String(body.status)); }
				if (body.stage != null) { sets.push('stage = ?'); vals.push(Number(body.stage)); }
				const pa = body.publishedAt ?? body.published_at;
				if (body.publishedAt !== undefined || body.published_at !== undefined) { sets.push('published_at = ?'); vals.push(pa == null ? null : String(pa)); }
				if (sets.length > 0) {
					sets.push('updated_at = ?');
					vals.push(new Date().toISOString());
					vals.push(noteId);
					await db.prepare(`UPDATE community_notes SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
				}
				const note = await db.prepare('SELECT * FROM community_notes WHERE id = ?').bind(noteId).first();
				if (!note) return notFound('Note not found');
				return json(await formatCommunityNoteRow(note, null));
			}

			// note_distribution
			if (method === 'POST' && pathname === '/community-note-distributions/batch') {
				const body=await request.json(),rows=Array.isArray(body.rows)?body.rows:[];
				for(let offset=0;offset<rows.length;offset+=100){const batch=rows.slice(offset,offset+100).filter(row=>Number.isSafeInteger(Number(row.noteId))&&Number.isSafeInteger(Number(row.userId)));
					if(!batch.length)continue;const now=new Date().toISOString();
					await db.batch(batch.map(row=>db.prepare(`INSERT INTO note_distribution(note_id,user_id,tier,notified,created_at) VALUES(?,?,?,?,?)
						ON CONFLICT(note_id,user_id) DO UPDATE SET tier=excluded.tier,notified=excluded.notified`).bind(Number(row.noteId),Number(row.userId),Number(row.tier??1),row.notified?1:0,now)));
				}return json({ok:true,count:rows.length});
			}
			if (method === 'POST' && pathname === '/community-note-distributions') {
				const body = await request.json();
				const noteId = Number(body.noteId ?? body.note_id);
				const userId = Number(body.userId ?? body.user_id);
				const tier = body.tier != null ? Number(body.tier) : 1;
				const notified = Boolean(body.notified ?? false);
				const existing = await db.prepare('SELECT 1 AS x FROM note_distribution WHERE note_id = ? AND user_id = ?').bind(noteId, userId).first();
				const now = new Date().toISOString();
				if (existing) {
					await db.prepare('UPDATE note_distribution SET tier = ?, notified = ? WHERE note_id = ? AND user_id = ?').bind(tier, notified ? 1 : 0, noteId, userId).run();
				} else {
					await db.prepare('INSERT INTO note_distribution (note_id, user_id, tier, notified, created_at) VALUES (?, ?, ?, ?, ?)').bind(noteId, userId, tier, notified ? 1 : 0, now).run();
				}
				return json({ noteId, userId, tier, notified, createdAt: now });
			}

			if (method === 'GET' && pathname === '/community-note-distributions') {
				const noteId = url.searchParams.get('noteId') != null ? Number(url.searchParams.get('noteId')) : null;
				const userId = url.searchParams.get('userId') != null ? Number(url.searchParams.get('userId')) : null;
				if (noteId != null && userId != null) {
					const row = await db.prepare('SELECT * FROM note_distribution WHERE note_id = ? AND user_id = ?').bind(noteId, userId).first();
					if (!row) return json(null);
					return json({ noteId: Number(row.note_id), userId: Number(row.user_id), tier: Number(row.tier), notified: Boolean(row.notified), createdAt: row.created_at ?? null });
				}
				let sql = 'SELECT * FROM note_distribution WHERE 1=1';
				const binds = [];
				if (noteId != null) { sql += ' AND note_id = ?'; binds.push(noteId); }
				if (userId != null) { sql += ' AND user_id = ?'; binds.push(userId); }
				const { results } = await db.prepare(sql).bind(...binds).all();
				const out = (results || []).map((r) => ({ noteId: Number(r.note_id), userId: Number(r.user_id), tier: Number(r.tier), notified: Boolean(r.notified), createdAt: r.created_at ?? null }));
				return json(out);
			}

			if (method === 'GET' && pathname === '/community-note-distributions/batch') {
				const noteId=Number(url.searchParams.get('noteId'));
				const ids=(url.searchParams.get('userIds')||'').split(',').map(Number).filter(Number.isSafeInteger).slice(0,500);
				if(!Number.isSafeInteger(noteId)||noteId<=0||!ids.length)return json([]);
				const {results}=await db.prepare(`SELECT note_id,user_id,tier,notified,created_at FROM note_distribution WHERE note_id=? AND user_id IN (${ids.map(()=>'?').join(',')})`).bind(noteId,...ids).all();
				return json((results||[]).map(row=>({noteId:Number(row.note_id),userId:Number(row.user_id),tier:Number(row.tier),notified:Boolean(row.notified),createdAt:row.created_at??null})));
			}

			if (method === 'DELETE' && pathname.match(/^\/community-note-distributions\/(\d+)(?:\/(\d+))?$/)) {
				const parts = pathname.split('/');
				const noteId = Number(parts[2]);
				const userId = parts[3] != null ? Number(parts[3]) : null;
				if (userId == null) {
					await db.prepare('DELETE FROM note_distribution WHERE note_id = ?').bind(noteId).run();
				} else {
					await db.prepare('DELETE FROM note_distribution WHERE note_id = ? AND user_id = ?').bind(noteId, userId).run();
				}
				return json({ success: true });
			}

			if (method === 'GET' && pathname === '/shared-group-membership') {
				const u1 = Number(url.searchParams.get('userId1'));
				const u2 = Number(url.searchParams.get('userId2'));
				let groups = 0;
				try {
					const row = await db.prepare('SELECT COUNT(*) AS c FROM group_memberships a JOIN group_memberships b ON a.group_id = b.group_id WHERE a.user_id = ? AND b.user_id = ? AND a.status = ? AND b.status = ?').bind(u1, u2, 'active', 'active').first();
					groups = Number(row?.c || 0);
				} catch (_) {}
				let dms = 0;
				try {
					const { results: dmRows } = await db.prepare('SELECT participants FROM dm_channels').all();
					for (const r of dmRows || []) {
						let parts = [];
						try { parts = JSON.parse(r.participants); } catch (_) { parts = String(r.participants || '').split(',').map((x) => Number(String(x).trim())); }
						if (parts.map(Number).includes(u1) && parts.map(Number).includes(u2)) dms++;
					}
				} catch (_) {}
				try {
					const { results: gdmRows } = await db.prepare('SELECT member FROM group_dms').all();
					for (const r of gdmRows || []) {
						let members = [];
						try { members = JSON.parse(r.member); } catch (_) { members = String(r.member || '').split(',').map((x) => Number(String(x).trim())); }
						if (members.map(Number).includes(u1) && members.map(Number).includes(u2)) dms++;
					}
				} catch (_) {}
				const total = groups + dms;
				const bonus = total > 0 ? 0.2 : 0;
				return json({ groups, dms, total, bonus });
			}

			if (method === 'POST' && pathname.match(/^\/posts\/(\d+)\/recommendation-penalty$/)) {
				const postId = Number(pathname.split('/')[2]);
				const body = await request.json();
				const delta = Number(body?.delta) || 0;
				const max = Number(body?.max) || 1;
				const row = await db.prepare('SELECT recommendation_penalty FROM posts WHERE id = ?').bind(postId).first();
				const current = Number(row?.recommendation_penalty) || 0;
				const next = Math.min(max, Math.max(0, current + delta));
				await db.prepare('UPDATE posts SET recommendation_penalty = ? WHERE id = ?').bind(next, postId).run();
				return json({ success: true, recommendation_penalty: next });
			}

			return notFound(`Path ${method} ${pathname} not handled`);
		} catch (error) {
			return internalError(error);
		}
	},
};

// Named exports are also used by isolated SQLite-backed migration tests.
export {
	importMigrationSnapshot,
	exportMigrationSnapshot,
	MIGRATION_TABLES,
	MIGRATION_COLUMNS,
	MIGRATION_INSERT_ORDER,
	MIGRATION_EXCLUDED_TABLES,
};
