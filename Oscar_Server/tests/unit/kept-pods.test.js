// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * Run pods kept for the runs of one batch (#1309; part 1 = #1316): the
 * server's record of them and the rules decided on #1309.
 */

const { randomUUID } = require('node:crypto');
const keptPods = require('../../src/worker/keptPods');
const runSecrets = require('../../src/utils/runSecrets');

const { STOP, MAX_RUNS, IDLE_MS, FIRST_CALL_MS, RUN_MARGIN_MS } = keptPods;
const POD = '10.42.0.17';
const OTHER = '10.42.0.99';

let results;   // run ids whose result files were received
let stops;     // every 'stop' event
let ended;     // every 'ended' event
beforeEach(() => {
  keptPods._clear();
  runSecrets._clear();
  results = new Set();
  keptPods.configure({ hasResults: async (runId) => results.has(runId) });
  stops = [];
  ended = [];
  keptPods.on('stop', (e) => stops.push(e));
  keptPods.on('ended', (e) => ended.push(e));
});
afterEach(() => {
  jest.useRealTimers();
  keptPods._clear();
  runSecrets._clear();
});

const batchOf = (overrides = {}) => ({ companyId: randomUUID(), userId: randomUUID(), batchId: randomUUID(), ...overrides });

// A run of `batch` with its secret issued, as the runner will hand it.
function runOf(batch, extra = {}) {
  const runId = randomUUID();
  const secret = runSecrets.issue(runId, batch.companyId);
  return { runId, deadlineSeconds: 600, envName: 'run', env: { OSCAR_RUN_SECRET: secret }, ...extra };
}

// Resolves once pod `podId` holds a call, waiting for a run.
function waiting(podId) {
  return new Promise((resolve) => {
    const off = keptPods.on('waiting', (e) => { if (e.podId === podId) { off(); resolve(); } });
  });
}

// A pod's call, once it holds (or was answered at once): { answer }, the
// promise of what the pod is told.
async function hold(pod, ended, { address = POD, signal } = {}) {
  const held = waiting(pod.podId);
  const answer = keptPods.ask(pod.secret, address, ended, { signal });
  await Promise.race([held, answer]);
  return { answer };
}

// A pod that took one run of `batch`: { pod, run, answer }.
async function podWithRun(batch) {
  const pod = keptPods.open(batch);
  const { answer } = await hold(pod, null);
  const run = runOf(batch);
  expect(keptPods.handRun(batch, run)).toBe(pod.podId);
  return { pod, run, answer: await answer };
}

