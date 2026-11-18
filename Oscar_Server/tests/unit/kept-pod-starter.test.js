// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * A run pod kept for a batch, started and followed by the server (#1309;
 * part 3 = #1320), with a stand-in for the dispatcher's connection.
 */

const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const keptPods = require('../../src/worker/keptPods');
const starter = require('../../src/worker/keptPodStarter');

const { STOP } = keptPods;
const POD = '10.42.0.17';
const OTHER = '10.42.0.99';

// The dispatcher's connection as the launcher returns it.
function fakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = jest.fn(() => true);
  return proc;
}

let launched;
let stops;
let lines;
const log = {
  info: (fields, text) => lines.push(['info', fields, text]),
  warn: (fields, text) => lines.push(['warn', fields, text]),
};
beforeEach(() => {
  keptPods._clear();
  starter._clear();
  launched = [];
  lines = [];
  stops = [];
  keptPods.on('stop', (e) => stops.push(e));
});
afterEach(() => {
  jest.useRealTimers();
  starter._clear();
  keptPods._clear();
});

const batchOf = (over = {}) => ({ companyId: randomUUID(), userId: randomUUID(), batchId: randomUUID(), ...over });
function start(batch = batchOf(), extra = {}) {
  const proc = fakeProc();
  const launch = (request) => { launched.push(request); return proc; };
  const { podId } = starter.startKeptPod(batch, { deadlineSeconds: 3600, launch, log, ...extra });
  return { podId, proc, batch, secret: launched.at(-1).podSecret };
}

describe('starting a kept pod', () => {
  test('the pod is recorded, and the dispatcher gets its id, its secret and its deadline', async () => {
    const { podId, batch, secret } = start();
    expect(launched).toEqual([{ podId, podSecret: secret, deadlineSeconds: 3600 }]);
    expect(keptPods.snapshot()).toEqual([expect.objectContaining({ podId, ...batch, state: 'new' })]);
    expect(starter.startedPods()).toEqual([podId]);
    // The secret handed to the dispatcher is the one the internal port takes.
    const answer = keptPods.ask(secret, POD, null);
    await Promise.resolve();
    keptPods.endBatch(batch);
    expect(await answer).toEqual({ action: 'stop', reason: STOP.BATCH_DONE });
    expect(JSON.stringify(lines)).not.toContain(secret);
  });

  test('a deadline out of range is refused before anything is made', () => {
    for (const deadlineSeconds of [undefined, 59, 86401, 1.5, '3600']) {
      expect(() => starter.startKeptPod(batchOf(), { deadlineSeconds, launch: () => fakeProc(), log })).toThrow(/deadlineSeconds/);
    }
    expect(keptPods.snapshot()).toEqual([]);
  });

  test('a dispatcher that cannot be asked: the pod is forgotten as not started, and the error goes up', () => {
    const launch = () => { throw new Error('launcher: a kept pod is started in pod mode only'); };
    expect(() => starter.startKeptPod(batchOf(), { deadlineSeconds: 600, launch, log })).toThrow(/pod mode only/);
    expect(keptPods.snapshot()).toEqual([]);
    expect(stops).toEqual([expect.objectContaining({ reason: STOP.NOT_STARTED })]);
    expect(starter.startedPods()).toEqual([]);
  });
});

