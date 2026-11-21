// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * api-test-results.test.js — #1342 PR 5: where each run of a test request
 * failed and warned (results only, D4), as JSON and as JUnit XML, and the
 * verdict passed_with_deviation.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-test-results';
process.env.APP_URL = 'https://oscar.test';

jest.mock('../../src/worker/queue', () => ({ enqueue: jest.fn(), on: jest.fn(), getStatus: jest.fn(() => ({})) }));

const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { run, get, encrypt, colEncrypt } = require('../../src/db/db');
const { writeDatafile } = require('../../src/utils/datafileWrite');
const { setCredentials } = require('../../src/utils/testerCredentials');
const { asValidDatafile } = require('../helpers/valid-datafile');
const { forgetDetails } = require('../../src/api/helpers/runDetail');
const Tokens = require('../../src/utils/apiAccessTokens');

const app = express();
app.use(express.json());
app.use('/v1/company/api-accounts', require('../../src/api/routes/company-api-accounts'));
app.use('/v1/api', require('../../src/api/routes/api'));

const D = crypto.randomUUID();
const P1 = crypto.randomUUID();
const tag = D.slice(0, 8);
const TM = { id: crypto.randomUUID(), email: `tm-${tag}@results.test`, role: 'test_manager', companyId: D };
const session = u => `Bearer ${jwt.sign({ sub: u.id, email: u.email, companyId: u.companyId, role: u.role }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;
let token;
let requestId;
let runs;

function results(runId, { checks = [], events = [], status = 'COMPLETED', error = null }) {
  run(`UPDATE runs SET status = ?, error_message = ?, started_at = '2026-11-20 10:00:00', completed_at = '2026-11-20 10:00:30' WHERE id = ?`, [status, error, runId]);
  if (checks.length) {
    const suite = Number(run(`INSERT INTO run_suites (run_id, company_id, scenario_name, suite_name, total, passed, failed) VALUES (?, ?, 'S', '02-Sale', 1, 1, 0)`, [runId, P1]).lastInsertRowid);
    for (const c of checks) {
      const req = Number(run(`INSERT INTO run_requests (suite_id, run_id, company_id, request_name, http_method, http_status, total, passed, failed, result, response_body)
                              VALUES (?, ?, ?, ?, 'POST', ?, 1, ?, ?, ?, ?)`,
      [suite, runId, P1, c.step, c.status, c.passed, 1 - c.passed, c.passed ? 'PASS' : 'FAIL', c.body ? colEncrypt(c.body) : null]).lastInsertRowid);
      run(`INSERT INTO run_assertions (request_id, suite_id, run_id, company_id, assertion_key, assertion_name, passed, error_msg, expected_value, actual_value)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [req, suite, runId, P1, `k|${c.check}`, c.check, c.passed, c.error || null, c.expected || null, c.actual || null]);
    }
  }
  for (const e of events) {
    run(`INSERT INTO run_events (run_id, level, request_name, message) VALUES (?, ?, ?, ?)`, [runId, e.level || 'warn', e.step || null, colEncrypt(e.message)]);
  }
}

