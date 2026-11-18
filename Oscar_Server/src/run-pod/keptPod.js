// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/* global AbortSignal */  // Node 22 global

/**
 * A run pod kept for the runs of one batch (#1309; part 2 = #1318): what the
 * run image's entrypoint does when its environment names a pod's secret.
 *
 * Its inputs (a Secret of its own, made by the dispatcher) hold nothing of a
 * run:
 *   OSCAR_POD_SECRET    the pod's own secret
 *   OSCAR_RESULTS_URL   the server's internal port
 *
 * It asks the internal port for its next run (POST /v1/run-pods/next, part 1)
 * and, while the answer is a run:
 *   - runs it in a work folder of its own, with a home folder of its own:
 *     Bruno gets the run's credentials and nothing else of the pod, its
 *     secret above all;
 *   - sends Bruno's and mergeReport.js's output to the internal port as it
 *     comes (outputSender.js), then the result files, as a pod of one run
 *     does (runPod.js); the run's deadline stops it;
 *   - cleans before the next run: the run's processes stopped (each run is a
 *     group of its own), the work folder removed, /tmp emptied, and the pod's
 *     processes listed: one the run left behind is stopped too, and the pod
 *     says it is no longer clean, which the server answers with stop;
 *   - reports the run's end on its next call.
 * It ends on stop (0), and on no answer, a refusal or an answer it cannot read
 * (1): it never calls again after a call that got no answer, since the server
 * would read that call as one made during a run. Wrong inputs: 2.
 * Node only: no dependency, nothing of the server.
 */

const fs = require('node:fs');
const path = require('node:path');
const R = require('./runPod');
const L = require('./runLayout');
const { OutputSender } = require('./outputSender');

const POD_SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The server holds a call 30 s at most (worker/keptPods.js IDLE_MS).
const NEXT_TIMEOUT_MS = 90 * 1000;
const MAX_DEADLINE_SECONDS = 24 * 60 * 60;
// A run that could not be started: the server answers it with stop.
const NOT_STARTED_CODE = 2;