describe('the dispatcher\'s word', () => {
  test('the pod\'s address is bound to its secret: a call from elsewhere is refused', async () => {
    const { podId, proc, secret } = start();
    proc.emit('pod', POD);
    expect(keptPods.snapshot()[0]).toMatchObject({ podId, address: POD });
    expect(await keptPods.ask(secret, OTHER, null)).toBeNull();
    expect(stops).toEqual([expect.objectContaining({ podId, reason: STOP.PROTOCOL })]);
  });

  test('an address other than the one the secret already came from: the pod and its company\'s pods are stopped, and removed at once', async () => {
    const { podId, proc, batch, secret } = start();
    const colleague = start(batchOf({ companyId: batch.companyId }));
    const elsewhere = start();
    const held = keptPods.ask(secret, OTHER, null);
    await Promise.resolve();
    proc.emit('pod', POD);
    expect(await held).toEqual({ action: 'stop', reason: STOP.PROTOCOL });
    expect(stops.find((s) => s.podId === podId)).toMatchObject({ reason: STOP.PROTOCOL, why: 'its secret came from another address than its pod\'s' });
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(colleague.proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(elsewhere.proc.kill).not.toHaveBeenCalled();
    expect(keptPods.snapshot().map((p) => p.podId)).toEqual([elsewhere.podId]);
  });

  test('a pod that ends is forgotten; one that held a run says which', async () => {
    const batch = batchOf();
    const { podId, proc, secret } = start(batch);
    proc.emit('pod', POD);
    const call = keptPods.ask(secret, POD, null);
    await new Promise((r) => setImmediate(r));
    const runId = randomUUID();
    require('../../src/utils/runSecrets').issue(runId, batch.companyId);
    expect(keptPods.handRun(batch, { runId, deadlineSeconds: 600 })).toBe(podId);
    await call;
    proc.emit('close', 137);
    expect(stops).toEqual([expect.objectContaining({ podId, runId, reason: STOP.POD_ENDED })]);
    expect(keptPods.snapshot()).toEqual([]);
    expect(starter.startedPods()).toEqual([]);
    expect(proc.kill).not.toHaveBeenCalled();
  });

  test('a pod that never ran, or a dispatcher that refused or went away: not started', () => {
    const never = start();
    never.proc.emit('close', 125);
    const refused = start();
    refused.proc.emit('error', new Error('the runner agent refused: too many runs'));
    expect(stops.map((s) => [s.podId, s.reason])).toEqual([[never.podId, STOP.NOT_STARTED], [refused.podId, STOP.NOT_STARTED]]);
    expect(lines.filter(([, , text]) => text === '[kept-pods] a kept pod ended').map(([, f]) => f)).toEqual([
      { podId: never.podId, code: 125 },
      { podId: refused.podId, code: null, why: 'the runner agent refused: too many runs' },
    ]);
  });

  test('an end after the server gave the pod up changes nothing', () => {
    const { podId, proc, batch } = start();
    proc.emit('pod', POD);
    keptPods.endBatch(batch);
    proc.emit('close', 0);
    proc.emit('close', 0);
    expect(stops).toEqual([expect.objectContaining({ podId, reason: STOP.BATCH_DONE })]);
  });
});

describe('the server stops a pod', () => {
  test.each([...starter.AT_ONCE])('for %s: removed at once', (reason) => {
    const { podId, proc } = start();
    proc.emit('pod', POD);
    // The registry's own stop: here through the reason's event, as keptPods sends it.
    keptPods.forget(podId, reason);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  test('revoked with its company: removed at once', () => {
    const { proc, batch } = start();
    keptPods.revokeCompany(batch.companyId);
    expect(proc.kill).toHaveBeenCalledTimes(1);
  });

  test('told stop for another reason: given time to end by itself, removed after it', () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    const { proc, batch } = start();
    proc.emit('pod', POD);
    keptPods.endBatch(batch);
    jest.advanceTimersByTime(starter.GRACE_MS - 1);
    expect(proc.kill).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  test('a pod that ends within that time is not removed', () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    const { proc, batch } = start();
    proc.emit('pod', POD);
    keptPods.endBatch(batch);
    proc.emit('close', 0);
    jest.advanceTimersByTime(starter.GRACE_MS);
    expect(proc.kill).not.toHaveBeenCalled();
  });
});

describe('the pod\'s own lines', () => {
  test('logged as data, one entry a line, from both streams', () => {
    const { podId, proc } = start();
    proc.stderr.emit('data', Buffer.from('[kept-pod] started bru in x\n[kept-pod] bru ended'));
    proc.stdout.emit('data', Buffer.from(' with 0\n'));
    expect(lines.filter(([, f]) => f.line).map(([level, f, text]) => [level, f, text])).toEqual([
      ['info', { podId, line: '[kept-pod] started bru in x' }, '[kept-pods] a line of the pod'],
      ['info', { podId, line: '[kept-pod] bru ended with 0' }, '[kept-pods] a line of the pod'],
    ]);
  });

  test(`${starter.MAX_LOG_BYTES} bytes a pod, then one line saying the rest is not logged`, () => {
    const { proc } = start();
    const line = `${'x'.repeat(999)}\n`;
    for (let i = 0; i < 100; i++) proc.stderr.emit('data', Buffer.from(line));
    const logged = lines.filter(([, f]) => f.line);
    expect(logged.length).toBe(Math.floor(starter.MAX_LOG_BYTES / 1000));
    expect(logged.every(([, f]) => f.line.length === 500)).toBe(true);
    expect(lines.filter(([level]) => level === 'warn')).toHaveLength(1);
  });
});
