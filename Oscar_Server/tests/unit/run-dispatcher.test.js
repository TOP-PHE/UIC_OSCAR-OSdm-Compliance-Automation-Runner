// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * The run dispatcher (src/run-dispatcher, run isolation option 4, #1130),
 * against a stand-in Kubernetes API server: each Job gets a pod that plays a
 * scenario (log lines, an exit code, a pod that cannot pull its image or
 * never starts, a pod stopped for its memory), and deleting a Job stops its
 * pod as a cluster does.
 */

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const { randomUUID, randomBytes } = require('node:crypto');
const P = require('../../src/runner-agent/protocol');
const J = require('../../src/run-dispatcher/jobSpec');
const { createKubeClient, KubeError } = require('../../src/run-dispatcher/kube');
const D = require('../../src/run-dispatcher/dispatcher');
const { SERVER_SECRETS } = require('../../src/runner-agent/agent');

const KUBE_TOKEN = 'kube-token';
const AGENT_TOKEN = randomBytes(24).toString('hex');   // 48 characters

// ── The stand-in API server ──────────────────────────────────────────────────
// scripts: runId -> { lines, exitCode, reason, waiting, pending, hang, vanish, gone, goneAtLog, invalid, answerLost }
// s.down (#1272): while set, the API does not answer: 'reset' closes every
// connection, { status, message } answers that instead.
function fakeApi() {
  const s = { secrets: new Map(), jobs: new Map(), pods: new Map(), logs: new Map(), scripts: new Map(), calls: [], created: { jobs: [], secrets: [] }, down: null };
  const matches = (obj, selector) => selector.split(',').every((pair) => {
    const [k, v] = pair.split('=');
    return (obj.metadata.labels || {})[k] === v;
  });
  const json = (res, status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };

  function endPod(pod, exitCode, reason) {
    const st = pod.status.containerStatuses[0];
    if (st.state.terminated) return;
    st.state = { terminated: { exitCode, reason } };
    pod.status.phase = exitCode === 0 ? 'Succeeded' : 'Failed';
    for (const res of s.logs.get(pod.metadata.name)?.watchers || []) res.end();
  }
  function emit(pod, line) {
    const log = s.logs.get(pod.metadata.name);
    log.lines.push(line);
    for (const res of log.watchers) res.write(line);
  }
  function startPod(job) {
    const runId = job.metadata.labels[J.RUN_ID_LABEL];
    const script = s.scripts.get(runId) || { lines: ['bru output\n'], exitCode: 0 };
    const startsAfterMs = script.startsAfterMs ?? 20;
    if (script.gone) {                          // the Job ended before its pod was ever seen running
      job.status = { conditions: [{ type: 'Failed', status: 'True', reason: script.gone }] };
      return;
    }
    const name = `${job.metadata.name}-x1`;
    const pod = {
      metadata: { name, labels: { 'job-name': job.metadata.name } },
      status: { phase: 'Pending', podIP: '10.1.0.9', containerStatuses: [{ name: J.CONTAINER, state: { waiting: { reason: 'ContainerCreating' } } }] },
    };
    s.pods.set(name, pod);
    s.logs.set(name, { lines: [], watchers: [] });
    if (script.waiting) { pod.status.containerStatuses[0].state = { waiting: { reason: script.waiting, message: 'cannot pull' } }; return; }
    if (script.pending) return;
    setTimeout(() => {
      if (pod.status.containerStatuses[0].state.terminated) return;
      pod.status.phase = 'Running';
      pod.status.containerStatuses[0].state = { running: {} };
      let i = 0;
      const tick = setInterval(() => {
        if (pod.status.containerStatuses[0].state.terminated) { clearInterval(tick); return; }
        if (i < script.lines.length) { emit(pod, script.lines[i]); i += 1; return; }
        clearInterval(tick);
        if (script.hang) return;
        if (script.vanish) {                      // the Job's deadline: the pod is removed
          for (const res of s.logs.get(name).watchers) res.end();
          s.pods.delete(name);
          job.status = { conditions: [{ type: 'Failed', status: 'True', reason: 'DeadlineExceeded' }] };
          return;
        }
        endPod(pod, script.exitCode, script.reason || (script.exitCode === 0 ? 'Completed' : 'Error'));
      }, 5);
    }, startsAfterMs);
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      s.calls.push(`${req.method} ${req.url}`);
      if (s.down === 'reset') return req.socket.destroy();
      if (s.down) return json(res, s.down.status, { message: s.down.message });
      if (req.headers.authorization !== `Bearer ${KUBE_TOKEN}`) return json(res, 401, { message: 'Unauthorized' });
      const body = raw ? JSON.parse(raw) : null;
      const url = new URL(req.url, 'http://api');
      const parts = url.pathname.split('/').filter(Boolean);
      const at = parts.indexOf('namespaces');                  // …/namespaces/<ns>/<kind>[/<name>[/log]]
      const kind = parts[at + 2];
      const name = parts[at + 3] === undefined ? null : decodeURIComponent(parts[at + 3]);
      const selector = url.searchParams.get('labelSelector');
      const store = { secrets: s.secrets, jobs: s.jobs, pods: s.pods }[kind];
      if (parts.at(-1) === 'log') {
        const podName = decodeURIComponent(parts.at(-2));
        const pod = s.pods.get(podName);
        const job = pod && s.jobs.get(pod.metadata.labels['job-name']);
        if (job && s.scripts.get(job.metadata.labels[J.RUN_ID_LABEL])?.goneAtLog) {
          // The deadline falls between the pod seen running and its log asked.
          s.pods.delete(podName);
          job.status = { conditions: [{ type: 'Failed', status: 'True', reason: 'DeadlineExceeded' }] };
        }
        if (!s.pods.has(podName)) return json(res, 404, { message: 'no pod' });
        res.statusCode = 200;
        const log = s.logs.get(podName);
        for (const line of log.lines) res.write(line);
        if (pod.status.containerStatuses[0].state.terminated) return res.end();
        log.watchers.push(res);
        return undefined;
      }
      if (req.method === 'POST') {
        if (store.has(body.metadata.name)) return json(res, 409, { message: 'already exists' });
        const script = s.scripts.get(body.metadata.labels?.[J.RUN_ID_LABEL]);
        if (kind === 'jobs' && script?.invalid) return json(res, 422, { message: `Job.batch "${body.metadata.name}" is invalid` });
        // #1276: the runs' quota updated by two creations at once; nothing made.
        if (script?.conflicts?.[kind] > 0) {
          script.conflicts[kind] -= 1;
          return json(res, 409, {
            kind: 'Status', reason: 'Conflict',
            message: 'Operation cannot be fulfilled on resourcequotas "oscar-runs": the object has been modified; please apply your changes to the latest version and try again',
          });
        }
        // Said to exist, yet not made (then read 404).
        if (kind === 'jobs' && script?.saidToExist > 0) {
          script.saidToExist -= 1;
          return json(res, 409, { kind: 'Status', reason: 'AlreadyExists', message: `jobs.batch "${body.metadata.name}" already exists` });
        }
        const obj = { ...body, metadata: { ...body.metadata, uid: randomUUID() }, status: {} };
        store.set(obj.metadata.name, obj);
        s.created[kind].push(body);
        if (kind === 'jobs') startPod(obj);
        if (kind === 'jobs' && script?.answerLost && !script.lost) {
          script.lost = true;                   // made, but its answer never arrives
          return req.socket.destroy();
        }
        return json(res, 201, obj);
      }
      if (req.method === 'GET' && !name) return json(res, 200, { items: [...store.values()].filter((o) => !selector || matches(o, selector)) });
      const obj = store.get(name);
      if (!obj) return json(res, 404, { message: 'not found' });
      if (req.method === 'GET') return json(res, 200, obj);
      if (req.method === 'PATCH') { Object.assign(obj.metadata, body.metadata); return json(res, 200, obj); }
      if (req.method === 'DELETE') {
        store.delete(name);
        if (kind === 'jobs') {
          for (const pod of [...s.pods.values()].filter((p) => p.metadata.labels['job-name'] === name)) {
            endPod(pod, 143, 'Error');
            setTimeout(() => s.pods.delete(pod.metadata.name), 30);
          }
        }
        return json(res, 200, { status: 'Success' });
      }
      return json(res, 405, { message: 'no' });
    });
  });
  const podOf = (runId) => s.pods.get(`${J.jobNameOf(runId)}-x1`);
  return {
    s,
    server,
    // The API server goes away: every log being followed is cut, not ended.
    cut() {
      for (const log of s.logs.values()) {
        for (const res of log.watchers) res.destroy();
        log.watchers.length = 0;
      }
    },
    emitTo: (runId, line) => emit(podOf(runId), line),
    endRun: (runId, exitCode) => endPod(podOf(runId), exitCode, exitCode === 0 ? 'Completed' : 'Error'),
  };
}

