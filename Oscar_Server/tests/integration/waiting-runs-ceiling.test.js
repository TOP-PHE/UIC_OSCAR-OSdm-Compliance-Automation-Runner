// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';
const { pageSource } = require('../helpers/page-source');

/**
 * waiting-runs-ceiling.test.js — #1369: a ceiling on the runs one person or
 * one Company API account has queued or running, all companies together.
 *
 * Both launch routes go through helpers/runLaunch.js waitingRoomRefusal():
 * POST /v1/runs (the Run page) and POST /v1/api/test-requests (an account).
 * A launch that would go over is refused with 429 before anything is queued.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-waiting-runs';
process.env.APP_URL = 'https://oscar.test';

// The queue is not run here: a queued run stays queued, which is what is counted.
jest.mock('../../src/worker/queue', () => ({ enqueue: jest.fn(), on: jest.fn(), getStatus: jest.fn(() => ({})) }));

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { run, get, all, encrypt, db } = require('../../src/db/db');
const queue = require('../../src/worker/queue');
const { writeDatafile } = require('../../src/utils/datafileWrite');
const { setCredentials } = require('../../src/utils/testerCredentials');
const { asValidDatafile } = require('../helpers/valid-datafile');
const Tokens = require('../../src/utils/apiAccessTokens');
const L = require('../../src/api/helpers/runLaunch');

const app = express();
app.use(express.json());
app.use('/v1/company/api-accounts', require('../../src/api/routes/company-api-accounts'));
app.use('/v1/runs', require('../../src/api/routes/runs'));
app.use('/v1/api', require('../../src/api/routes/api'));

const C = crypto.randomUUID();
const ELSEWHERE = crypto.randomUUID();
const tag = C.slice(0, 8);
const TM = { id: crypto.randomUUID(), email: `tm-${tag}@waiting.test`, role: 'test_manager', companyId: C };
const session = `Bearer ${jwt.sign({ sub: TM.id, email: TM.email, companyId: C, role: TM.role }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;
const CODES = ['OTST_SALE_A', 'OTST_SALE_B', 'OTST_SALE_C'];
let account;
let token;

const setCeiling = (value) => run(`INSERT INTO server_config (key, value) VALUES ('MAX_WAITING_RUNS_PER_ACCOUNT', ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(value)]);
const noCeilingStored = () => run("DELETE FROM server_config WHERE key = 'MAX_WAITING_RUNS_PER_ACCOUNT'");
const waiting = (userId) => get("SELECT COUNT(*) AS n FROM runs WHERE user_id = ? AND status IN ('QUEUED', 'RUNNING')", [userId]).n;
const runsOf = (userId) => get('SELECT COUNT(*) AS n FROM runs WHERE user_id = ?', [userId]).n;
const finishRunsOf = (userId) => run("UPDATE runs SET status = 'COMPLETED' WHERE user_id = ?", [userId]);
const fromPage = (body = {}) => request(app).post('/v1/runs').set('Authorization', session).send(body);
const fromApi = (body = { providers: [C], scenarios: CODES }, key) => {
  const r = request(app).post('/v1/api/test-requests').set('Authorization', `Bearer ${token}`);
  if (key) r.set('Idempotency-Key', key);
  return r.send(body);
};

beforeAll(async () => {
  run(`INSERT INTO companies (id, name, slug, api_base) VALUES (?, 'Waiting Co', ?, 'https://c.example/osdm')`, [C, `waiting-${tag}`]);
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Elsewhere Co', ?)`, [ELSEWHERE, `waiting-e-${tag}`]);
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'test_manager')`, [TM.id, C, TM.email]);
  await writeDatafile({ id: C, slug: `waiting-${tag}` }, asValidDatafile({ scenarios: CODES.map(code => ({ code })) }));
  const origin = new URL('https://c.example/osdm').origin;
  setCredentials(TM.id, C, { auth_mode: 'bearer', access_token_enc: encrypt('tm-token'), credentials_endpoint: origin });
  account = (await request(app).post('/v1/company/api-accounts').set('Authorization', session).send({ name: 'CI', providers: [] })).body;
  setCredentials(account.id, C, { auth_mode: 'bearer', access_token_enc: encrypt('ci-token'), credentials_endpoint: origin });
  token = Tokens.issue(account.id, ['runs:read', 'runs:write']).token;
});

afterAll(() => {
  noCeilingStored();
  const row = get('SELECT datafile_path FROM companies WHERE id = ?', [C]);
  if (row?.datafile_path) fs.rmSync(row.datafile_path, { force: true });
});

beforeEach(() => {
  queue.enqueue.mockClear();
  finishRunsOf(TM.id);
  finishRunsOf(account.id);
  setCeiling(5);
});

describe('the ceiling', () => {
  test('5,000 when nothing is stored, or when what is stored is no number', () => {
    noCeilingStored();
    expect(L.waitingRunsCeiling()).toBe(5000);
    expect(L.WAITING_RUNS_DEFAULT).toBe(5000);
    for (const stored of ['', 'many', '0', '-3']) {
      setCeiling(stored);
      expect(L.waitingRunsCeiling()).toBe(5000);
    }
    setCeiling(250);
    expect(L.waitingRunsCeiling()).toBe(250);
  });

  test('it is a Server Config setting, with the default the code reads', () => {
    const admin = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'api', 'routes', 'admin.js'), 'utf8');
    expect(admin).toMatch(/MAX_WAITING_RUNS_PER_ACCOUNT: \{[^}]*type: 'number', default: 5000, min: 100, max: 100000 \}/);
    const launch = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'api', 'helpers', 'runLaunch.js'), 'utf8');
    expect(launch).toContain("getConfig('MAX_WAITING_RUNS_PER_ACCOUNT', '5000')");
    const page = pageSource(path.join(__dirname, '..', '..', 'public', 'admin.html'), 'utf8');
    expect(page).toContain("MAX_WAITING_RUNS_PER_ACCOUNT: 'Max Waiting Runs per Account'");
  });

  test('the count reads the index of the runs waiting, never the whole table', () => {
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM runs INDEXED BY idx_runs_active WHERE status IN ('QUEUED', 'RUNNING') AND user_id = ?`).all(TM.id);
    expect(plan.map(p => p.detail).join(' | ')).toContain('idx_runs_active');
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'api', 'helpers', 'runLaunch.js'), 'utf8');
    expect(source).toContain("FROM runs INDEXED BY idx_runs_active WHERE status IN ('QUEUED', 'RUNNING') AND user_id = ?");
  });
});

describe('POST /v1/runs: a person', () => {
  test('under the ceiling: queued; over it: 429, and nothing is queued', async () => {
    const first = await fromPage();
    expect(first.status).toBe(202);
    expect(waiting(TM.id)).toBe(3);

    const before = runsOf(TM.id);
    queue.enqueue.mockClear();
    const second = await fromPage();
    expect(second.status).toBe(429);
    expect(second.body).toMatchObject({ waiting: 3, wanted: 3, limit: 5 });
    expect(second.body.detail).toMatch(/nothing was queued/);
    expect(runsOf(TM.id)).toBe(before);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  test('exactly at the ceiling passes', async () => {
    setCeiling(6);
    expect((await fromPage()).status).toBe(202);
    expect((await fromPage()).status).toBe(202);
    expect(waiting(TM.id)).toBe(6);
    expect((await fromPage()).status).toBe(429);
  });

  test('runs that are finished do not count', async () => {
    expect((await fromPage()).status).toBe(202);
    expect((await fromPage()).status).toBe(429);
    finishRunsOf(TM.id);
    expect((await fromPage()).status).toBe(202);
  });

  test('a running run counts as a queued one', async () => {
    expect((await fromPage()).status).toBe(202);
    run("UPDATE runs SET status = 'RUNNING' WHERE user_id = ? AND status = 'QUEUED'", [TM.id]);
    expect((await fromPage()).status).toBe(429);
  });

  test('the count is the person\'s, all companies together', async () => {
    for (let i = 0; i < 4; i++) {
      run(`INSERT INTO runs (id, company_id, user_id, status) VALUES (?, ?, ?, 'QUEUED')`, [crypto.randomUUID(), ELSEWHERE, TM.id]);
    }
    const res = await fromPage();
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ waiting: 4, wanted: 3, limit: 5 });
  });

  test('another account\'s runs are not counted against this person', async () => {
    expect((await fromApi()).status).toBe(202);
    expect(waiting(account.id)).toBe(3);
    expect((await fromPage()).status).toBe(202);
  });
});

describe('POST /v1/api/test-requests: a Company API account', () => {
  test('over the ceiling: 429, no run, no test request recorded', async () => {
    expect((await fromApi()).status).toBe(202);
    const requests = () => get('SELECT COUNT(*) AS n FROM test_request WHERE user_id = ?', [account.id]).n;
    const [runsBefore, requestsBefore] = [runsOf(account.id), requests()];
    queue.enqueue.mockClear();

    const res = await fromApi();
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ status: 429, waiting: 3, wanted: 3, limit: 5 });
    expect(runsOf(account.id)).toBe(runsBefore);
    expect(requests()).toBe(requestsBefore);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  test('a refused request does not use up its Idempotency-Key', async () => {
    expect((await fromApi()).status).toBe(202);
    const key = `key-${crypto.randomUUID()}`;
    expect((await fromApi(undefined, key)).status).toBe(429);
    finishRunsOf(account.id);
    const again = await fromApi(undefined, key);
    expect(again.status).toBe(202);
    expect(all('SELECT id FROM test_request WHERE user_id = ? AND idempotency_key = ?', [account.id, key])).toHaveLength(1);
  });

  test('every provider of the request is counted together', async () => {
    setCeiling(4);
    // Three scenarios asked: 3 fit under 4.
    expect((await fromApi()).status).toBe(202);
    finishRunsOf(account.id);
    setCeiling(2);
    const res = await fromApi();
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ waiting: 0, wanted: 3, limit: 2 });
  });
});