describe('a pod for one batch', () => {
  test('the numbers decided on #1309', () => {
    expect({ MAX_RUNS, IDLE_MS, FIRST_CALL_MS, RUN_MARGIN_MS }).toEqual({
      MAX_RUNS: 20, IDLE_MS: 30000, FIRST_CALL_MS: 300000, RUN_MARGIN_MS: 60000,
    });
  });

  test('open() gives an id and a secret once; the record never shows the secret', () => {
    const batch = batchOf();
    const pod = keptPods.open(batch);
    expect(pod.podId).toMatch(/^[0-9a-f-]{36}$/);
    expect(pod.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(keptPods.open(batch).secret).not.toBe(pod.secret);
    const shown = JSON.stringify(keptPods.snapshot());
    expect(shown).not.toContain(pod.secret);
    expect(keptPods.snapshot()[0]).toMatchObject({ podId: pod.podId, ...batch, state: 'new', runs: 0, waiting: false });
  });

  test('open() needs the company, the user and the batch', () => {
    for (const missing of ['companyId', 'userId', 'batchId']) {
      expect(() => keptPods.open({ ...batchOf(), [missing]: '' })).toThrow(new RegExp(missing));
    }
    expect(keptPods.snapshot()).toEqual([]);
  });

  test('its first call waits; a run of its batch is handed to it, with the run\'s inputs', async () => {
    const batch = batchOf();
    const { pod, run, answer } = await podWithRun(batch);
    expect(answer).toEqual({ action: 'run', run });
    expect(keptPods.snapshot()[0]).toMatchObject({ podId: pod.podId, state: 'running', runs: 1, runId: run.runId, address: POD });
  });

  test('the run\'s secret is bound to the pod\'s address when it is handed', async () => {
    const batch = batchOf();
    const { run } = await podWithRun(batch);
    expect(runSecrets.fromRunAddress(run.runId, OTHER)).toBe(false);
    expect(runSecrets.fromRunAddress(run.runId, `::ffff:${POD}`)).toBe(true);
  });

  test('a run is never handed to a pod of another batch, user or company', async () => {
    const batch = batchOf();
    const pod = keptPods.open(batch);
    const { answer } = await hold(pod, null);
    for (const other of [{ batchId: randomUUID() }, { userId: randomUUID() }, { companyId: randomUUID() }]) {
      const elsewhere = { ...batch, ...other };
      expect(keptPods.handRun(elsewhere, runOf(elsewhere))).toBeNull();
    }
    expect(keptPods.snapshot()[0].waiting).toBe(true);
    keptPods.endBatch(batch);
    expect(await answer).toEqual({ action: 'stop', reason: STOP.BATCH_DONE });
  });

  test('no pod waiting, or a run whose secret was not issued: nothing is handed', async () => {
    const batch = batchOf();
    expect(keptPods.handRun(batch, runOf(batch))).toBeNull();
    const pod = keptPods.open(batch);
    expect(keptPods.handRun(batch, runOf(batch))).toBeNull();     // not called yet
    const { answer } = await hold(pod, null);
    expect(keptPods.handRun(batch, { runId: randomUUID(), deadlineSeconds: 60 })).toBeNull();
    expect(keptPods.snapshot()[0]).toMatchObject({ state: 'waiting', waiting: true, runs: 0 });
    keptPods.endBatch(batch);
    await answer;
  });

  test('handRun() needs a run id and a deadline in whole seconds', () => {
    const batch = batchOf();
    expect(() => keptPods.handRun(batch, { deadlineSeconds: 60 })).toThrow(/runId/);
    for (const deadlineSeconds of [undefined, 0, -1, 1.5, '60']) {
      expect(() => keptPods.handRun(batch, { runId: randomUUID(), deadlineSeconds })).toThrow(/deadlineSeconds/);
    }
  });
});

describe('after a run', () => {
  test('a run that ended normally, its results received: the pod waits for the next one', async () => {
    const batch = batchOf();
    const { pod, run } = await podWithRun(batch);
    results.add(run.runId);
    const { answer: next } = await hold(pod, { runId: run.runId, code: 1 });
    expect(ended).toEqual([{ podId: pod.podId, ...batch, runId: run.runId, code: 1, resultsReceived: true, clean: true }]);
    const second = runOf(batch);
    expect(keptPods.handRun(batch, second)).toBe(pod.podId);
    expect(await next).toEqual({ action: 'run', run: second });
    expect(keptPods.snapshot()[0].runs).toBe(2);
  });

  test(`after ${MAX_RUNS} runs the pod is told to stop`, async () => {
    const batch = batchOf();
    const pod = keptPods.open(batch);
    let call = (await hold(pod, null)).answer;
    for (let i = 1; i <= MAX_RUNS; i++) {
      const run = runOf(batch);
      expect(keptPods.handRun(batch, run)).toBe(pod.podId);
      expect((await call).run.runId).toBe(run.runId);
      results.add(run.runId);
      call = (await hold(pod, { runId: run.runId, code: 0 })).answer;
    }
    expect(await call).toEqual({ action: 'stop', reason: STOP.MAX_RUNS });
    expect(keptPods.snapshot()).toEqual([]);
  });

  test('any exit but 0 or 1, or no result received: the pod stops', async () => {
    for (const [code, received] of [[2, true], [137, true], [255, true], [0, false], [1, false]]) {
      const batch = batchOf();
      const { pod, run } = await podWithRun(batch);
      if (received) results.add(run.runId);
      expect(await keptPods.ask(pod.secret, POD, { runId: run.runId, code })).toEqual({ action: 'stop', reason: STOP.ABNORMAL_END });
      expect(keptPods.snapshot()).toEqual([]);
      expect(stops.at(-1)).toMatchObject({ podId: pod.podId, reason: STOP.ABNORMAL_END });
    }
  });

  test('a pod no longer clean after a run: the run\'s end stands, the pod stops (#1318)', async () => {
    const batch = batchOf();
    const { pod, run } = await podWithRun(batch);
    results.add(run.runId);
    expect(await keptPods.ask(pod.secret, POD, { runId: run.runId, code: 0, clean: false }))
      .toEqual({ action: 'stop', reason: STOP.NOT_CLEAN });
    expect(ended).toEqual([expect.objectContaining({ runId: run.runId, code: 0, resultsReceived: true, clean: false })]);
    expect(stops).toEqual([expect.objectContaining({ podId: pod.podId, reason: STOP.NOT_CLEAN })]);
    expect(keptPods.snapshot()).toEqual([]);
  });

  test('an end that does not say, or says clean: the pod goes on', async () => {
    for (const clean of [undefined, true]) {
      const batch = batchOf();
      const { pod, run } = await podWithRun(batch);
      results.add(run.runId);
      const { answer } = await hold(pod, { runId: run.runId, code: 0, ...(clean === undefined ? {} : { clean }) });
      expect(keptPods.snapshot().find((p) => p.podId === pod.podId)).toMatchObject({ state: 'waiting', waiting: true });
      keptPods.endBatch(batch);
      expect(await answer).toEqual({ action: 'stop', reason: STOP.BATCH_DONE });
    }
  });

  test('a pod stopped while its results are checked is told why', async () => {
    const batch = batchOf();
    const { pod, run } = await podWithRun(batch);
    let answerResults;
    keptPods.configure({ hasResults: () => new Promise((resolve) => { answerResults = resolve; }) });
    const asked = keptPods.ask(pod.secret, POD, { runId: run.runId, code: 2 });
    await Promise.resolve();
    keptPods.revokeCompany(batch.companyId);
    answerResults(true);
    expect(await asked).toEqual({ action: 'stop', reason: STOP.REVOKED });
  });

  test('a second call while the first one\'s results are checked is a second call', async () => {
    const batch = batchOf();
    const { pod, run } = await podWithRun(batch);
    let answerResults;
    keptPods.configure({ hasResults: () => new Promise((resolve) => { answerResults = resolve; }) });
    const first = keptPods.ask(pod.secret, POD, { runId: run.runId, code: 0 });
    await Promise.resolve();
    expect(await keptPods.ask(pod.secret, POD, { runId: run.runId, code: 0 })).toEqual({ action: 'stop', reason: STOP.PROTOCOL });
    answerResults(true);
    expect(await first).toEqual({ action: 'stop', reason: STOP.PROTOCOL });
    expect(keptPods.snapshot()).toEqual([]);
  });

  test('a failing check of the results, or none configured, reads as none received', async () => {
    const batch = batchOf();
    const first = await podWithRun(batch);
    keptPods.configure({ hasResults: async () => { throw new Error('disk'); } });
    expect(await keptPods.ask(first.pod.secret, POD, { runId: first.run.runId, code: 0 })).toMatchObject({ reason: STOP.ABNORMAL_END });
    keptPods.configure({ hasResults: async () => true });
    keptPods.configure({ hasResults: null });
    const second = await podWithRun(batch);
    results.add(second.run.runId);
    expect(await keptPods.ask(second.pod.secret, POD, { runId: second.run.runId, code: 0 })).toMatchObject({ reason: STOP.ABNORMAL_END });
  });
});

describe('the end of a pod', () => {
  test('the batch has nothing left: a waiting pod stops now, a running one after its run', async () => {
    const batch = batchOf();
    const busy = await podWithRun(batch);
    const waitingPod = keptPods.open(batch);
    const { answer } = await hold(waitingPod, null);
    const other = batchOf();
    const otherPod = keptPods.open(other);
    keptPods.endBatch(batch);
    expect(await answer).toEqual({ action: 'stop', reason: STOP.BATCH_DONE });
    expect(keptPods.snapshot().map((p) => p.podId).sort()).toEqual([busy.pod.podId, otherPod.podId].sort());
    results.add(busy.run.runId);
    expect(await keptPods.ask(busy.pod.secret, POD, { runId: busy.run.runId, code: 0 })).toEqual({ action: 'stop', reason: STOP.BATCH_DONE });
    expect(keptPods.snapshot().map((p) => p.podId)).toEqual([otherPod.podId]);
  });

  test(`a pod waits ${IDLE_MS / 1000} s at most, then is told to stop`, async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    const batch = batchOf();
    const pod = keptPods.open(batch);
    const { answer } = await hold(pod, null);
    jest.advanceTimersByTime(IDLE_MS - 1);
    expect(keptPods.snapshot()).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(await answer).toEqual({ action: 'stop', reason: STOP.IDLE });
    expect(keptPods.snapshot()).toEqual([]);
  });

  test('the wait counts from the end of the run, not from each call', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    const batch = batchOf();
    const pod = keptPods.open(batch);
    const controller = new AbortController();
    const { answer: first } = await hold(pod, null, { signal: controller.signal });
    jest.advanceTimersByTime(IDLE_MS / 2);
    controller.abort();
    expect(await first).toBeNull();
    const { answer: again } = await hold(pod, null);
    jest.advanceTimersByTime(IDLE_MS / 2);
    expect(await again).toEqual({ action: 'stop', reason: STOP.IDLE });
  });

  test(`after a run, too, the pod waits ${IDLE_MS / 1000} s at most`, async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    const batch = batchOf();
    const { pod, run } = await podWithRun(batch);
    results.add(run.runId);
    jest.advanceTimersByTime(run.deadlineSeconds * 1000);
    const { answer } = await hold(pod, { runId: run.runId, code: 0 });
    jest.advanceTimersByTime(IDLE_MS - 1);
    expect(keptPods.snapshot()).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(await answer).toEqual({ action: 'stop', reason: STOP.IDLE });
  });

  test('a pod that never calls is given up', () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    const pod = keptPods.open(batchOf());
    jest.advanceTimersByTime(FIRST_CALL_MS);
    expect(keptPods.snapshot()).toEqual([]);
    expect(stops).toEqual([expect.objectContaining({ podId: pod.podId, reason: STOP.NOT_STARTED })]);
  });

  test('a pod that never reports its run\'s end is given up past the run\'s deadline', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    const batch = batchOf();
    const { pod, run } = await podWithRun(batch);
    jest.advanceTimersByTime(run.deadlineSeconds * 1000 + RUN_MARGIN_MS - 1);
    expect(keptPods.snapshot()).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(stops).toEqual([expect.objectContaining({ podId: pod.podId, runId: run.runId, reason: STOP.DEADLINE })]);
    expect(await keptPods.ask(pod.secret, POD, { runId: run.runId, code: 0 })).toBeNull();
  });
});

