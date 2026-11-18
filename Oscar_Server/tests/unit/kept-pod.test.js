// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * A run pod kept for the runs of one batch (#1309; part 2 = #1318): the run
 * image's loop, against a stand-in for the server's internal port.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { randomUUID, randomBytes } = require('node:crypto');
const { keptPod, podInputs, podProcesses, emptyFolder, NOT_STARTED_CODE } = require('../../src/run-pod/keptPod');
const { DEADLINE_CODE } = require('../../src/run-pod/runPod');
const { makeKeptPodFakes } = require('../helpers/kept-pod-fakes');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kept-pod-')));
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });
const fakes = makeKeptPodFakes(root);
const POD_SECRET = randomBytes(32).toString('base64url');
const YML = 'name: OTST_acme_1a2b3c4d_Env\nvariables:\n  - name: api_base\n    value: "https://p.example/osdm"\n';

// The internal port: each call for a next run takes the next of `script`
// (an answer { status, json | text }, 'hang' or 'reset'); output and results
// are recorded and taken.
let server;
let script;
let calls;
const held = new Set();
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      calls.push({ method: req.method, url: req.url, podSecret: req.headers['x-oscar-pod-secret'], runSecret: req.headers['x-oscar-run-secret'], body });
      if (req.url !== '/v1/run-pods/next') {
        res.statusCode = req.method === 'PUT' ? 201 : 200;
        res.end('{}');
        return;
      }
      const answer = script.shift() ?? { status: 200, json: { action: 'stop', reason: 'batch-done' } };
      if (answer === 'hang') { held.add(res); return; }
      if (answer === 'reset') { req.socket.destroy(); return; }
      res.statusCode = answer.status;
      res.end(answer.json === undefined ? answer.text : JSON.stringify(answer.json));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});
afterAll(() => new Promise((resolve) => {
  for (const res of held) res.destroy();
  server.close(resolve);
}));
beforeEach(() => { script = []; calls = []; });

const nextCalls = () => calls.filter((c) => c.url === '/v1/run-pods/next');
const endedOf = (call) => JSON.parse(call.body).ended;

// A run as the server hands it, its plan written for the fake Bruno.
function runAnswer(plan = {}, over = {}) {
  const runId = randomUUID();
  fakes.plan(runId, plan);
  const run = {
    runId, envName: 'OTST_acme_1a2b3c4d_Env', envYml: Buffer.from(YML).toString('base64'), deadlineSeconds: 60,
    env: { OSCAR_RUN_SECRET: randomBytes(32).toString('hex'), OSCAR_ACCESS_TOKEN: `token-${runId.slice(0, 8)}` },
    ...over,
  };
  return { run, answer: { status: 200, json: { action: 'run', run } } };
}

function podEnv(over = {}) {
  return {
    PATH: process.env.PATH,
    HOME: root,
    SystemRoot: process.env.SystemRoot,                      // Windows needs it to start node
    OSCAR_POD_SECRET: POD_SECRET,
    OSCAR_RESULTS_URL: `http://127.0.0.1:${server.address().port}/`,
    OSCAR_ACCESS_TOKEN: 'a-token-of-the-pod-itself',          // never reaches Bruno
    ENCRYPTION_KEY: 'the-server-key',
    ...over,
  };
}