// ── Set-up ───────────────────────────────────────────────────────────────────
let api;
let dispatcher;
let port;
const settings = D.settingsOf({
  RUN_AGENT_TOKEN: AGENT_TOKEN,
  RUN_IMAGE: 'registry.example.org/oscar/oscar-run:ci',
  RUN_RESULTS_URL: 'http://oscar-internal:3003',
  RUN_DISPATCHER_MAX_RUNS: '2',
  RUN_POD_START_TIMEOUT_MS: '400',
});
beforeAll(async () => {
  api = fakeApi();
  await new Promise((resolve) => api.server.listen(0, '127.0.0.1', resolve));
  const kube = createKubeClient({ base: `http://127.0.0.1:${api.server.address().port}`, token: KUBE_TOKEN, namespace: 'oscar-runs' });
  dispatcher = D.createDispatcher({ kube, settings, log: {}, pollMs: 10 });
  await new Promise((resolve) => dispatcher.listen(0, '127.0.0.1', resolve));
  port = dispatcher.address().port;
});
afterAll(async () => {
  await new Promise((resolve) => dispatcher.close(resolve));
  api.server.closeAllConnections?.();
  await new Promise((resolve) => api.server.close(resolve));
});

function runRequest(over = {}) {
  return {
    v: P.VERSION, token: AGENT_TOKEN, kind: 'run', runId: randomUUID(), envName: 'OTST_acme_1a2b3c4d_Env',
    envYml: Buffer.from('name: x\n').toString('base64'), deadlineSeconds: 600,
    env: { OSCAR_RUN_SECRET: randomBytes(32).toString('hex'), OSCAR_ACCESS_TOKEN: 'provider-token', ENCRYPTION_KEY: 'dropped' },
    ...over,
  };
}
// Sends a request; resolves with the messages once the dispatcher ends the connection.
function ask(msg, { onMessage, socketRef, at = port } = {}) {
  return new Promise((resolve) => {
    const messages = [];
    const socket = net.connect(at, '127.0.0.1', () => socket.write(P.line(msg)));
    if (socketRef) socketRef.socket = socket;
    socket.on('data', P.lineReader((text) => {
      const m = JSON.parse(text);
      messages.push(m);
      onMessage?.(m, socket);
    }, () => {}));
    socket.on('close', () => resolve(messages));
    socket.on('error', () => {});
  });
}
const out = (messages) => messages.filter((m) => m.t === 'out').map((m) => m.d).join('');
const last = (messages) => messages[messages.length - 1];
async function until(check, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ── A run ────────────────────────────────────────────────────────────────────
describe('a run in a pod of its own', () => {
  test('its pod\'s log is the run\'s output, its address is given, and its exit code ends it', async () => {
    const req = runRequest();
    api.s.scripts.set(req.runId, { lines: ['line 1\n', 'line 2\n'], exitCode: 3 });
    const messages = await ask(req);
    expect(messages[0]).toEqual({ t: 'started' });
    expect(messages).toContainEqual({ t: 'pod', address: '10.1.0.9' });
    expect(out(messages)).toBe('line 1\nline 2\n');
    expect(last(messages)).toMatchObject({ t: 'exit', code: 3 });
    const name = J.jobNameOf(req.runId);
    await until(() => !api.s.jobs.has(name) && !api.s.secrets.has(name));
  });

  test('the Secret holds the run\'s inputs and its credentials only; the Job is held tight', async () => {
    const req = runRequest();
    await ask(req);
    const secret = api.s.created.secrets.find((x) => x.metadata.name === J.jobNameOf(req.runId));
    expect(secret.stringData).toEqual({
      OSCAR_RUN_SECRET: req.env.OSCAR_RUN_SECRET, OSCAR_ACCESS_TOKEN: 'provider-token',
      OSCAR_RUN_ID: req.runId, OSCAR_ENV_NAME: req.envName, OSCAR_RUN_ENV_YML: req.envYml,
      OSCAR_RESULTS_URL: 'http://oscar-internal:3003',
    });
    const job = api.s.created.jobs.find((x) => x.metadata.name === J.jobNameOf(req.runId));
    expect(job.spec).toMatchObject({ backoffLimit: 0, activeDeadlineSeconds: 600 + J.DEADLINE_MARGIN_S, ttlSecondsAfterFinished: J.TTL_AFTER_FINISHED_S });
    const pod = job.spec.template.spec;
    expect(pod).toMatchObject({ restartPolicy: 'Never', automountServiceAccountToken: false, enableServiceLinks: false, serviceAccountName: 'oscar-run' });
    expect(pod.securityContext).toEqual({ runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } });
    const [c] = pod.containers;
    expect(c.image).toBe('registry.example.org/oscar/oscar-run:ci');
    expect(c.securityContext).toEqual({ allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } });
    expect(c.envFrom).toEqual([{ secretRef: { name: J.jobNameOf(req.runId) } }]);
    expect(c.env).toBeUndefined();
    // #1307: 2 CPUs at most, and both folders in memory, each with its size.
    expect(c.resources).toEqual({ requests: { cpu: '200m', memory: '256Mi' }, limits: { cpu: '2', memory: '1Gi' } });
    expect(c.volumeMounts).toEqual([{ name: 'work', mountPath: '/work' }, { name: 'tmp', mountPath: '/tmp' }]);
    expect(pod.volumes).toEqual([
      { name: 'work', emptyDir: { medium: 'Memory', sizeLimit: '256Mi' } },
      { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '64Mi' } },
    ]);
    expect(pod.runtimeClassName).toBeUndefined();
    expect(api.s.calls).toContain(`PATCH /api/v1/namespaces/oscar-runs/secrets/${J.jobNameOf(req.runId)}`);
  });

  test('a stop request deletes the Job, and the run ends as stopped', async () => {
    const req = runRequest();
    api.s.scripts.set(req.runId, { lines: ['working\n'], hang: true });
    const messages = await ask(req, {
      onMessage: (m, socket) => { if (m.t === 'out') socket.write(P.line({ t: 'kill', signal: 'SIGTERM' })); },
    });
    expect(last(messages)).toMatchObject({ t: 'exit', code: D.EXIT_STOPPED });
    expect(api.s.jobs.has(J.jobNameOf(req.runId))).toBe(false);
  });

  test('a connection that drops deletes the run\'s Job', async () => {
    const req = runRequest();
    api.s.scripts.set(req.runId, { lines: ['working\n'], hang: true });
    const ref = {};
    const done = ask(req, { socketRef: ref, onMessage: (m, socket) => { if (m.t === 'out') socket.destroy(); } });
    await done;
    await until(() => !api.s.jobs.has(J.jobNameOf(req.runId)));
    expect(api.s.jobs.has(J.jobNameOf(req.runId))).toBe(false);
    expect(api.s.secrets.has(J.jobNameOf(req.runId))).toBe(false);
  });

  test('a pod that cannot pull its image ends the run at once, saying so', async () => {
    const req = runRequest();
    api.s.scripts.set(req.runId, { waiting: 'ImagePullBackOff' });
    const messages = await ask(req);
    expect(messages.find((m) => m.t === 'err').d).toContain('did not start: ImagePullBackOff');
    expect(last(messages)).toMatchObject({ t: 'exit', code: D.EXIT_NOT_STARTED });
  });

  test('a pod that never starts ends the run after the start timeout', async () => {
    const req = runRequest();
    api.s.scripts.set(req.runId, { pending: true });
    const messages = await ask(req);
    expect(messages.find((m) => m.t === 'err').d).toMatch(/did not start within/);
    expect(last(messages)).toMatchObject({ t: 'exit', code: D.EXIT_NOT_STARTED });
  });

  test('a pod stopped for its memory says so', async () => {
    const req = runRequest();
    api.s.scripts.set(req.runId, { lines: ['big\n'], exitCode: 137, reason: 'OOMKilled' });
    const messages = await ask(req);
    expect(messages.some((m) => m.t === 'err' && m.d.includes('OOMKilled'))).toBe(true);
    expect(last(messages)).toMatchObject({ t: 'exit', code: 137, reason: 'OOMKilled' });
  });

  test('a run that reached its deadline ends with 124', async () => {
    const req = runRequest();
    api.s.scripts.set(req.runId, { lines: ['slow\n'], vanish: true });
    const messages = await ask(req);
    expect(last(messages)).toMatchObject({ t: 'exit', code: D.EXIT_TIMEOUT, reason: 'DeadlineExceeded' });
  });

  test('a pod gone between being seen running and its log being asked ends as its Job says, not as refused', async () => {
    const req = runRequest();
    api.s.scripts.set(req.runId, { lines: [], hang: true, goneAtLog: true });
    const messages = await ask(req);
    expect(messages.some((m) => m.t === 'refused')).toBe(false);
    expect(messages.some((m) => m.t === 'err' && m.d.includes('stopped: DeadlineExceeded'))).toBe(true);
    expect(last(messages)).toMatchObject({ t: 'exit', code: D.EXIT_TIMEOUT, reason: 'DeadlineExceeded' });
  });

  test('a Job past its deadline before its pod was seen running ends with 124, not as never started', async () => {
    const req = runRequest();
    api.s.scripts.set(req.runId, { gone: 'DeadlineExceeded' });
    const messages = await ask(req);
    expect(messages.some((m) => m.t === 'err' && m.d.includes('stopped: DeadlineExceeded'))).toBe(true);
    expect(last(messages)).toMatchObject({ t: 'exit', code: D.EXIT_TIMEOUT, reason: 'DeadlineExceeded' });
  });

  test('a Job failed otherwise with no pod left ends with 1 and its reason', async () => {
    const req = runRequest();
    api.s.scripts.set(req.runId, { gone: 'BackoffLimitExceeded' });
    const messages = await ask(req);
    expect(last(messages)).toMatchObject({ t: 'exit', code: 1, reason: 'BackoffLimitExceeded' });
  });
});

