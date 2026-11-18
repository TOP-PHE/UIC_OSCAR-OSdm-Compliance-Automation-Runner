// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * A kept run pod's program against the server's own internal port (#1309,
 * parts 1 and 2 = #1316, #1318): two runs of a batch, their output and their
 * results, then the batch ends. What part 4 will do (hand the runs, open their
 * output) is done here by hand.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID: uuidv4, randomBytes } = require('node:crypto');

process.env.PORT = '0';
process.env.INTERNAL_PORT = '0';
const { internalApp } = require('../../src/server');
const { run: dbRun } = require('../../src/db/db');
const keptPods = require('../../src/worker/keptPods');
const runSecrets = require('../../src/utils/runSecrets');
const runOutput = require('../../src/worker/runOutput');
const { listRunResults, removeRunResults } = require('../../src/utils/runResults');
const { keptPod } = require('../../src/run-pod/keptPod');
const { makeKeptPodFakes } = require('../helpers/kept-pod-fakes');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kept-pod-e2e-')));
const fakes = makeKeptPodFakes(root);
let listener;
beforeAll(async () => {
  listener = internalApp.listen(0, '127.0.0.1');
  await new Promise((resolve) => listener.once('listening', resolve));
});
afterAll(async () => {
  await new Promise((resolve) => listener.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.INTERNAL_PORT;
});

const YML = 'name: OTST_acme_1a2b3c4d_Env\nvariables:\n  - name: api_base\n    value: "https://p.example/osdm"\n';

test('two runs of a batch, one after the other, in one pod', async () => {
  const C = uuidv4();
  const U = uuidv4();
  const batch = { companyId: C, userId: U, batchId: uuidv4() };
  dbRun(`INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)`, [C, `Kept e2e ${C.slice(0, 8)}`, `kept-e2e-${C.slice(0, 8)}`]);
  dbRun(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'company_user')`, [U, C, `e2e-${U.slice(0, 8)}@x.example`]);

  // The runs the queue would hand: each with its secret issued, its output opened.
  const runs = [0, 1].map((code) => {
    const runId = uuidv4();
    dbRun(`INSERT INTO runs (id, company_id, user_id, status, batch_id) VALUES (?, ?, ?, 'RUNNING', ?)`, [runId, C, U, batch.batchId]);
    fakes.plan(runId, { code });
    const secret = runSecrets.issue(runId, C);
    return {
      runId, output: [],
      run: { runId, envName: 'OTST_acme_1a2b3c4d_Env', envYml: Buffer.from(YML).toString('base64'), deadlineSeconds: 120,
        env: { OSCAR_RUN_SECRET: secret, OSCAR_ACCESS_TOKEN: `token-${code}` } },
    };
  });
  const pod = keptPods.open(batch);
  const queue = [...runs];
  const ended = [];
  const stops = [];
  const offs = [
    keptPods.on('waiting', (e) => {
      if (e.podId !== pod.podId) return;
      const next = queue.shift();
      if (!next) { keptPods.endBatch(e); return; }
      runOutput.open(next.runId, (stream, text) => next.output.push([stream, text]));
      expect(keptPods.handRun(e, next.run)).toBe(pod.podId);
    }),
    keptPods.on('ended', (e) => ended.push(e)),
    keptPods.on('stop', (e) => stops.push(e)),
  ];
  try {
    const lines = [];
    const code = await keptPod({
      env: {
        PATH: process.env.PATH, HOME: root, SystemRoot: process.env.SystemRoot,
        OSCAR_POD_SECRET: pod.secret, OSCAR_RESULTS_URL: `http://127.0.0.1:${listener.address().port}`,
      },
      collectionDir: fakes.collectionDir, workRoot: path.join(root, 'work'), tmpDir: path.join(root, 'tmp'),
      bru: fakes.bru, log: (l) => lines.push(l), processes: () => [], outputFlushMs: 20, killGraceMs: 200,
    });
    expect([code, lines.at(-1)]).toEqual([0, '[kept-pod] ends after 2 run(s): told to stop (batch-done)']);
    expect(ended.map((e) => ({ runId: e.runId, code: e.code, resultsReceived: e.resultsReceived, clean: e.clean }))).toEqual([
      { runId: runs[0].runId, code: 0, resultsReceived: true, clean: true },
      { runId: runs[1].runId, code: 1, resultsReceived: true, clean: true },
    ]);
    expect(stops).toEqual([expect.objectContaining({ podId: pod.podId, reason: 'batch-done' })]);
    for (const r of runs) {
      const text = r.output.map(([, t]) => t).join('');
      expect(text).toContain(`bru output ${r.runId.slice(0, 8)}`);
      expect(text).toContain(`bru error ${r.runId.slice(0, 8)}`);
      expect(await listRunResults(r.runId)).toContain(`.bru_results_${r.runId.slice(0, 8)}.json`);
      expect(fakes.started(r.runId).env.OSCAR_ACCESS_TOKEN).toBe(r.run.env.OSCAR_ACCESS_TOKEN);
      expect(fakes.started(r.runId).env.OSCAR_POD_SECRET).toBeUndefined();
    }
  } finally {
    for (const off of offs) off();
    for (const r of runs) {
      runOutput.close(r.runId);
      runSecrets.revoke(r.runId);
      await removeRunResults(r.runId);
    }
    keptPods.revokeCompany(C);
  }
});
