// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1015: a free slot of the run queue goes to the company with the fewest runs
// going, then to its batch with the fewest, not to the first queued run. Before,
// the company whose batch came first kept every slot until its batch emptied.

const pending = [];
jest.mock('../../src/worker/runner', () => ({
  executeRun: jest.fn((job) => new Promise((resolve) => pending.push({ job, resolve }))),
}));
const config = { MAX_CONCURRENT_RUNS: '6', PARALLEL_STAGGER_MS: '0' };
jest.mock('../../src/db/db', () => ({ getConfig: (key, fallback) => config[key] ?? fallback }));
jest.mock('../../src/utils/logger', () => {
  const quiet = { info() {}, debug() {}, warn() {}, error() {} };
  return { child: () => quiet };
});

const queue = require('../../src/worker/queue');
const { nextJobIndex } = queue;

const job = (runId, companyId, batchId, concurrentLimit = 10) => ({ runId, companyId, batchId, concurrentLimit });
const counts = (entries) => new Map(Object.entries(entries));
const settle = () => new Promise((resolve) => setImmediate(resolve));

// End the oldest running job and let the queue start the next.
async function finishOldest() {
  const { resolve } = pending.shift();
  resolve({ exitCode: 0 });
  await settle();
  await settle();
}

const runningPerCompany = () => {
  const out = {};
  for (const { job: j } of pending) out[j.companyId] = (out[j.companyId] || 0) + 1;
  return out;
};

describe('nextJobIndex (pure)', () => {
  test('the company with the fewest runs going wins, not the first queued', () => {
    const q = [job('a1', 'A', 'ba'), job('a2', 'A', 'ba'), job('b1', 'B', 'bb')];
    expect(nextJobIndex(q, counts({ A: 3, B: 1 }), new Map())).toBe(2);
    expect(nextJobIndex(q, counts({ A: 1, B: 3 }), new Map())).toBe(0);
  });

  test('a tie goes to the company waiting longest (its oldest queued run)', () => {
    const q = [job('b1', 'B', 'bb'), job('a1', 'A', 'ba')];
    expect(nextJobIndex(q, counts({ A: 2, B: 2 }), new Map())).toBe(0);
  });

  test('a company at its own limit is passed over; none eligible gives -1', () => {
    const q = [job('a1', 'A', 'ba', 2), job('b1', 'B', 'bb', 2)];
    expect(nextJobIndex(q, counts({ A: 0, B: 2 }), new Map())).toBe(0);
    expect(nextJobIndex(q, counts({ A: 2, B: 0 }), new Map())).toBe(1);
    expect(nextJobIndex(q, counts({ A: 2, B: 2 }), new Map())).toBe(-1);
    expect(nextJobIndex([], new Map(), new Map())).toBe(-1);
  });

  test('within a company, the batch with the fewest runs going; a job alone is its own batch', () => {
    const q = [job('x1', 'A', 'b1'), job('x2', 'A', 'b1'), job('y1', 'A', 'b2'), job('z1', 'A', undefined)];
    expect(nextJobIndex(q, counts({ A: 3 }), counts({ 'batch:b1': 2, 'batch:b2': 1 }))).toBe(3);
    expect(nextJobIndex(q, counts({ A: 3 }), counts({ 'batch:b1': 2, 'batch:b2': 0 }))).toBe(2);
    expect(nextJobIndex(q, counts({ A: 3 }), counts({ 'batch:b1': 0, 'batch:b2': 0 }))).toBe(0);
  });
});

describe('the queue shares its slots', () => {
  test('a provider launched later gets its share as the first one\'s runs end', async () => {
    for (let i = 0; i < 30; i++) queue.enqueue(job(`a${i}`, 'alpha', 'A'));
    await settle();
    await settle();
    expect(runningPerCompany()).toEqual({ alpha: 6 });

    for (let i = 0; i < 30; i++) queue.enqueue(job(`e${i}`, 'epsilon', 'E'));
    await settle();
    // Three runs of alpha end: each freed slot goes to epsilon, which has fewer.
    for (let i = 0; i < 3; i++) await finishOldest();
    expect(runningPerCompany()).toEqual({ alpha: 3, epsilon: 3 });

    // A third provider arrives: it takes the next slots until the shares are even.
    for (let i = 0; i < 30; i++) queue.enqueue(job(`z${i}`, 'zeta', 'Z'));
    await settle();
    for (let i = 0; i < 6; i++) await finishOldest();
    expect(runningPerCompany()).toEqual({ alpha: 2, epsilon: 2, zeta: 2 });

    // It stays even while all three have work.
    for (let i = 0; i < 12; i++) await finishOldest();
    expect(runningPerCompany()).toEqual({ alpha: 2, epsilon: 2, zeta: 2 });
    expect(queue.running).toBe(6);

    // Drain everything: no slot is lost, every run is started once.
    while (pending.length) await finishOldest();
    const { executeRun } = require('../../src/worker/runner');
    const started = executeRun.mock.calls.map(([j]) => j.runId);
    expect(started).toHaveLength(90);
    expect(new Set(started).size).toBe(90);
    expect(queue.running).toBe(0);
    expect(queue.depth).toBe(0);
  });
});
