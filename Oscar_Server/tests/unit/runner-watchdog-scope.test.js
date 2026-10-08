// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #540: provider access withdrawn mid-run stops the runner's token watchdog.
 */

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { randomUUID: uuidv4 } = require('node:crypto');

jest.mock('child_process');
const { spawn } = require('child_process');
jest.mock('../../src/worker/access-token');
const { resolveAccessToken } = require('../../src/worker/access-token');
const { run } = require('../../src/db/db');
const { executeRun } = require('../../src/worker/runner');

const ARTIFACTS_DIR = path.resolve(__dirname, '../../data/artifacts');
const DIR = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'rv-wd-'));
const DF = path.join(DIR, 'datafile.json');
fs.writeFileSync(DF, JSON.stringify({ scenariosToRun: 'ALL', scenarios: [{ code: 'S1' }] }));
fs.mkdirSync(path.join(process.env.COLLECTION_PATH, 'environments'), { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('the token watchdog stops refreshing once provider access is withdrawn', async () => {
  run(`INSERT OR REPLACE INTO server_config (key, value) VALUES ('TOKEN_WATCHDOG_INTERVAL_MS', '40')`);
  const D = uuidv4(), P = uuidv4(), U = uuidv4(), runId = uuidv4();
  run(`INSERT INTO companies (id, name, slug, api_base, datafile_path) VALUES (?, 'D', ?, 'https://d.example/osdm', ?)`, [D, `d-${D.slice(0, 8)}`, DF]);
  run(`INSERT INTO companies (id, name, slug, api_base, datafile_path, parent_id) VALUES (?, 'P', ?, 'https://p.example/osdm', ?, ?)`, [P, `p-${P.slice(0, 8)}`, DF, D]);
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'company_user')`, [U, D, `u-${U.slice(0, 8)}@x.example`]);
  run('INSERT INTO provider_access (company_id, user_id) VALUES (?, ?)', [P, U]);
  run(`INSERT INTO tester_credentials (user_id, company_id, auth_mode, token_url, client_id_enc, client_secret_enc) VALUES (?, ?, 'oauth2', 'https://p.example/token', 'a', 'b')`, [U, P]);
  run(`INSERT INTO runs (id, company_id, user_id, status) VALUES (?, ?, ?, 'QUEUED')`, [runId, P, U]);

  resolveAccessToken.mockResolvedValue('tok');
  const proc = new EventEmitter(); proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.kill = jest.fn();
  spawn.mockReturnValueOnce(proc);
  const p = executeRun({ runId, companyId: P, userId: U, scenarioOverride: 'S1' });
  while (spawn.mock.calls.length < 1) await sleep(5);

  run('DELETE FROM provider_access WHERE company_id = ? AND user_id = ?', [P, U]);   // withdrawn
  const before = resolveAccessToken.mock.calls.length;
  await sleep(200);
  const after = resolveAccessToken.mock.calls.length;
  proc.emit('close', 0);
  await p;
  fs.rmSync(path.join(ARTIFACTS_DIR, runId), { recursive: true, force: true });
  fs.rmSync(DIR, { recursive: true, force: true });
  run(`DELETE FROM server_config WHERE key = 'TOKEN_WATCHDOG_INTERVAL_MS'`);
  expect(after).toBe(before);
});
