// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * The run dispatcher (run isolation, option 4, #1130): each run in a pod of
 * its own. A small Deployment of its own, the only component with Kubernetes
 * rights: create, watch and delete Jobs and Secrets in the runs' namespace,
 * and read their pods' logs. The server holds no Kubernetes credentials; it
 * asks for a run over the runner agent's protocol (runner-agent/protocol.js,
 * a `run` request with the run's secret token).
 *
 * For each run: a Secret with the run pod's inputs, a Job running the run
 * image once (jobSpec.js), the pod's log streamed back as the run's output,
 * its address once known ({ t: 'pod' }, for the server to bind the run's
 * secret to it), then its exit code. A stop request or a dropped connection
 * deletes the Job; at start, the Jobs and Secrets it made before are removed.
 *
 * Settings (environment):
 *   RUN_AGENT_TOKEN            the secret the server sends (32 characters or more)
 *   RUN_DISPATCHER_HOST/PORT   where to listen (default 0.0.0.0:3002)
 *   RUN_NAMESPACE              the runs' namespace (default: its own)
 *   RUN_IMAGE                  the run image
 *   RUN_RESULTS_URL            the server's internal port, as a run pod reaches it
 *   RUN_SERVICE_ACCOUNT        the run pods' service account (default oscar-run, no rights)
 *   RUN_CPU_REQUEST/LIMIT, RUN_MEMORY_REQUEST/LIMIT  a run pod's resources
 *   RUN_RUNTIME_CLASS          a sandboxed runtime, where the cluster offers one
 *   RUN_DISPATCHER_MAX_RUNS    at most this many runs at once (default 50)
 *   RUN_POD_START_TIMEOUT_MS   how long a pod may take to start (default 5 min)
 *
 * Like the runner agent, it refuses to start while it can see a server
 * secret or the database.
 */

const fs = require('node:fs');
const net = require('node:net');
const P = require('../runner-agent/protocol');
const { SERVER_SECRETS } = require('../runner-agent/agent');
const J = require('./jobSpec');
const { createKubeClient, inClusterConfig } = require('./kube');

const SERVER_DATABASES = Object.freeze(['/app/data/oscar.db']);
// Waiting reasons that do not get better by waiting.
const FAILED_WAITING = new Set(['ErrImagePull', 'ImagePullBackOff', 'InvalidImageName',
  'CreateContainerError', 'CreateContainerConfigError', 'RunContainerError']);
const EXIT_TIMEOUT = 124;       // the Job reached its deadline
const EXIT_NOT_STARTED = 125;   // the pod never ran
const EXIT_STOPPED = 143;       // stopped on the server's word, or the server went away
const NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/** The dispatcher's settings, from its environment. */
function settingsOf(env = process.env) {
  const int = (value, fallback) => Number.parseInt(value || String(fallback), 10) || fallback;
  return {
    token: env.RUN_AGENT_TOKEN || '',
    host: env.RUN_DISPATCHER_HOST || '0.0.0.0',
    port: int(env.RUN_DISPATCHER_PORT, 3002),
    namespace: env.RUN_NAMESPACE || '',
    image: env.RUN_IMAGE || '',
    resultsUrl: env.RUN_RESULTS_URL || '',
    serviceAccount: env.RUN_SERVICE_ACCOUNT || 'oscar-run',
    cpuRequest: env.RUN_CPU_REQUEST || '200m',
    cpuLimit: env.RUN_CPU_LIMIT || '1',
    memoryRequest: env.RUN_MEMORY_REQUEST || '256Mi',
    memoryLimit: env.RUN_MEMORY_LIMIT || '1Gi',
    runtimeClass: env.RUN_RUNTIME_CLASS || '',
    maxRuns: int(env.RUN_DISPATCHER_MAX_RUNS, 50),
    startTimeoutMs: int(env.RUN_POD_START_TIMEOUT_MS, 300000),
  };
}

/** Why the dispatcher may not start with these settings, or null. */
function startupProblem(env = process.env, settings = settingsOf(env), exists = fs.existsSync) {
  if (settings.token.length < P.MIN_TOKEN_LENGTH) return `RUN_AGENT_TOKEN is missing or shorter than ${P.MIN_TOKEN_LENGTH} characters.`;
  if (!settings.image || /\s/.test(settings.image)) return 'RUN_IMAGE does not name the run image.';
  let results;
  try { results = new URL(settings.resultsUrl); } catch { results = null; }
  if (!results || !['http:', 'https:'].includes(results.protocol)) return 'RUN_RESULTS_URL is not the http(s) address of the server\'s internal port.';
  if (!NAME_RE.test(settings.serviceAccount)) return 'RUN_SERVICE_ACCOUNT is not a name.';
  if (settings.namespace && !NAME_RE.test(settings.namespace)) return 'RUN_NAMESPACE is not a name.';
  if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535) return 'RUN_DISPATCHER_PORT is not a port.';
  const held = SERVER_SECRETS.filter((k) => env[k] !== undefined && env[k] !== '');
  if (held.length > 0) return `The dispatcher can see the server's ${held.join(', ')}: give it none of the server's settings.`;
  const seen = [env.OSCAR_DB_PATH, ...SERVER_DATABASES].filter(Boolean).find((p) => exists(p));
  if (seen) return `The dispatcher can see the server's database (${seen}): do not mount the data folder in its pod.`;
  return null;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const ignoreGone = (promise) => promise.catch((err) => { if (err?.status !== 404) throw err; });
