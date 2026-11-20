// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * api-test-requests.test.js — #1342 PR 3: a Company API account launches
 * tests on one or more providers and reads their verdicts.
 *
 *   - scenarios by code or by a selection; codes a provider does not have are
 *     named, never a refusal of the whole request;
 *   - every provider is checked before anything is queued (404 not given,
 *     409 suspended endpoint or missing credentials);
 *   - an account sees the company's shared scenarios, never a tester's own;
 *   - an Idempotency-Key answers the same request again, and refuses another;
 *   - the verdicts: passed, failed, not a result; the whole request's;
 *   - the long poll; the scopes; a read-only key cannot launch; the runner
 *     refuses the queued runs of a suspended account.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-test-requests';
process.env.APP_URL = 'https://oscar.test';

jest.mock('../../src/worker/queue', () => ({ enqueue: jest.fn(), on: jest.fn(), getStatus: jest.fn(() => ({})) }));

const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { run, get, all } = require('../../src/db/db');
const queue = require('../../src/worker/queue');
const { writeDatafile } = require('../../src/utils/datafileWrite');
const { setCredentials } = require('../../src/utils/testerCredentials');
const { encrypt } = require('../../src/db/db');
const { asValidDatafile } = require('../helpers/valid-datafile');
const Tokens = require('../../src/utils/apiAccessTokens');

const app = express();
app.use(express.json());
app.use('/v1/company/api-accounts', require('../../src/api/routes/company-api-accounts'));
app.use('/v1/api', require('../../src/api/routes/api'));