describe('a call the pod\'s program never makes stops it and every pod of its company', () => {
  // Each case: a pod in some state, then the call. Another pod of the same
  // company and one of another company are there too.
  async function caseOf(make) {
    const batch = batchOf();
    const sameCompany = keptPods.open({ ...batchOf(), companyId: batch.companyId });
    const otherCompany = keptPods.open(batchOf());
    const answer = await make(batch);
    expect(answer === null || answer.reason === STOP.PROTOCOL).toBe(true);
    const left = keptPods.snapshot().map((p) => p.podId);
    expect(left).toEqual([otherCompany.podId]);
    expect(stops.find((s) => s.podId === sameCompany.podId)?.reason).toBe(STOP.REVOKED);
    expect(stops.find((s) => s.reason === STOP.PROTOCOL)).toBeTruthy();
    return answer;
  }

  test('a second call while one is held', async () => {
    await caseOf(async (batch) => {
      const pod = keptPods.open(batch);
      const { answer: first } = await hold(pod, null);
      const second = await keptPods.ask(pod.secret, POD, null);
      expect(await first).toEqual({ action: 'stop', reason: STOP.PROTOCOL });
      expect(stops.find((s) => s.reason === STOP.PROTOCOL).why).toBe('a second call while one is held');
      return second;
    });
  });

  test('a call during a run that does not report its end', async () => {
    await caseOf(async (batch) => {
      const { pod } = await podWithRun(batch);
      return keptPods.ask(pod.secret, POD, null);
    });
  });

  test('the end of another run', async () => {
    await caseOf(async (batch) => {
      const { pod } = await podWithRun(batch);
      return keptPods.ask(pod.secret, POD, { runId: randomUUID(), code: 0 });
    });
  });

  test('an end reported with no run', async () => {
    await caseOf(async (batch) => {
      const pod = keptPods.open(batch);
      return keptPods.ask(pod.secret, POD, { runId: randomUUID(), code: 0 });
    });
  });

  test('a call from another address than the first one\'s (refused)', async () => {
    const answer = await caseOf(async (batch) => {
      const pod = keptPods.open(batch);
      const { answer: first } = await hold(pod, null);
      const refused = await keptPods.ask(pod.secret, OTHER, null);
      expect(await first).toEqual({ action: 'stop', reason: STOP.PROTOCOL });
      return refused;
    });
    expect(answer).toBeNull();
  });

  test('a call from another address than the dispatcher\'s word (refused)', async () => {
    const answer = await caseOf(async (batch) => {
      const pod = keptPods.open(batch);
      expect(keptPods.bindAddress(pod.podId, `::ffff:${POD}`)).toBe(true);
      return keptPods.ask(pod.secret, OTHER, null);
    });
    expect(answer).toBeNull();
  });
});

