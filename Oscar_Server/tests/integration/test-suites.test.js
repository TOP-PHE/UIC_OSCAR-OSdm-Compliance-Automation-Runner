// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * test-suites.test.js — #1342 PR 4: named suites.
 *
 *   - a Test Manager saves, changes and deletes the company's suites; testers
 *     read them; administrators and certifiers get 403; another company's
 *     are not reached;
 *   - a Company API account lists them on /v1/api/suites and asks one by
 *     name: on each provider, the codes its selection keeps and the codes it
 *     lists, those a provider lacks named.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-test-suites';
process.env.APP_URL = 'https://oscar.test';

jest.mock('../../src/worker/queue', () => ({ enqueue: jest.fn(), on: jest.fn(), getStatus: jest.fn(() => ({})) }));

const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { run, get, encrypt } = require('../../src/db/db');
const { writeDatafile } = require('../../src/utils/datafileWrite');
const { setCredentials } = require('../../src/utils/testerCredentials');
const { asValidDatafile } = require('../helpers/valid-datafile');
const Tokens = require('../../src/utils/apiAccessTokens');

const app = express();
app.use(express.json());
app.use('/v1/company/api-accounts', require('../../src/api/routes/company-api-accounts'));
app.use('/v1/company/test-suites', require('../../src/api/routes/company-test-suites'));
app.use('/v1/api', require('../../src/api/routes/api'));

const D = crypto.randomUUID();
const P1 = crypto.randomUUID();
const OTHER = crypto.randomUUID();
const tag = D.slice(0, 8);
const user = (role, companyId = D) => ({ id: crypto.randomUUID(), email: `${role}-${crypto.randomUUID().slice(0, 6)}@suites.test`, role, companyId });
const TM = user('test_manager');
const TESTER = user('company_user');
const CERT = user('certification_user');
const OTHER_TM = user('test_manager', OTHER);
const session = u => `Bearer ${jwt.sign({ sub: u.id, email: u.email, companyId: u.companyId, role: u.role }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;
let token;

beforeAll(async () => {
  run(`INSERT INTO companies (id, name, slug, api_base) VALUES (?, 'Suites Co', ?, 'https://d.example/osdm')`, [D, `suites-${tag}`]);
  run(`INSERT INTO companies (id, name, slug, parent_id, api_base) VALUES (?, 'Suites P1', ?, ?, 'https://p1.example/osdm')`, [P1, `suites-${tag}--p1`, D]);
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Other Co', ?)`, [OTHER, `suites-o-${tag}`]);
  for (const u of [TM, TESTER, CERT, OTHER_TM]) {
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', ?)`, [u.id, u.companyId, u.email, u.role]);
  }
  await writeDatafile({ id: P1, slug: `suites-${tag}--p1` }, asValidDatafile({ scenarios: [
    { code: 'OTST_SALE_A' }, { code: 'OTST_SALE_B' }, { code: 'NHF_REFUSED_C', scenarioType: 'SALE' },
  ] }));
  const account = (await request(app).post('/v1/company/api-accounts').set('Authorization', session(TM)).send({ name: 'CI', providers: [P1] })).body;
  setCredentials(account.id, P1, { auth_mode: 'bearer', access_token_enc: encrypt('t'), credentials_endpoint: 'https://p1.example' });
  token = Tokens.issue(account.id, ['runs:read', 'runs:write']).token;
});

afterAll(() => {
  const row = get('SELECT datafile_path FROM companies WHERE id = ?', [P1]);
  if (row?.datafile_path) fs.rmSync(row.datafile_path, { force: true });
});

const suites = (method, path = '', u = TM) => request(app)[method](`/v1/company/test-suites${path}`).set('Authorization', session(u));
const asAccount = (method, path) => request(app)[method](`/v1/api${path}`).set('Authorization', `Bearer ${token}`);