let n = 0;
async function startPod({
  env = podEnv(), processes = () => [], nextTimeoutMs = 10_000, outputFlushMs = 20, fetchImpl = globalThis.fetch, connectRetryDelaysMs,
} = {}) {
  n += 1;
  const workRoot = path.join(root, `work-${n}`);
  const tmpDir = path.join(root, `tmp-${n}`);
  fs.mkdirSync(workRoot, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  const lines = [];
  const killed = [];
  const pauses = [];
  const code = await keptPod({
    env, collectionDir: fakes.collectionDir, workRoot, tmpDir, bru: fakes.bru, fetchImpl,
    log: (l) => lines.push(l), processes, kill: (pid, signal) => killed.push([pid, signal]),
    nextTimeoutMs, retryDelaysMs: [], outputRetryDelaysMs: [], outputFlushMs, killGraceMs: 200,
    ...(connectRetryDelaysMs ? { connectRetryDelaysMs } : {}),
    sleep: async (ms) => { pauses.push(ms); },
  });
  return { code, workRoot, tmpDir, lines, killed, pauses };
}

// A connection refused before the request was sent, as fetch reports it.
const refused = (code = 'ECONNREFUSED') => new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
// fetch, refusing the first `times` calls for a next run.
function refusingFirst(times, code) {
  let left = times;
  return async (url, init) => {
    if (url.endsWith('/v1/run-pods/next') && left > 0) {
      left -= 1;
      throw refused(code);
    }
    return globalThis.fetch(url, init);
  };
}

describe('a pod kept for the runs of one batch', () => {
  test('runs what it is handed, one after another, each with its own credentials only, then stops when told', async () => {
    const a = runAnswer({ tmp: path.join(root, `tmp-${n + 1}`) });
    const b = runAnswer({ code: 1 });
    script = [a.answer, b.answer, { status: 200, json: { action: 'stop', reason: 'batch-done' } }];
    const pod = await startPod();
    expect(pod.code).toBe(0);

    const asked = nextCalls();
    expect(asked.map((c) => c.podSecret)).toEqual([POD_SECRET, POD_SECRET, POD_SECRET]);
    expect(asked.map((c) => JSON.parse(c.body))).toEqual([
      {},
      { ended: { runId: a.run.runId, code: 0, clean: true } },
      { ended: { runId: b.run.runId, code: 1, clean: true } },
    ]);

    for (const { run } of [a, b]) {
      const started = fakes.started(run.runId);
      expect(started.cwd).toBe(path.join(pod.workRoot, run.runId));
      expect(started.env.HOME).toBe(path.join(pod.workRoot, run.runId, '.home'));
      expect(started.env.OSCAR_ACCESS_TOKEN).toBe(run.env.OSCAR_ACCESS_TOKEN);
      expect(started.env.OSCAR_RUN_SECRET).toBe(run.env.OSCAR_RUN_SECRET);
      for (const key of ['OSCAR_POD_SECRET', 'ENCRYPTION_KEY', 'OSCAR_RESULTS_URL']) expect(started.env[key]).toBeUndefined();

      const id8 = run.runId.slice(0, 8);
      const output = calls.filter((c) => c.url === `/v1/runs/${run.runId}/output`);
      expect(output.length).toBeGreaterThan(0);
      expect(output.every((c) => c.runSecret === run.env.OSCAR_RUN_SECRET)).toBe(true);
      expect(output.map((c) => JSON.parse(c.body).seq)).toEqual([...output.keys()]);
      const parts = output.flatMap((c) => JSON.parse(c.body).parts);
      const text = (stream) => parts.filter(([s]) => s === stream).map(([, t]) => t).join('');
      expect(text('out')).toContain(`bru output ${id8}`);
      expect(text('out')).toContain('merge output');
      expect(text('err')).toContain(`bru error ${id8}`);

      const results = calls.filter((c) => c.method === 'PUT' && c.url.startsWith(`/v1/runs/${run.runId}/results/`));
      expect(results.every((c) => c.runSecret === run.env.OSCAR_RUN_SECRET)).toBe(true);
      expect(results.map((c) => decodeURIComponent(c.url.split('/').pop())).sort()).toEqual([
        '.bru_results_' + id8 + '.json', `20261118_OTST_acme_1a2b3c4d_Env_Report.html`, `20261118_x_${id8}_Report.html`,
      ].sort());
    }
    // Clean between two runs: no work folder left, /tmp emptied.
    expect(fs.readdirSync(pod.workRoot)).toEqual([]);
    expect(fs.readdirSync(pod.tmpDir)).toEqual([]);
    expect(pod.lines.at(-1)).toBe('[kept-pod] ends after 2 run(s): told to stop (batch-done)');
  });

  test('Bruno\'s code is reported as it is; a run past its deadline is stopped and reported as such', async () => {
    const three = runAnswer({ code: 3 });
    const late = runAnswer({ sleepMs: 30_000 }, { deadlineSeconds: 1 });
    script = [three.answer, late.answer];
    const started = Date.now();
    const pod = await startPod();
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(nextCalls().slice(1).map(endedOf)).toEqual([
      { runId: three.run.runId, code: 3, clean: true },
      { runId: late.run.runId, code: DEADLINE_CODE, clean: true },
    ]);
    expect(pod.code).toBe(0);
  });

  test('a run\'s output and results are all sent before its end is reported', async () => {
    const a = runAnswer();
    script = [a.answer];
    // A flush time longer than the run: what was not sent yet goes at the run's end.
    await startPod({ outputFlushMs: 60_000 });
    expect(calls.some((c) => c.url === `/v1/runs/${a.run.runId}/output`)).toBe(true);
    const reported = calls.findIndex((c) => c.url === '/v1/run-pods/next' && JSON.parse(c.body).ended?.runId === a.run.runId);
    const lastOfRun = calls.findLastIndex((c) => c.url.startsWith(`/v1/runs/${a.run.runId}/`));
    expect(reported).toBeGreaterThan(0);
    expect(lastOfRun).toBeLessThan(reported);
  });

  test('a process that holds the output open does not hold the run', async () => {
    const a = runAnswer({ holdOutputMs: 10_000 });
    script = [a.answer];
    const started = Date.now();
    await startPod();
    expect(Date.now() - started).toBeLessThan(7000);
    expect(endedOf(nextCalls()[1])).toEqual({ runId: a.run.runId, code: 0, clean: true });
  });

  (process.platform === 'win32' ? test.skip : test)('a process the run left behind ends with the run (its group is stopped)', async () => {
    const orphanFile = path.join(root, `orphan-${randomUUID()}`);
    const a = runAnswer({ orphanFile });
    script = [a.answer];
    await startPod();
    await new Promise((r) => setTimeout(r, 1500));
    expect(fs.existsSync(orphanFile)).toBe(false);
  });

  test('a process left behind is stopped, and the pod says it is no longer clean', async () => {
    const a = runAnswer();
    script = [a.answer, { status: 200, json: { action: 'stop', reason: 'not-clean' } }];
    let looked = 0;
    const pod = await startPod({ processes: () => (looked++ === 0 ? [] : [4242, 4243]) });
    expect(pod.killed).toEqual([[4242, 'SIGKILL'], [4243, 'SIGKILL']]);
    expect(endedOf(nextCalls()[1])).toEqual({ runId: a.run.runId, code: 0, clean: false });
    expect(pod.lines).toContain(`[kept-pod] 2 process(es) left behind by ${a.run.runId}: stopped, and the pod is no longer clean`);
    expect(pod.code).toBe(0);
  });

  test('not the first process of its pod: said once, and the processes are not looked for', async () => {
    script = [];
    const pod = await startPod({ processes: () => null });
    expect(pod.lines[0]).toBe('[kept-pod] not the first process of its pod: the processes a run leaves are not looked for');
    expect(pod.code).toBe(0);
  });
});

describe('an answer the pod cannot use: it ends, and never calls again', () => {
  test.each([
    ['a refusal', { status: 403, json: { status: 403 } }, 'HTTP 403'],
    ['a server error', { status: 500, json: {} }, 'HTTP 500'],
    ['a redirect', { status: 302, text: '' }, 'HTTP 302'],
    ['not JSON', { status: 200, text: 'nope' }, 'an answer that is not JSON'],
    ['another action', { status: 200, json: { action: 'dance' } }, 'an answer it cannot read'],
    ['a run that is a list', { status: 200, json: { action: 'run', run: [] } }, 'an answer it cannot read'],
    ['a stop without a reason', { status: 200, json: { action: 'stop' } }, 'an answer it cannot read'],
  ])('%s', async (_, answer, why) => {
    script = [answer, { status: 200, json: { action: 'stop', reason: 'never asked' } }];
    const pod = await startPod();
    expect(pod.code).toBe(1);
    expect(nextCalls()).toHaveLength(1);
    expect(pod.lines.at(-1)).toBe(`[kept-pod] ends after 0 run(s): ${why}`);
  });

  test('a call whose connection was never made is made again (a new pod\'s network, #1324); the pod then runs', async () => {
    const a = runAnswer();
    script = [a.answer];
    const pod = await startPod({ fetchImpl: refusingFirst(2) });
    expect(pod.code).toBe(0);
    expect(pod.pauses.slice(0, 2)).toEqual([500, 1000]);
    expect(pod.lines.filter((l) => /was not reached/.test(l))).toEqual([
      '[kept-pod] the server was not reached (fetch failed (ECONNREFUSED)); asked again in 0.5 s',
      '[kept-pod] the server was not reached (fetch failed (ECONNREFUSED)); asked again in 1 s',
    ]);
    expect(nextCalls()).toHaveLength(2);                       // the run, then the end: the refused ones never arrived
    expect(endedOf(nextCalls()[1])).toEqual({ runId: a.run.runId, code: 0, clean: true });
  });

  test('each way the connection is not made is made again; a name not found too', async () => {
    for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']) {
      calls = [];
      script = [];
      const pod = await startPod({ fetchImpl: refusingFirst(1, code) });
      expect([code, pod.code, nextCalls().length]).toEqual([code, 0, 1]);
    }
  });

  test('a connection refused past the pauses: the pod ends', async () => {
    const pod = await startPod({ fetchImpl: refusingFirst(10), connectRetryDelaysMs: [1, 2] });
    expect([pod.code, pod.pauses]).toEqual([1, [1, 2]]);
    expect(pod.lines.at(-1)).toBe('[kept-pod] ends after 0 run(s): fetch failed (ECONNREFUSED)');
  });

  test('a connection cut: the call reached the server, so it is not made again', async () => {
    script = ['reset'];
    const pod = await startPod();
    expect(pod.code).toBe(1);
    expect(nextCalls()).toHaveLength(1);
    expect(pod.pauses).toEqual([]);
  });

  test('no answer in time', async () => {
    script = ['hang'];
    const pod = await startPod({ nextTimeoutMs: 300 });
    expect(pod.code).toBe(1);
    expect(nextCalls()).toHaveLength(1);
    expect(pod.lines.at(-1)).toMatch(/^\[kept-pod\] ends after 0 run\(s\): /);
  });

  test('a run without a run id', async () => {
    script = [{ status: 200, json: { action: 'run', run: { runId: 'nope' } } }];
    const pod = await startPod();
    expect(pod.code).toBe(1);
    expect(nextCalls()).toHaveLength(1);
  });
});