describe('a call that is refused', () => {
  test('no such pod, a secret of the wrong shape, or no address: refused, nothing changes', async () => {
    const pod = keptPods.open(batchOf());
    for (const [secret, address] of [
      ['A'.repeat(43), POD], [undefined, POD], [pod.secret.slice(1), POD], [`${pod.secret}=`, POD], [pod.secret, ''], [pod.secret, undefined],
    ]) {
      expect(await keptPods.ask(secret, address, null)).toBeNull();
    }
    expect(keptPods.snapshot()[0]).toMatchObject({ state: 'new', address: '' });
    expect(stops).toEqual([]);
  });

  test('the dispatcher\'s word binds once', () => {
    const pod = keptPods.open(batchOf());
    expect(keptPods.bindAddress(pod.podId, POD)).toBe(true);
    expect(keptPods.bindAddress(pod.podId, `::ffff:${POD}`)).toBe(true);
    expect(keptPods.bindAddress(pod.podId, OTHER)).toBe(false);
    expect(keptPods.bindAddress(randomUUID(), POD)).toBe(false);
    expect(keptPods.bindAddress(pod.podId, '')).toBe(false);
  });

  test('a call whose connection closed lets go of its pod, which may call again', async () => {
    const batch = batchOf();
    const pod = keptPods.open(batch);
    const controller = new AbortController();
    const { answer: first } = await hold(pod, null, { signal: controller.signal });
    controller.abort();
    expect(await first).toBeNull();
    expect(keptPods.handRun(batch, runOf(batch))).toBeNull();
    const { answer: again } = await hold(pod, null);
    const run = runOf(batch);
    expect(keptPods.handRun(batch, run)).toBe(pod.podId);
    expect(await again).toEqual({ action: 'run', run });
  });

  test('a call whose connection was already closed holds nothing', async () => {
    const pod = keptPods.open(batchOf());
    const controller = new AbortController();
    controller.abort();
    expect(await keptPods.ask(pod.secret, POD, null, { signal: controller.signal })).toBeNull();
    expect(keptPods.snapshot()[0].waiting).toBe(false);
  });
});

