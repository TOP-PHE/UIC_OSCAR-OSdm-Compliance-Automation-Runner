// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * A kept run pod asks the internal port what comes next (#1309; part 1 =
 * #1316): POST /v1/run-pods/next, with the pod's own secret, on the internal
 * port only.
 */

const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { randomUUID: uuidv4 } = require('node:crypto');

process.env.PORT = '0';
process.env.INTERNAL_PORT = '0';
const app = require('../../src/server');
const { internalApp, _podCallOf: podCallOf } = app;
const { run } = require('../../src/db/db');
const runSecrets = require('../../src/utils/runSecrets');
const keptPods = require('../../src/worker/keptPods');

const ARTIFACTS_DIR = path.resolve(__dirname, '../../data/artifacts');
const URL = '/v1/run-pods/next';
const cleanup = [];
afterEach(() => {
  // Only the pods: the server's own listeners (its log of stops) stay.
  for (const p of keptPods.snapshot()) keptPods.revokeCompany(p.companyId);
});
afterAll(() => {
  for (const p of cleanup) fs.rmSync(p, { recursive: true, force: true });
  delete process.env.INTERNAL_PORT;
});

// A company, a tester, and a batch of one run with its secret.
function seedBatch() {
  const C = uuidv4(), U = uuidv4(), B = uuidv4(), runId = uuidv4();
  run(`INSERT INTO companies (id, name, slug, api_base) VALUES (?, ?, ?, 'https://c.example/osdm')`, [C, `Kept ${C.slice(0, 8)}`, `kept-${C.slice(0, 8)}`]);
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'company_user')`, [U, C, `k-${U.slice(0, 8)}@x.example`]);
  run(`INSERT INTO runs (id, company_id, user_id, status, batch_id) VALUES (?, ?, ?, 'RUNNING', ?)`, [runId, C, U, B]);
  cleanup.push(path.join(ARTIFACTS_DIR, runId));
  const batch = { companyId: C, userId: U, batchId: B };
  const runSecret = runSecrets.issue(runId, C);
  return { batch, run: { runId, deadlineSeconds: 600, envName: 'run', env: { OSCAR_RUN_SECRET: runSecret } }, runSecret };
}

function waiting(podId) {
  return new Promise((resolve) => {
    const off = keptPods.on('waiting', (e) => { if (e.podId === podId) { off(); resolve(); } });
  });
}

// A pod's call through the port, once it holds: { answer }, the promise of the HTTP answer.
async function call(pod, body, { timeout } = {}) {
  let req = request(internalApp).post(URL).set('X-OSCAR-Pod-Secret', pod.secret);
  if (timeout) req = req.timeout(timeout);
  const held = waiting(pod.podId);
  const answer = (body === undefined ? req : req.send(body)).then((r) => r, (err) => err);
  await Promise.race([held, answer]);
  return { answer };
}

describe('POST /v1/run-pods/next', () => {
  test('a pod\'s first call waits; it is handed its batch\'s run', async () => {
    const { batch, run: theRun } = seedBatch();
    const pod = keptPods.open(batch);
    const { answer } = await call(pod);
    expect(keptPods.handRun(batch, theRun)).toBe(pod.podId);
    const res = await answer;
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ action: 'run', run: theRun });
  });

  test('after a run sent its results, the pod waits again; the batch ends: stop', async () => {
    const { batch, run: theRun, runSecret } = seedBatch();
    const pod = keptPods.open(batch);
    const first = await call(pod);
    keptPods.handRun(batch, theRun);
    await first.answer;
    const sent = await request(internalApp).put(`/v1/runs/${theRun.runId}/results/.bru_results_1a2b3c4d.json`)
      .set('X-OSCAR-Run-Secret', runSecret).set('Content-Type', 'application/octet-stream').send(Buffer.from('{"results":[]}'));
    expect(sent.status).toBe(201);
    const { answer } = await call(pod, { ended: { runId: theRun.runId, code: 0 } });
    expect(keptPods.snapshot()[0]).toMatchObject({ podId: pod.podId, state: 'waiting', runs: 1, waiting: true });
    keptPods.endBatch(batch);
    const res = await answer;
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ action: 'stop', reason: 'batch-done' });
  });

  test('a run that sent no results: stop', async () => {
    const { batch, run: theRun } = seedBatch();
    const pod = keptPods.open(batch);
    const first = await call(pod);
    keptPods.handRun(batch, theRun);
    await first.answer;
    const res = await request(internalApp).post(URL).set('X-OSCAR-Pod-Secret', pod.secret).send({ ended: { runId: theRun.runId, code: 0 } });
    expect(res.body).toEqual({ action: 'stop', reason: 'abnormal-end' });
  });

  test('refused without a pod\'s secret, with a run\'s secret, or through a proxy', async () => {
    const { batch, runSecret } = seedBatch();
    const pod = keptPods.open(batch);
    const refusals = [
      request(internalApp).post(URL),
      request(internalApp).post(URL).set('X-OSCAR-Pod-Secret', 'A'.repeat(43)),
      request(internalApp).post(URL).set('X-OSCAR-Pod-Secret', runSecret),
      request(internalApp).post(URL).set('X-OSCAR-Run-Secret', pod.secret),
      request(internalApp).post(URL).set('X-OSCAR-Pod-Secret', pod.secret).set('X-Forwarded-For', '203.0.113.9'),
      request(internalApp).post(URL).set('X-OSCAR-Pod-Secret', pod.secret).set('X-Real-IP', '203.0.113.9'),
      request(internalApp).post(URL).set('X-OSCAR-Pod-Secret', pod.secret).set('Forwarded', 'for=203.0.113.9'),
    ];
    for (const r of refusals) {
      const res = await r;
      expect(res.status).toBe(403);
      expect(res.body.detail).toBe("This endpoint requires a run pod's secret.");
    }
    expect(keptPods.snapshot()[0]).toMatchObject({ podId: pod.podId, state: 'new', address: '' });
  });

  test('a body that is not nothing or an end is refused before the secret is looked at', async () => {
    const { batch } = seedBatch();
    const pod = keptPods.open(batch);
    for (const body of [[], { x: 1 }, { ended: null }, { ended: { runId: 'nope', code: 0 } },
      { ended: { runId: uuidv4(), code: 256 } }, { ended: { runId: uuidv4(), code: 1.5 } },
      { ended: { runId: uuidv4(), code: 0, more: 1 } }, { ended: { runId: uuidv4(), code: 0 }, more: 1 }]) {
      const res = await request(internalApp).post(URL).set('X-OSCAR-Pod-Secret', pod.secret).send(body);
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400]);
    }
    const big = await request(internalApp).post(URL).set('X-OSCAR-Pod-Secret', pod.secret)
      .set('Content-Type', 'application/json').send(JSON.stringify({ ended: { runId: uuidv4(), code: 0 }, pad: 'x'.repeat(2000) }));
    expect(big.status).toBe(413);
    expect(keptPods.snapshot()[0]).toMatchObject({ state: 'new', address: '' });
  });

  test('podCallOf(): nothing, or one end of a run', () => {
    const runId = uuidv4();
    expect(podCallOf(undefined)).toEqual({ ended: null });
    expect(podCallOf({})).toEqual({ ended: null });
    expect(podCallOf({ ended: { runId, code: 0 } })).toEqual({ ended: { runId, code: 0 } });
    expect(podCallOf({ ended: { code: 255, runId } })).toEqual({ ended: { runId, code: 255 } });
    expect(podCallOf('text')).toBeNull();
    expect(podCallOf({ ended: { runId, code: -1 } })).toBeNull();
    expect(podCallOf({ ended: { runId, code: '0' } })).toBeNull();
    expect(podCallOf({ ended: [runId, 0] })).toBeNull();
  });

  test('a call whose connection closes lets go of the pod: no run is handed to it', async () => {
    const { batch, run: theRun } = seedBatch();
    const pod = keptPods.open(batch);
    const { answer } = await call(pod, undefined, { timeout: 300 });
    const res = await answer;
    expect(res.timeout).toBe(300);
    const until = Date.now() + 2000;
    while (keptPods.snapshot()[0]?.waiting && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    expect(keptPods.snapshot()[0]).toMatchObject({ podId: pod.podId, state: 'waiting', waiting: false });
    expect(keptPods.handRun(batch, theRun)).toBeNull();
  });

  test('the public port has no such route', async () => {
    const { batch } = seedBatch();
    const pod = keptPods.open(batch);
    const res = await request(app).post(URL).set('X-OSCAR-Pod-Secret', pod.secret).send({});
    expect(res.status).toBe(404);
    expect(keptPods.snapshot()[0].state).toBe('new');
  });
});
