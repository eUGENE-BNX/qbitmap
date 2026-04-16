'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Semaphore } = require('../../src/utils/semaphore');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('rejects non-positive max', () => {
  assert.throws(() => new Semaphore(0));
  assert.throws(() => new Semaphore(-1));
  assert.throws(() => new Semaphore(1.5));
});

test('caps concurrency at max', async () => {
  const sem = new Semaphore(2);
  let peak = 0;
  let active = 0;
  const task = async () => {
    active++;
    if (active > peak) peak = active;
    await sleep(20);
    active--;
  };
  await Promise.all(Array.from({ length: 6 }, () => sem.run(task)));
  assert.equal(peak, 2);
});

test('queued waiters run in FIFO order', async () => {
  const sem = new Semaphore(1);
  const order = [];
  const p1 = sem.run(async () => { await sleep(30); order.push(1); });
  await sleep(5); // ensure p1 has the permit
  const p2 = sem.run(async () => { order.push(2); });
  const p3 = sem.run(async () => { order.push(3); });
  await Promise.all([p1, p2, p3]);
  assert.deepEqual(order, [1, 2, 3]);
});

test('releases permit when task throws', async () => {
  const sem = new Semaphore(1);
  await assert.rejects(sem.run(async () => { throw new Error('boom'); }), /boom/);
  // If release did not fire on throw, this would deadlock.
  const result = await sem.run(async () => 'ok');
  assert.equal(result, 'ok');
  assert.equal(sem.stats().active, 0);
});