// ── Refusals ─────────────────────────────────────────────────────────────────
describe('what the dispatcher refuses', () => {
  test.each([
    ['another token', { token: 'x'.repeat(48) }, 'not authorised'],
    ['the runner agent\'s kind', { kind: 'bru' }, 'unknown kind'],
    ['a run id that is not one', { runId: '../x' }, 'not a run id'],
    ['an environment name with a folder', { envName: '../env' }, 'not an environment name'],
    ['an environment file that is not base64', { envYml: 'not base64!' }, 'environment file refused'],
    ['a deadline out of range', { deadlineSeconds: 5 }, 'deadline refused'],
    ['no run secret', { env: { OSCAR_ACCESS_TOKEN: 't' } }, 'environment refused'],
  ])('%s', async (_what, over, reason) => {
    const before = api.s.created.jobs.length;
    const messages = await ask(runRequest(over));
    expect(messages).toEqual([{ t: 'refused', reason }]);
    expect(api.s.created.jobs.length).toBe(before);
  });

  test('more runs than its limit', async () => {
    const a = runRequest();
    const b = runRequest();
    api.s.scripts.set(a.runId, { lines: ['a\n'], hang: true });
    api.s.scripts.set(b.runId, { lines: ['b\n'], hang: true });
    const sockets = [];
    const keep = (m, socket) => { if (m.t === 'started') sockets.push(socket); };
    const running = [ask(a, { onMessage: keep }), ask(b, { onMessage: keep })];
    await until(() => sockets.length === 2);
    expect(await ask(runRequest())).toEqual([{ t: 'refused', reason: 'too many runs' }]);
    for (const socket of sockets) socket.destroy();
    await Promise.all(running);
  });

  test('the runner agent refuses a run request', () => {
    expect(P.checkRequest(runRequest(), { token: AGENT_TOKEN, workspacesDir: os.tmpdir() })).toEqual({ reason: 'unknown kind' });
  });
});

