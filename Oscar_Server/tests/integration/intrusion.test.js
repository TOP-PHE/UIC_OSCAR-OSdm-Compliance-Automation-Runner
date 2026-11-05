// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * An intrusion attempt met by a run (utils/intrusion.js): recorded once,
 * the endpoint suspended until a Test Manager resumes it, cached provider
 * tokens dropped, administrators told; the run, the company and the admin
 * list say so.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-intrusion';

const jwt = require('jsonwebtoken');
const { randomUUID: uuidv4 } = require('node:crypto');
const request = require('supertest');
const express = require('express');
const { run, get } = require('../../src/db/db');
const I = require('../../src/utils/intrusion');

const app = express();
app.use(express.json());
app.use('/v1/company', require('../../src/api/routes/company'));
app.use('/v1/runs', require('../../src/api/routes/runs'));
app.use('/v1/admin', require('../../src/api/routes/admin'));

const companyId = uuidv4();
const platformId = uuidv4();
const tmId = uuidv4();
const testerId = uuidv4();
const adminId = uuidv4();
const runId = uuidv4();

const token = (id, role, cid) => jwt.sign({ sub: id, email: `${id}@intrusion.test`, companyId: cid, role },
  process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
const asTm = () => `Bearer ${token(tmId, 'test_manager', companyId)}`;
const asTester = () => `Bearer ${token(testerId, 'company_user', companyId)}`;
const asAdmin = () => `Bearer ${token(adminId, 'administrator', platformId)}`;

const OPEN = '{' + '{';
let notified;

beforeAll(() => {
  run('INSERT INTO companies (id, name, slug, api_base) VALUES (?, ?, ?, ?)', [companyId, 'Intrusion Co', `intrusion-${companyId}`, 'https://provider.example/osdm']);
  run('INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)', [platformId, 'Platform', `platform-${platformId}`]);
  for (const [id, role, cid] of [[tmId, 'test_manager', companyId], [testerId, 'company_user', companyId], [adminId, 'administrator', platformId]]) {
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', ?)`, [id, cid, `${id}@intrusion.test`, role]);
  }
  run(`INSERT INTO tester_credentials (user_id, company_id, cached_token_enc, cached_token_expires_at, cached_token_cred_fp) VALUES (?, ?, 'enc', '2099-01-01', 'fp')`, [testerId, companyId]);
  run(`INSERT INTO runs (id, company_id, user_id, status) VALUES (?, ?, ?, 'RUNNING')`, [runId, companyId, testerId]);
});

describe('parseIntrusionLine()', () => {
  test('reads kind and step from the collection\'s line', () => {
    expect(I.parseIntrusionLine('[ERROR] [INTRUSION] kind=template step=02. POST Create Booking'))
      .toEqual({ kind: 'template', step: '02. POST Create Booking' });
  });
  test.each(['[INTRUSION] kind=other step=x', 'kind=template step=x', '', null])('%j is not an intrusion line', (line) => {
    expect(I.parseIntrusionLine(line)).toBeNull();
  });
});

describe('a run meets an intrusion attempt', () => {
  beforeAll(() => {
    notified = [];
    const runRow = get('SELECT * FROM runs WHERE id = ?', [runId]);
    expect(I.onIntrusionLine('[INTRUSION] kind=template step=05. GET Booking', runRow, (e) => { notified.push(e); })).toBe(true);
    // A second line of the same run records nothing more.
    I.onIntrusionLine('[INTRUSION] kind=script step=06. POST Fulfillment', runRow, (e) => { notified.push(e); });
  });

  test('one event is recorded, without the answer, and the administrators are told once', async () => {
    const rows = get('SELECT COUNT(*) AS n FROM security_event WHERE run_id = ?', [runId]);
    expect(rows.n).toBe(1);
    await new Promise(r => setImmediate(r));
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({ run_id: runId, company_id: companyId, kind: 'template', step: '05. GET Booking' });
  });

  test('the cached provider tokens of the company are dropped', () => {
    expect(get('SELECT cached_token_enc FROM tester_credentials WHERE user_id = ?', [testerId]).cached_token_enc).toBeNull();
  });

  test('the run says so', async () => {
    const res = await request(app).get(`/v1/runs/${runId}`).set('Authorization', asTester());
    expect(res.status).toBe(200);
    expect(res.body.intrusion).toMatchObject({ kind: 'template', step: '05. GET Booking' });
  });

  test('the endpoint is suspended: the company says so and no run starts', async () => {
    const company = await request(app).get('/v1/company').set('Authorization', asTester());
    expect(company.body.endpoint_suspended_at).toBeTruthy();
    const launch = await request(app).post('/v1/runs').set('Authorization', asTester()).send({});
    expect(launch.status).toBe(409);
    expect(launch.body.endpoint_suspended).toBe(true);
  });

  test('the administrators list it, without test data', async () => {
    const res = await request(app).get('/v1/admin/security-events').set('Authorization', asAdmin());
    expect(res.status).toBe(200);
    const ev = res.body.events.find(e => e.run_id === runId);
    expect(ev).toMatchObject({ kind: 'template', company_name: 'Intrusion Co', started_by: `${testerId}@intrusion.test` });
    expect(JSON.stringify(res.body)).not.toContain(OPEN);
  });

  test('a tester cannot resume the endpoint; the Test Manager can, once', async () => {
    expect((await request(app).post('/v1/company/endpoint/resume').set('Authorization', asTester())).status).toBe(403);
    expect((await request(app).post('/v1/company/endpoint/resume').set('Authorization', asTm())).status).toBe(200);
    expect(I.endpointSuspension(companyId)).toBeNull();
    expect(get('SELECT resumed_by FROM security_event WHERE run_id = ?', [runId]).resumed_by).toBe(`${tmId}@intrusion.test`);
    expect((await request(app).post('/v1/company/endpoint/resume').set('Authorization', asTm())).status).toBe(409);
  });
});

describe('another endpoint saved ends a suspension', () => {
  test('PATCH /v1/company with a new endpoint resumes', async () => {
    const other = uuidv4();
    run(`INSERT INTO runs (id, company_id, user_id, status) VALUES (?, ?, ?, 'RUNNING')`, [other, companyId, testerId]);
    I.recordIntrusion({ runId: other, companyId, userId: testerId, kind: 'redirect', step: 'x' }, () => {});
    expect(I.endpointSuspension(companyId)).toBeTruthy();
    const res = await request(app).patch('/v1/company').set('Authorization', asTm()).send({ api_base: 'https://other-provider.example/osdm' });
    expect(res.status).toBe(200);
    expect(I.endpointSuspension(companyId)).toBeNull();
  });
});
