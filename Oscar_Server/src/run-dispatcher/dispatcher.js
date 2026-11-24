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
 * A kept pod (#1309; part 3 = #1320) goes the same way: a `pod` request, a
 * Secret holding the pod's secret and the internal port's address (nothing of
 * a run), a Job running the same image, whose entrypoint then takes the runs
 * of one batch from the internal port itself (run-pod/keptPod.js). Its log is
 * its own lines, its exit code its own; a kept pod takes a place as a run does.
 *
 * The Kubernetes API may stop answering for a while (#1272: k3s restarting,
 * 27 s on the test machine). A run then waits for it, keeping its place, for
 * up to RUN_DISPATCHER_API_WAIT_MS, and a run already running keeps running:
 * its log resumes once the API answers again. Only past that wait is the run
 * refused. A refusal was immediate before, and the server's queue emptied
 * itself into failures within seconds. Each refusal is logged, with its
 * reason but never the API's own words, which are sent to the server only.
 *
 * Settings (environment):
 *   RUN_AGENT_TOKEN            the secret the server sends (32 characters or more)
 *   RUN_DISPATCHER_HOST/PORT   where to listen (default 0.0.0.0:3002)
 *   RUN_NAMESPACE              the runs' namespace (default: its own)
 *   RUN_IMAGE                  the run image
 *   RUN_RESULTS_URL            the server's internal port, as a run pod reaches it
 *   RUN_SERVICE_ACCOUNT        the run pods' service account (default oscar-run, no rights)
 *   RUN_CPU_REQUEST/LIMIT, RUN_MEMORY_REQUEST/LIMIT  a run pod's resources
 *   RUN_WORK_FOLDERS           memory (default) or disk: where a run pod's work folder and /tmp are kept
 *   RUN_RUNTIME_CLASS          a sandboxed runtime, where the cluster offers one
 *   RUN_DISPATCHER_MAX_RUNS    at most this many runs at once (default 50)
 *   RUN_POD_START_TIMEOUT_MS   how long a pod may take to start (default 5 min)
 *   RUN_DISPATCHER_API_WAIT_MS how long a run waits for the Kubernetes API to answer again (default 2 min)
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
const RETRY_MAX_MS = 8000;      // the longest pause between two tries of the API
const EXIT_TRIES = 30;          // polls for the container's end once its log stream closed
const MAX_RESUMES = 20;         // times a run's log is followed again after being cut
const RESUME_MARGIN_MS = 2000;  // a resumed log starts this much earlier: lines may repeat, none is lost
// What a run, or a kept pod, is called in the lines sent to the server.
const RUN_WORDS = Object.freeze({ pod: "The run's pod", log: "The run's log" });
const KEPT_POD_WORDS = Object.freeze({ pod: 'The kept pod', log: "The kept pod's log" });

// Kubernetes API errors that waiting can cure (#1272): no answer at all (a
// refused, reset or timed-out connection: a system error code), or what the
// API server answers while it starts: 401 and 403 before its access rules are
// loaded, 408, 429 and 5xx (k3s: "apiserver not ready", "starting"). And a
// 409 Conflict (#1276): two writes of one object met, typically the runs'
// quota, which every Job and Secret made updates; nothing was made. Anything
// else (400, 404, 409 AlreadyExists, 422, a fault of the dispatcher's own) is
// final at once.
function isPassing(err) {
  if (Number.isInteger(err?.status)) {
    return [401, 403, 408, 429].includes(err.status) || err.status >= 500 || (err.status === 409 && err.reason === 'Conflict');
  }
  return typeof err?.code === 'string';
}
// What failed, for the dispatcher's own log: a status and its reason word, or
// an error code; never the API's words.
function failureOf(err) {
  if (!Number.isInteger(err?.status)) return String(err?.code || 'error');
  return err.reason ? `HTTP ${err.status} ${err.reason}` : `HTTP ${err.status}`;
}

// The Kubernetes API still failed when the wait was over.
class ApiUnavailable extends Error {
  constructor(waitMs, what, err) {
    const seconds = Math.round(waitMs / 1000);
    super(`the Kubernetes API still failed after ${seconds} s (${what}: ${String(err?.message || err).slice(0, 150)})`);
    this.logText = `the Kubernetes API still failed after ${seconds} s (${what}: ${failureOf(err)})`;
  }
}

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
    // 1 CPU. At 1 a run pod is throttled in a quarter to half of its periods
    // (Bruno starts on several threads), and #1307 tried 2. Measured on a
    // machine of 16 CPUs with 15 runs going (#1310): the same runs a minute
    // at 1 and at 2, pods 2 to 4 s slower to start at 2. With about one run
    // per CPU the machine as a whole is short of CPU: a higher limit moves the
    // wait from the pod's quota to the machine's run queue. 2 may help where
    // far fewer runs go at once than there are CPUs; not measured.
    cpuLimit: env.RUN_CPU_LIMIT || '1',
    memoryRequest: env.RUN_MEMORY_REQUEST || '256Mi',
    memoryLimit: env.RUN_MEMORY_LIMIT || '1Gi',
    workFolders: (env.RUN_WORK_FOLDERS || 'memory').trim().toLowerCase(),
    runtimeClass: env.RUN_RUNTIME_CLASS || '',
    maxRuns: int(env.RUN_DISPATCHER_MAX_RUNS, 50),
    startTimeoutMs: int(env.RUN_POD_START_TIMEOUT_MS, 300000),
    apiWaitMs: int(env.RUN_DISPATCHER_API_WAIT_MS, 120000),
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
  if (!J.WORK_FOLDERS.includes(settings.workFolders)) return `RUN_WORK_FOLDERS is neither ${J.WORK_FOLDERS.join(' nor ')}.`;
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

/**
 * How the Job failed, as { code, reason }, or null while it has not (or is
 * gone). An API that does not answer is not a Job gone (#1272): that error
 * goes up, once the wait for the API is over.
 */
async function jobOutcome(kube, name) {
  let job;
  try {
    job = await kube.getJob(name);
  } catch (err) {
    if (err?.status === 404) return null;
    throw err;
  }
  const failed = (job?.status?.conditions || []).find((c) => c.type === 'Failed' && c.status === 'True');
  if (failed?.reason === 'DeadlineExceeded') return { code: EXIT_TIMEOUT, reason: 'DeadlineExceeded' };
  if (failed) return { code: 1, reason: String(failed.reason || 'the Job failed').slice(0, 300) };
  return null;
}

/**
 * The run's pod once it runs or has ended, { ended } when its Job ended with
 * no pod left to read (a deadline reached before the pod was seen running),
 * or { failed } saying why it will not start.
 */
async function waitForPod(kube, name, { pollMs, startTimeoutMs, isStopped }) {
  const until = Date.now() + startTimeoutMs;
  for (;;) {
    if (isStopped()) return { failed: 'stopped' };
    const pod = (await podsOf(kube, name))[0];
    const state = runStatusOf(pod)?.state || {};
    if (state.running || state.terminated) return { pod };
    if (!pod) {
      const ended = await jobOutcome(kube, name);
      if (ended) return { ended };
    }
    const waiting = state.waiting?.reason;
    if (waiting && FAILED_WAITING.has(waiting)) return { failed: `${waiting} ${state.waiting.message || ''}`.trim().slice(0, 300) };
    if (pod?.status?.phase === 'Failed') return { failed: String(pod.status.reason || 'the pod failed').slice(0, 300) };
    if (Date.now() > until) {
      return { failed: `the pod did not start within ${Math.round(startTimeoutMs / 1000)} s (${waiting || pod?.status?.phase || 'not scheduled'})` };
    }
    await sleep(pollMs);
  }
}

/**
 * How the run's container ended, { code, reason }, once its log stream
 * closed; or { running: true } when it still runs after `tries` polls: the
 * stream was cut, not ended (#1272: the API server went away).
 */
async function exitOf(kube, name, podName, { pollMs, tries = EXIT_TRIES }) {
  let gone = false;
  for (let i = 0; i < tries; i++) {
    const pods = await podsOf(kube, name);
    const pod = pods.find((p) => p.metadata?.name === podName);
    const ended = runStatusOf(pod)?.state?.terminated;
    if (ended) return { code: Number.isInteger(ended.exitCode) ? ended.exitCode : 1, reason: ended.reason || '' };
    if (!pod) {
      gone = true;
      break;
    }
    await sleep(pollMs);
  }
  if (!gone) return { running: true };
  // No pod any more: the Job's conditions say why.
  return (await jobOutcome(kube, name)) || { code: 1, reason: 'the pod ended without an exit code' };
}

// Follows the run's log from sinceTime (null: from its start), until the
// stream closes. True when it was cut (closed without its end: #1272, the
// API server went away). The pod may be gone by the time its log is asked
// (its deadline reached just after it was seen running): nothing more to
// read, and exitOf() then reads how it ended from the Job. Any other
// refusal still ends the run.
function followLog(kube, podName, sinceTime, onData) {
  return kube.followLog(podName, J.CONTAINER, sinceTime).then((stream) => new Promise((resolve) => {
    let ended = false;
    stream.on('data', onData);
    stream.on('end', () => { ended = true; resolve(false); });
    stream.on('close', () => resolve(!ended));
    stream.on('error', () => resolve(!ended));
  }), (err) => {
    if (err?.status !== 404) throw err;
    return false;
  });
}

// Where a cut log resumes: a little before its last output, to the second
// (the API's sinceTime), so that a line may show twice but none is lost.
function resumeFrom(lastOutputAt) {
  const at = Math.floor((lastOutputAt - RESUME_MARGIN_MS) / 1000) * 1000;
  return new Date(at).toISOString().replace('.000Z', 'Z');
}

// How a run, or a kept pod, ended; a pod stopped for its memory or its
// deadline says so to the server.
function endedWith(ended, send, run) {
  if (ended.reason === 'OOMKilled' || ended.reason === 'DeadlineExceeded') {
    send({ t: 'err', d: `[run-dispatcher] ${run.words.pod} was stopped: ${ended.reason}\n` });
  }
  return ended;
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
 * @param {{ kube: object, settings: object, log?: object, pollMs?: number, retryMs?: number }} options
 *   retryMs: the first pause before the API is tried again; it doubles, up to RETRY_MAX_MS.
 */
function createDispatcher({ kube, settings, log = console, pollMs = 1000, retryMs = 500 }) {
  const running = new Set();
  const apiWaitMs = settings.apiWaitMs ?? 120000;

  // One API call of a run, tried again while its failure is one waiting can
  // cure (#1272, #1276), for up to apiWaitMs from its first failure. A stopped
  // run waits no more, except to remove what it made (evenStopped).
  // `since` is the time of the first failure (0: none yet), `pause` the next
  // wait; each try after a failure is a call of its own, at most about twenty.
  async function patiently(run, what, call, { evenStopped = false } = {}, since = 0, pause = retryMs) {
    try {
      const value = await call();
      if (since) log.info?.(`[run-dispatcher] ${run.name}: ${what} went through (after ${Math.round((Date.now() - since) / 1000)} s)`);
      return value;
    } catch (err) {
      if (!isPassing(err) || (run.stopped && !evenStopped)) throw err;
      const now = Date.now();
      if (!since) {
        log.warn?.(`[run-dispatcher] ${run.name}: ${what} failed (${failureOf(err)}); trying again for up to ${Math.round(apiWaitMs / 1000)} s`);
      }
      const first = since || now;
      const left = first + apiWaitMs - now;
      if (left <= 0) throw new ApiUnavailable(apiWaitMs, what, err);
      await sleep(Math.min(pause, left));
      return patiently(run, what, call, { evenStopped }, first, Math.min(pause * 2, RETRY_MAX_MS));
    }
  }

  // The client as one run uses it: each call waits for the API (#1272).
  function clientOf(run, options = {}) {
    const wait = (what, call) => (...args) => patiently(run, what, () => call(...args), options);
    return {
      createSecret: wait('creating the Secret', kube.createSecret),
      patchSecret: wait('linking the Secret to the Job', kube.patchSecret),
      deleteSecret: wait('deleting the Secret', kube.deleteSecret),
      createJob: wait('creating the Job', kube.createJob),
      getJob: wait('reading the Job', kube.getJob),
      deleteJob: wait('deleting the Job', kube.deleteJob),
      listPods: wait('reading the pod', kube.listPods),
      followLog: wait('following the log', kube.followLog),
    };
  }

  async function removeRun(run) {
    const k = clientOf(run, { evenStopped: true });
    await Promise.all([ignoreGone(k.deleteJob(run.name)), ignoreGone(k.deleteSecret(run.name))]).catch((err) => {
      log.warn?.(`[run-dispatcher] ${run.name} not removed: ${err.logText || failureOf(err)}`);
    });
  }

  async function createObjects(run, k) {
    const inputs = { ...run.request, resultsUrl: settings.resultsUrl };
    const secret = run.kept ? J.keptPodSecret(inputs) : J.runSecret(inputs);
    try {
      await k.createSecret(secret);
    } catch (err) {
      // A 409 Conflict was tried again by patiently(): this one says the
      // Secret exists. A run id is new: what has its name is left from
      // before, or a try of this run's that went through unanswered (#1272).
      if (err?.status !== 409) throw err;
      await removeRun(run);
      await k.createSecret(secret);
    }
    const spec = run.kept ? J.keptPodJob(run.request, settings) : J.runJob(run.request, settings);
    const job = await createRunJob(run, k, spec, Date.now() + apiWaitMs);
    // The Secret goes with the Job (best effort: the dispatcher removes it too).
    k.patchSecret(run.name, J.ownedBy(job)).catch(() => {});
  }

  // The run's Job. A 409 that says it exists (AlreadyExists; a Conflict was
  // tried again by patiently()) is this run's own Job, from a try that went
  // through unanswered (#1272): read back. One that then reads 404 is not
  // there after all, and is made again within the API wait, never taken for
  // a refusal (#1276: it read 404 after a quota conflict). The tries go one
  // after the other: a call of its own each time.
  async function createRunJob(run, k, spec, until) {
    try {
      return await k.createJob(spec);
    } catch (err) {
      if (err?.status !== 409) throw err;
    }
    try {
      return await k.getJob(run.name);
    } catch (err) {
      if (err?.status !== 404 || run.stopped || Date.now() >= until) throw err;
    }
    log.warn?.(`[run-dispatcher] ${run.name}: its Job was said to exist, then not found; making it again`);
    await sleep(retryMs);
    return createRunJob(run, k, spec, until);
  }

  // The run's log until its container ends. A log cut while the container
  // runs, or a container that ends while its log is cut (#1272: the API
  // server went away), is read again from a little before its last output:
  // the run goes on, and no line of it is lost.
  async function followToTheEnd(run, k, podName, send) {
    let lastOutputAt = Date.now();
    let sinceTime = null;
    const onData = (chunk) => {
      lastOutputAt = Date.now();
      send({ t: 'out', d: chunk.toString('utf8') });
    };
    for (let reads = 1; ; reads += 1) {
      const cut = await followLog(k, podName, sinceTime, onData);
      if (run.stopped) return { code: EXIT_STOPPED };
      const ended = await exitOf(k, run.name, podName, { pollMs });
      if (!ended.running && !cut) return endedWith(ended, send, run);
      if (reads > MAX_RESUMES) {
        return ended.running ? { code: 1, reason: `the run's log was cut ${reads} times` } : endedWith(ended, send, run);
      }
      sinceTime = resumeFrom(lastOutputAt);
      send({ t: 'err', d: `[run-dispatcher] ${run.words.log} was cut; it is read again from ${sinceTime}: a line may show twice.\n` });
      log.info?.(`[run-dispatcher] ${run.name}: its log was cut, read again from ${sinceTime}`);
    }
  }

  async function execute(run, send) {
    const k = clientOf(run);
    await createObjects(run, k);
    if (run.stopped) return { code: EXIT_STOPPED };
    send({ t: 'started' });
    log.info?.(`[run-dispatcher] started ${run.name}`);
    const started = await waitForPod(k, run.name, { pollMs, startTimeoutMs: settings.startTimeoutMs, isStopped: () => run.stopped });
    if (started.failed) {
      if (!run.stopped) send({ t: 'err', d: `[run-dispatcher] ${run.words.pod} did not start: ${started.failed}\n` });
      return { code: run.stopped ? EXIT_STOPPED : EXIT_NOT_STARTED };
    }
    if (started.ended) return endedWith(started.ended, send, run);
    const podName = started.pod.metadata.name;
    if (started.pod.status?.podIP) send({ t: 'pod', address: started.pod.status.podIP });
    return followToTheEnd(run, k, podName, send);
  }

  return net.createServer((socket) => {
    let run = null;
    const send = (msg) => { if (!socket.destroyed && !socket.writableEnded) socket.write(P.line(msg)); };
    const finish = (msg) => { send(msg); socket.end(); };
    // Every refusal is logged (#1272), in the dispatcher's own words: the
    // API's words go to the server only.
    const refuse = (reason, logText = reason) => {
      const who = run ? `${run.name} ` : '';
      log.warn?.(`[run-dispatcher] ${who}refused: ${logText}`);
      finish({ t: 'refused', reason });
    };
    const stop = () => {
      if (!run || run.stopped || run.done) return;
      run.stopped = true;
      void removeRun(run);                // the pod is stopped; its log, then the run, end (removeRun logs its own failure)
    };

    socket.on('data', P.lineReader((text) => {
      let msg;
      try { msg = JSON.parse(text); } catch { return refuse('not JSON'); }
      if (run) {
        if (P.killSignalOf(msg)) stop();
        return undefined;
      }
      const kept = msg?.kind === P.POD_KIND;
      const checked = kept ? P.checkPodRequest(msg, { token: settings.token }) : P.checkRunRequest(msg, { token: settings.token });
      if (!checked.request) return refuse(checked.reason);
      if (running.size >= settings.maxRuns) return refuse('too many runs');
      run = {
        request: checked.request,
        name: kept ? J.podJobNameOf(checked.request.podId) : J.jobNameOf(checked.request.runId),
        kept,
        words: kept ? KEPT_POD_WORDS : RUN_WORDS,
        stopped: false,
        done: false,
      };
      running.add(run);
      execute(run, send).then(
        ({ code, reason }) => finish({ t: 'exit', code, signal: null, reason: reason || undefined }),
        (err) => {
          // A run stopped while the API did not answer ends as stopped.
          if (run.stopped) return finish({ t: 'exit', code: EXIT_STOPPED, signal: null });
          return refuse(`the run could not be dispatched: ${String(err?.message || err).slice(0, 200)}`,
            `the run could not be dispatched (${err?.logText || failureOf(err)})`);
        },
      ).finally(() => {
        run.done = true;
        running.delete(run);
        return removeRun(run);
      }).catch((err) => log.warn?.(`[run-dispatcher] ${run.name}: ${err?.message || err}`));
      return undefined;
    }, () => refuse('line too long')));

    // The server went away: the run does not outlive its connection.
    socket.on('close', stop);
    socket.on('error', () => { /* 'close' follows */ });
  });
}

/* istanbul ignore next: the process entry point */
if (require.main === module) {
  try {
    require('../utils/secretFiles').loadSecretFiles(process.env, { names: ['RUN_AGENT_TOKEN'] });
  } catch (err) {
    console.error(`[run-dispatcher] Not started: ${err.message}`);
    process.exit(1);
  }
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
  createDispatcher, settingsOf, startupProblem, removeLeftovers, waitForPod, exitOf, isPassing, resumeFrom,
  EXIT_TIMEOUT, EXIT_NOT_STARTED, EXIT_STOPPED,
};
