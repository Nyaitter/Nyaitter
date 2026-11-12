'use strict';

const crypto = require('crypto');

class PostActionQueue {
  constructor({ maxPendingJobs = 1000, concurrency = 5 } = {}) {
    this.maxPendingJobs = maxPendingJobs;
    this.concurrency = Math.max(1, Math.min(concurrency, 20));
    this.queues = Array.from({ length: 11 }, () => ({ jobs: [], head: 0 }));
    this.pending = 0;
    this.lastEnqueuedAt = -Infinity;
    this.clockReversed = false;
    this.activeWorkers = 0;
    this.stopped = false;
    this.nextSequence = 0;
  }

  get length() {
    return this.pending;
  }

  enqueue(type, run, policy = null) {
    if (this.stopped) {
      const error = new Error('Post action queue is unavailable');
      error.statusCode = 503;
      throw error;
    }
    if (typeof run !== 'function') {
      throw new TypeError('Post action must be a function');
    }
    if (this.length >= this.maxPendingJobs) {
      const error = new Error('Post action queue is full');
      error.statusCode = 503;
      throw error;
    }

    const actionId = crypto.randomUUID();
    const priority=policy && !policy.exempt && Number.isInteger(policy.queuePriority)?Math.max(-5,Math.min(5,policy.queuePriority)):0;
    const enqueuedAt = Date.now();
    if (enqueuedAt < this.lastEnqueuedAt) this.clockReversed = true;
    this.lastEnqueuedAt = enqueuedAt;
    this.queues[priority + 5].jobs.push({ actionId, type: String(type || 'post'), run, priority, enqueuedAt, sequence: this.nextSequence++ });
    this.pending += 1;
    this._dispatch();
    return actionId;
  }

  stop() {
    this.stopped = true;
    for (const queue of this.queues) {
      queue.jobs.length = 0;
      queue.head = 0;
    }
    this.pending = 0;
  }

  _dispatch() {
    while (!this.stopped && this.activeWorkers < this.concurrency && this.pending > 0) {
      const now = Date.now();
      let bestQueue = null;
      let bestIndex = -1;
      let bestJob = null;
      let bestValue = -Infinity;
      for (const queue of this.queues) {
        const end = this.clockReversed ? queue.jobs.length : Math.min(queue.head + 1, queue.jobs.length);
        for (let i = queue.head; i < end; i += 1) {
          const job = queue.jobs[i];
          const value = job.priority + Math.floor((now - job.enqueuedAt) / 1000);
          if (value > bestValue || (value === bestValue && (!bestJob || job.sequence < bestJob.sequence))) {
            bestQueue = queue;
            bestIndex = i;
            bestJob = job;
            bestValue = value;
          }
        }
      }
      if (bestIndex === bestQueue.head) {
        bestQueue.jobs[bestQueue.head++] = null;
        if (bestQueue.head > 64 && bestQueue.head * 2 >= bestQueue.jobs.length) {
          bestQueue.jobs = bestQueue.jobs.slice(bestQueue.head);
          bestQueue.head = 0;
        }
      } else {
        bestQueue.jobs.splice(bestIndex, 1);
      }
      this.pending -= 1;
      if (this.pending === 0) {
        this.clockReversed = false;
        this.lastEnqueuedAt = -Infinity;
      }
      this.activeWorkers += 1;
      this._runJob(bestJob);
    }
  }

  async _runJob(job) {
    try {
      await job.run();
    } catch (error) {
      console.error(
        `[post-actions] ${job.type} action=${job.actionId} failed:`,
        error.message,
      );
    } finally {
      this.activeWorkers = Math.max(0, this.activeWorkers - 1);
      if (!this.stopped && this.pending > 0) {
        this._dispatch();
      }
    }
  }
}

module.exports = PostActionQueue;
