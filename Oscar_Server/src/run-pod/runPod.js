// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/* global AbortSignal */  // Node 22 global

/**
 * One run in a pod of its own (run isolation, option 4, #1130): what the run
 * image's entrypoint does. The pod is created for the run and deleted after
 * it; it holds the collection (in the image), the run's own credentials and
 * nothing of the server.
 *
 * Its inputs come from its environment (a Secret of its own, made by the
 * dispatcher):
 *   OSCAR_RUN_ID        the run's id
 *   OSCAR_ENV_NAME      the Bruno environment's name
 *   OSCAR_RUN_ENV_YML   the environment file, base64, as the server builds it
 *   OSCAR_RESULTS_URL   the server's internal port, where the results go
 *   OSCAR_RUN_SECRET, OSCAR_ACCESS_TOKEN, OSCAR_SUBSCRIPTION_KEY,
 *   OSCAR_OAUTH_EXTRA   the run's own secret and credentials
 *
 * It copies the collection into its work folder, writes the environment file,
 * runs Bruno (whose output is the pod's log, which the dispatcher streams to
 * the server), runs mergeReport.js, sends the result files (again, for about a
 * minute, while the server cannot take them) and ends with Bruno's exit code.
 * Node only: no dependency, nothing of the server.
 */

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const L = require('./runLayout');