const podsOf = async (kube, name) => (await kube.listPods(`job-name=${name}`))?.items || [];
const runStatusOf = (pod) => pod?.status?.containerStatuses?.find((c) => c.name === J.CONTAINER) || pod?.status?.containerStatuses?.[0];

/** The run's pod once it runs or has ended, or { failed } saying why it will not. */
async function waitForPod(kube, name, { pollMs, startTimeoutMs, isStopped }) {
  const until = Date.now() + startTimeoutMs;
  for (;;) {
    if (isStopped()) return { failed: 'stopped' };
    const pod = (await podsOf(kube, name))[0];
    const state = runStatusOf(pod)?.state || {};
    if (state.running || state.terminated) return { pod };
    const waiting = state.waiting?.reason;
    if (waiting && FAILED_WAITING.has(waiting)) return { failed: `${waiting} ${state.waiting.message || ''}`.trim().slice(0, 300) };
    if (pod?.status?.phase === 'Failed') return { failed: String(pod.status.reason || 'the pod failed').slice(0, 300) };
    if (Date.now() > until) {
      return { failed: `the pod did not start within ${Math.round(startTimeoutMs / 1000)} s (${waiting || pod?.status?.phase || 'not scheduled'})` };
    }
    await sleep(pollMs);
  }
}

/** How the run's container ended: { code, reason }. */
async function exitOf(kube, name, podName, { pollMs, tries = 30 }) {
  for (let i = 0; i < tries; i++) {
    const pods = await podsOf(kube, name);
    const pod = pods.find((p) => p.metadata?.name === podName);
    const ended = runStatusOf(pod)?.state?.terminated;
    if (ended) return { code: Number.isInteger(ended.exitCode) ? ended.exitCode : 1, reason: ended.reason || '' };
    if (!pod) break;
    await sleep(pollMs);
  }
  // No pod any more: the Job's conditions say why.
  try {
    const job = await kube.getJob(name);
    const failed = (job?.status?.conditions || []).find((c) => c.type === 'Failed' && c.status === 'True');
    if (failed?.reason === 'DeadlineExceeded') return { code: EXIT_TIMEOUT, reason: 'DeadlineExceeded' };
  } catch { /* the Job is gone too */ }
  return { code: 1, reason: 'the pod ended without an exit code' };
}

/** Removes the Jobs and Secrets the dispatcher made before (a restart ends their runs). */
async function removeLeftovers(kube, log = console) {
  const jobs = (await kube.listJobs(J.MANAGED_SELECTOR))?.items || [];
  const secrets = (await kube.listSecrets(J.MANAGED_SELECTOR))?.items || [];
  await Promise.all([
    ...jobs.map((j) => ignoreGone(kube.deleteJob(j.metadata.name))),
    ...secrets.map((s) => ignoreGone(kube.deleteSecret(s.metadata.name))),
  ]);
  if (jobs.length + secrets.length > 0) log.info?.(`[run-dispatcher] removed ${jobs.length} job(s) and ${secrets.length} secret(s) left from before`);
  return { jobs: jobs.length, secrets: secrets.length };
}

/**
 * The dispatcher's server (not listening yet).
 * @param {{ kube: object, settings: object, log?: object, pollMs?: number }} options
 */