describe('a run the pod cannot start is reported, not started', () => {
  test.each([
    ['a wrong environment name', { envName: '../x' }],
    ['no environment file', { envYml: '' }],
    ['no deadline', { deadlineSeconds: undefined }],
    ['a deadline that is not whole seconds', { deadlineSeconds: 1.5 }],
    ['no run secret', { env: { OSCAR_ACCESS_TOKEN: 't' } }],
    ['the pod\'s secret in the run\'s environment', { env: { OSCAR_RUN_SECRET: 'a'.repeat(64), OSCAR_POD_SECRET: POD_SECRET } }],
    ['a credential that is not text', { env: { OSCAR_RUN_SECRET: 'a'.repeat(64), OSCAR_ACCESS_TOKEN: 1 } }],
    ['no environment', { env: null }],
  ])('%s', async (_, over) => {
    const bad = runAnswer({}, over);
    script = [bad.answer];
    const pod = await startPod();
    expect(endedOf(nextCalls()[1])).toEqual({ runId: bad.run.runId, code: NOT_STARTED_CODE, clean: true });
    expect(fakes.started(bad.run.runId)).toBeNull();
    expect(pod.code).toBe(0);
  });
});

describe('the pod\'s inputs', () => {
  test('a pod secret and the internal port, else nothing is asked', async () => {
    for (const over of [
      { OSCAR_POD_SECRET: undefined }, { OSCAR_POD_SECRET: 'short' }, { OSCAR_RESULTS_URL: 'ftp://x.example' },
      { OSCAR_RESULTS_URL: 'http://user:pw@x.example' }, { OSCAR_RESULTS_URL: 'not an address' },
    ]) {
      calls = [];
      const pod = await startPod({ env: podEnv(over) });
      expect(pod.code).toBe(2);
      expect(calls).toEqual([]);
    }
    expect(podInputs(podEnv({ OSCAR_RESULTS_URL: 'http://oscar-internal:3002///' }))).toEqual({ podSecret: POD_SECRET, base: 'http://oscar-internal:3002' });
  });

  test('the entrypoint is a kept pod with a pod secret, a pod of one run without', () => {
    const entry = path.join(__dirname, '../../src/run-pod/entrypoint.js');
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
    const kept = spawnSync(process.execPath, [entry], { env: { ...env, OSCAR_POD_SECRET: 'short' }, encoding: 'utf8' });
    expect([kept.status, kept.stderr.trim()]).toEqual([2, '[kept-pod] Not started: OSCAR_POD_SECRET is not a pod secret.']);
    const one = spawnSync(process.execPath, [entry], { env, encoding: 'utf8' });
    expect([one.status, one.stderr.trim()]).toEqual([2, '[run-pod] Not started: OSCAR_RUN_ID is not a run id.']);
  });
});

