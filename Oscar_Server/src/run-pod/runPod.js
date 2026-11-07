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
 * the server), runs mergeReport.js, sends the result files and ends with
 * Bruno's exit code. Node only: no dependency, nothing of the server.
 */

const fs = require('node:fs');
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

/** Starts a process and resolves with its exit code (127 when it cannot start). */
function runProcess(command, args, { cwd, env, stdio, log }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, stdio, shell: false });
    } catch (err) {
      log(`[run-pod] ${path.basename(command)} could not start: ${err.message}`);
      resolve(127);
      return;
    }
    child.on('error', (err) => {
      log(`[run-pod] ${path.basename(command)} could not start: ${err.message}`);
      resolve(127);
    });
    child.on('close', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}

/** Sends the run's result files to the server; returns how many went. */
async function sendResults({ workDir, runId, resultsBase, secret, fetchImpl, log }) {
  const reports = path.join(workDir, L.REPORTS_DIR);
  let names = [];
  try {
    names = await fs.promises.readdir(reports);
  } catch {
    log('[run-pod] no results folder: nothing sent');
    return 0;
  }
  let sent = 0;
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    if (name === L.MERGE_RESULTS_NAME || L.resultNameProblem(name)) continue;
    const file = path.join(reports, name);
    const st = await fs.promises.lstat(file);
    if (!st.isFile()) { log(`[run-pod] ${name} not sent: not a plain file`); continue; }
    if (st.size === 0 || st.size > MAX_RESULT_BYTES) { log(`[run-pod] ${name} not sent: ${st.size} bytes`); continue; }
    try {
      const res = await fetchImpl(`${resultsBase}/v1/runs/${runId}/results/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'X-OSCAR-Run-Secret': secret, 'Content-Type': 'application/octet-stream' },
        body: await fs.promises.readFile(file),
        redirect: 'manual',
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (res.status === 201) { sent += 1; log(`[run-pod] sent ${name}`); }
      else log(`[run-pod] ${name} not sent: HTTP ${res.status}`);
    } catch (err) {
      log(`[run-pod] ${name} not sent: ${err.message}`);
    }
  }
  return sent;
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
} = {}) {
  const input = runInputs(env);
  if (input.problem) {
    log(`[run-pod] Not started: ${input.problem}.`);
    return 2;
  }
  const { runId, envName, yml, resultsBase } = input;
  await prepareWork({ collectionDir, workDir, envName, yml });
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

  const sent = await sendResults({ workDir, runId, resultsBase, secret: env.OSCAR_RUN_SECRET, fetchImpl, log });
  log(`[run-pod] bru ended with ${exitCode}; ${sent} result file(s) sent`);
  return exitCode;
}

module.exports = { runPod, runInputs, childEnv, RUN_CREDENTIALS, BASE_ENV };