// Bruno's credentials, as the server hands them to its own child process
// (worker/childEnv.js RUN_ENV_KEYS, pinned by run-pod.test.js).
const RUN_CREDENTIALS = Object.freeze(['OSCAR_ACCESS_TOKEN', 'OSCAR_SUBSCRIPTION_KEY', 'OSCAR_OAUTH_EXTRA', 'OSCAR_RUN_SECRET']);
// What else a child process of the pod gets from its environment.
const BASE_ENV = Object.freeze(['PATH', 'HOME', 'LANG', 'TZ', 'NODE_ENV']);
// As the server keeps them (utils/runResults.js).
const MAX_RESULT_BYTES = 100 * 1024 * 1024;
const MAX_ENV_YML_BYTES = 1024 * 1024;
const SEND_TIMEOUT_MS = 60 * 1000;
// A result the server cannot take yet (no connection, or 502/503/504) is sent
// again after these pauses: about a minute in all, shared by every file of the
// run, so a server that stays away costs one minute, not one per file.
const RETRY_DELAYS_MS = Object.freeze([1000, 2000, 4000, 8000, 15000, 30000]);
const RETRY_STATUSES = new Set([502, 503, 504]);
// A connection that was never made: tried again after the pauses, about 30 s
// in all. A new pod's network may need a moment: on k3s its network policy is
// in place a little after the pod starts, and until then OSCAR's internal
// port refuses it, while the provider is already reached. A kept pod's first
// call was refused half a second in (#1324); a pod of one run had its data
// file refused for 2.5 s, 19 s in, under a batch (#1326).
const NOT_CONNECTED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);
const CONNECT_RETRY_DELAYS_MS = Object.freeze([500, 1000, 2000, 4000, 8000, 15000]);
// waitForServer() opens a connection only, so its own timeout (ETIMEDOUT) is
// one never made too.
const CONNECT_TIMEOUT_MS = 5000;
const NOT_REACHED = new Set([...NOT_CONNECTED, 'ETIMEDOUT']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENV_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;
const SECRET_RE = /^[0-9a-f]{64}$/;

/**
 * The run's inputs, read and checked, or { problem } saying what is wrong.
 * Nothing is started when one is missing.
 */
function runInputs(env) {
  const runId = String(env.OSCAR_RUN_ID || '');
  if (!UUID_RE.test(runId)) return { problem: 'OSCAR_RUN_ID is not a run id' };
  const envName = String(env.OSCAR_ENV_NAME || '');
  if (!ENV_NAME_RE.test(envName)) return { problem: 'OSCAR_ENV_NAME is not an environment name' };
  const yml = Buffer.from(String(env.OSCAR_RUN_ENV_YML || ''), 'base64');
  if (yml.length === 0 || yml.length > MAX_ENV_YML_BYTES) return { problem: 'OSCAR_RUN_ENV_YML is empty or too large' };
  let resultsUrl;
  try {
    resultsUrl = new URL(String(env.OSCAR_RESULTS_URL || ''));
  } catch {
    return { problem: 'OSCAR_RESULTS_URL is not an address' };
  }
  if (!['http:', 'https:'].includes(resultsUrl.protocol) || resultsUrl.username || resultsUrl.password) {
    return { problem: 'OSCAR_RESULTS_URL must be http(s), without credentials' };
  }
  if (!SECRET_RE.test(String(env.OSCAR_RUN_SECRET || ''))) return { problem: 'OSCAR_RUN_SECRET is not a run secret' };
  let resultsBase = resultsUrl.href;
  while (resultsBase.endsWith('/')) resultsBase = resultsBase.slice(0, -1);
  return { runId, envName, yml, resultsBase };
}

/** A child process's environment: the base variables, plus `extra` names. */
function childEnv(env, extra = []) {
  const out = {};
  for (const key of [...BASE_ENV, ...extra]) if (env[key] !== undefined) out[key] = env[key];
  return out;
}

// A collection item the image does not hold is left out, as the server's runner does.
async function ignoreMissing(promise) {
  try {
    return await promise;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return undefined;
  }
}

/** The work folder: the collection copied in, the environment file written. */
async function prepareWork({ collectionDir, workDir, envName, yml }) {
  await fs.promises.mkdir(workDir, { recursive: true });
  for (const item of L.COLLECTION_DIRS) {
    await ignoreMissing(fs.promises.cp(path.join(collectionDir, item), path.join(workDir, item), { recursive: true }));
  }
  for (const item of L.COLLECTION_FILES) {
    await ignoreMissing(fs.promises.copyFile(path.join(collectionDir, item), path.join(workDir, item)));
  }
  await fs.promises.mkdir(path.join(workDir, L.ENVIRONMENTS_DIR), { recursive: true });
  await fs.promises.mkdir(path.join(workDir, L.REPORTS_DIR), { recursive: true });
  await fs.promises.writeFile(path.join(workDir, L.ENVIRONMENTS_DIR, `${envName}.yml`), yml, { mode: 0o600 });
}

// A run that outlives its deadline ends with this code, as the dispatcher's.
const DEADLINE_CODE = 124;
const KILL_GRACE_MS = 10 * 1000;
// Once the process has exited, how long its output may still take to arrive.
const OUTPUT_DRAIN_MS = 2000;
// Where processes form groups: a run's processes are stopped together.
const GROUPS = process.platform !== 'win32';

/** Stops a process and, where there are groups, every process of its group. */
function stopProcess(child, signal) {
  try {
    if (GROUPS && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { /* already gone */ }
}

/**
 * Starts a process and resolves with its exit code (127 when it cannot start).
 * With `onOutput(stream, chunk)` its stdout ('out') and stderr ('err') are
 * piped there, and it is started in a group of its own, which is stopped once
 * it ends: a process it left behind ends with it. With `deadlineMs` it is
 * stopped after that time, and resolves with DEADLINE_CODE.
 */
function runProcess(command, args, { cwd, env, stdio, log, onOutput, deadlineMs = 0, killGraceMs = KILL_GRACE_MS }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd, env, stdio: onOutput ? ['ignore', 'pipe', 'pipe'] : stdio, shell: false, detached: Boolean(onOutput) && GROUPS,
      });
    } catch (err) {
      log(`[run-pod] ${path.basename(command)} could not start: ${err.message}`);
      resolve(127);
      return;
    }
    let done = false;
    let timedOut = false;
    let deadline = null;
    let drain = null;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      clearTimeout(drain);
      if (onOutput) stopProcess(child, 'SIGKILL');
      resolve(timedOut ? DEADLINE_CODE : code);
    };
    if (onOutput) {
      child.stdout.on('data', (chunk) => onOutput('out', chunk));
      child.stderr.on('data', (chunk) => onOutput('err', chunk));
      // A process left behind may hold the output open: the exit is enough.
      child.on('exit', (code, signal) => {
        drain = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish(code ?? (signal ? 128 : 1));
        }, OUTPUT_DRAIN_MS);
      });
    }
    if (deadlineMs > 0) {
      deadline = setTimeout(() => {
        timedOut = true;
        log(`[run-pod] ${path.basename(command)} stopped: its deadline passed`);
        stopProcess(child, 'SIGTERM');
        setTimeout(() => stopProcess(child, 'SIGKILL'), killGraceMs).unref?.();
      }, deadlineMs);
    }
    child.on('error', (err) => {
      log(`[run-pod] ${path.basename(command)} could not start: ${err.message}`);
      if (done) return;
      done = true;
      clearTimeout(deadline);
      resolve(127);
    });
    child.on('close', (code, signal) => finish(code ?? (signal ? 128 : 1)));
  });
}