const D = crypto.randomUUID();
const P1 = crypto.randomUUID();
const P2 = crypto.randomUUID();
const OTHER = crypto.randomUUID();
const tag = D.slice(0, 8);
const TM = { id: crypto.randomUUID(), email: `tm-${tag}@requests.test`, role: 'test_manager', companyId: D };
const TESTER_EMAIL = `tester-${tag}@requests.test`;
const session = u => `Bearer ${jwt.sign({ sub: u.id, email: u.email, companyId: u.companyId, role: u.role }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;
let account;
let token;

const DATAFILE = () => asValidDatafile({ scenarios: [
  { code: 'OTST_SALE_A' },
  { code: 'OTST_SALE_B' },
  { code: 'OTST_TESTER_OWN', created_by: TESTER_EMAIL, shared: false },
] });

function withCredentials(userId, companyId) {
  const company = get('SELECT api_base FROM companies WHERE id = ?', [companyId]);
  setCredentials(userId, companyId, { auth_mode: 'bearer', access_token_enc: encrypt('provider-token'), credentials_endpoint: new URL(company.api_base).origin });
}

beforeAll(async () => {
  run(`INSERT INTO companies (id, name, slug, api_base) VALUES (?, 'Req Co', ?, 'https://d.example/osdm')`, [D, `req-${tag}`]);
  run(`INSERT INTO companies (id, name, slug, parent_id, api_base) VALUES (?, 'Req P1', ?, ?, 'https://p1.example/osdm')`, [P1, `req-${tag}--p1`, D]);
  run(`INSERT INTO companies (id, name, slug, parent_id, api_base) VALUES (?, 'Req P2', ?, ?, 'https://p2.example/osdm')`, [P2, `req-${tag}--p2`, D]);
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Other Co', ?)`, [OTHER, `req-o-${tag}`]);
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'test_manager')`, [TM.id, D, TM.email]);
  for (const [id, slug] of [[P1, `req-${tag}--p1`], [P2, `req-${tag}--p2`]]) await writeDatafile({ id, slug }, DATAFILE());
  account = (await request(app).post('/v1/company/api-accounts').set('Authorization', session(TM)).send({ name: 'CI', providers: [P1, P2] })).body;
  withCredentials(account.id, P1);
  withCredentials(account.id, P2);
  token = Tokens.issue(account.id, ['runs:read', 'runs:write']).token;
});

afterAll(() => {
  for (const id of [P1, P2]) {
    const row = get('SELECT datafile_path FROM companies WHERE id = ?', [id]);
    if (row?.datafile_path) fs.rmSync(row.datafile_path, { force: true });
  }
});

beforeEach(() => queue.enqueue.mockClear());

const launch = (body, { as = token, key } = {}) => {
  const r = request(app).post('/v1/api/test-requests').set('Authorization', `Bearer ${as}`);
  if (key) r.set('Idempotency-Key', key);
  return r.send(body);
};
const read = (id, query = '') => request(app).get(`/v1/api/test-requests/${id}${query}`).set('Authorization', `Bearer ${token}`);
const runsOf = (answer) => answer.providers.flatMap(p => p.runs);

describe('launching', () => {
  test('scenarios by code on two providers: one batch each, queued as the account, the codes a provider lacks named', async () => {
    const res = await launch({ providers: [P1, P2], scenarios: ['OTST_SALE_A', 'OTST_MISSING'], reference: 'pipeline 42' });
    expect(res.status).toBe(202);
    expect(res.headers.location).toBe(`/v1/api/test-requests/${res.body.id}`);
    expect(res.body).toMatchObject({ reference: 'pipeline 42', state: 'queued', verdict: null, asked: { scenarios: ['OTST_SALE_A', 'OTST_MISSING'] } });
    expect(res.body.providers.map(p => [p.id, p.name, p.not_found])).toEqual([[P1, 'Req P1', ['OTST_MISSING']], [P2, 'Req P2', ['OTST_MISSING']]]);
    for (const p of res.body.providers) {
      expect(p.runs.map(r => [r.scenario_code, r.state])).toEqual([['OTST_SALE_A', 'queued']]);
      expect(p.runs[0].run_url).toBe(`https://oscar.test/run-detail.html?id=${p.runs[0].id}`);
    }
    expect(queue.enqueue).toHaveBeenCalledTimes(2);
    const stored = get('SELECT user_id, company_id, status FROM runs WHERE id = ?', [res.body.providers[0].runs[0].id]);
    expect(stored).toEqual({ user_id: account.id, company_id: P1, status: 'QUEUED' });
  });

  test('a selection, as the Run page makes it; a tester\'s own scenario is never seen', async () => {
    const res = await launch({ providers: [P1], selection: { categories: ['happy'] } });
    expect(res.status).toBe(202);
    expect(runsOf(res.body).map(r => r.scenario_code).sort()).toEqual(['OTST_SALE_A', 'OTST_SALE_B']);
    const own = await launch({ providers: [P1], scenarios: ['OTST_TESTER_OWN'] });
    expect(own.status).toBe(400);
    expect(own.body.not_found).toEqual([{ provider: P1, codes: ['OTST_TESTER_OWN'] }]);
  });

  test('refused before anything is queued: a provider not given, a suspended endpoint, missing credentials', async () => {
    expect((await launch({ providers: [P1, OTHER], scenarios: ['OTST_SALE_A'] })).status).toBe(404);
    run("UPDATE companies SET endpoint_suspended_at = datetime('now'), endpoint_suspended_reason = 'test' WHERE id = ?", [P2]);
    try {
      const res = await launch({ providers: [P1, P2], scenarios: ['OTST_SALE_A'] });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ provider: P2, endpoint_suspended: true });
    } finally {
      run('UPDATE companies SET endpoint_suspended_at = NULL, endpoint_suspended_reason = NULL WHERE id = ?', [P2]);
    }
    run('DELETE FROM tester_credentials WHERE user_id = ? AND company_id = ?', [account.id, P2]);
    try {
      const res = await launch({ providers: [P1, P2], scenarios: ['OTST_SALE_A'] });
      expect(res.status).toBe(409);
      expect(res.body.missing).toEqual(['Bearer token (your credentials)']);
    } finally {
      withCredentials(account.id, P2);
    }
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  test('refused: a bad body; a read-only key; a token without runs:write', async () => {
    expect((await launch({ providers: [], scenarios: ['A'] })).status).toBe(400);
    expect((await launch({ providers: [P1] })).status).toBe(400);
    expect((await launch({ providers: [P1], scenarios: ['A'], selection: {} })).status).toBe(400);
    expect((await launch({ providers: [P1], scenarios: ['A'], reference: 'x\ny' })).status).toBe(400);
    const readOnly = Tokens.issue(account.id, ['runs:read']).token;
    const res = await launch({ providers: [P1], scenarios: ['OTST_SALE_A'] }, { as: readOnly });
    expect(res.status).toBe(403);
    expect(res.headers['www-authenticate']).toContain('runs:write');
  });

  test('an Idempotency-Key answers the same request again, and refuses another', async () => {
    const body = { providers: [P1], scenarios: ['OTST_SALE_B'] };
    const first = await launch(body, { key: 'ci-build-1001' });
    const again = await launch(body, { key: 'ci-build-1001' });
    expect(first.status).toBe(202);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    expect((await launch({ ...body, reference: 'other' }, { key: 'ci-build-1001' })).status).toBe(422);
    expect((await launch(body, { key: 'short' })).status).toBe(400);
  });
});

