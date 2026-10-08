// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #540: provider access withdrawn mid-run stops the run's token refresh.
 */

const request = require('supertest');
const { randomUUID: uuidv4 } = require('node:crypto');

jest.mock('../../src/worker/access-token');
const { resolveAccessToken } = require('../../src/worker/access-token');
process.env.PORT = '0';
const app = require('../../src/server');
const { run } = require('../../src/db/db');
const runSecrets = require('../../src/utils/runSecrets');

test('the token refresh loopback refuses once the tester\'s provider access is withdrawn', async () => {
  const D = uuidv4(), P = uuidv4(), U = uuidv4(), runId = uuidv4();
  run(`INSERT INTO companies (id, name, slug, api_base) VALUES (?, 'D', ?, 'https://d.example/osdm')`, [D, `d-${D.slice(0, 8)}`]);
  run(`INSERT INTO companies (id, name, slug, api_base, parent_id) VALUES (?, 'P', ?, 'https://p.example/osdm', ?)`, [P, `p-${P.slice(0, 8)}`, D]);
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'company_user')`, [U, D, `u-${U.slice(0, 8)}@x.example`]);
  run('INSERT INTO provider_access (company_id, user_id) VALUES (?, ?)', [P, U]);
  run(`INSERT INTO tester_credentials (user_id, company_id, auth_mode, access_token_enc) VALUES (?, ?, 'bearer', 'enc')`, [U, P]);
  run(`INSERT INTO runs (id, company_id, user_id, status) VALUES (?, ?, ?, 'RUNNING')`, [runId, P, U]);
  const secret = runSecrets.issue(runId, P);

  // With access: the provider's credentials are used.
  resolveAccessToken.mockResolvedValue('provider-token');
  const ok = await request(app).post(`/v1/runs/${runId}/refresh-access-token`).set('X-OSCAR-Run-Secret', secret);
  expect(ok.status).toBe(200);
  expect(resolveAccessToken).toHaveBeenCalledWith(expect.objectContaining({ user_id: U, company_id: P }), expect.anything(), expect.anything());
  resolveAccessToken.mockClear();

  // The Test Manager withdraws the tester's access while the run is in flight.
  run('DELETE FROM provider_access WHERE company_id = ? AND user_id = ?', [P, U]);

  const res = await request(app).post(`/v1/runs/${runId}/refresh-access-token?force=1`).set('X-OSCAR-Run-Secret', secret);
  runSecrets.revoke(runId);
  expect(res.status).toBe(403);
  expect(res.body.access_token).toBeUndefined();
  expect(resolveAccessToken).not.toHaveBeenCalled();
});
