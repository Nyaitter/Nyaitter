const config = require('../config');
const DatabaseAdapter = require('./database/DatabaseAdapter');
const StorageAdapter = require('./storage/StorageAdapter');
const InMemoryAdapter = require('./database/InMemoryAdapter');

const LocalStorageAdapter = require('./storage/local/LocalStorageAdapter');

/**
 * データベースアダプターを生成する
 */
function createDatabaseAdapter() {
	const type = config.database.adapter;

	if (type === 'memory' || type === 'inmemory') {
		console.log('[adapters] Using InMemoryAdapter (開発用)');
		return new InMemoryAdapter();
	}

	if (type === 'postgres' || type === 'pg') {
		console.log('[adapters] Using PostgresAdapter');
		const PostgresAdapter = require('./database/postgres/PostgresAdapter');
		return new PostgresAdapter(config.database.postgres);
	}

	if (type === 'd1' || type === 'cloudflare-d1') {
		console.log('[adapters] Using D1Adapter (via Worker proxy)');
		const D1Adapter = require('./database/d1/D1Adapter');
		return new D1Adapter(config.database.d1);
	}

	console.warn(
		`[adapters] Unknown database adapter "${type}". Falling back to InMemoryAdapter.`,
	);
	return new InMemoryAdapter();
}

/**
 * ストレージアダプターを生成する
 */
function createStorageAdapter() {
	const type = config.storage.adapter;

	if (type === 'local' || type === 'filesystem') {
		console.log('[adapters] Using LocalStorageAdapter');
		return new LocalStorageAdapter(config.storage.local);
	}

	if (type === 'r2' || type === 'cloudflare-r2') {
		console.log('[adapters] Using R2StorageAdapter');
		const R2StorageAdapter = require('./storage/r2/R2StorageAdapter');
		return new R2StorageAdapter(config.storage);
	}

	console.warn(
		`[adapters] STORAGE_ADAPTER="${type}" は未対応です。ダミーアダプターを使用します。`,
	);
	return new (class extends StorageAdapter {})();
}

module.exports = {
	createDatabaseAdapter,
	createStorageAdapter,
};
