// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * Run pods kept for the runs of one batch (#1309; part 1 = #1316).
 *
 * In pod mode (#1130) every run gets a pod of its own. A kept pod takes the
 * runs of one batch one after another instead: after each run it asks the
 * server's internal port what comes next (POST /v1/run-pods/next), and the
 * server answers *run*, with that run's inputs, or *stop*. This module is the
 * server's record of those pods and the rules decided on #1309 (2026-11-18):
 *
 * - a pod belongs to one batch: one user, one company or provider;
 * - it takes at most MAX_RUNS runs, each after a run that ended normally
 *   (Bruno's exit 0 or 1, reported for the run it was given, and result
 *   files received by the internal port);
 * - it waits at most IDLE_MS for its batch's next run, and is told *stop* as
 *   soon as the batch has nothing left (endBatch);
 * - its secret is bound to its address: the dispatcher's word
 *   (bindAddress), else the address of its first call;
 * - a call its own program never makes stops it and every pod of its
 *   company: a second call while one is held, a call during a run that does
 *   not report that run's end, the end of another run, another address. A
 *   compromised Bruno that read its pod's secret would make one;
 * - an intrusion, another endpoint, new credentials stop the pods concerned
 *   (revokeCompany, revokeUser).
 *
 * A run's credentials and secret reach a pod only in a *run* answer, never
 * with the pod's start. The pod never calls again after a call that got no
 * answer: it ends, and so does its run's wait here (the run's deadline).
 *
 * In memory on purpose, like the runs' secrets (utils/runSecrets.js): nothing
 * outlives a restart, and a pod cannot either.
 */

const crypto = require('node:crypto');
const runSecrets = require('../utils/runSecrets');

const MAX_RUNS = 20;
const IDLE_MS = 30 * 1000;
// A pod that never calls: the dispatcher's own wait for a pod to start
// (RUN_POD_START_TIMEOUT_MS, 5 minutes by default).
const FIRST_CALL_MS = 5 * 60 * 1000;
// Past a run's own deadline, the pod that took it is given up.
const RUN_MARGIN_MS = 60 * 1000;

const STOP = Object.freeze({
  BATCH_DONE: 'batch-done',
  IDLE: 'idle',
  MAX_RUNS: 'max-runs',
  ABNORMAL_END: 'abnormal-end',
  NOT_CLEAN: 'not-clean',
  NOT_STARTED: 'not-started',
  POD_ENDED: 'pod-ended',
  DEADLINE: 'deadline',
  REVOKED: 'revoked',
  PROTOCOL: 'protocol',
  // The runner stopped the run the pod held (#1322: timeout, silence, emergency stop).
  STOPPED: 'stopped',
});

// The secret: 32 random bytes in base64url, 43 characters.
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

const _byId = new Map();     // podId -> entry, oldest first
const _byHash = new Map();   // sha256(secret) -> entry
const _listeners = { stop: new Set(), ended: new Set(), waiting: new Set() };
const NO_RESULTS = async () => false;
let _hasResults = NO_RESULTS;

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const plainAddress = (address) => String(address || '').replace(/^::ffff:/, '');
const stopAnswer = (reason) => ({ action: 'stop', reason });

function emit(event, detail) {
  for (const fn of _listeners[event]) {
    try { fn(detail); } catch { /* a listener never changes what a pod is told */ }
  }
}

const batchOf = (entry) => ({ companyId: entry.companyId, userId: entry.userId, batchId: entry.batchId });
const inBatch = (entry, b) => entry.companyId === b.companyId && entry.userId === b.userId && entry.batchId === b.batchId;

function checkBatch(b, what) {
  for (const key of ['companyId', 'userId', 'batchId']) {
    if (typeof b?.[key] !== 'string' || b[key] === '') throw new TypeError(`keptPods.${what}: ${key} is required`);
  }
}

function arm(entry, ms, reason) {
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => stop(entry, reason), ms);
  entry.timer.unref?.();
}

function stop(entry, reason, why) {
  if (_byId.get(entry.id) !== entry) return;
  _byId.delete(entry.id);
  _byHash.delete(entry.hash);
  clearTimeout(entry.timer);
  entry.stopped = reason;
  const waiter = entry.waiter;
  entry.waiter = null;
  if (waiter) waiter.resolve(stopAnswer(reason));
  emit('stop', { podId: entry.id, ...batchOf(entry), runId: entry.runId, reason, ...(why ? { why } : {}) });
}

// A call the pod's own program never makes: this pod and every pod of its
// company are stopped.
function violation(entry, why) {
  stop(entry, STOP.PROTOCOL, why);
  revokeCompany(entry.companyId);
  return stopAnswer(STOP.PROTOCOL);
}

