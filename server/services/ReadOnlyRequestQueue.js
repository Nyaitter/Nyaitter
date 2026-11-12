'use strict';

class ReadOnlyRequestQueue {
  constructor({ concurrency = 5, maxPending = 100, maxWaitMs = 15000, maxRunMs = 30000, fairnessMs = 5000 } = {}) {
    this.concurrency = Math.max(1, Math.min(20, Math.floor(concurrency)));
    this.maxPending = Math.max(0, Math.floor(maxPending));
    this.maxWaitMs = Math.max(1, Math.floor(maxWaitMs));
    this.maxRunMs = Math.max(1, Math.floor(maxRunMs));
    this.fairnessMs = Math.max(1, Math.floor(fairnessMs));
    this.pending = [];
    this.active = 0;
    this.sequence = 0;
    this.stopped = false;
    this.activeCancellations = new Set();
  }

  run(priority, signal, operation) {
    if (typeof operation !== 'function') return Promise.reject(new TypeError('Read-only operation must be a function'));
    if (this.stopped) return Promise.reject(this._error('Read-only request queue is unavailable', 503));
    if (signal?.aborted) return Promise.reject(this._error('Request was cancelled', 499));

    if (this.active < this.concurrency && this.pending.length === 0) {
      return this._run(operation, signal);
    }
    if (this.pending.length >= this.maxPending) {
      return Promise.reject(this._error('Read-only request queue is full', 503));
    }

    return new Promise((resolve, reject) => {
      const item = {
        operation,
        priority: Number.isInteger(priority) ? Math.max(-5, Math.min(5, priority)) : 0,
        sequence: this.sequence++,
        enqueuedAt: Date.now(),
        resolve,
        reject,
        signal,
        timer: null,
        onAbort: null,
      };
      const remove = (error) => {
        const index = this.pending.indexOf(item);
        if (index < 0) return;
        this.pending.splice(index, 1);
        this._cleanup(item);
        reject(error);
        this._dispatch();
      };
      item.onAbort = () => remove(this._error('Request was cancelled', 499));
      item.timer = setTimeout(() => remove(this._error('Read-only request queue timed out', 503)), this.maxWaitMs);
      signal?.addEventListener('abort', item.onAbort, { once: true });
      this.pending.push(item);
      this._dispatch();
    });
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const cancel of this.activeCancellations) cancel();
    for (const item of this.pending.splice(0)) {
      this._cleanup(item);
      item.reject(this._error('Read-only request queue is unavailable', 503));
    }
  }

  _run(operation, signal) {
    this.active += 1;
    const execution = Promise.resolve().then(() => {
      if (this.stopped) throw this._error('Read-only request queue is unavailable', 503);
      if (signal?.aborted) throw this._error('Request was cancelled', 499);
      return operation();
    }).finally(() => {
      this.active = Math.max(0, this.active - 1);
      this._dispatch();
    });
    let onAbort;
    let onStop;
    let runTimer;
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(this._error('Request was cancelled', 499));
      onStop = () => reject(this._error('Read-only request queue is unavailable', 503));
      signal?.addEventListener('abort', onAbort, { once: true });
      this.activeCancellations.add(onStop);
      if (this.stopped) onStop();
    });
    const timeout = new Promise((_, reject) => {
      runTimer = setTimeout(() => reject(this._error('Read-only request timed out', 504)), this.maxRunMs);
    });
    return Promise.race([execution, cancelled, timeout]).finally(() => {
      clearTimeout(runTimer);
      signal?.removeEventListener('abort', onAbort);
      this.activeCancellations.delete(onStop);
    });
  }

  _dispatch() {
    while (!this.stopped && this.active < this.concurrency && this.pending.length) {
      const now = Date.now();
      let bestIndex = 0;
      let bestScore = -Infinity;
      for (let i = 0; i < this.pending.length; i += 1) {
        const item = this.pending[i];
        const age = now - item.enqueuedAt;
        const score = age >= this.fairnessMs ? 1000 + age : item.priority + Math.floor(age / 1000);
        if (score > bestScore || (score === bestScore && item.sequence < this.pending[bestIndex].sequence)) {
          bestIndex = i;
          bestScore = score;
        }
      }
      const [item] = this.pending.splice(bestIndex, 1);
      this._cleanup(item);
      this._run(item.operation, item.signal).then(item.resolve, item.reject);
    }
  }

  _cleanup(item) {
    clearTimeout(item.timer);
    item.signal?.removeEventListener('abort', item.onAbort);
  }

  _error(message, statusCode) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
  }
}

module.exports = ReadOnlyRequestQueue;