describe('revocation', () => {
  test('revokeCompany() stops every pod of the company, the waiting one told so', async () => {
    const batch = batchOf();
    const pod = keptPods.open(batch);
    const { answer } = await hold(pod, null);
    const busy = await podWithRun({ ...batchOf(), companyId: batch.companyId });
    const other = keptPods.open(batchOf());
    expect(keptPods.revokeCompany(batch.companyId)).toBe(2);
    expect(await answer).toEqual({ action: 'stop', reason: STOP.REVOKED });
    expect(keptPods.snapshot().map((p) => p.podId)).toEqual([other.podId]);
    expect(stops.find((s) => s.podId === busy.pod.podId)).toMatchObject({ reason: STOP.REVOKED, runId: busy.run.runId });
    expect(await keptPods.ask(busy.pod.secret, POD, { runId: busy.run.runId, code: 0 })).toBeNull();
  });

  test('revokeUser() stops one user\'s pods for one company only', () => {
    const batch = batchOf();
    const mine = keptPods.open(batch);
    const mineElsewhere = keptPods.open({ ...batchOf(), userId: batch.userId });
    const colleague = keptPods.open({ ...batchOf(), companyId: batch.companyId });
    expect(keptPods.revokeUser(batch.userId, batch.companyId)).toBe(1);
    const left = keptPods.snapshot().map((p) => p.podId).sort();
    expect(left).toEqual([mineElsewhere.podId, colleague.podId].sort());
    expect(stops).toEqual([expect.objectContaining({ podId: mine.podId, reason: STOP.REVOKED })]);
  });
});

