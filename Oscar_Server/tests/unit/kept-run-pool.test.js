// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * The runs of a batch given to pods kept for it (#1309; part 4 = #1322).
 * The pods are recorded in the real keptPods; the dispatcher is a stand-in
 * that records them, and the test plays each pod's program with its secret.
 */

const { randomUUID } = require('node:crypto');
const keptPods = require('../../src/worker/keptPods');
const starter = require('../../src/worker/keptPodStarter');
const runOutput = require('../../src/worker/runOutput');
const runSecrets = require('../../src/utils/runSecrets');
const pool = require('../../src/worker/keptRunPool');

const { STOP, MAX_RUNS } = keptPods;
const ADDRESS = '10.42.0.17';

let started;    // the pods asked of the stand-in: { podId, secret, batch, deadlineSeconds }
let results;
let queued;
beforeEach(() => {
  keptPods._clear();
  pool._clear();
  runOutput._clear();
  runSecrets._clear();
  started = [];
  results = new Set();
  queued = 0;
  keptPods.configure({ hasResults: async (runId) => results.has(runId) });
  pool.configure({ queuedOf: () => queued });
  jest.spyOn(starter, 'startKeptPod').mockImplementation((batch, { deadlineSeconds }) => {
    const pod = keptPods.open(batch);
    started.push({ ...pod, batch, deadlineSeconds });
    return { podId: pod.podId };
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  pool._clear();
  keptPods._clear();
});

const batchOf = (over = {}) => ({ companyId: randomUUID(), userId: randomUUID(), batchId: randomUUID(), ...over });
const tick = () => new Promise((r) => setImmediate(r));

// A run as the runner hands it, its secret issued.
function runOf(batch, extra = {}) {
  const runId = randomUUID();
  return {
    runId, envName: 'OTST_acme_1a2b3c4d_Env', envYml: Buffer.from('name: x\n').toString('base64'), deadlineSeconds: 600,
    env: { OSCAR_RUN_SECRET: runSecrets.issue(runId, batch.companyId), OSCAR_ACCESS_TOKEN: 'tok', PATH: '/usr/bin', ENCRYPTION_KEY: 'never' },
    ...extra,
  };
}

// The run's process as the runner sees it, and what it said.
function launch(batch, run) {
  const proc = pool.launchKeptRun({ batch, run });
  const seen = { started: 0, pod: [], close: [], error: [], out: '', err: '' };
  proc.on('started', () => { seen.started += 1; });
  proc.on('pod', (a) => seen.pod.push(a));
  proc.on('close', (c) => seen.close.push(c));
  proc.on('error', (e) => seen.error.push(e.message));
  proc.stdout.on('data', (d) => { seen.out += d.toString(); });
  proc.stderr.on('data', (d) => { seen.err += d.toString(); });
  return { proc, seen, run };
}

// A pod's call, once it holds or got its answer: { answer }, its promise.
async function hold(pod, ended = null) {
  let answer;
  const held = new Promise((resolve) => {
    const off = keptPods.on('waiting', (e) => { if (e.podId === pod.podId) { off(); resolve(); } });
    answer = keptPods.ask(pod.secret, ADDRESS, ended);
    answer.then(() => { off(); resolve(); });
  });
  await held;
  return { answer };
}
// A pod's call answered at once (a run waiting for it, or stop).
const podCall = async (pod, ended = null) => (await hold(pod, ended)).answer;

describe('a run of a batch', () => {
  test('with no pod of its batch, a pod is started for it; its first call takes the run, credentials only', async () => {
    const batch = batchOf();
    const a = launch(batch, runOf(batch));
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ batch, deadlineSeconds: Math.min(pool.MAX_POD_DEADLINE_S, MAX_RUNS * 600 + pool.POD_MARGIN_S) });
    const answer = await podCall(started[0]);
    expect(answer).toEqual({
      action: 'run',
      run: { ...a.run, env: { OSCAR_RUN_SECRET: a.run.env.OSCAR_RUN_SECRET, OSCAR_ACCESS_TOKEN: 'tok' } },
    });
    await tick();
    expect([a.seen.started, a.seen.pod]).toEqual([1, [ADDRESS]]);
    expect(runSecrets.fromRunAddress(a.run.runId, '10.9.9.9')).toBe(false);
  });

  test('its output comes in order on its streams; its end is Bruno\'s code', async () => {
    const batch = batchOf();
    const a = launch(batch, runOf(batch));
    await podCall(started[0]);
    expect(runOutput.deliver(a.run.runId, { seq: 0, parts: [['out', 'line 1\n'], ['err', 'warn 1\n'], ['out', 'line 2\n']] }).status).toBe(200);
    results.add(a.run.runId);
    await podCall(started[0], { runId: a.run.runId, code: 1, clean: true });
    await tick();
    expect([a.seen.out, a.seen.err, a.seen.close]).toEqual(['line 1\nline 2\n', 'warn 1\n', [1]]);
    expect(runOutput.deliver(a.run.runId, { seq: 1, parts: [['out', 'late\n']] }).status).toBe(409);
  });

  test('the next run of the batch goes to the pod that waits: no pod started', async () => {
    const batch = batchOf();
    const a = launch(batch, runOf(batch));
    await podCall(started[0]);
    results.add(a.run.runId);
    queued = 1;
    const { answer: next } = await hold(started[0], { runId: a.run.runId, code: 0, clean: true });
    await tick();
    const b = launch(batch, runOf(batch));
    expect(started).toHaveLength(1);
    expect((await next).run.runId).toBe(b.run.runId);
    await tick();
    expect(b.seen.pod).toEqual([ADDRESS]);
  });

  test('two runs at once: two pods, each taking one', async () => {
    const batch = batchOf();
    const a = launch(batch, runOf(batch));
    const b = launch(batch, runOf(batch));
    expect(started).toHaveLength(2);
    const first = await podCall(started[0]);
    const second = await podCall(started[1]);
    expect([first.run.runId, second.run.runId]).toEqual([a.run.runId, b.run.runId]);
    expect(pool.snapshot()[0]).toMatchObject({ pending: [], starting: [] });
  });

  test('a run that waits while a pod starts for nothing else: no other pod is started', async () => {
    const batch = batchOf();
    queued = 1;
    const a = launch(batch, runOf(batch));
    const b = launch(batch, runOf(batch));
    expect(started).toHaveLength(2);
    await podCall(started[0]);                       // takes a
    results.add(a.run.runId);
    // The first pod takes b too, after a: the second is still starting, for nothing.
    expect((await podCall(started[0], { runId: a.run.runId, code: 0, clean: true })).run.runId).toBe(b.run.runId);
    const c = launch(batch, runOf(batch));
    expect(started).toHaveLength(2);                 // c waits for the pod already starting
    expect((await podCall(started[1])).run.runId).toBe(c.run.runId);
  });

  test('a run of another batch, of the same user and company, gets a pod of its own', async () => {
    const batch = batchOf();
    launch(batch, runOf(batch));
    await podCall(started[0]);
    results.add('x');
    const other = { ...batch, batchId: randomUUID() };
    launch(other, runOf(other));
    expect(started).toHaveLength(2);
    expect(started[1].batch).toEqual(other);
  });
});

