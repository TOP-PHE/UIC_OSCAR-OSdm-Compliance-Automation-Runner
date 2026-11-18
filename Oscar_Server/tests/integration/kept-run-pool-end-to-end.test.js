// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * The runs of a batch through the kept pods' pool, a kept pod's real program
 * and the server's own internal port (#1309, parts 1, 2 and 4). The
 * dispatcher is the one stand-in: it starts the pod's program here.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID: uuidv4 } = require('node:crypto');

process.env.PORT = '0';
process.env.INTERNAL_PORT = '0';
const { internalApp } = require('../../src/server');
const { run: dbRun } = require('../../src/db/db');
const keptPods = require('../../src/worker/keptPods');
const starter = require('../../src/worker/keptPodStarter');
const runSecrets = require('../../src/utils/runSecrets');
const { listRunResults, removeRunResults } = require('../../src/utils/runResults');
const pool = require('../../src/worker/keptRunPool');
const { keptPod } = require('../../src/run-pod/keptPod');
const { makeKeptPodFakes } = require('../helpers/kept-pod-fakes');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kept-run-pool-e2e-')));
const fakes = makeKeptPodFakes(root);
let listener;
beforeAll(async () => {
  listener = internalApp.listen(0, '127.0.0.1');
  await new Promise((resolve) => listener.once('listening', resolve));
});
afterAll(async () => {
  jest.restoreAllMocks();
  await new Promise((resolve) => listener.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.INTERNAL_PORT;
});

const YML = 'name: OTST_acme_1a2b3c4d_Env\nvariables:\n  - name: api_base\n    value: "https://p.example/osdm"\n';

test('two runs of a batch in one kept pod, then the batch ends and so does the pod', async () => {
  const C = uuidv4();
  const U = uuidv4();
  const batch = { companyId: C, userId: U, batchId: uuidv4() };
  dbRun(`INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)`, [C, `Kept pool ${C.slice(0, 8)}`, `kept-pool-${C.slice(0, 8)}`]);
  dbRun(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'company_user')`, [U, C, `pool-${U.slice(0, 8)}@x.example`]);

  // The dispatcher's stand-in: the pod's program, started here.
  const pods = [];
  jest.spyOn(starter, 'startKeptPod').mockImplementation((b) => {
    const pod = keptPods.open(b);
    pods.push(keptPod({
      env: {
        PATH: process.env.PATH, HOME: root, SystemRoot: process.env.SystemRoot,
        OSCAR_POD_SECRET: pod.secret, OSCAR_RESULTS_URL: `http://127.0.0.1:${listener.address().port}`,
      },
      collectionDir: fakes.collectionDir, workRoot: path.join(root, `work-${pods.length}`), tmpDir: path.join(root, `tmp-${pods.length}`),
      bru: fakes.bru, log: () => {}, processes: () => [], outputFlushMs: 20, killGraceMs: 200,
    }));
    return { podId: pod.podId };
  });
  let queued = 1;
  pool.configure({ queuedOf: () => queued });

  // A run as the runner hands it: its row, its secret, its plan for Bruno.
  const runOf = (code) => {
    const runId = uuidv4();
    dbRun(`INSERT INTO runs (id, company_id, user_id, status, batch_id) VALUES (?, ?, ?, 'RUNNING', ?)`, [runId, C, U, batch.batchId]);
    fakes.plan(runId, { code });
    return {
      runId, envName: 'OTST_acme_1a2b3c4d_Env', envYml: Buffer.from(YML).toString('base64'), deadlineSeconds: 300,
      env: { OSCAR_RUN_SECRET: runSecrets.issue(runId, C), OSCAR_ACCESS_TOKEN: `token-${code}` },
    };
  };
  const ran = (run) => new Promise((resolve) => {
    const proc = pool.launchKeptRun({ batch, run });
    const seen = { out: '', pod: null };
    proc.stdout.on('data', (d) => { seen.out += d.toString(); });
    proc.on('pod', (a) => { seen.pod = a; });
    proc.on('close', (code) => resolve({ ...seen, code }));
    proc.on('error', (err) => resolve({ ...seen, error: err.message }));
  });

  const a = runOf(0);
  const b = runOf(1);
  try {
    const first = await ran(a);
    expect(first).toMatchObject({ code: 0, pod: '127.0.0.1' });
    expect(first.out).toContain(`bru output ${a.runId.slice(0, 8)}`);
    // The last run of the batch: nothing left in the queue once it is handed.
    const second = ran(b);
    queued = 0;
    expect(await second).toMatchObject({ code: 1, pod: '127.0.0.1' });
    expect(pods).toHaveLength(1);
    expect(await pods[0]).toBe(0);                     // told stop: the batch has nothing left
    for (const r of [a, b]) expect(await listRunResults(r.runId)).toContain(`.bru_results_${r.runId.slice(0, 8)}.json`);
    expect(fakes.started(b.runId).env.OSCAR_ACCESS_TOKEN).toBe('token-1');
    expect(keptPods.snapshot()).toEqual([]);
    expect(pool.snapshot()).toEqual([]);
  } finally {
    for (const r of [a, b]) {
      runSecrets.revoke(r.runId);
      await removeRunResults(r.runId);
    }
    keptPods.revokeCompany(C);
  }
});