describe('the dispatcher\'s word (#1320)', () => {
  test('forget(): a pod that ended is given up, a run it held named; once', async () => {
    const batch = batchOf();
    const { pod, run } = await podWithRun(batch);
    expect(keptPods.forget(pod.podId)).toBe(true);
    expect(stops).toEqual([expect.objectContaining({ podId: pod.podId, runId: run.runId, reason: STOP.POD_ENDED })]);
    expect(keptPods.forget(pod.podId)).toBe(false);
    const never = keptPods.open(batchOf());
    expect(keptPods.forget(never.podId, STOP.NOT_STARTED)).toBe(true);
    expect(stops.at(-1)).toMatchObject({ podId: never.podId, reason: STOP.NOT_STARTED });
    expect(keptPods.snapshot()).toEqual([]);
  });

  test('fault(): the pod and every pod of its company are stopped, its waiting call told so', async () => {
    const batch = batchOf();
    const pod = keptPods.open(batch);
    const { answer } = await hold(pod, null);
    const colleague = keptPods.open({ ...batchOf(), companyId: batch.companyId });
    const other = keptPods.open(batchOf());
    expect(keptPods.fault(pod.podId, 'its secret came from another address than its pod\'s')).toBe(true);
    expect(await answer).toEqual({ action: 'stop', reason: STOP.PROTOCOL });
    expect(stops.find((s) => s.podId === pod.podId)).toMatchObject({ reason: STOP.PROTOCOL, why: 'its secret came from another address than its pod\'s' });
    expect(stops.find((s) => s.podId === colleague.podId)).toMatchObject({ reason: STOP.REVOKED });
    expect(keptPods.snapshot().map((p) => p.podId)).toEqual([other.podId]);
    expect(keptPods.fault(pod.podId, 'again')).toBe(false);
  });
});

describe('listeners', () => {
  test('a pod handed a run from its own "waiting" event gets it', async () => {
    const batch = batchOf();
    const run = runOf(batch);
    keptPods.on('waiting', (e) => keptPods.handRun(e, run));
    const pod = keptPods.open(batch);
    expect(await keptPods.ask(pod.secret, POD, null)).toEqual({ action: 'run', run });
  });

  test('a listener that throws changes no answer', async () => {
    keptPods.on('stop', () => { throw new Error('listener'); });
    keptPods.on('waiting', () => { throw new Error('listener'); });
    const batch = batchOf();
    const pod = keptPods.open(batch);
    const answer = keptPods.ask(pod.secret, POD, null);
    await Promise.resolve();
    keptPods.endBatch(batch);
    expect(await answer).toEqual({ action: 'stop', reason: STOP.BATCH_DONE });
  });

  test('an unknown event is a programming error', () => {
    expect(() => keptPods.on('nothing', () => {})).toThrow(/no event/);
  });
});