// ── When the Kubernetes API does not answer (#1272) ──────────────────────────
describe('when the Kubernetes API does not answer (#1272)', () => {
  let patient;
  let patientPort;
  let logged;
  const WAIT_MS = 600;
  jest.setTimeout(20000);      // a busy machine stretches the outages these tests play
  beforeAll(async () => {
    const kube = createKubeClient({ base: `http://127.0.0.1:${api.server.address().port}`, token: KUBE_TOKEN, namespace: 'oscar-runs' });
    const log = { info: (line) => logged.push(['info', line]), warn: (line) => logged.push(['warn', line]) };
    patient = D.createDispatcher({
      kube,
      settings: D.settingsOf({
        RUN_AGENT_TOKEN: AGENT_TOKEN, RUN_IMAGE: 'registry.example.org/oscar/oscar-run:ci', RUN_RESULTS_URL: 'http://oscar-internal:3003',
        RUN_POD_START_TIMEOUT_MS: '3000', RUN_DISPATCHER_API_WAIT_MS: String(WAIT_MS),
      }),
      log, pollMs: 10, retryMs: 10,
    });
    await new Promise((resolve) => patient.listen(0, '127.0.0.1', resolve));
    patientPort = patient.address().port;
  });
  beforeEach(() => { logged = []; });
  afterEach(() => { api.s.down = null; });
  afterAll(async () => { await new Promise((resolve) => patient.close(resolve)); });
  const askPatient = (msg, options = {}) => ask(msg, { ...options, at: patientPort });
  const warnings = () => logged.filter(([level]) => level === 'warn').map(([, line]) => line);
  const after = (ms, act) => setTimeout(act, ms);

  test('the wait is 2 minutes unless set', () => {
    expect(D.settingsOf({}).apiWaitMs).toBe(120000);
    expect(D.settingsOf({ RUN_DISPATCHER_API_WAIT_MS: '30000' }).apiWaitMs).toBe(30000);
  });

  test.each([
    ['no connection', Object.assign(new Error('connect ECONNREFUSED 10.43.0.1:443'), { code: 'ECONNREFUSED' }), true],
    ['a reset connection', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), true],
    ['no answer in time', Object.assign(new Error('the API server did not answer in time'), { code: 'ETIMEDOUT' }), true],
    ['k3s starting (503)', { status: 503, message: 'apiserver not ready' }, true],
    ['500', { status: 500 }, true],
    ['429', { status: 429 }, true],
    ['401 while the API starts', { status: 401 }, true],
    ['403 while the API starts', { status: 403 }, true],
    ['400', { status: 400 }, false],
    ['404', { status: 404 }, false],
    ['409', { status: 409 }, false],
    ['409 Conflict (two writes of the quota met, #1276)', { status: 409, reason: 'Conflict' }, true],
    ['409 AlreadyExists', { status: 409, reason: 'AlreadyExists' }, false],
    ['422', { status: 422 }, false],
    ['a fault of its own', new TypeError('x is not a function'), false],
  ])('%s: waiting can cure it = %s', (_what, err, passing) => {
    expect(D.isPassing(err)).toBe(passing);
  });

  test('a log resumes a little before its last output, to the second', () => {
    expect(D.resumeFrom(Date.parse('2026-11-15T15:53:07.900Z'))).toBe('2026-11-15T15:53:05Z');
  });

  test('a run asked while k3s starts (503) waits, then runs to its end', async () => {
    const req = runRequest();
    api.s.scripts.set(req.runId, { lines: ['line 1\n'], exitCode: 0 });
    api.s.down = { status: 503, message: 'apiserver not ready' };
    after(150, () => { api.s.down = null; });
    const messages = await askPatient(req);
    expect(messages.some((m) => m.t === 'refused')).toBe(false);
    expect(messages[0]).toEqual({ t: 'started' });
    expect(out(messages)).toBe('line 1\n');
    expect(last(messages)).toMatchObject({ t: 'exit', code: 0 });
    expect(warnings()).toContain(`[run-dispatcher] ${J.jobNameOf(req.runId)}: creating the Secret failed (HTTP 503); trying again for up to 1 s`);
    expect(logged.some(([level, line]) => level === 'info' && line.includes('creating the Secret went through (after'))).toBe(true);
  });

  test('connections reset while the pod is awaited: the run waits, then runs to its end', async () => {
    const req = runRequest();
    // The pod starts well after the outage: the dispatcher is still awaiting it then.
    api.s.scripts.set(req.runId, { lines: ['line 1\n'], exitCode: 4, startsAfterMs: 1500 });
    const messages = await askPatient(req, {
      onMessage: (m) => {
        if (m.t !== 'started') return;
        api.s.down = 'reset';
        after(150, () => { api.s.down = null; });
      },
    });
    expect(messages.some((m) => m.t === 'refused')).toBe(false);
    expect(out(messages)).toBe('line 1\n');
    expect(last(messages)).toMatchObject({ t: 'exit', code: 4 });
    expect(warnings().some((line) => line.includes('reading the pod failed (ECONNRESET)'))).toBe(true);
  });

  test('a run that ends while its log is cut: its last lines are read once the API answers', async () => {
    const req = runRequest();
    api.s.scripts.set(req.runId, { lines: ['before\n'], hang: true });
    let cut = false;
    const messages = await askPatient(req, {
      onMessage: (m) => {
        if (m.t !== 'out' || cut) return;
        cut = true;
        api.s.down = 'reset';
        api.cut();
        after(100, () => { api.s.down = null; });
        after(150, () => { api.emitTo(req.runId, 'after\n'); api.endRun(req.runId, 0); });
      },
    });
    expect(messages.some((m) => m.t === 'refused')).toBe(false);
    expect(out(messages)).toContain('after\n');
    expect(messages.some((m) => m.t === 'err' && /log was cut while its pod runs|log was cut/.test(m.d))).toBe(true);
    expect(api.s.calls.some((c) => c.includes('/log?') && c.includes('sinceTime='))).toBe(true);
    expect(last(messages)).toMatchObject({ t: 'exit', code: 0 });
  });

  test('a run still running when its log is cut keeps running: its log resumes, its Job is not deleted', async () => {
    const req = runRequest();
    const name = J.jobNameOf(req.runId);
    api.s.scripts.set(req.runId, { lines: ['before\n'], hang: true });
    let cut = false;
    let jobKept = null;
    // Once the dispatcher follows the log again, the run goes on and ends.
    const goOn = async () => {
      await until(() => api.s.logs.get(`${name}-x1`).watchers.length === 1, 10000);
      jobKept = api.s.jobs.has(name);
      api.emitTo(req.runId, 'after\n');
      api.endRun(req.runId, 0);
    };
    const messages = await askPatient(req, {
      onMessage: (m) => {
        if (m.t !== 'out' || cut) return;
        cut = true;
        api.s.down = 'reset';
        api.cut();
        after(50, () => {
          api.s.down = null;
          goOn().catch(() => {});
        });
      },
    });
    expect(jobKept).toBe(true);
    expect(out(messages)).toContain('after\n');
    expect(messages.filter((m) => m.t === 'err' && m.d.includes('log was cut'))).toHaveLength(1);
    expect(last(messages)).toMatchObject({ t: 'exit', code: 0 });
    expect(logged.some(([, line]) => line.includes(`${name}: its log was cut, read again from`))).toBe(true);
  });

  test('past the wait the run is refused, saying why; the log names it without the API\'s words', async () => {
    const req = runRequest();
    const name = J.jobNameOf(req.runId);
    api.s.down = { status: 503, message: 'apiserver not ready' };
    const started = Date.now();
    const messages = await askPatient(req);
    expect(Date.now() - started).toBeGreaterThanOrEqual(WAIT_MS - 20);
    expect(messages).toEqual([{
      t: 'refused',
      reason: 'the run could not be dispatched: the Kubernetes API still failed after 1 s (creating the Secret: apiserver not ready)',
    }]);
    expect(warnings()).toContain(`[run-dispatcher] ${name} refused: the run could not be dispatched (the Kubernetes API still failed after 1 s (creating the Secret: HTTP 503))`);
    expect(logged.some(([, line]) => line.includes('apiserver not ready'))).toBe(false);
  });

  test('an error waiting cannot cure refuses the run at once, and what it made is removed', async () => {
    const req = runRequest();
    const name = J.jobNameOf(req.runId);
    api.s.scripts.set(req.runId, { invalid: true });
    const messages = await askPatient(req);
    expect(messages).toEqual([{ t: 'refused', reason: `the run could not be dispatched: Job.batch "${name}" is invalid` }]);
    expect(warnings()).toContain(`[run-dispatcher] ${name} refused: the run could not be dispatched (HTTP 422)`);
    expect(warnings().some((line) => line.includes(`${name}: `) && line.includes('trying again'))).toBe(false);
    await until(() => !api.s.secrets.has(name));
  });

  test('a Job made by a try whose answer was lost is taken, not made twice', async () => {
    const req = runRequest();
    const name = J.jobNameOf(req.runId);
    api.s.scripts.set(req.runId, { lines: ['once\n'], exitCode: 0, answerLost: true });
    const messages = await askPatient(req);
    expect(last(messages)).toMatchObject({ t: 'exit', code: 0 });
    expect(out(messages)).toBe('once\n');
    expect(api.s.created.jobs.filter((j) => j.metadata.name === name)).toHaveLength(1);
    expect(api.s.calls).toContain(`GET /apis/batch/v1/namespaces/oscar-runs/jobs/${name}`);
  });

  test('a run stopped while the API does not answer ends as stopped, and its Job is removed once it answers', async () => {
    const req = runRequest();
    const name = J.jobNameOf(req.runId);
    api.s.scripts.set(req.runId, { lines: ['working\n'], hang: true });
    let stopped = false;
    const messages = await askPatient(req, {
      onMessage: (m, socket) => {
        if (m.t !== 'out' || stopped) return;
        stopped = true;
        api.s.down = 'reset';
        api.cut();
        after(30, () => socket.write(P.line({ t: 'kill', signal: 'SIGTERM' })));
        after(200, () => { api.s.down = null; });
      },
    });
    expect(last(messages)).toMatchObject({ t: 'exit', code: D.EXIT_STOPPED });
    await until(() => !api.s.jobs.has(name) && !api.s.secrets.has(name));
  });

  test('the request refusals are logged too', async () => {
    const messages = await askPatient(runRequest({ token: 'x'.repeat(48) }));
    expect(messages).toEqual([{ t: 'refused', reason: 'not authorised' }]);
    expect(warnings()).toContain('[run-dispatcher] refused: not authorised');
  });

  // #1276: on the k3s test machine a run was refused with 'jobs.batch "…" not
  // found': its Job's creation met another write of the runs' quota (409
  // Conflict, nothing made), read as "its own Job exists", then read 404.
  test('a 409 Conflict on the Job is tried again: one Job is made, and the run goes to its end', async () => {
    const req = runRequest();
    const name = J.jobNameOf(req.runId);
    api.s.scripts.set(req.runId, { lines: ['line 1\n'], exitCode: 0, conflicts: { jobs: 2 } });
    const messages = await askPatient(req);
    expect(messages.some((m) => m.t === 'refused')).toBe(false);
    expect(last(messages)).toMatchObject({ t: 'exit', code: 0 });
    expect(api.s.created.jobs.filter((j) => j.metadata.name === name)).toHaveLength(1);
    expect(warnings()).toContain(`[run-dispatcher] ${name}: creating the Job failed (HTTP 409 Conflict); trying again for up to 1 s`);
    expect(api.s.calls).not.toContain(`GET /apis/batch/v1/namespaces/oscar-runs/jobs/${name}`);
  });

  test('a 409 Conflict on the Secret is tried again, never taken for a Secret left from before', async () => {
    const req = runRequest();
    const name = J.jobNameOf(req.runId);
    api.s.scripts.set(req.runId, { lines: ['line 1\n'], exitCode: 0, conflicts: { secrets: 1 } });
    const messages = await askPatient(req);
    expect(last(messages)).toMatchObject({ t: 'exit', code: 0 });
    expect(warnings()).toContain(`[run-dispatcher] ${name}: creating the Secret failed (HTTP 409 Conflict); trying again for up to 1 s`);
    // A Secret left from before would be removed first: a conflict removes
    // nothing, so the Secret is deleted once, when the run ends.
    await until(() => !api.s.secrets.has(name));
    expect(api.s.calls.filter((c) => c === `DELETE /api/v1/namespaces/oscar-runs/secrets/${name}`)).toHaveLength(1);
  });

  test('a Job said to exist that then reads 404 is made again, not a refusal', async () => {
    const req = runRequest();
    const name = J.jobNameOf(req.runId);
    api.s.scripts.set(req.runId, { lines: ['line 1\n'], exitCode: 0, saidToExist: 1 });
    const messages = await askPatient(req);
    expect(messages.some((m) => m.t === 'refused')).toBe(false);
    expect(last(messages)).toMatchObject({ t: 'exit', code: 0 });
    expect(api.s.created.jobs.filter((j) => j.metadata.name === name)).toHaveLength(1);
    expect(warnings()).toContain(`[run-dispatcher] ${name}: its Job was said to exist, then not found; making it again`);
  });

  test('a Job said to exist and never found is refused once the wait is over', async () => {
    const req = runRequest();
    api.s.scripts.set(req.runId, { lines: ['line 1\n'], exitCode: 0, saidToExist: 1000 });
    const started = Date.now();
    const messages = await askPatient(req);
    expect(Date.now() - started).toBeGreaterThanOrEqual(WAIT_MS - 20);
    expect(messages).toEqual([{ t: 'refused', reason: 'the run could not be dispatched: not found' }]);
  });

  test('the reason of an answer is kept when it is one word of the API, dropped otherwise', () => {
    expect(new KubeError(409, 'x', 'Conflict').reason).toBe('Conflict');
    expect(new KubeError(409, 'x', 'AlreadyExists').reason).toBe('AlreadyExists');
    expect(new KubeError(409, 'x', 'the object <b>has</b> been modified').reason).toBeNull();
    expect(new KubeError(409, 'x', { reason: 'Conflict' }).reason).toBeNull();
    expect(new KubeError(500, 'x').reason).toBeNull();
  });
});

