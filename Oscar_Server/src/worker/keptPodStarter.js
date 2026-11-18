// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * Starts a run pod kept for the runs of one batch, and follows it (#1309;
 * part 3 = #1320). The queue calls startKeptPod() when a batch needs a pod
 * (part 4); this module ties three things together:
 *
 * - the server's record of the pod (keptPods.js): opened here, its secret
 *   handed to the dispatcher (launcher.launchPod), never kept or logged;
 * - the dispatcher's word about the pod: its address is bound to the pod's
 *   secret (another address than the one the secret already came from stops
 *   the pod and every pod of its company), and its end makes the server forget
 *   it (a run it held ends with it, part 4);
 * - the server's decision to stop a pod: the dispatcher removes it, at once
 *   when the pod may not be trusted to end by itself (AT_ONCE), else after
 *   GRACE_MS, in which a pod told stop ends by itself.
 *
 * The pod's own lines go to the server's log as data, MAX_LOG_BYTES a pod:
 * since #1318 they hold no run's output, but a run could still write there.
 */

const keptPods = require('./keptPods');
const launcher = require('./launcher');
const P = require('../runner-agent/protocol');
const baseLog = require('../utils/logger').child({ module: 'kept-pods' });
const metrics = require('../utils/metrics');

const { STOP } = keptPods;
// Stopped for these, a pod is removed at once.
const AT_ONCE = new Set([STOP.REVOKED, STOP.PROTOCOL, STOP.NOT_CLEAN, STOP.DEADLINE, STOP.NOT_STARTED, STOP.STOPPED]);
const GRACE_MS = 30 * 1000;
const MAX_LOG_BYTES = 64 * 1024;
const MAX_LINE_CHARS = 500;
const MIN_DEADLINE_S = 60;
const MAX_DEADLINE_S = 24 * 60 * 60;

const _started = new Map();   // podId -> { proc, ended, timer, graceMs }
let _listening = null;

function removePod(pod) {
  clearTimeout(pod.timer);
  if (!pod.ended) pod.proc.kill('SIGTERM');
}

// The server gave a pod up: the dispatcher removes it.
function onStop({ podId, reason }) {
  try { metrics.keptPodsStopped.inc({ reason }); } catch { /* a metric never stops anything */ }
  const pod = _started.get(podId);
  if (!pod || pod.ended) return;
  if (AT_ONCE.has(reason)) {
    removePod(pod);
    return;
  }
  clearTimeout(pod.timer);
  pod.timer = setTimeout(() => removePod(pod), pod.graceMs);
  pod.timer.unref?.();
}

// The pod's own lines, as data, up to MAX_LOG_BYTES.
function podLines(podId, log) {
  let logged = 0;
  let full = false;
  return P.lineReader((text) => {
    if (full) return;
    logged += Buffer.byteLength(text) + 1;
    if (logged > MAX_LOG_BYTES) {
      full = true;
      log.warn({ podId }, `[kept-pods] the pod's other lines are not logged (${MAX_LOG_BYTES} bytes logged)`);
      return;
    }
    log.info({ podId, line: text.slice(0, MAX_LINE_CHARS) }, '[kept-pods] a line of the pod');
  }, () => {
    full = true;
    log.warn({ podId }, '[kept-pods] the pod wrote a line too long: its other lines are not logged');
  });
}

/**
 * Starts a pod kept for `batch` ({ companyId, userId, batchId }), ending at
 * `deadlineSeconds` whatever happens. Returns { podId }. Throws when the
 * dispatcher cannot be asked (not pod mode, no dispatcher set), the pod then
 * forgotten.
 */
function startKeptPod(batch, { deadlineSeconds, launch = launcher.launchPod, log = baseLog, graceMs = GRACE_MS } = {}) {
  if (!Number.isInteger(deadlineSeconds) || deadlineSeconds < MIN_DEADLINE_S || deadlineSeconds > MAX_DEADLINE_S) {
    throw new TypeError(`startKeptPod: deadlineSeconds must be a whole number from ${MIN_DEADLINE_S} to ${MAX_DEADLINE_S}`);
  }
  _listening ??= keptPods.on('stop', onStop);
  const { podId, secret } = keptPods.open(batch);
  let proc;
  try {
    proc = launch({ podId, podSecret: secret, deadlineSeconds });
  } catch (err) {
    keptPods.forget(podId, STOP.NOT_STARTED);
    throw err;
  }
  const pod = { proc, ended: false, ran: false, timer: null, graceMs };
  _started.set(podId, pod);

  proc.on('pod', (address) => {
    pod.ran = true;
    if (!keptPods.bindAddress(podId, address)) keptPods.fault(podId, 'its secret came from another address than its pod\'s');
  });
  const lines = podLines(podId, log);
  proc.stdout?.on('data', lines);
  proc.stderr?.on('data', lines);

  const ended = (code, why) => {
    if (pod.ended) return;
    pod.ended = true;
    clearTimeout(pod.timer);
    _started.delete(podId);
    keptPods.forget(podId, pod.ran ? STOP.POD_ENDED : STOP.NOT_STARTED);
    log.info({ podId, code, ...(why ? { why } : {}) }, '[kept-pods] a kept pod ended');
  };
  proc.on('close', (code) => ended(code));
  proc.on('error', (err) => ended(null, String(err?.message || err).slice(0, 300)));
  return { podId };
}

/** The pods started and not ended yet: their ids. */
function startedPods() {
  return [..._started.keys()];
}

/** Tests only. */
function _clear() {
  for (const pod of _started.values()) clearTimeout(pod.timer);
  _started.clear();
  _listening?.();
  _listening = null;
}

module.exports = { startKeptPod, startedPods, AT_ONCE, GRACE_MS, MAX_LOG_BYTES, _clear };