describe('reading the verdicts', () => {
  const finish = (runId, status, { checks = [], error = null } = {}) => {
    run(`UPDATE runs SET status = ?, error_message = ?, started_at = datetime('now'), completed_at = datetime('now') WHERE id = ?`, [status, error, runId]);
    if (checks.length === 0) return;
    const company = get('SELECT company_id FROM runs WHERE id = ?', [runId]).company_id;
    const suite = Number(run(`INSERT INTO run_suites (run_id, company_id, scenario_name, suite_name, total, passed, failed)
                              VALUES (?, ?, 'S', '02-Sale', 1, 1, 0)`, [runId, company]).lastInsertRowid);
    const req = Number(run(`INSERT INTO run_requests (suite_id, run_id, company_id, request_name, http_method, http_status, total, passed, failed, result)
                            VALUES (?, ?, ?, '02. POST Booking', 'POST', 201, 1, 1, 0, 'PASS')`, [suite, runId, company]).lastInsertRowid);
    checks.forEach((passed, i) => run(`INSERT INTO run_assertions (request_id, suite_id, run_id, company_id, assertion_key, assertion_name, passed)
                                       VALUES (?, ?, ?, ?, ?, ?, ?)`, [req, suite, runId, company, `k|${i}`, `check ${i}`, passed]));
  };

  test('each run and the whole request: passed, failed, not a result', async () => {
    const res = await launch({ providers: [P1, P2], scenarios: ['OTST_SALE_A', 'OTST_SALE_B'] });
    const [a1, b1] = res.body.providers[0].runs;
    const [a2, b2] = res.body.providers[1].runs;
    finish(a1.id, 'COMPLETED', { checks: [1, 1] });
    finish(b1.id, 'COMPLETED', { checks: [1] });
    finish(a2.id, 'FAILED', { checks: [1, 0] });
    let answer = (await read(res.body.id)).body;
    expect(answer.state).toBe('queued');
    expect(answer.providers[0]).toMatchObject({ state: 'finished', verdict: 'passed', counts: { passed: 2 } });
    finish(b2.id, 'FAILED', { error: 'RUN_NOT_FINISHED' });
    answer = (await read(res.body.id)).body;
    expect(answer).toMatchObject({ state: 'finished', verdict: 'failed', counts: { passed: 2, failed: 1, not_a_result: 1 } });
    const b2Answer = answer.providers[1].runs.find(r => r.id === b2.id);
    expect(b2Answer).toMatchObject({ verdict: 'not_a_result', reason: 'RUN_NOT_FINISHED', checks: { total: 0 } });
    expect(answer.providers[1].runs.find(r => r.id === a2.id)).toMatchObject({ verdict: 'failed', checks: { total: 2, passed: 1, failed: 1 } });
  });

  test('the long poll answers as soon as the request is finished', async () => {
    const res = await launch({ providers: [P1], scenarios: ['OTST_SALE_A'] });
    const runId = runsOf(res.body)[0].id;
    setTimeout(() => finish(runId, 'COMPLETED', { checks: [1] }), 300);
    const started = Date.now();
    const answer = await read(res.body.id, '?wait=10');
    expect(answer.body).toMatchObject({ state: 'finished', verdict: 'passed' });
    expect(Date.now() - started).toBeLessThan(6000);
    expect((await read(res.body.id, '?wait=61')).status).toBe(400);
  });

  test('an account holds five waits at a time; a sixth call answers at once', async () => {
    const res = await launch({ providers: [P1], scenarios: ['OTST_SALE_A'] });
    const runId = runsOf(res.body)[0].id;
    // Five waits, each held open until the run finishes.
    const held = Array.from({ length: 5 }, () => read(res.body.id, '?wait=20').then(r => r));
    await new Promise(r => setTimeout(r, 300));
    const started = Date.now();
    const sixth = await read(res.body.id, '?wait=20');
    expect(Date.now() - started).toBeLessThan(1500);
    expect(sixth.body.state).toBe('queued');
    finish(runId, 'COMPLETED', { checks: [1] });
    for (const r of await Promise.all(held)) expect(r.body).toMatchObject({ state: 'finished', verdict: 'passed' });
  });

  test('another account, or a read-only key, reads none; an unknown id is a 404', async () => {
    const res = await launch({ providers: [P1], scenarios: ['OTST_SALE_A'] });
    const other = (await request(app).post('/v1/company/api-accounts').set('Authorization', session(TM)).send({ name: 'Other CI' })).body;
    const otherToken = Tokens.issue(other.id, ['runs:read']).token;
    expect((await request(app).get(`/v1/api/test-requests/${res.body.id}`).set('Authorization', `Bearer ${otherToken}`)).status).toBe(404);
    expect((await read(crypto.randomUUID())).status).toBe(404);
  });
});

describe('the runner', () => {
  test('refuses the queued runs of an account suspended since', () => {
    const { refusedRunScope } = require('../../src/worker/runner');
    run("UPDATE users SET status = 'suspended' WHERE id = ?", [account.id]);
    try {
      expect(refusedRunScope({ company_id: P1 }, P1, account.id)).toContain('suspended');
      run("UPDATE users SET status = 'active' WHERE id = ?", [account.id]);
      expect(refusedRunScope({ company_id: P1 }, P1, account.id)).toBeNull();
    } finally {
      run("UPDATE users SET status = 'active' WHERE id = ?", [account.id]);
    }
  });

  test('an account\'s runs are listed as its own by GET /v1/api/runs', async () => {
    const list = await request(app).get('/v1/api/runs?limit=200').set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    const ids = new Set(all('SELECT id FROM runs WHERE user_id = ?', [account.id]).map(r => r.id));
    expect(list.body.runs.every(r => ids.has(r.id))).toBe(true);
  });
});