// ── Start-up ─────────────────────────────────────────────────────────────────
describe('start-up', () => {
  test('the Jobs and Secrets it made before are removed, nothing else', async () => {
    api.s.jobs.set('oscar-run-old', { metadata: { name: 'oscar-run-old', labels: { ...J.LABELS } }, status: {} });
    api.s.secrets.set('oscar-run-old', { metadata: { name: 'oscar-run-old', labels: { ...J.LABELS } } });
    api.s.secrets.set('someone-else', { metadata: { name: 'someone-else', labels: { app: 'other' } } });
    const kube = createKubeClient({ base: `http://127.0.0.1:${api.server.address().port}`, token: KUBE_TOKEN, namespace: 'oscar-runs' });
    const removed = await D.removeLeftovers(kube, {});
    expect(removed.jobs).toBeGreaterThanOrEqual(1);
    expect(api.s.jobs.has('oscar-run-old')).toBe(false);
    expect(api.s.secrets.has('oscar-run-old')).toBe(false);
    expect(api.s.secrets.has('someone-else')).toBe(true);
  });

  const good = { RUN_AGENT_TOKEN: AGENT_TOKEN, RUN_IMAGE: 'r/oscar-run:1', RUN_RESULTS_URL: 'http://oscar-internal:3003' };
  test.each([
    ['no token', { RUN_AGENT_TOKEN: '' }, /RUN_AGENT_TOKEN/],
    ['no image', { RUN_IMAGE: '' }, /RUN_IMAGE/],
    ['no results address', { RUN_RESULTS_URL: 'oscar-internal' }, /RUN_RESULTS_URL/],
    ['a namespace that is not a name', { RUN_NAMESPACE: 'Runs!' }, /RUN_NAMESPACE/],
    ['work folders kept nowhere it knows', { RUN_WORK_FOLDERS: 'ramdisk' }, /^RUN_WORK_FOLDERS is neither memory nor disk\.$/],
    ['a server secret', { ENCRYPTION_KEY: 'k' }, /ENCRYPTION_KEY/],
  ])('refused with %s', (_what, over, message) => {
    expect(D.startupProblem({ ...good, ...over }, undefined, () => false)).toMatch(message);
  });

  test('refused when it can see the database; started otherwise', () => {
    expect(D.startupProblem(good, undefined, (p) => p === '/app/data/oscar.db')).toMatch(/database/);
    expect(D.startupProblem(good, undefined, () => false)).toBeNull();
    expect(SERVER_SECRETS).toEqual(expect.arrayContaining(['ENCRYPTION_KEY', 'JWT_SECRET']));
  });
});