describe('stopping a run', () => {
  test('kill() of a run still waiting: taken off, ended as stopped', async () => {
    const batch = batchOf();
    const a = launch(batch, runOf(batch));
    expect(a.proc.kill('SIGTERM')).toBe(true);
    await tick();
    expect(a.seen.close).toEqual([pool.STOPPED_CODE]);
    expect(a.seen.err).toBe('[kept-pods] The run\'s kept pod was given up (stopped before a pod took it).\n');
    expect(a.proc.kill('SIGTERM')).toBe(false);
    // The pod started for it then has nothing to take, and the batch nothing left.
    expect(await podCall(started[0])).toEqual({ action: 'stop', reason: STOP.BATCH_DONE });
  });

  test('kill() of a run in a pod: the pod is removed at once', async () => {
    const batch = batchOf();
    const stops = [];
    keptPods.on('stop', (e) => stops.push(e));
    const a = launch(batch, runOf(batch));
    await podCall(started[0]);
    a.proc.kill('SIGTERM');
    await tick();
    expect(a.seen.close).toEqual([pool.STOPPED_CODE]);
    expect(stops).toEqual([expect.objectContaining({ podId: started[0].podId, runId: a.run.runId, reason: STOP.STOPPED })]);
    expect(starter.AT_ONCE.has(STOP.STOPPED)).toBe(true);
    expect(keptPods.snapshot()).toEqual([]);
  });

  test.each([
    [STOP.DEADLINE, 124], [STOP.POD_ENDED, 137], [STOP.REVOKED, 143], [STOP.PROTOCOL, 143],
  ])('a pod given up under its run (%s): the run ends with %i, never 0 or 1', async (reason, code) => {
    const batch = batchOf();
    const a = launch(batch, runOf(batch));
    await podCall(started[0]);
    keptPods.forget(started[0].podId, reason);
    await tick();
    expect(a.seen.close).toEqual([code]);
    expect(a.seen.err).toBe(`[kept-pods] The run's kept pod was given up (${reason}).\n`);
  });

  test('a pod meant for a waiting run that never starts: that run fails', async () => {
    const batch = batchOf();
    const a = launch(batch, runOf(batch));
    keptPods.forget(started[0].podId, STOP.NOT_STARTED);
    await tick();
    expect(a.seen.error).toEqual(['the kept pod meant for the run was given up before it took it (not-started)']);
    expect(a.seen.close).toEqual([]);
    expect(pool.snapshot()).toEqual([]);
  });

  test('a pod that took a run no longer counts as starting: the next run gets a pod, and fails when that one never starts', async () => {
    const batch = batchOf();
    queued = 1;
    launch(batch, runOf(batch));
    await podCall(started[0]);                       // the first pod is running its run
    const b = launch(batch, runOf(batch));
    expect(started).toHaveLength(2);
    keptPods.forget(started[1].podId, STOP.NOT_STARTED);
    await tick();
    expect(b.seen.error).toEqual(['the kept pod meant for the run was given up before it took it (not-started)']);
  });

  test('a dispatcher that cannot be asked: the run fails, after the runner listened', async () => {
    starter.startKeptPod.mockImplementation(() => { throw new Error('launcher: a kept pod is started in pod mode only'); });
    const batch = batchOf();
    const a = launch(batch, runOf(batch));
    expect(a.seen.error).toEqual([]);
    await tick();
    expect(a.seen.error).toEqual(['launcher: a kept pod is started in pod mode only']);
    expect(pool.snapshot()).toEqual([]);
  });
});