// Linux has both flags; where one is missing, the open file is compared with
// what lstat finds under its name.
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const NONBLOCK = fs.constants.O_NONBLOCK || 0;

/**
 * A result file's content, read once from the file opened (never followed as
 * a link, never waited on as a pipe), or { why } it is not sent.
 */
async function readPlainFile(file) {
  let handle;
  try {
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch (err) {
    return { why: err.code === 'ELOOP' ? 'not a plain file' : err.code || err.message };
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) return { why: 'not a plain file' };
    if (!NOFOLLOW) {
      const named = await fs.promises.lstat(file);
      if (named.isSymbolicLink() || named.ino !== st.ino) return { why: 'not a plain file' };
    }
    if (st.size === 0 || st.size > MAX_RESULT_BYTES) return { why: `${st.size} bytes` };
    return { content: await handle.readFile() };
  } finally {
    await handle.close();
  }
}

/**
 * Why a request did not reach the server, in words: fetch says only "fetch
 * failed", its cause says why (ECONNREFUSED, ENOTFOUND, a timeout…).
 */
function reasonOf(err) {
  const cause = err?.cause;
  const code = cause?.code || cause?.errno;
  if (code) return `${err.message} (${code})`;
  if (cause?.message) return `${err.message}: ${cause.message}`;
  return err?.message || String(err);
}

/**
 * PUTs one result file, sending it again while the server cannot take it and
 * the run's pauses last. Resolves with { status } or { failed: reason }.
 */
async function putResult(url, init, { name, fetchImpl, pauses, sleep, log }) {
  for (;;) {
    let reason;
    try {
      const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
      if (!RETRY_STATUSES.has(res.status)) return { status: res.status };
      reason = `HTTP ${res.status}`;
    } catch (err) {
      reason = reasonOf(err);
    }
    const pause = pauses.shift();
    if (pause === undefined) return { failed: reason };
    log(`[run-pod] ${name} not sent yet (${reason}); sent again in ${pause / 1000} s`);
    await sleep(pause);
  }
}

