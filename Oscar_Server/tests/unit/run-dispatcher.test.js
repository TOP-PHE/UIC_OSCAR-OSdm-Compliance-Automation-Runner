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
const { createKubeClient } = require('../../src/run-dispatcher/kube');
const D = require('../../src/run-dispatcher/dispatcher');
const { SERVER_SECRETS } = require('../../src/runner-agent/agent');

const KUBE_TOKEN = 'kube-token';
const AGENT_TOKEN = randomBytes(24).toString('hex');   // 48 characters

// ── The stand-in API server ──────────────────────────────────────────────────
// scripts: runId -> { lines, exitCode, reason, waiting, pending, hang, vanish }
function fakeApi() {
  const s = { secrets: new Map(), jobs: new Map(), pods: new Map(), logs: new Map(), scripts: new Map(), calls: [], created: { jobs: [], secrets: [] } };
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
    }, 20);
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      s.calls.push(`${req.method} ${req.url}`);
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
        if (!pod) return json(res, 404, { message: 'no pod' });
        res.statusCode = 200;
        const log = s.logs.get(podName);
        for (const line of log.lines) res.write(line);
        if (pod.status.containerStatuses[0].state.terminated) return res.end();
        log.watchers.push(res);
        return undefined;
      }
      if (req.method === 'POST') {
        if (store.has(body.metadata.name)) return json(res, 409, { message: 'already exists' });
        const obj = { ...body, metadata: { ...body.metadata, uid: randomUUID() }, status: {} };
        store.set(obj.metadata.name, obj);
        s.created[kind].push(body);
        if (kind === 'jobs') startPod(obj);
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
  return { s, server };
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
function ask(msg, { onMessage, socketRef } = {}) {
  return new Promise((resolve) => {
    const messages = [];
    const socket = net.connect(port, '127.0.0.1', () => socket.write(P.line(msg)));
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

  test('a sandboxed runtime is named when one is set', () => {
    const job = J.runJob({ runId: randomUUID(), deadlineSeconds: 600 }, { ...settings, runtimeClass: 'gvisor' });
    expect(job.spec.template.spec.runtimeClassName).toBe('gvisor');
  });
});
