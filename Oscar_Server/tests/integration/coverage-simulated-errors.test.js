// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * coverage-simulated-errors.test.js — the simulator's deliberate errors are
 * kept out of the provider's coverage and listed apart, detected or missed
 * (#1029 PR 2), through GET /v1/company/coverage and its workbook.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-simulated-errors';

const fs      = require('fs');
const path    = require('path');
const express = require('express');
const jwt     = require('jsonwebtoken');
const request = require('supertest');
const { randomUUID: uuidv4 } = require('node:crypto');
const { run, get, colEncrypt } = require('../../src/db/db');
const { writeDatafile } = require('../../src/utils/datafileWrite');
const { readZipEntry } = require('../../src/utils/zip');

const app = express();
app.use(express.json());
app.use('/v1/company', require('../../src/api/routes/company-coverage'));

const simulator = require(path.resolve(__dirname, '../../../Bruno_Collection/data_base/simulator_datafile.json'));
const replay = require('../helpers/fault-replay.json');
const FAULT = 'SIM_FAULT_ANSWER_HTML_38';

const tag = uuidv4().slice(0, 8);
const ids = { C: uuidv4(), TM: uuidv4() };
const TM = { email: `tm-${tag}@sim-errors.example`, role: 'test_manager' };
const auth = () => ({ Authorization: `Bearer ${jwt.sign({ sub: ids.TM, email: TM.email, companyId: ids.C, role: TM.role }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}` });

const base = { scenarioType: 'SALE', tripRequirementId: 1, passengersListId: 1 };
const SCENARIOS = [
  { code: 'OTST_SALE_ONE_WAY', ...base },
  { code: 'SIM_WRONG_BOOKING_PRICE_38', ...base },
  { code: 'SIM_WRONG_SILENT_38', ...base },
  { code: 'SIM_WRONG_FARE_OVERLAP_38', ...base },
  { code: 'SIM_WRONG_FARE_WIDER_CLUSTERS_38', ...base },
  { ...simulator.scenarios.find((s) => s.code === FAULT), tripRequirementId: 1, passengersListId: 1 },
  { code: 'SIM_FAULT_NEVER_RUN_38', ...base, simulatorFaults: 'offer.price-below-parts' },
];

// A finished run of `code`: its failed checks [[step, check]] and passed ones, and [WARNING] lines.
function addRun(code, failures = [], warnings = []) {
  const id = uuidv4();
  run(`INSERT INTO runs (id, company_id, user_id, status, scenario_code, queued_at, completed_at)
       VALUES (?, ?, ?, ?, ?, datetime('now', '-1 hour'), datetime('now', '-1 hour'))`, [id, ids.C, ids.TM, failures.length ? 'FAILED' : 'COMPLETED', code]);
  const suite = run('INSERT INTO run_suites (run_id, company_id, scenario_name, suite_name) VALUES (?, ?, ?, ?)', [id, ids.C, code, 's']).lastInsertRowid;
  const steps = [...new Set(['01. POST Get Offer', ...failures.map(([step]) => step)])];
  const reqOf = Object.fromEntries(steps.map((step) => [step,
    run('INSERT INTO run_requests (suite_id, run_id, company_id, request_name, http_status) VALUES (?, ?, ?, ?, 200)', [suite, id, ids.C, step]).lastInsertRowid]));
  failures.forEach(([step, check], i) => run(`INSERT INTO run_assertions (request_id, suite_id, run_id, company_id, assertion_key, assertion_name, type, passed)
    VALUES (?, ?, ?, ?, ?, ?, 'test', 0)`, [reqOf[step], suite, id, ids.C, `f${i}`, check]));
  run(`INSERT INTO run_assertions (request_id, suite_id, run_id, company_id, assertion_key, assertion_name, type, passed)
    VALUES (?, ?, ?, ?, 'ok', 'a check that passed', 'test', 1)`, [reqOf['01. POST Get Offer'], suite, id, ids.C]);
  if (warnings.length) run('INSERT INTO run_events (run_id, level, message) VALUES (?, ?, ?)', [id, 'warn', colEncrypt(warnings.join('\n'))]);
  return id;
}

beforeAll(async () => {
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Sim Errors Co', ?)`, [ids.C, `sim-errors-${tag}`]);
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', ?)`, [ids.TM, ids.C, TM.email, TM.role]);
  await writeDatafile({ id: ids.C, slug: `sim-errors-${tag}` }, {
    scenariosToRun: ['OTST_SALE_ONE_WAY', 'SIM_WRONG_BOOKING_PRICE_38'], scenarios: SCENARIOS,
    tripRequirements: [{ id: 1, tripType: 'SEARCH', trip: { origin: 'urn:a', destination: 'urn:b' } }],
    passengersList: [{ id: 1, passengers: [{ type: 'PERSON' }] }],
  });
  run(`INSERT INTO test_frameworks (id, company_id, config) VALUES (?, ?, ?)`, [uuidv4(), ids.C, colEncrypt(JSON.stringify({ salesFlows: ['SALE'] }))]);
  addRun('OTST_SALE_ONE_WAY');
  addRun('SIM_WRONG_BOOKING_PRICE_38', [['02. POST Create Booking', 'provisionalPrice is the sum of the pre-booked parts']]);
  addRun('SIM_WRONG_SILENT_38');
  // Meant to warn only (#1029 follow-up): one gives its warning, the other only another one.
  addRun('SIM_WRONG_FARE_OVERLAP_38', [], ['[INFO] offers read', '[WARNING] [fares O8] Each passenger\'s fares do not overlap — fares covering a part of the section twice']);
  addRun('SIM_WRONG_FARE_WIDER_CLUSTERS_38', [], ['[WARNING] [fares O10] CLUSTERING: the reference cluster is one of the five']);
  addRun(FAULT, replay[FAULT].failures, replay[FAULT].warnings);
});

afterAll(() => {
  const row = get('SELECT datafile_path FROM companies WHERE id = ?', [ids.C]);
  if (row?.datafile_path) fs.rmSync(row.datafile_path, { force: true });
  run('DELETE FROM companies WHERE id = ?', [ids.C]);
  run('DELETE FROM users WHERE id = ?', [ids.TM]);
});

const isSimulated = (code) => /^SIM_(WRONG|FAULT)_/.test(code);

test('the simulated errors count in no view of the coverage', async () => {
  const res = await request(app).get('/v1/company/coverage').set(auth());
  expect(res.status).toBe(200);
  const c = res.body.byCapability;
  expect(c.points).toEqual([]);
  const formCodes = [...c.capabilities.flatMap((r) => r.tests.flatMap((t) => t.forms)), ...c.expectedRefusals.flatMap((r) => r.forms)].map((f) => f.code);
  expect(formCodes).toEqual(['OTST_SALE_ONE_WAY']);
  expect(c.apart.map((a) => a.code).filter(isSimulated)).toEqual([]);
  expect(res.body.scenarios.map((s) => s.code).filter(isSimulated)).toEqual([]);
  expect(res.body.functions.flatMap((f) => f.scenarios.map((s) => s.code)).filter(isSimulated)).toEqual([]);
});

test('they are listed apart: detected, missed, not run', async () => {
  const res = await request(app).get('/v1/company/coverage').set(auth());
  const se = res.body.byCapability.simulatedErrors;
  expect(se.summary).toEqual({ total: 6, detected: 3, missed: 2, notRun: 1 });
  const byCode = Object.fromEntries(se.entries.map((e) => [e.code, e]));
  expect(byCode.SIM_WRONG_BOOKING_PRICE_38).toMatchObject({ kind: 'wrong', result: 'detected', step: '02. POST Create Booking', check: 'provisionalPrice is the sum of the pre-booked parts' });
  expect(byCode.SIM_WRONG_SILENT_38).toMatchObject({ kind: 'wrong', result: 'missed' });
  expect(byCode.SIM_WRONG_FARE_OVERLAP_38).toMatchObject({
    kind: 'wrong', result: 'detected', step: null,
    check: '[WARNING] [fares O8] Each passenger\'s fares do not overlap — fares covering a part of the section twice',
  });
  expect(byCode.SIM_WRONG_FARE_WIDER_CLUSTERS_38).toMatchObject({
    kind: 'wrong', result: 'missed', check: 'The run passed every check and gave no [fares O11] warning: OSCAR did not see the error.',
  });
  expect(byCode[FAULT]).toMatchObject({ kind: 'fault', result: 'detected', faults: [expect.objectContaining({ detected: true })] });
  expect(byCode.SIM_FAULT_NEVER_RUN_38).toMatchObject({ kind: 'fault', result: 'not-run', runId: null });
});

test('the workbook lists them on a sheet of their own', async () => {
  const res = await request(app).get('/v1/company/coverage/download').set(auth()).buffer(true)
    .parse((r, cb) => { const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
  expect(res.status).toBe(200);
  const book = readZipEntry(res.body, 'xl/workbook.xml').toString();
  const names = [...book.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
  expect(names).toContain('Simulated errors');
  const index = names.indexOf('Simulated errors') + 1;
  const sheet = readZipEntry(res.body, `xl/worksheets/sheet${index}.xml`).toString();
  expect(sheet).toContain('SIM_WRONG_SILENT_38');
  expect(sheet).toContain('Missed');
});