describe('cleaning between two runs', () => {
  test('podProcesses(): the pod\'s processes alive but this one, only when it is the pod\'s first', () => {
    const proc = path.join(root, 'proc');
    const stat = (pid, text) => {
      fs.mkdirSync(path.join(proc, String(pid)), { recursive: true });
      if (text) fs.writeFileSync(path.join(proc, String(pid), 'stat'), text);
    };
    stat(1, '1 (node) S 0 1 1');
    stat(7, '7 (bru) S 1 7 7');
    stat(8, '8 (a (b) c) Z 1 8 8');
    stat(9, '9 (x y) R 1 9 9');
    stat(11, '11 (gone) X 1 11 11');
    stat(10);
    fs.mkdirSync(path.join(proc, 'self'), { recursive: true });
    expect(podProcesses({ procDir: proc, self: 1 }).sort((x, y) => x - y)).toEqual([7, 9]);
    expect(podProcesses({ procDir: proc, self: 5 })).toBeNull();
  });

  test('emptyFolder(): what it holds goes, the folder stays', async () => {
    const dir = path.join(root, 'to-empty');
    fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a', 'b', 'c'), 'x');
    fs.writeFileSync(path.join(dir, '.hidden'), 'x');
    expect(await emptyFolder(dir)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(await emptyFolder(path.join(root, 'not-there'))).toBe(true);
  });
});
