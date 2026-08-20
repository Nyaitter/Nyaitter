'use strict';

const crypto = require('crypto');

/**
 * ポスト操作をHTTPレスポンスの外側で順次実行するプロセス内キュー。
 * DB更新の重複を避けるため、失敗したジョブの自動再試行は行わない。
 */
class PostActionQueue {
  constructor({ maxPendingJobs = 1000 } = {}) {
    this.maxPendingJobs = maxPendingJobs;
    this.queue = [];
    this.processing = false;
    this.stopped = false;
  }

  enqueue(type, run) {
    if (this.stopped) {
      const error = new Error('Post action queue is unavailable');
      error.statusCode = 503;
      throw error;
    }
    if (typeof run !== 'function') {
      throw new TypeError('Post action must be a function');
    }
    if (this.queue.length >= this.maxPendingJobs) {
      const error = new Error('Post action queue is full');
      error.statusCode = 503;
      throw error;
    }

    const actionId = crypto.randomUUID();
    this.queue.push({ actionId, type: String(type || 'post'), run });
    this._startProcessing();
    return actionId;
  }

  stop() {
    this.stopped = true;
    this.queue.length = 0;
  }

  _startProcessing() {
    if (this.processing || this.stopped) return;
    this.processing = true;
    void this._processQueue()
      .catch((error) => {
        console.error('[post-actions] queue stopped unexpectedly:', error.message);
      })
      .finally(() => {
        this.processing = false;
        if (!this.stopped && this.queue.length > 0) this._startProcessing();
      });
  }

  async _processQueue() {
    while (!this.stopped && this.queue.length > 0) {
      const job = this.queue.shift();
      try {
        await job.run();
      } catch (error) {
        console.error(
          `[post-actions] ${job.type} action=${job.actionId} failed:`,
          error.message,
        );
      }
    }
  }
}

module.exports = PostActionQueue;
