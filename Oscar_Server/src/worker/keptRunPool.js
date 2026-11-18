// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * The runs of a batch, given to pods kept for that batch (#1309; part 4 =
 * #1322), when RUN_KEPT_PODS is on (launcher.keptPodsOn()).
 *
 * launchKeptRun() gives the runner, for one run, an object that behaves as a
 * run's process does in pod mode (launcher.launchRun): `stdout` / `stderr`
 * 'data', 'started' and 'pod' (address) once a pod took the run, 'close'
 * (code), 'error', kill(). The runner does the rest as for any run in a pod.
 *
 * - A pod of the batch waiting for a run takes it at once (keptPods.handRun,
 *   which binds the run's secret to the pod's address).
 * - Else the run waits, and a pod is started for it (keptPodStarter) unless
 *   enough pods are starting already for the runs waiting.
 * - The run's output comes through POST /v1/runs/:runId/output (runOutput,
 *   opened here), its end from the pod's next call: Bruno's own exit code.
 * - A pod given up under a run ends the run with a code that is no test
 *   result (#1287): CODE_OF_STOP, else STOPPED_CODE. A pod meant for runs
 *   that never starts fails as many waiting runs as pods are missing.
 * - kill(): a waiting run is taken off; a run in a pod has its pod removed at
 *   once (keptPods STOPPED).
 * - The end of a batch: a waiting pod is told stop once the batch has nothing
 *   left: no run in the queue (configure({ queuedOf })), none on its way to a
 *   pod (announce() / release(), from the runner), none waiting here.
 *
 * In memory, like the pods' record: a restart ends every pod and run.
 */

const { EventEmitter } = require('node:events');
const keptPods = require('./keptPods');
const starter = require('./keptPodStarter');
const runOutput = require('./runOutput');
const { RUN_ENV_KEYS } = require('./childEnv');

const { STOP, MAX_RUNS } = keptPods;
// A run's process ends with these when its pod is given up under it.
const CODE_OF_STOP = Object.freeze({ [STOP.DEADLINE]: 124, [STOP.NOT_STARTED]: 125, [STOP.POD_ENDED]: 137 });
const STOPPED_CODE = 143;
// A kept pod lives at most MAX_RUNS runs of the first one's deadline, and a margin.
const POD_MARGIN_S = 600;
const MIN_POD_DEADLINE_S = 60;
const MAX_POD_DEADLINE_S = 24 * 60 * 60;

const keyOf = (b) => `${b.companyId}|${b.userId}|${b.batchId}`;
const batchOf = (b) => ({ companyId: b.companyId, userId: b.userId, batchId: b.batchId });
const _batches = new Map();   // batch key -> { batch, pending: KeptRun[], starting: Set<podId>, announced: Set<runId>, runs: Set<runId> }
const _byRun = new Map();     // runId -> KeptRun
let _queuedOf = () => 0;
let _offs = null;

class KeptRun extends EventEmitter {
  constructor(state, run) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.state = state;
    this.run = run;
    this.podId = null;
    this.done = false;
  }

  /** Stops the run: off the waiting list, or its pod removed. False once it ended. */
  kill() {
    if (this.done) return false;
    if (this.podId) keptPods.forget(this.podId, STOP.STOPPED);
    if (!this.done) finish(this, STOPPED_CODE, this.podId ? STOP.STOPPED : 'stopped before a pod took it');
    return true;
  }
}

function stateOf(batch) {
  const key = keyOf(batch);
  let state = _batches.get(key);
  if (!state) {
    state = { batch: batchOf(batch), pending: [], starting: new Set(), announced: new Set(), runs: new Set() };
    _batches.set(key, state);
  }
  return state;
}

// A batch with nothing going on here is forgotten; its pods are keptPods'.
function forgetIfIdle(state) {
  if (state.pending.length + state.starting.size + state.announced.size + state.runs.size > 0) return;
  if (_batches.get(keyOf(state.batch)) === state) _batches.delete(keyOf(state.batch));
}

// The run leaves the pool: its output closed, off every list.
function leave(kept) {
  const { state, run } = kept;
  state.pending = state.pending.filter((k) => k !== kept);
  state.runs.delete(run.runId);
  if (_byRun.get(run.runId) === kept) _byRun.delete(run.runId);
  runOutput.close(run.runId);
  forgetIfIdle(state);
}

function finish(kept, code, reason) {
  if (kept.done) return;
  kept.done = true;
  leave(kept);
  setImmediate(() => {
    if (reason) kept.stderr.emit('data', Buffer.from(`[kept-pods] The run's kept pod was given up (${reason}).\n`, 'utf8'));
    kept.emit('close', code);
  });
}

function fail(kept, err) {
  if (kept.done) return;
  kept.done = true;
  leave(kept);
  setImmediate(() => kept.emit('error', err));
}

// The run to a pod of its batch that waits for one: true when one took it.
function giveToWaitingPod(kept) {
  const podId = keptPods.handRun(kept.state.batch, kept.run);
  if (!podId) return false;
  kept.podId = podId;
  const address = keptPods.snapshot().find((p) => p.podId === podId)?.address;
  // As the dispatcher's messages come for a pod of its own: after the
  // runner has listened.
  setImmediate(() => {
    if (kept.done) return;
    kept.emit('started');
    if (address) kept.emit('pod', address);
  });
  return true;
}