beforeAll(async () => {
  run(`INSERT INTO companies (id, name, slug, api_base) VALUES (?, 'Results Co', ?, 'https://d.example/osdm')`, [D, `res-${tag}`]);
  run(`INSERT INTO companies (id, name, slug, parent_id, api_base) VALUES (?, 'Results <P1>', ?, ?, 'https://p1.example/osdm')`, [P1, `res-${tag}--p1`, D]);
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'test_manager')`, [TM.id, D, TM.email]);
  await writeDatafile({ id: P1, slug: `res-${tag}--p1` }, asValidDatafile({ scenarios: [{ code: 'OTST_A' }, { code: 'OTST_B' }, { code: 'OTST_C' }, { code: 'OTST_D' }] }));
  const account = (await request(app).post('/v1/company/api-accounts').set('Authorization', session(TM)).send({ name: 'CI', providers: [P1] })).body;
  setCredentials(account.id, P1, { auth_mode: 'bearer', access_token_enc: encrypt('t'), credentials_endpoint: 'https://p1.example' });
  token = Tokens.issue(account.id, ['runs:read', 'runs:write']).token;
  const launched = await request(app).post('/v1/api/test-requests').set('Authorization', `Bearer ${token}`)
    .send({ providers: [P1], scenarios: ['OTST_A', 'OTST_B', 'OTST_C', 'OTST_D'], reference: 'build <7>' });
  requestId = launched.body.id;
  runs = Object.fromEntries(launched.body.providers[0].runs.map(r => [r.scenario_code, r.id]));

  // A: failed at the booking, the provider's problem code read from its error answer.
  results(runs.OTST_A, {
    status: 'FAILED',
    checks: [
      { step: '01. POST Get Offer', check: 'HTTP response status', passed: 1, status: 200 },
      { step: '02. POST Booking', check: 'HTTP response status — expected 200', passed: 0, status: 400, error: 'expected 200, actual: 400',
        expected: '200', actual: '400', body: JSON.stringify({ code: 'urn:uic:problem:BOOKING_REFUSED', title: 'Refused', detail: 'Alex Example' }) },
    ],
    events: [{ step: '02. POST Booking', message: '[WARNING] The booking names no confirmableUntil.' },
      // #1355: the collection's echo of the failed check is not a warning of its own.
      { step: '02. POST Booking', message: '[WARNING] ❌ HTTP response status — expected 200: expected 200, actual: 400' },
      { step: '02. POST Booking', level: 'info', message: '[INFO] Not a warning, never answered' }],
  });
  // B: passed, with a known deviation applied.
  results(runs.OTST_B, {
    checks: [{ step: '03. PATCH Passenger', check: 'Known deviation', passed: 1, status: 501 }],
    events: [{ step: '03. PATCH Passenger', message: '[WARNING] Known deviation (documented): 03. PATCH Passenger returned HTTP 501 — no passenger update. Not counted as a failure' }],
  });
  // C: no result; D: passed, plain.
  results(runs.OTST_C, { status: 'FAILED', error: 'RUN_NOT_FINISHED' });
  results(runs.OTST_D, { checks: [{ step: '01. POST Get Offer', check: 'HTTP response status', passed: 1, status: 200 }] });
  forgetDetails();
});

afterAll(() => {
  const row = get('SELECT datafile_path FROM companies WHERE id = ?', [P1]);
  if (row?.datafile_path) fs.rmSync(row.datafile_path, { force: true });
});

const get$ = path => request(app).get(path).set('Authorization', `Bearer ${token}`);

test('the status names a pass with a known deviation; the request still passes or fails on its runs', async () => {
  const res = await get$(`/v1/api/test-requests/${requestId}`);
  const byCode = Object.fromEntries(res.body.providers[0].runs.map(r => [r.scenario_code, r]));
  expect(byCode.OTST_B.verdict).toBe('passed_with_deviation');
  expect(byCode.OTST_D.verdict).toBe('passed');
  expect(res.body).toMatchObject({ state: 'finished', verdict: 'failed', counts: { passed: 1, passed_with_deviation: 1, failed: 1, not_a_result: 1 } });
  expect(byCode.OTST_A).not.toHaveProperty('failures');
});

test('the results say where each run failed and warned, and nothing more', async () => {
  const res = await get$(`/v1/api/test-requests/${requestId}/results`);
  expect(res.status).toBe(200);
  const byCode = Object.fromEntries(res.body.providers[0].runs.map(r => [r.scenario_code, r]));
  expect(byCode.OTST_A.failures).toEqual([{ step: '02. POST Booking', check: 'HTTP response status — expected 200', message: 'expected 200, actual: 400',
    expected: '200', actual: '400', http_status: 400, problem_code: 'BOOKING_REFUSED' }]);
  expect(byCode.OTST_A.warnings).toEqual([{ step: '02. POST Booking', message: '[WARNING] The booking names no confirmableUntil.' }]);
  expect(byCode.OTST_B.deviations).toEqual([{ step: '03. PATCH Passenger', status: 501, note: 'no passenger update' }]);
  expect(byCode.OTST_B.warnings).toEqual([]);
  expect(byCode.OTST_C).toMatchObject({ verdict: 'not_a_result', reason: 'RUN_NOT_FINISHED', failures: [], warnings: [] });
  const text = JSON.stringify(res.body);
  // Results only (D4): the answer's body, its other text and other log lines never leave.
  expect(text).not.toContain('Alex Example');
  expect(text).not.toContain('Not a warning');
});

test('as JUnit XML: one suite per provider, one case per run, escaped, warnings in system-out', async () => {
  const res = await get$(`/v1/api/test-requests/${requestId}/results?format=junit`);
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toContain('application/xml');
  const xml = res.text;
  expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  expect(xml).toContain('<testsuites name="OSCAR test request ' + requestId + ' (build &lt;7&gt;)" tests="4" failures="1" errors="1" skipped="0">');
  expect(xml).toContain('<testsuite name="Results &lt;P1&gt;"');
  expect(xml).toMatch(/<testcase classname="Results &lt;P1&gt;" name="OTST_A" time="30.000">.*<failure message="02\. POST Booking: HTTP response status — expected 200 \[HTTP 400 BOOKING_REFUSED\]/s);
  expect(xml).toMatch(/name="OTST_C".*<error message="No test result: RUN_NOT_FINISHED" type="not_a_result"\/>/s);
  expect(xml).toContain('<system-out>Known deviation: 03. PATCH Passenger returned HTTP 501 — no passenger update');
  expect(xml).toContain(`<property name="run_url" value="https://oscar.test/run-detail.html?id=${runs.OTST_D}"/>`);
  expect(xml).not.toContain('Alex Example');
});

test('format other than json or junit is a 400; another account reads nothing', async () => {
  expect((await get$(`/v1/api/test-requests/${requestId}/results?format=html`)).status).toBe(400);
  const other = (await request(app).post('/v1/company/api-accounts').set('Authorization', session(TM)).send({ name: 'Other' })).body;
  const otherToken = Tokens.issue(other.id, ['runs:read']).token;
  expect((await request(app).get(`/v1/api/test-requests/${requestId}/results`).set('Authorization', `Bearer ${otherToken}`)).status).toBe(404);
});
