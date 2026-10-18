// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #823: what the AI analysis preview sends now holds the [WARNING] lines of
 * the batch's run logs, apart from the failures, and each scenario's OSDM
 * version and what the Test Framework does not declare of it. The first
 * analysis with a real AI service took scenarios written for OSDM 3.8, run on
 * a provider declaring 3.6.0, for OSCAR's errors: it was told neither.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-ai-analysis-warnings';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');
const { randomUUID: uuidv4 } = require('node:crypto');
const request = require('supertest');
const { run, colEncrypt, encrypt } = require('../../src/db/db');
const { encryptToFile } = require('../../src/utils/at-rest');
const A = require('../../src/utils/aiAccess');

const app = express();
app.use(express.json());
app.use('/v1/company', require('../../src/api/routes/company-ai-analysis-results'));

const companyId = uuidv4();
const otherId = uuidv4();
const tmId = uuidv4();
// at-rest writes only under data/artifacts or data/datafiles.
const ARTIFACTS = path.resolve(__dirname, '..', '..', 'data', 'artifacts');
fs.mkdirSync(ARTIFACTS, { recursive: true });
const dir = fs.mkdtempSync(path.join(ARTIFACTS, 'ai-warnings-'));
const DATA = path.resolve(__dirname, '../../../Bruno_Collection/data_base');
const datafile = JSON.parse(fs.readFileSync(path.join(DATA, 'simulator_datafile.json'), 'utf8'));
const alpha = JSON.parse(fs.readFileSync(path.join(DATA, 'reference', 'simulator-alpha.json'), 'utf8'));

const tm = () => `Bearer ${jwt.sign({ sub: tmId, email: 'tm@ai-warn.com', companyId, role: 'test_manager' },
  process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;

// One run of one scenario: one failed check, and its log rows as [level, request, message].
function seedRun(batch, scenario, events, company = companyId, status = 'COMPLETED') {
  const runId = uuidv4();
  run(`INSERT INTO runs (id, company_id, user_id, status, batch_id, scenario_code, queued_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`, [runId, company, tmId, status, batch, scenario]);
  const suite = run(`INSERT INTO run_suites (run_id, company_id, scenario_name, suite_name) VALUES (?, ?, ?, '02-Common Requests')`,
    [runId, company, scenario]).lastInsertRowid;
  const req = run(`INSERT INTO run_requests (suite_id, run_id, company_id, request_name, http_status) VALUES (?, ?, ?, '01b. POST Get Return Offer', 200)`,
    [suite, runId, company]).lastInsertRowid;
  run(`INSERT INTO run_assertions (request_id, suite_id, run_id, company_id, assertion_key, assertion_name, passed) VALUES (?, ?, ?, ?, 'k', 'offer covers the inbound trip', 0)`,
    [req, suite, runId, company]);
  for (const [level, requestName, message] of events) {
    run('INSERT INTO run_events (run_id, level, request_name, message) VALUES (?, ?, ?, ?)', [runId, level, requestName, colEncrypt(message)]);
  }
}

beforeAll(() => {
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'AI Warn', ?)`, [companyId, `ai-warn-${companyId.slice(0, 8)}`]);
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'AI Warn Other', ?)`, [otherId, `ai-warn-o-${otherId.slice(0, 8)}`]);
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, 'tm@ai-warn.com', 'x', 'test_manager')`, [tmId, companyId]);
  run(`INSERT INTO ai_access_request (id, company_id, user_id, state, text_version, text_hash) VALUES (?, ?, ?, 'approved', ?, 'h')`,
    [uuidv4(), companyId, tmId, A.COMMITMENT.version]);
  run(`INSERT INTO ai_config (company_id, user_id, connector, base_url, model, api_key_enc, tested_at)
       VALUES (?, ?, 'anthropic', 'https://ai.example', 'claude-opus-5-5', ?, datetime('now'))`, [companyId, tmId, encrypt('sk-ant-warn-0123456789')]);
  run('INSERT INTO test_frameworks (id, company_id, config) VALUES (?, ?, ?)', [uuidv4(), companyId, colEncrypt(JSON.stringify(alpha.framework))]);
  const file = path.join(dir, 'datafile.json');
  encryptToFile(JSON.stringify(datafile), file);
  run('UPDATE companies SET datafile_path = ? WHERE id = ?', [file, companyId]);

  seedRun('b-1', 'SIM_RETURN_COMBINED_1ADT_38', [
    ['warn', '01. POST Get Offer', '[WARNING] ⚠️ returnModel COMBINED is not declared in the Test Framework'],
    ['warn', '07. GET Booking after Fulfillments', '[WARNING] booked part afterSaleConditions absent for passenger "Jane Doe" (part 4711)'],
    ['warn', null, '[runner] Env file deletion attempt 1 failed: EBUSY'],
    ['info', '07. GET Booking after Fulfillments', '[INFO] confirmedPrice 5150'],
  ]);
  seedRun('b-1', 'SIM_SALE_SEARCH_1ADT_36', [
    ['warn', '07. GET Booking after Fulfillments', '[WARNING] booked part afterSaleConditions absent for passenger "John Roe" (part 4712)'],
  ]);
  seedRun('b-1', 'SIM_SALE_SEARCH_1ADT_36', [['warn', '07. GET Booking', '[WARNING] from a run still running']], companyId, 'RUNNING');
  seedRun('b-1', 'SIM_SALE_SEARCH_1ADT_36', [['warn', '07. GET Booking', '[WARNING] another company']], otherId);
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