/** Sends the run's result files to the server; returns how many went. */
async function sendResults({ workDir, runId, resultsBase, secret, fetchImpl, log, retryDelaysMs = RETRY_DELAYS_MS, sleep = defaultSleep }) {
  const reports = path.join(workDir, L.REPORTS_DIR);
  let names = [];
  try {
    names = await fs.promises.readdir(reports);
  } catch {
    log('[run-pod] no results folder: nothing sent');
    return 0;
  }
  let sent = 0;
  const pauses = [...retryDelaysMs];
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    if (name === L.MERGE_RESULTS_NAME || L.resultNameProblem(name)) continue;
    const read = await readPlainFile(path.join(reports, name));
    if (read.why) { log(`[run-pod] ${name} not sent: ${read.why}`); continue; }
    const out = await putResult(`${resultsBase}/v1/runs/${runId}/results/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'X-OSCAR-Run-Secret': secret, 'Content-Type': 'application/octet-stream' },
      body: read.content,
      redirect: 'manual',
    }, { name, fetchImpl, pauses, sleep, log });
    if (out.status === 201) {
      sent += 1;
      log(`[run-pod] sent ${name}`);
    } else {
      const why = out.failed || 'HTTP ' + out.status;
      log(`[run-pod] ${name} not sent: ${why}`);
    }
  }
  return sent;
}

function defaultSleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Opens a TCP connection to the address and closes it at once: no request is
 * sent. Resolves once connected, rejects with the error (its `code` set, and
 * ETIMEDOUT after `timeoutMs`).
 */
function tcpConnect(host, port, timeoutMs = CONNECT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(timeoutMs, () => {
      const err = new Error(`no connection in ${timeoutMs / 1000} s`);
      err.code = 'ETIMEDOUT';
      socket.destroy(err);
    });
    socket.once('connect', () => { socket.destroy(); resolve(); });
    socket.once('error', reject);
  });
}

/** The host and port of an http(s) address: IPv6 without its brackets. */
function hostAndPort(base) {
  const url = new URL(base);
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  return { host, port };
}

/**
 * Waits until OSCAR's internal port takes a connection, trying again after
 * each pause while it is not reached (NOT_REACHED). Bruno's first call to
 * OSCAR is the collection's read of the data file, which is not tried again
 * (#1326). Resolves true once reached, false when the pauses are over: Bruno
 * then starts as it would have, and says what it meets.
 */
async function waitForServer({ base, connect = tcpConnect, pauses = CONNECT_RETRY_DELAYS_MS, sleep = defaultSleep, log }) {
  const { host, port } = hostAndPort(base);
  const left = [...pauses];
  let waited = 0;
  for (;;) {
    try {
      await connect(host, port);
      if (waited > 0) log(`[run-pod] OSCAR reached after ${waited / 1000} s`);
      return true;
    } catch (err) {
      const code = err?.code || err?.message || String(err);
      const pause = NOT_REACHED.has(err?.code) ? left.shift() : undefined;
      if (pause === undefined) {
        log(`[run-pod] OSCAR not reached (${code}); bru starts anyway`);
        return false;
      }
      log(`[run-pod] OSCAR not reached yet (${code}); tried again in ${pause / 1000} s`);
      await sleep(pause);
      waited += pause;
    }
  }
}

/**
 * Runs the run in this pod and resolves with the exit code to end with:
 * Bruno's, 2 when the inputs are wrong (nothing started), 127 when Bruno
 * cannot start.
 */
async function runPod({
  env = process.env,
  collectionDir = '/collection',
  workDir = '/work',
  bru = ['bru'],
  node = process.execPath,
  fetchImpl = globalThis.fetch,
  stdio = ['ignore', 'inherit', 'inherit'],
  log = (line) => process.stderr.write(`${line}\n`),
  retryDelaysMs = RETRY_DELAYS_MS,
  sleep = defaultSleep,
  connect = tcpConnect,
  connectRetryDelaysMs = CONNECT_RETRY_DELAYS_MS,
} = {}) {
  const input = runInputs(env);
  if (input.problem) {
    log(`[run-pod] Not started: ${input.problem}.`);
    return 2;
  }
  const { runId, envName, yml, resultsBase } = input;
  await prepareWork({ collectionDir, workDir, envName, yml });
  await waitForServer({ base: resultsBase, connect, pauses: connectRetryDelaysMs, sleep, log });
  log(`[run-pod] started bru in ${runId}`);

  const [bruCommand, ...bruPrefix] = bru;
  const exitCode = await runProcess(bruCommand, [...bruPrefix, ...L.bruRunArgs(envName, runId)],
    { cwd: workDir, env: childEnv(env, RUN_CREDENTIALS), stdio, log });

  // mergeReport.js: Bruno's results under the name it reads, and none of the run's credentials.
  const results = path.join(workDir, L.REPORTS_DIR, L.bruResultsName(runId));
  const merge = path.join(workDir, 'library-bruno', 'mergeReport.js');
  const copied = fs.existsSync(merge)
    && await ignoreMissing(fs.promises.copyFile(results, path.join(workDir, L.REPORTS_DIR, L.MERGE_RESULTS_NAME)).then(() => true));
  if (copied) {
    const mergeCode = await runProcess(node, [merge, envName], { cwd: workDir, env: childEnv(env), stdio, log });
    if (mergeCode !== 0) log(`[run-pod] mergeReport.js ended with ${mergeCode}`);
  }

  const sent = await sendResults({ workDir, runId, resultsBase, secret: env.OSCAR_RUN_SECRET, fetchImpl, log, retryDelaysMs, sleep });
  log(`[run-pod] bru ended with ${exitCode}; ${sent} result file(s) sent`);
  return exitCode;
}

module.exports = {
  runPod, runInputs, childEnv, reasonOf, prepareWork, runProcess, sendResults, ignoreMissing, defaultSleep,
  tcpConnect, hostAndPort, waitForServer,
  RUN_CREDENTIALS, BASE_ENV, RETRY_DELAYS_MS, DEADLINE_CODE, KILL_GRACE_MS,
  NOT_CONNECTED, CONNECT_RETRY_DELAYS_MS, CONNECT_TIMEOUT_MS,
};