function createDispatcher({ kube, settings, log = console, pollMs = 1000 }) {
  const running = new Set();

  async function removeRun(run) {
    await Promise.all([ignoreGone(kube.deleteJob(run.name)), ignoreGone(kube.deleteSecret(run.name))]).catch((err) => {
      log.warn?.(`[run-dispatcher] ${run.name} not removed: ${err.message}`);
    });
  }

  async function createObjects(run) {
    const secret = J.runSecret({ ...run.request, resultsUrl: settings.resultsUrl });
    try {
      await kube.createSecret(secret);
    } catch (err) {
      if (err?.status !== 409) throw err;
      await removeRun(run);               // a run id is new: what has its name is left from before
      await kube.createSecret(secret);
    }
    const job = await kube.createJob(J.runJob(run.request, settings));
    // The Secret goes with the Job (best effort: the dispatcher removes it too).
    kube.patchSecret(run.name, J.ownedBy(job)).catch(() => {});
  }

  function followLog(podName, send) {
    return kube.followLog(podName, J.CONTAINER).then((stream) => new Promise((resolve) => {
      stream.on('data', (chunk) => send({ t: 'out', d: chunk.toString('utf8') }));
      stream.on('end', resolve);
      stream.on('close', resolve);
      stream.on('error', resolve);
    }));
  }

  async function execute(run, send) {
    await createObjects(run);
    if (run.stopped) return { code: EXIT_STOPPED };
    send({ t: 'started' });
    log.info?.(`[run-dispatcher] started ${run.name}`);
    const started = await waitForPod(kube, run.name, { pollMs, startTimeoutMs: settings.startTimeoutMs, isStopped: () => run.stopped });
    if (started.failed) {
      if (!run.stopped) send({ t: 'err', d: `[run-dispatcher] The run's pod did not start: ${started.failed}\n` });
      return { code: run.stopped ? EXIT_STOPPED : EXIT_NOT_STARTED };
    }
    const podName = started.pod.metadata.name;
    if (started.pod.status?.podIP) send({ t: 'pod', address: started.pod.status.podIP });
    await followLog(podName, send);
    if (run.stopped) return { code: EXIT_STOPPED };
    const ended = await exitOf(kube, run.name, podName, { pollMs });
    if (ended.reason === 'OOMKilled' || ended.reason === 'DeadlineExceeded') {
      send({ t: 'err', d: `[run-dispatcher] The run's pod was stopped: ${ended.reason}\n` });
    }
    return ended;
  }

  return net.createServer((socket) => {
    let run = null;
    const send = (msg) => { if (!socket.destroyed && !socket.writableEnded) socket.write(P.line(msg)); };
    const finish = (msg) => { send(msg); socket.end(); };
    const stop = () => {
      if (!run || run.stopped || run.done) return;
      run.stopped = true;
      void removeRun(run);                // the pod is stopped; its log, then the run, end (removeRun logs its own failure)
    };

    socket.on('data', P.lineReader((text) => {
      let msg;
      try { msg = JSON.parse(text); } catch { return finish({ t: 'refused', reason: 'not JSON' }); }
      if (run) {
        if (P.killSignalOf(msg)) stop();
        return undefined;
      }
      const checked = P.checkRunRequest(msg, { token: settings.token });
      if (!checked.request) return finish({ t: 'refused', reason: checked.reason });
      if (running.size >= settings.maxRuns) return finish({ t: 'refused', reason: 'too many runs' });
      run = { request: checked.request, name: J.jobNameOf(checked.request.runId), stopped: false, done: false };
      running.add(run);
      execute(run, send).then(
        ({ code, reason }) => finish({ t: 'exit', code, signal: null, reason: reason || undefined }),
        (err) => finish({ t: 'refused', reason: `the run could not be dispatched: ${String(err?.message || err).slice(0, 200)}` }),
      ).finally(() => {
        run.done = true;
        running.delete(run);
        return removeRun(run);
      }).catch((err) => log.warn?.(`[run-dispatcher] ${run.name}: ${err?.message || err}`));
      return undefined;
    }, () => finish({ t: 'refused', reason: 'line too long' })));

    // The server went away: the run does not outlive its connection.
    socket.on('close', stop);
    socket.on('error', () => { /* 'close' follows */ });
  });
}

/* istanbul ignore next: the process entry point */
if (require.main === module) {
  const settings = settingsOf(process.env);
  const problem = startupProblem(process.env, settings);
  if (problem) {
    console.error(`[run-dispatcher] Not started: ${problem}`);
    process.exit(1);
  }
  const cluster = inClusterConfig();
  const kube = createKubeClient({
    base: cluster.base, ca: cluster.ca, tokenFile: cluster.tokenFile, namespace: settings.namespace || cluster.ownNamespace,
  });
  removeLeftovers(kube).catch((err) => console.error(`[run-dispatcher] leftovers not removed: ${err.message}`)).finally(() => {
    createDispatcher({ kube, settings }).listen(settings.port, settings.host,
      () => console.log(`[run-dispatcher] listening on ${settings.host}:${settings.port}, runs in ${kube.namespace}`));
  });
}

module.exports = {
  createDispatcher, settingsOf, startupProblem, removeLeftovers, waitForPod, exitOf,
  EXIT_TIMEOUT, EXIT_NOT_STARTED, EXIT_STOPPED,
};