function startPod(state, runDeadlineS) {
  const deadlineSeconds = Math.min(MAX_POD_DEADLINE_S, Math.max(MIN_POD_DEADLINE_S, MAX_RUNS * runDeadlineS + POD_MARGIN_S));
  try {
    const { podId } = starter.startKeptPod(state.batch, { deadlineSeconds });
    state.starting.add(podId);
  } catch (err) {
    const kept = state.pending.at(-1);
    if (kept) fail(kept, err);
  }
}

// The batch has nothing left: its waiting pods are told stop.
function endIfNothingLeft(state) {
  if (state.pending.length > 0 || state.announced.size > 0) return;
  let queued;
  try { queued = _queuedOf(state.batch); } catch { queued = 1; }
  if (queued === 0) keptPods.endBatch(state.batch);
}

function onWaiting(e) {
  const state = _batches.get(keyOf(e)) || stateOf(e);
  state.starting.delete(e.podId);
  while (state.pending.length > 0) {
    const kept = state.pending.shift();
    if (giveToWaitingPod(kept)) return;
    fail(kept, new Error('the run could not be handed to a kept pod'));
  }
  endIfNothingLeft(state);
  forgetIfIdle(state);
}

function onEnded({ runId, code }) {
  const kept = _byRun.get(runId);
  if (kept) finish(kept, code);
}

function onStop(e) {
  const kept = e.runId ? _byRun.get(e.runId) : null;
  if (kept && kept.podId === e.podId) finish(kept, CODE_OF_STOP[e.reason] ?? STOPPED_CODE, e.reason);
  const state = _batches.get(keyOf(e));
  if (!state) return;
  state.starting.delete(e.podId);
  // Runs waiting for pods that will not come: as many as pods are missing.
  while (state.pending.length > state.starting.size) {
    fail(state.pending.at(-1), new Error(`the kept pod meant for the run was given up before it took it (${e.reason})`));
  }
  forgetIfIdle(state);
}

function listen() {
  _offs ??= [keptPods.on('waiting', onWaiting), keptPods.on('ended', onEnded), keptPods.on('stop', onStop)];
}

/**
 * A run of `batch` ({ companyId, userId, batchId }) for a kept pod. `run` is
 * what launcher.launchRun takes ({ runId, envName, envYml, deadlineSeconds,
 * env }); of env, the run's credentials only go on (childEnv RUN_ENV_KEYS).
 * Its secret is issued before (runSecrets).
 */
function launchKeptRun({ batch, run }) {
  listen();
  const env = {};
  for (const key of RUN_ENV_KEYS) if (run.env?.[key] !== undefined) env[key] = run.env[key];
  const handed = { runId: run.runId, envName: run.envName, envYml: run.envYml, deadlineSeconds: run.deadlineSeconds, env };
  const state = stateOf(batch);
  const kept = new KeptRun(state, handed);
  _byRun.set(run.runId, kept);
  state.runs.add(run.runId);
  state.announced.delete(run.runId);
  runOutput.open(run.runId, (stream, text) => (stream === 'out' ? kept.stdout : kept.stderr).emit('data', Buffer.from(text, 'utf8')));
  if (!giveToWaitingPod(kept)) {
    state.pending.push(kept);
    if (state.starting.size < state.pending.length) startPod(state, handed.deadlineSeconds);
  }
  return kept;
}

/** A run of `batch` is on its way to a pod (the runner started it). */
function announce(runId, batch) {
  listen();
  stateOf(batch).announced.add(runId);
}

/** The runner is done with a run, whatever happened to it. */
function release(runId) {
  const kept = _byRun.get(runId);
  if (kept && !kept.done) kept.kill();
  for (const state of _batches.values()) {
    if (!state.announced.delete(runId)) continue;
    endIfNothingLeft(state);
    forgetIfIdle(state);
    return;
  }
}

/** `queuedOf(batch)`: how many runs of that batch the queue still holds. */
function configure({ queuedOf } = {}) {
  if (typeof queuedOf === 'function') _queuedOf = queuedOf;
}

/** The batches the pool follows: what waits, starts and runs. */
function snapshot() {
  return [..._batches.values()].map((s) => ({
    ...s.batch, pending: s.pending.map((k) => k.run.runId), starting: [...s.starting], announced: [...s.announced], runs: [...s.runs],
  }));
}

/** Tests only: what the queue says of a batch. */
function _queued(batch) {
  return _queuedOf(batch);
}

/** Tests only. */
function _clear() {
  for (const off of _offs || []) off();
  _offs = null;
  _batches.clear();
  _byRun.clear();
  _queuedOf = () => 0;
}

module.exports = {
  launchKeptRun, announce, release, configure, snapshot, _queued, _clear,
  CODE_OF_STOP, STOPPED_CODE, POD_MARGIN_S, MAX_POD_DEADLINE_S,
};