/** The server's internal port, without trailing slashes, or null. */
function baseOf(text) {
  let url;
  try {
    url = new URL(String(text || ''));
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  let base = url.href;
  while (base.endsWith('/')) base = base.slice(0, -1);
  return base;
}

/** The pod's inputs, read and checked, or { problem }. */
function podInputs(env) {
  const podSecret = String(env.OSCAR_POD_SECRET || '');
  if (!POD_SECRET_RE.test(podSecret)) return { problem: 'OSCAR_POD_SECRET is not a pod secret' };
  const base = baseOf(env.OSCAR_RESULTS_URL);
  if (!base) return { problem: 'OSCAR_RESULTS_URL must be an http(s) address, without credentials' };
  return { podSecret, base };
}

/**
 * Asks the server for the pod's next run, reporting the end of the last one.
 * { action: 'run', run }, { action: 'stop', reason }, or { failed: why }.
 */
async function askNext({ base, podSecret, ended, fetchImpl, timeoutMs }) {
  let res;
  try {
    res = await fetchImpl(`${base}/v1/run-pods/next`, {
      method: 'POST',
      headers: { 'X-OSCAR-Pod-Secret': podSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify(ended ? { ended } : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { failed: R.reasonOf(err) };
  }
  if (res.status !== 200) return { failed: `HTTP ${res.status}` };
  let body;
  try {
    body = await res.json();
  } catch {
    return { failed: 'an answer that is not JSON' };
  }
  if (body?.action === 'stop' && typeof body.reason === 'string') return { action: 'stop', reason: body.reason.slice(0, 40) };
  if (body?.action === 'run' && body.run && typeof body.run === 'object' && !Array.isArray(body.run)) return { action: 'run', run: body.run };
  return { failed: 'an answer it cannot read' };
}

/**
 * The run of an answer, read and checked as a pod of one run reads its
 * environment: { runId, input, credentials, deadlineSeconds }, or
 * { runId, problem } (runId null when it is not a run id).
 */
function runOfAnswer(run, base) {
  const runId = UUID_RE.test(String(run.runId || '')) ? String(run.runId) : null;
  if (!runId) return { runId: null, problem: 'the run has no run id' };
  const env = run.env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return { runId, problem: 'the run has no environment' };
  const unknown = Object.keys(env).filter((k) => !R.RUN_CREDENTIALS.includes(k));
  if (unknown.length > 0) return { runId, problem: `the run's environment holds ${unknown.join(', ').slice(0, 200)}` };
  const credentials = {};
  for (const key of R.RUN_CREDENTIALS) {
    if (env[key] === undefined) continue;
    if (typeof env[key] !== 'string') return { runId, problem: `${key} is not text` };
    credentials[key] = env[key];
  }
  const input = R.runInputs({
    OSCAR_RUN_ID: runId, OSCAR_ENV_NAME: run.envName, OSCAR_RUN_ENV_YML: run.envYml,
    OSCAR_RESULTS_URL: base, OSCAR_RUN_SECRET: credentials.OSCAR_RUN_SECRET,
  });
  if (input.problem) return { runId, problem: input.problem };
  const deadlineSeconds = run.deadlineSeconds;
  if (!Number.isInteger(deadlineSeconds) || deadlineSeconds <= 0 || deadlineSeconds > MAX_DEADLINE_SECONDS) {
    return { runId, problem: 'the run has no deadline in whole seconds' };
  }
  return { runId, input, credentials, deadlineSeconds };
}

/**
 * The pod's processes other than this one, alive: their pids. Looked at only
 * when this program is its pod's first process (pid 1): elsewhere /proc shows
 * processes that are not the pod's. null when not looked at.
 */
function podProcesses({ procDir = '/proc', self = process.pid } = {}) {
  if (self !== 1) return null;
  const pids = [];
  for (const name of fs.readdirSync(procDir)) {
    if (!/^\d+$/.test(name) || Number(name) === self) continue;
    let stat;
    try {
      stat = fs.readFileSync(path.join(procDir, name, 'stat'), 'utf8');
    } catch {
      continue;   // ended meanwhile
    }
    // "pid (name) state …": the name may hold spaces and parentheses.
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
    if (state !== 'Z' && state !== 'X') pids.push(Number(name));
  }
  return pids;
}

/** Removes what a folder holds, keeping the folder. True when all went. */
async function emptyFolder(dir) {
  let names;
  try {
    names = await fs.promises.readdir(dir);
  } catch (err) {
    return err.code === 'ENOENT';
  }
  const removed = await Promise.allSettled(names.map((name) => fs.promises.rm(path.join(dir, name), { recursive: true, force: true })));
  return removed.every((r) => r.status === 'fulfilled');
}

/** One run, from its work folder to its result files sent. Resolves with Bruno's code. */
async function oneRun(run, o) {
  const { runId, input, credentials, deadlineSeconds } = run;
  const workDir = path.join(o.workRoot, runId);
  const home = path.join(workDir, '.home');
  await R.prepareWork({ collectionDir: o.collectionDir, workDir, envName: input.envName, yml: input.yml });
  await fs.promises.mkdir(home, { recursive: true });
  const output = new OutputSender({
    url: `${o.base}/v1/runs/${runId}/output`, secret: credentials.OSCAR_RUN_SECRET, fetchImpl: o.fetchImpl,
    log: o.log, sleep: o.sleep, reasonOf: R.reasonOf, retryDelaysMs: o.outputRetryDelaysMs, flushMs: o.outputFlushMs,
  });
  // Bruno: the pod's base variables, its own home, the run's credentials.
  const podEnv = { ...R.childEnv(o.env), HOME: home };
  o.log(`[kept-pod] started bru in ${runId}`);
  const [bruCommand, ...bruPrefix] = o.bru;
  const exitCode = await R.runProcess(bruCommand, [...bruPrefix, ...L.bruRunArgs(input.envName, runId)], {
    cwd: workDir, env: { ...podEnv, ...credentials }, log: o.log, onOutput: output.push,
    deadlineMs: deadlineSeconds * 1000, killGraceMs: o.killGraceMs,
  });
  const results = path.join(workDir, L.REPORTS_DIR, L.bruResultsName(runId));
  const merge = path.join(workDir, 'library-bruno', 'mergeReport.js');
  const copied = fs.existsSync(merge)
    && await R.ignoreMissing(fs.promises.copyFile(results, path.join(workDir, L.REPORTS_DIR, L.MERGE_RESULTS_NAME)).then(() => true));
  if (copied) {
    const mergeCode = await R.runProcess(o.node, [merge, input.envName], {
      cwd: workDir, env: podEnv, log: o.log, onOutput: output.push, killGraceMs: o.killGraceMs,
    });
    if (mergeCode !== 0) o.log(`[kept-pod] mergeReport.js ended with ${mergeCode}`);
  }
  await output.end();
  const sent = await R.sendResults({
    workDir, runId, resultsBase: o.base, secret: credentials.OSCAR_RUN_SECRET, fetchImpl: o.fetchImpl,
    log: o.log, retryDelaysMs: o.retryDelaysMs, sleep: o.sleep,
  });
  o.log(`[kept-pod] bru ended with ${exitCode} in ${runId}; ${sent} result file(s) sent`);
  return exitCode;
}

/** After a run: its processes and files gone. True when the pod is clean. */
async function cleanUp(runId, o) {
  let clean = true;
  const left = o.processes();
  if (left?.length > 0) {
    clean = false;
    o.log(`[kept-pod] ${left.length} process(es) left behind by ${runId}: stopped, and the pod is no longer clean`);
    for (const pid of left) {
      try { o.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
  try {
    await fs.promises.rm(path.join(o.workRoot, runId), { recursive: true, force: true });
  } catch {
    clean = false;
  }
  if (!(await emptyFolder(o.tmpDir))) clean = false;
  if (!clean) o.log(`[kept-pod] what ${runId} left could not all be removed, or a process was left behind`);
  return clean;
}

/**
 * The kept pod's loop. Resolves with the code to end with: 0 when told to
 * stop, 1 when the server did not answer or refused, 2 on wrong inputs.
 */
async function keptPod({
  env = process.env,
  collectionDir = '/collection',
  workRoot = '/work',
  tmpDir = '/tmp',
  bru = ['bru'],
  node = process.execPath,
  fetchImpl = globalThis.fetch,
  log = (line) => process.stderr.write(`${line}\n`),
  processes = podProcesses,
  kill = (pid, signal) => process.kill(pid, signal),
  nextTimeoutMs = NEXT_TIMEOUT_MS,
  retryDelaysMs = R.RETRY_DELAYS_MS,
  outputRetryDelaysMs = undefined,
  outputFlushMs = undefined,
  killGraceMs = R.KILL_GRACE_MS,
  sleep = R.defaultSleep,
} = {}) {
  const pod = podInputs(env);
  if (pod.problem) {
    log(`[kept-pod] Not started: ${pod.problem}.`);
    return 2;
  }
  if (processes() === null) log('[kept-pod] not the first process of its pod: the processes a run leaves are not looked for');
  const o = {
    env, collectionDir, workRoot, tmpDir, bru, node, fetchImpl, log, processes, kill, retryDelaysMs,
    outputRetryDelaysMs, outputFlushMs, killGraceMs, sleep, base: pod.base,
  };
  let ended = null;
  let runs = 0;
  for (;;) {
    const answer = await askNext({ base: pod.base, podSecret: pod.podSecret, ended, fetchImpl, timeoutMs: nextTimeoutMs });
    if (answer.failed) {
      log(`[kept-pod] ends after ${runs} run(s): ${answer.failed}`);
      return 1;
    }
    if (answer.action === 'stop') {
      log(`[kept-pod] ends after ${runs} run(s): told to stop (${answer.reason})`);
      return 0;
    }
    const run = runOfAnswer(answer.run, pod.base);
    if (!run.runId) {
      log(`[kept-pod] ends after ${runs} run(s): ${run.problem}`);
      return 1;
    }
    let code = NOT_STARTED_CODE;
    if (run.problem) {
      log(`[kept-pod] ${run.runId} not started: ${run.problem}`);
    } else {
      try {
        code = await oneRun(run, o);
      } catch (err) {
        log(`[kept-pod] ${run.runId} failed: ${err?.message || err}`);
      }
    }
    const clean = await cleanUp(run.runId, o);
    ended = { runId: run.runId, code, clean };
    runs += 1;
  }
}

module.exports = { keptPod, podInputs, askNext, runOfAnswer, podProcesses, emptyFolder, NEXT_TIMEOUT_MS, NOT_STARTED_CODE };
