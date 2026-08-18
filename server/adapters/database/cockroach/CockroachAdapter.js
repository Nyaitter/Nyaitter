const { Pool } = require('pg');
const PostgresAdapter = require('../postgres/PostgresAdapter');

class CockroachAdapter extends PostgresAdapter {
  constructor(options = {}) {
    super(options);
    this.transactionRetries = Math.max(
      0,
      Math.min(10, Math.floor(Number(options.transactionRetries) || 5)),
    );
    this.retryBaseDelayMs = Math.max(
      10,
      Math.min(5000, Math.floor(Number(options.retryBaseDelayMs) || 50)),
    );
  }

  async connect() {
    const connectionString =
      this.config.connectionString ||
      process.env.COCKROACH_DATABASE_URL ||
      process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'CockroachDB Cloud connection string is required (COCKROACH_DATABASE_URL, DATABASE_URL, or config.connectionString)',
      );
    }

    this.pool = new Pool({
      connectionString,
      max: this.config.poolSize || 10,
      min: Math.min(this.config.poolSize || 10, this.config.poolMin || 2),
      idleTimeoutMillis: this.config.poolIdleTimeoutMs || 300000,
      connectionTimeoutMillis: this.config.connectionTimeoutMs || 15000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
      ssl: this.config.sslCa
        ? { ca: this.config.sslCa, rejectUnauthorized: true }
        : { rejectUnauthorized: true },
    });
    const client = await this.pool.connect();
    try {
      await client.query('SELECT 1');
    } finally {
      client.release();
    }
    console.log('[CockroachAdapter] Connected to CockroachDB');
  }

  _isRetryableTransactionError(error) {
    return error?.code === '40001' || /restart transaction/i.test(error?.message || '');
  }

  async _waitForTransactionRetry(attempt) {
    const delay = Math.min(
      2000,
      this.retryBaseDelayMs * (2 ** Math.max(0, attempt - 1)),
    );
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  async _withTransaction(operation) {
    let lastError;
    for (let attempt = 0; attempt <= this.transactionRetries; attempt += 1) {
      const client = await this.pool.connect();
      let started = false;
      try {
        await client.query('BEGIN');
        started = true;
        const result = await operation(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        lastError = error;
        if (started) {
          try {
            await client.query('ROLLBACK');
          } catch (_) {
            // The original query error is more useful to callers.
          }
        }
        if (
          !this._isRetryableTransactionError(error) ||
          attempt >= this.transactionRetries
        ) {
          throw error;
        }
        await this._waitForTransactionRetry(attempt + 1);
      } finally {
        client.release();
      }
    }
    throw lastError;
  }
}

module.exports = CockroachAdapter;