/** Records a pod for one batch. Returns its id and its secret, given once. */
function open(batch) {
  checkBatch(batch, 'open');
  const secret = crypto.randomBytes(32).toString('base64url');
  const entry = {
    id: crypto.randomUUID(), hash: sha256(secret), ...batchOf(batch),
    address: '', state: 'new', runs: 0, runId: null, closing: false,
    waiter: null, asking: false, timer: null, stopped: null,
  };
  _byId.set(entry.id, entry);
  _byHash.set(entry.hash, entry);
  arm(entry, FIRST_CALL_MS, STOP.NOT_STARTED);
  return { podId: entry.id, secret };
}

/**
 * Binds a pod's secret to its pod's address (the dispatcher's word). False
 * when the pod is not known or the secret already came from another address:
 * the caller then stops the pod.
 */
function bindAddress(podId, address) {
  const entry = _byId.get(podId);
  const a = plainAddress(address);
  if (!entry || !a) return false;
  if (entry.address && entry.address !== a) return false;
  entry.address = a;
  return true;
}

async function resultsReceived(runId) {
  try { return (await _hasResults(runId)) === true; } catch { return false; }
}

// A pod that reports the end of its run: told whether it may wait for another.
// Null when it may, else the answer.
async function afterRun(entry, ended) {
  if (!ended) return violation(entry, 'a call during a run that does not report its end');
  if (ended.runId !== entry.runId) return violation(entry, 'the end of another run');
  const received = await resultsReceived(ended.runId);
  const clean = ended.clean !== false;
  emit('ended', { podId: entry.id, ...batchOf(entry), runId: ended.runId, code: ended.code, resultsReceived: received, clean });
  if (entry.stopped) return stopAnswer(entry.stopped);
  entry.runId = null;
  entry.state = 'waiting';
  // The run's end stands as it is; a pod that is no longer clean takes no other run (#1318).
  if (!clean) {
    stop(entry, STOP.NOT_CLEAN);
    return stopAnswer(STOP.NOT_CLEAN);
  }
  if (!((ended.code === 0 || ended.code === 1) && received)) {
    stop(entry, STOP.ABNORMAL_END);
    return stopAnswer(STOP.ABNORMAL_END);
  }
  arm(entry, IDLE_MS, STOP.IDLE);
  return null;
}

// Where a pod's call leaves it: null when it may wait for a run, else the answer.
async function settle(entry, ended) {
  if (entry.state === 'running') return afterRun(entry, ended);
  if (ended) return violation(entry, 'an end reported with no run');
  if (entry.state === 'new') {
    entry.state = 'waiting';
    arm(entry, IDLE_MS, STOP.IDLE);
  }
  return null;
}

/**
 * A pod's call: `secret` from X-OSCAR-Pod-Secret, `address` the caller's,
 * `ended` null on a first call, else { runId, code, clean } of the run it was
 * given (clean false: the pod is no longer clean, #1318).
 * Resolves to { action: 'run', run }, { action: 'stop', reason }, or null
 * when the call is refused (no such pod, or another address). Held until a
 * run is handed to the pod or its wait ends; `signal` ends the hold when the
 * pod's connection closes first.
 */
async function ask(secret, address, ended, { signal } = {}) {
  if (typeof secret !== 'string' || !SECRET_RE.test(secret)) return null;
  const entry = _byHash.get(sha256(secret));
  const a = plainAddress(address);
  if (!entry || !a) return null;
  if (entry.address && entry.address !== a) {
    violation(entry, 'a call from another address');
    return null;
  }
  entry.address = a;
  if (entry.waiter || entry.asking) return violation(entry, 'a second call while one is held');
  entry.asking = true;
  let answer;
  try {
    answer = await settle(entry, ended || null);
  } finally {
    entry.asking = false;
  }
  if (answer) return answer;
  if (entry.stopped) return stopAnswer(entry.stopped);
  if (entry.closing) {
    stop(entry, STOP.BATCH_DONE);
    return stopAnswer(STOP.BATCH_DONE);
  }
  if (entry.runs >= MAX_RUNS) {
    stop(entry, STOP.MAX_RUNS);
    return stopAnswer(STOP.MAX_RUNS);
  }
  return new Promise((resolve) => {
    const waiter = { resolve };
    entry.waiter = waiter;
    signal?.addEventListener('abort', () => {
      if (entry.waiter !== waiter) return;
      entry.waiter = null;
      resolve(null);
    }, { once: true });
    if (signal?.aborted) {
      entry.waiter = null;
      resolve(null);
      return;
    }
    emit('waiting', { podId: entry.id, ...batchOf(entry) });
  });
}