describe('the company\'s suites', () => {
  test('a Test Manager saves a selection, a list of codes, or both; anyone of the company reads them', async () => {
    const a = await suites('post').send({ name: 'nightly', selection: { categories: ['happy'] } });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ name: 'nightly', codes: null, created_by: TM.email });
    expect(a.body.selection).toMatchObject({ base: 'all', categories: ['happy'] });
    const b = await suites('post').send({ name: 'Smoke', codes: ['OTST_SALE_B', 'OTST_GONE'] });
    expect(b.status).toBe(201);
    // The provider a request names belongs to the company: its suites are the company's.
    const list = await suites('get').set('X-Provider-Id', P1);
    expect(list.body.company).toEqual({ id: D, name: 'Suites Co' });
    expect(list.body.suites.map(s => s.name)).toEqual(['nightly', 'Smoke']);
    expect((await suites('get', '', TESTER)).body.suites.map(s => s.name)).toEqual(['nightly', 'Smoke']);
  });

  test('refused: a tester or certifier changing, a bad suite, a name taken without case, another company', async () => {
    expect((await suites('post', '', TESTER).send({ name: 'x', codes: ['A'] })).status).toBe(403);
    expect((await suites('get', '', CERT)).status).toBe(403);
    expect((await suites('post').send({ name: 'empty' })).status).toBe(400);
    expect((await suites('post').send({ name: 'bad', selection: { categories: ['nonsense'] } })).status).toBe(400);
    expect((await suites('post').send({ name: 'NIGHTLY', codes: ['A'] })).status).toBe(409);
    const mine = (await suites('get')).body.suites[0];
    expect((await suites('delete', `/${mine.id}`, OTHER_TM)).status).toBe(404);
    expect((await suites('get', '', OTHER_TM)).body.suites).toEqual([]);
  });

  test('a change is checked whole; a deletion is final', async () => {
    const made = (await suites('post').send({ name: 'temp', codes: ['OTST_SALE_A'] })).body;
    expect((await suites('patch', `/${made.id}`).send({ codes: null })).status).toBe(400);
    const changed = await suites('patch', `/${made.id}`).send({ name: 'temporary', selection: { lastRun: 'failed' } });
    expect(changed.body).toMatchObject({ name: 'temporary', codes: ['OTST_SALE_A'] });
    expect(changed.body.selection.lastRun).toBe('failed');
    expect((await suites('delete', `/${made.id}`)).body).toEqual({ deleted: true, id: made.id });
    expect((await suites('patch', `/${made.id}`).send({ name: 'x' })).status).toBe(404);
  });
});

describe('asked by name through the API', () => {
  test('GET /v1/api/suites lists them for the account', async () => {
    const res = await asAccount('get', '/suites');
    expect(res.status).toBe(200);
    expect(res.body.suites.map(s => s.name)).toEqual(['nightly', 'Smoke']);
  });

  test('a suite of codes runs those the provider has and names the others; the name is found without case', async () => {
    const res = await asAccount('post', '/test-requests').send({ providers: [P1], suite: 'smoke' });
    expect(res.status).toBe(202);
    expect(res.body.asked.suite).toBe('smoke');
    expect(res.body.providers[0].runs.map(r => r.scenario_code)).toEqual(['OTST_SALE_B']);
    expect(res.body.providers[0].not_found).toEqual(['OTST_GONE']);
  });

  test('a suite of filters is applied on the provider at the launch', async () => {
    const res = await asAccount('post', '/test-requests').send({ providers: [P1], suite: 'nightly' });
    expect(res.status).toBe(202);
    expect(res.body.providers[0].runs.map(r => r.scenario_code).sort()).toEqual(['OTST_SALE_A', 'OTST_SALE_B']);
    expect(get('SELECT selection FROM run_batch WHERE batch_id = ?', [res.body.providers[0].batch_id]).selection).toContain('happy');
  });

  test('an unknown suite is a 404 that says where they are listed; another company\'s is unknown', async () => {
    const res = await asAccount('post', '/test-requests').send({ providers: [P1], suite: 'nope' });
    expect(res.status).toBe(404);
    expect(res.body.detail).toContain('/v1/api/suites');
    await suites('post', '', OTHER_TM).send({ name: 'theirs', codes: ['OTST_SALE_A'] });
    expect((await asAccount('post', '/test-requests').send({ providers: [P1], suite: 'theirs' })).status).toBe(404);
  });
});