describe('the Kubernetes client', () => {
  test('reads its token again at each call, as the kubelet renews it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kube-token-'));
    const tokenFile = path.join(dir, 'token');
    fs.writeFileSync(tokenFile, `${KUBE_TOKEN}\n`);
    const kube = createKubeClient({ base: `http://127.0.0.1:${api.server.address().port}`, tokenFile, namespace: 'oscar-runs' });
    await expect(kube.listJobs(J.MANAGED_SELECTOR)).resolves.toHaveProperty('items');
    fs.writeFileSync(tokenFile, 'renewed-but-unknown');
    await expect(kube.listJobs(J.MANAGED_SELECTOR)).rejects.toMatchObject({ status: 401 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a run pod\'s size and folders: 2 CPUs and memory unless set (#1307)', () => {
    const byDefault = D.settingsOf({});
    expect([byDefault.cpuRequest, byDefault.cpuLimit, byDefault.memoryRequest, byDefault.memoryLimit]).toEqual(['200m', '2', '256Mi', '1Gi']);
    expect(byDefault.workFolders).toBe('memory');
    expect(J.WORK_FOLDERS).toEqual(['memory', 'disk']);
    expect(D.settingsOf({ RUN_CPU_LIMIT: '1', RUN_WORK_FOLDERS: ' Disk ' })).toMatchObject({ cpuLimit: '1', workFolders: 'disk' });
    // The folders and the pod's memory: both folders full still leave Bruno its memory.
    const megabytes = (size) => Number(size.replace('Mi', ''));
    expect(megabytes(J.FOLDER_SIZES.work) + megabytes(J.FOLDER_SIZES.tmp)).toBeLessThanOrEqual(1024 / 2);
  });

  test('on the node\'s disk when told so: the folders as they were before', () => {
    const onDisk = D.settingsOf({ RUN_WORK_FOLDERS: 'disk' });
    const job = J.runJob({ runId: randomUUID(), deadlineSeconds: 600 }, onDisk);
    expect(job.spec.template.spec.volumes).toEqual([{ name: 'work', emptyDir: {} }, { name: 'tmp', emptyDir: {} }]);
    expect(D.startupProblem({ RUN_AGENT_TOKEN: AGENT_TOKEN, RUN_IMAGE: 'r/oscar-run:1', RUN_RESULTS_URL: 'http://oscar-internal:3003', RUN_WORK_FOLDERS: 'disk' }, undefined, () => false)).toBeNull();
  });

  test('a sandboxed runtime is named when one is set', () => {
    const job = J.runJob({ runId: randomUUID(), deadlineSeconds: 600 }, { ...settings, runtimeClass: 'gvisor' });
    expect(job.spec.template.spec.runtimeClassName).toBe('gvisor');
  });
});
