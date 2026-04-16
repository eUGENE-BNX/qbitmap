'use strict';

// Minimal concurrency limiter. N permits, FIFO queue of waiters.
//
// Use: const sem = new Semaphore(3); await sem.run(() => expensiveAsync());
// run() returns the inner promise's value; releases the permit even if the
// task throws. No external dependency.
//
// Chosen over p-limit to avoid a new package for a ~20-line need; mirrors
// the counter-based pattern already present in video-ai-queue.js.

class Semaphore {
  constructor(max) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error(`Semaphore: max must be a positive integer, got ${max}`);
    }
    this.max = max;
    this.active = 0;
    this.waiters = [];
  }

  async acquire() {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise(resolve => this.waiters.push(resolve));
    this.active++;
  }

  release() {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }

  async run(task) {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  stats() {
    return { active: this.active, queued: this.waiters.length, max: this.max };
  }
}

module.exports = { Semaphore };