test('the preview sends the warnings of the finished runs, grouped and without values, apart from the failures', async () => {
  const res = await request(app).post('/v1/company/ai-analysis/preview').set('Authorization', tm()).send({ batches: ['b-1'] });
  expect(res.status).toBe(200);
  const input = JSON.parse(res.body.input);
  expect(input.failures).toHaveLength(1);
  expect(input.warnings).toEqual([
    { step: '07. GET Booking after Fulfillments', warning: 'booked part afterSaleConditions absent for passenger "…" (part N)', count: 2,
      scenarios: ['SIM_RETURN_COMBINED_1ADT_38', 'SIM_SALE_SEARCH_1ADT_36'], moreScenarios: 0 },
    { step: '01. POST Get Offer', warning: 'returnModel COMBINED is not declared in the Test Framework', count: 1,
      scenarios: ['SIM_RETURN_COMBINED_1ADT_38'], moreScenarios: 0 },
  ]);
  expect(res.body.counts).toEqual({ groups: 1, warningGroups: 2 });
  expect(res.body.batches[0]).toMatchObject({ failedChecks: 2, warnings: 3, warningsTruncated: false });
  for (const text of ['Jane Doe', 'John Roe', '4711', 'EBUSY', 'confirmedPrice', 'still running', 'another company']) expect(res.body.input).not.toContain(text);
});

test('each scenario names its OSDM version and what the Test Framework does not declare of it', async () => {
  const res = await request(app).post('/v1/company/ai-analysis/preview').set('Authorization', tm()).send({ batches: ['b-1'] });
  const input = JSON.parse(res.body.input);
  const byCode = Object.fromEntries(input.scenarios.map((s) => [s.code, s]));
  expect(input.provider.declaredOsdmVersion).toBe('3.6.0');
  expect(byCode.SIM_RETURN_COMBINED_1ADT_38).toMatchObject({ osdmVersion: '3.8.0', notDeclaredInTestFramework: ['returnModel'] });
  expect(byCode.SIM_SALE_SEARCH_1ADT_36.osdmVersion).toBe('3.6.0');
  expect(byCode.SIM_SALE_SEARCH_1ADT_36).not.toHaveProperty('notDeclaredInTestFramework');
  expect(res.body.instructions).toContain('its failures are the configuration\'s first');
});