/**
 * Gives a run to a pod of that batch that is waiting for one, the longest
 * known first. `run` holds the run's inputs: runId and deadlineSeconds are
 * required, the rest goes to the pod as it is. The run's secret, issued
 * before (utils/runSecrets.js), is bound to the pod's address. Returns the
 * pod's id, or null when no pod of the batch can take it now.
 */
function handRun(batch, run) {
  checkBatch(batch, 'handRun');
  if (typeof run?.runId !== 'string' || run.runId === '') throw new TypeError('keptPods.handRun: run.runId is required');
  if (!Number.isInteger(run.deadlineSeconds) || run.deadlineSeconds <= 0) {
    throw new TypeError('keptPods.handRun: run.deadlineSeconds must be a positive integer');
  }
  // A pod holds a call only while it may take a run: ask() answers stop
  // instead once its batch ended or it took MAX_RUNS runs.
  for (const entry of _byId.values()) {
    if (!inBatch(entry, batch) || !entry.waiter) continue;
    if (!runSecrets.bindAddress(run.runId, entry.address)) return null;
    const waiter = entry.waiter;
    entry.waiter = null;
    entry.state = 'running';
    entry.runId = run.runId;
    entry.runs += 1;
    arm(entry, run.deadlineSeconds * 1000 + RUN_MARGIN_MS, STOP.DEADLINE);
    waiter.resolve({ action: 'run', run: { ...run } });
    return entry.id;
  }
  return null;
}

/** The batch has nothing left: its waiting pods stop now, the others after their run. */
// stop() removes the entry it is given: a Map's iteration goes on past an
// entry removed during it.
function endBatch(batch) {
  checkBatch(batch, 'endBatch');
  for (const entry of _byId.values()) {
    if (!inBatch(entry, batch)) continue;
    entry.closing = true;
    if (entry.state !== 'running') stop(entry, STOP.BATCH_DONE);
  }
}

/**
 * The pod's end, as the dispatcher reports it (#1320): the pod is forgotten,
 * `reason` NOT_STARTED when it never ran, else POD_ENDED; a run it held ends
 * with it. False when it was already given up.
 */
function forget(podId, reason = STOP.POD_ENDED) {
  const entry = _byId.get(podId);
  if (!entry) return false;
  stop(entry, reason);
  return true;
}

/**
 * A fault seen from outside that only a pod's secret used elsewhere explains
 * (#1320: the dispatcher names another address than the one it came from):
 * the pod and every pod of its company are stopped. False when it is not known.
 */
function fault(podId, why) {
  const entry = _byId.get(podId);
  if (!entry) return false;
  violation(entry, why);
  return true;
}

function revokeWhere(match) {
  let count = 0;
  for (const entry of _byId.values()) {
    if (!match(entry)) continue;
    stop(entry, STOP.REVOKED);
    count += 1;
  }
  return count;
}

/** Stops every pod of a company or provider. Returns how many. */
function revokeCompany(companyId) {
  return revokeWhere((e) => e.companyId === companyId);
}

/** Stops a user's pods for a company or provider. Returns how many. */
function revokeUser(userId, companyId) {
  return revokeWhere((e) => e.userId === userId && e.companyId === companyId);
}

/**
 * Listens to 'stop' (a pod is given up: { podId, companyId, userId, batchId,
 * runId, reason, why? }), 'ended' (a pod reported its run's end: { podId, …,
 * runId, code, resultsReceived, clean }) or 'waiting' (a pod waits for a run).
 * Returns the function that stops listening.
 */
function on(event, fn) {
  const set = _listeners[event];
  if (!set) throw new TypeError(`keptPods.on: no event ${event}`);
  set.add(fn);
  return () => set.delete(fn);
}

/** `hasResults(runId)`: whether the internal port received the run's result files. */
function configure({ hasResults } = {}) {
  if (hasResults !== undefined) _hasResults = typeof hasResults === 'function' ? hasResults : NO_RESULTS;
}

/** The pods known, without their secrets. */
function snapshot() {
  return [..._byId.values()].map((e) => ({
    podId: e.id, ...batchOf(e), state: e.state, runs: e.runs, runId: e.runId, address: e.address, waiting: Boolean(e.waiter),
  }));
}

/** Tests only. */
function _clear() {
  for (const entry of _byId.values()) clearTimeout(entry.timer);
  _byId.clear();
  _byHash.clear();
  for (const set of Object.values(_listeners)) set.clear();
  _hasResults = NO_RESULTS;
}

module.exports = {
  MAX_RUNS, IDLE_MS, FIRST_CALL_MS, RUN_MARGIN_MS, STOP,
  open, bindAddress, ask, handRun, endBatch, forget, fault, revokeCompany, revokeUser, on, configure, snapshot, _clear,
};