describe('the end of a batch', () => {
  test('nothing queued, none on its way, none waiting: the waiting pod is told stop', async () => {
    const batch = batchOf();
    const a = launch(batch, runOf(batch));
    await podCall(started[0]);
    results.add(a.run.runId);
    // The runner said it on its way before it launched it: launched, it is no longer.
    expect(await podCall(started[0], { runId: a.run.runId, code: 0, clean: true })).toEqual({ action: 'stop', reason: STOP.BATCH_DONE });
  });

  test('a run still queued, or on its way, keeps the pod waiting for it', async () => {
    const batch = batchOf();
    const a = launch(batch, runOf(batch));
    await podCall(started[0]);
    results.add(a.run.runId);
    queued = 1;
    const { answer: waiting } = await hold(started[0], { runId: a.run.runId, code: 0, clean: true });
    expect(keptPods.snapshot()[0]).toMatchObject({ waiting: true });
    // The run leaves the queue for the runner, which says it is on its way.
    const b = runOf(batch);
    queued = 0;
    pool.announce(b.runId, batch);
    pool.release(a.run.runId);
    expect(keptPods.snapshot()[0]).toMatchObject({ waiting: true });
    launch(batch, b);
    expect((await waiting).run.runId).toBe(b.runId);
  });

  test('as the runner does it, announced then launched: launched, the run is no longer on its way', async () => {
    const batch = batchOf();
    const a = runOf(batch);
    pool.announce(a.runId, batch);
    launch(batch, a);
    await podCall(started[0]);
    results.add(a.runId);
    // The batch ends with the run's end, before the runner releases it.
    expect(await podCall(started[0], { runId: a.runId, code: 0, clean: true })).toEqual({ action: 'stop', reason: STOP.BATCH_DONE });
  });

  test('a run on its way when a pod finishes keeps that pod waiting for it, nothing queued', async () => {
    const batch = batchOf();
    const a = launch(batch, runOf(batch));
    await podCall(started[0]);
    results.add(a.run.runId);
    const b = runOf(batch);
    pool.announce(b.runId, batch);
    const { answer } = await hold(started[0], { runId: a.run.runId, code: 0, clean: true });
    expect(keptPods.snapshot()[0]).toMatchObject({ waiting: true });
    launch(batch, b);
    expect((await answer).run.runId).toBe(b.runId);
  });

  test('the last run released, with nothing left: the waiting pod is told stop', async () => {
    const batch = batchOf();
    const a = launch(batch, runOf(batch));
    await podCall(started[0]);
    results.add(a.run.runId);
    queued = 1;
    const { answer: waiting } = await hold(started[0], { runId: a.run.runId, code: 0, clean: true });
    const b = runOf(batch);
    queued = 0;
    pool.announce(b.runId, batch);
    pool.release(b.runId);                // refused before it needed a pod
    expect(await waiting).toEqual({ action: 'stop', reason: STOP.BATCH_DONE });
  });

  test('a queue that cannot be read keeps the pods waiting (their own wait ends them)', async () => {
    pool.configure({ queuedOf: () => { throw new Error('queue'); } });
    const batch = batchOf();
    const a = launch(batch, runOf(batch));
    await podCall(started[0]);
    results.add(a.run.runId);
    await hold(started[0], { runId: a.run.runId, code: 0, clean: true });
    expect(keptPods.snapshot()[0]).toMatchObject({ waiting: true });
  });

  test('release() of a run the runner is done with stops it if it is still going', async () => {
    const batch = batchOf();
    const a = launch(batch, runOf(batch));
    pool.release(a.run.runId);
    await tick();
    expect(a.seen.close).toEqual([pool.STOPPED_CODE]);
  });

  test('the server\'s queue is what the pool asks', () => {
    let queue;
    let isolatedPool;
    jest.isolateModules(() => {
      queue = require('../../src/worker/queue');
      isolatedPool = require('../../src/worker/keptRunPool');
    });
    const batch = batchOf();
    queue._queue = [{ runId: 'a', companyId: batch.companyId, batchId: batch.batchId }];
    expect(isolatedPool._queued(batch)).toBe(1);
    queue._queue = [];
    expect(isolatedPool._queued(batch)).toBe(0);
  });

  test('the server\'s queue says what it holds of a batch', () => {
    const queue = require('../../src/worker/queue');
    const batch = batchOf();
    const saved = queue._queue;
    queue._queue = [
      { runId: 'a', companyId: batch.companyId, batchId: batch.batchId },
      { runId: 'b', companyId: batch.companyId, batchId: randomUUID() },
      { runId: 'c', companyId: randomUUID(), batchId: batch.batchId },
      { runId: 'd', companyId: batch.companyId, batchId: batch.batchId },
    ];
    try {
      expect(queue.queuedOf(batch)).toBe(2);
    } finally {
      queue._queue = saved;
    }
  });
});
