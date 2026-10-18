// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #833 PR D: GET /v1/company/ai-analysis/fault-detection — which faults the
 * simulator was asked for a batch detected, and whether an AI analysis of it
 * explained them. No model is called.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-fault-detection';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');
const { randomUUID: uuidv4 } = require('node:crypto');
const request = require('supertest');
const { run, colEncrypt } = require('../../src/db/db');
const { encryptToFile } = require('../../src/utils/at-rest');

const app = express();
app.use(express.json());
app.use('/v1/company', require('../../src/api/routes/company-ai-analysis-results'));

const companyId = uuidv4();
const otherId = uuidv4();
const tmId = uuidv4();
const testerId = uuidv4();
const URL_ = '/v1/company/ai-analysis/fault-detection';
// at-rest writes only under data/artifacts or data/datafiles.
const ARTIFACTS = path.resolve(__dirname, '..', '..', 'data', 'artifacts');
fs.mkdirSync(ARTIFACTS, { recursive: true });
const dir = fs.mkdtempSync(path.join(ARTIFACTS, 'fault-detection-'));

const token = (role, uid, cid = companyId) => `Bearer ${jwt.sign({ sub: uid, email: `${role}@fd.com`, companyId: cid, role },
  process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;
const tm = () => token('test_manager', tmId);

function seedRun(batch, scenario, step, checks, logLines = []) {
  const runId = uuidv4();
  run(`INSERT INTO runs (id, company_id, user_id, status, batch_id, scenario_code, queued_at, completed_at) VALUES (?, ?, ?, 'COMPLETED', ?, ?, datetime('now'), datetime('now'))`,
    [runId, companyId, tmId, batch, scenario]);
  const suite = run(`INSERT INTO run_suites (run_id, company_id, scenario_name, suite_name) VALUES (?, ?, ?, '02-Common Requests')`, [runId, companyId, scenario]).lastInsertRowid;
  const reqId = run(`INSERT INTO run_requests (suite_id, run_id, company_id, request_name, http_status) VALUES (?, ?, ?, ?, 200)`, [suite, runId, companyId, step]).lastInsertRowid;
  for (const name of checks) {
    run(`INSERT INTO run_assertions (request_id, suite_id, run_id, company_id, assertion_key, assertion_name, passed) VALUES (?, ?, ?, ?, ?, ?, 0)`,
      [reqId, suite, runId, companyId, `${step}|${name}`, name]);
  }
  for (const line of logLines) {
    run(`INSERT INTO run_events (run_id, level, message) VALUES (?, 'stdout', ?)`, [runId, colEncrypt(line)]);
  }
  return runId;
}

beforeAll(() => {
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'FD', 'fd')`, [companyId]);
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'FD Other', 'fd-other')`, [otherId]);
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, 'tm@fd.com', 'x', 'test_manager')`, [tmId, companyId]);
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, 'tester@fd.com', 'x', 'company_user')`, [testerId, companyId]);
  const file = path.join(dir, 'fd-datafile.json');
  encryptToFile(JSON.stringify({ scenarios: [
    { code: 'SIM_FAULT_OFFER_PRICE_BELOW_PARTS_38', simulatorFaults: ['offer.price-below-parts'] },
    { code: 'SIM_FAULT_ERROR_PROBLEM_WITHOUT_CODE_38', simulatorFaults: 'error.problem-without-code' },
    { code: 'SIM_FAULT_BOOKING_CURRENCY_CHANGED_38', simulatorFaults: ['booking.currency-changed'] },
    { code: 'OTST_SALE_1ADT' },
  ] }), file);
  run('UPDATE companies SET datafile_path = ? WHERE id = ?', [file, companyId]);
  seedRun('b1', 'SIM_FAULT_OFFER_PRICE_BELOW_PARTS_38', '01. POST Get Offer', ['Offer minimalPrice >= sum of admission parts price - minimalPrice: 9, admissions: 10']);
  seedRun('b1', 'SIM_FAULT_ERROR_PROBLEM_WITHOUT_CODE_38', '14. POST Booking Purchaser', [],
    ['[INFO] sweep\n[WARNING] Negative requestedInformation [purchaser.firstName]: the refusal names no OSDM problem code (Problem.code) — OSDM announces it as mandatory.']);
  seedRun('b1', 'SIM_FAULT_BOOKING_CURRENCY_CHANGED_38', '02. POST Create Booking', []);
  seedRun('b1', 'OTST_SALE_1ADT', '01. POST Get Offer', ['something else']);
  run(`INSERT INTO ai_analysis (id, company_id, user_id, mode, batch_a, language, connector, model, input_hash, input_chars, status, result_enc)
       VALUES ('an-1', ?, ?, 'single', 'b1', 'English', 'anthropic', 'claude-opus-5-5', 'h', 1, 'done', ?)`,
  [companyId, tmId, colEncrypt(JSON.stringify({ summary: 's', groups: [
    { title: 'Offer price below its admissions', owner: 'provider', steps: ['01. POST Get Offer'], scenarios: ['SIM_FAULT_OFFER_PRICE_BELOW_PARTS_38'] },
  ] }))]);
  run(`INSERT INTO ai_analysis (id, company_id, user_id, mode, batch_a, language, connector, model, input_hash, input_chars, status)
       VALUES ('an-other-batch', ?, ?, 'single', 'b2', 'English', 'anthropic', 'm', 'h', 1, 'done')`, [companyId, tmId]);
});

afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

test('Test Managers only', async () => {
  expect((await request(app).get(`${URL_}?batch=b1`).set('Authorization', token('company_user', testerId))).status).toBe(403);
});

test('a batch: each fault of its scenarios, detected or not; scenarios without faults are left out', async () => {
  const res = await request(app).get(`${URL_}?batch=b1`).set('Authorization', tm());
  expect(res.status).toBe(200);
  expect(res.body.runs).toBe(4);
  expect(res.body.summary).toEqual({ injected: 3, unknown: 0, detected: 2, asExpected: 2 });
  const by = Object.fromEntries(res.body.faults.map((f) => [f.code, f]));
  expect(by['offer.price-below-parts'].detected).toBe(true);
  expect(by['error.problem-without-code'].expectations[0].found[0].level).toBe('WARNING');
  expect(by['booking.currency-changed'].detected).toBe(false);
  expect(res.body.analysis).toBeNull();
});

test('with an analysis of that batch: the AI score', async () => {
  const res = await request(app).get(`${URL_}?batch=b1&analysis=an-1`).set('Authorization', tm());
  expect(res.status).toBe(200);
  expect(res.body.analysis).toMatchObject({ id: 'an-1', model: 'claude-opus-5-5', summary: { judged: 1, explained: 1, score: 1 } });
});

test('an analysis of another batch, an unknown one, another company\'s batch: refused', async () => {
  expect((await request(app).get(`${URL_}?batch=b1&analysis=an-other-batch`).set('Authorization', tm())).status).toBe(400);
  expect((await request(app).get(`${URL_}?batch=b1&analysis=nope`).set('Authorization', tm())).status).toBe(404);
  expect((await request(app).get(`${URL_}?batch=nope`).set('Authorization', tm())).status).toBe(404);
  expect((await request(app).get(URL_).set('Authorization', tm())).status).toBe(404);
  expect((await request(app).get(`${URL_}?batch=b1`).set('Authorization', token('test_manager', uuidv4(), otherId))).status).toBe(404);
});
