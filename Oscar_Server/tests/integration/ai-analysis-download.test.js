// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #867: GET /v1/company/ai-analysis/history/:id/download, an analysis's
 * groups with the failing requests of each as one Markdown file. The readers
 * of the history only; headers and the endpoint's host never in the file.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-ai-analysis-download';

const express = require('express');
const jwt = require('jsonwebtoken');
const { randomUUID: uuidv4 } = require('node:crypto');
const request = require('supertest');
const { run, get, colEncrypt } = require('../../src/db/db');
const DL = require('../../src/utils/aiAnalysisDownload');

const app = express();
app.use(express.json());
app.use('/v1/company', require('../../src/api/routes/company-ai-analysis-results'));

const companyId = uuidv4();
const otherId = uuidv4();
const tmId = uuidv4();
const otherTmId = uuidv4();
const testerId = uuidv4();
const certId = uuidv4();
const adminId = uuidv4();
const BASE = '/v1/company/ai-analysis/history';
const HOST = 'osdm.secret-provider.example';

const token = (role, uid, cid = companyId) => `Bearer ${jwt.sign({ sub: uid, email: `${role}@ai-dl.com`, companyId: cid, role },
  process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;
const tm = () => token('test_manager', tmId);

const result = {
  summary: 'The booking is refused.',
  groups: [
    { title: 'Booking refused', cause: 'The provider asks a purchaser.', owner: 'provider', why: 'A 400 MISSING_INFORMATION.',
      action: 'The provider says which member.', steps: ['02. POST Booking'], scenarios: ['OTST_DL_A'] },
    { title: 'Offer slow', cause: 'c', owner: 'oscar', why: 'w', action: 'a', steps: ['01. POST Get Offer'], scenarios: ['OTST_DL_A'] },
  ],
};

function analysis(company, status = 'done', body = result, batch = 'batch-dl') {
  const id = uuidv4();
  run(`INSERT INTO ai_analysis (id, company_id, user_id, mode, batch_a, language, connector, model, input_hash, input_chars, status, result_enc)
       VALUES (?, ?, ?, 'one', ?, 'English', 'anthropic', 'claude-opus-5-5', 'h', 10, ?, ?)`,
  [id, company, tmId, batch, status, body ? colEncrypt(JSON.stringify(body)) : null]);
  return id;
}

// One run with one failing request at `step`, its bodies and headers stored as the runner stores them.
function failingRun({ step, sent, got, check = 'status is 201', status = 400, scenario = 'OTST_DL_A', batch = 'batch-dl', passed = 0 }) {
  const runId = uuidv4();
  run(`INSERT INTO runs (id, company_id, user_id, status, batch_id, scenario_code, queued_at, completed_at)
       VALUES (?, ?, ?, 'COMPLETED', ?, ?, datetime('now'), datetime('now'))`, [runId, companyId, tmId, batch, scenario]);
  const suite = run(`INSERT INTO run_suites (run_id, company_id, scenario_name, suite_name) VALUES (?, ?, ?, 'x')`, [runId, companyId, scenario]).lastInsertRowid;
  const reqId = run(`INSERT INTO run_requests (suite_id, run_id, company_id, request_name, http_method, http_url, http_status,
                       request_headers, request_body, response_headers, response_body)
                     VALUES (?, ?, ?, ?, 'POST', ?, ?, ?, ?, ?, ?)`,
  [suite, runId, companyId, step, `https://${HOST}/alpha/bookings?client_secret=cs-999&embed=ALL`, status,
    colEncrypt(JSON.stringify({ Authorization: 'Bearer tok-hdr-123', Requestor: 'req-hdr-456' })),
    colEncrypt(typeof sent === 'string' ? sent : JSON.stringify(sent)),
    colEncrypt(JSON.stringify({ 'x-api-key': 'resp-hdr-789' })),
    colEncrypt(typeof got === 'string' ? got : JSON.stringify(got))]).lastInsertRowid;
  run(`INSERT INTO run_assertions (request_id, suite_id, run_id, company_id, assertion_key, assertion_name, passed) VALUES (?, ?, ?, ?, 'k', ?, ?)`,
    [reqId, suite, runId, companyId, check, passed]);
  return { runId, reqId };
}

let doneId;
beforeAll(() => {
  run(`INSERT INTO companies (id, name, slug, api_base) VALUES (?, 'AI Download Rail', ?, ?)`, [companyId, `ai-dl-${companyId.slice(0, 8)}`, `https://${HOST}/alpha`]);
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'AI Download Other', ?)`, [otherId, `ai-dl-o-${otherId.slice(0, 8)}`]);
  for (const [id, role, cid] of [[tmId, 'test_manager', companyId], [testerId, 'company_user', companyId], [certId, 'certification_user', companyId],
    [adminId, 'administrator', companyId], [otherTmId, 'test_manager', otherId]]) {
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', ?)`, [id, cid, `${id}@ai-dl.com`, role]);
  }
  doneId = analysis(companyId);
  failingRun({ step: '02. POST Booking', sent: { offers: [{ offerId: 'O-1' }], passengers: [{ firstName: 'Marie' }], requestor: 'body-req-1' },
    got: { problems: [{ code: 'MISSING_INFORMATION', title: 'Marie needs a purchaser' }], _links: { self: `https://${HOST}/alpha/bookings/B-1` } } });
  failingRun({ step: '02. POST Booking', sent: { big: 'q'.repeat(DL.MAX_BODY_CHARS + 500) }, got: 'not json' });
  for (let i = 0; i < 3; i++) failingRun({ step: '02. POST Booking', sent: { n: i }, got: { n: i } });
  failingRun({ step: '02. POST Booking', sent: { passedOnly: true }, got: {}, passed: 1 });
  failingRun({ step: '02. POST Booking', sent: { otherBatch: true }, got: {}, batch: 'batch-elsewhere' });
});

const download = (id, auth = tm()) => request(app).get(`${BASE}/${id}/download`).set('Authorization', auth);

test('a Test Manager gets one Markdown file named by date and company, the groups in order, with their failing requests', async () => {
  const res = await download(doneId);
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toMatch(/^text\/markdown/);
  expect(res.headers['content-disposition']).toMatch(/^attachment; filename="oscar-analysis-\d{4}-\d{2}-\d{2}-ai-dl-[a-f0-9]{8}\.md"$/);
  const t = res.text;
  expect(t.indexOf('## 1. Booking refused')).toBeLessThan(t.indexOf('## 2. Offer slow'));
  expect(t).toContain('- **Owner:** Provider');
  expect(t).toContain('#### 1.1 OTST_DL_A — 02. POST Booking');
  expect(t).toContain('` POST /alpha/bookings?client_secret=<removed>&embed=ALL `');
  expect(t).toContain('"firstName": "Marie"');                 // the company's own test data, not masked
  expect(t).toContain('"code": "MISSING_INFORMATION"');
  expect(t).toContain('**Response:** HTTP 400');
  expect(t).toContain('  - status is 201');
  expect(t).toContain('No failing request of the batch matches');   // group 2: no request at 01
  expect(get('SELECT COUNT(*) AS n FROM auth_events WHERE event_type = ?', [`ai_analysis_downloaded:${doneId}`]).n).toBe(1);
});

test('never a header, the endpoint\'s host or a credential in the file', async () => {
  const t = (await download(doneId)).text;
  for (const secret of ['tok-hdr-123', 'req-hdr-456', 'resp-hdr-789', 'cs-999', 'body-req-1', 'secret-provider', 'Authorization']) {
    expect(t).not.toContain(secret);
  }
  expect(t).toContain('"self": "https://<host>/alpha/bookings/B-1"');
});

test('a body over 20 KB is cut, saying where; the others are counted as left out; other batches and passed checks are not read', async () => {
  const t = (await download(doneId)).text;
  expect(t).toContain(`_The request body is cut here: ${DL.MAX_BODY_CHARS} of its`);
  expect(t).toContain('```\nnot json\n```');
  expect(t).toContain('#### 1.3 OTST_DL_A');
  expect(t).not.toContain('#### 1.4');
  expect(t).toContain('_2 more failing request(s) of this group left out');
  expect(t).not.toContain('passedOnly');
  expect(t).not.toContain('otherBatch');
});

test('refused to a tester, a certifier and an administrator; another company\'s analysis is a 404; no result is a 409', async () => {
  expect((await download(doneId, token('company_user', testerId))).status).toBe(403);
  expect((await download(doneId, token('certification_user', certId))).status).toBe(403);
  expect((await download(doneId, token('administrator', adminId))).status).toBe(403);
  expect((await download(doneId, token('test_manager', otherTmId, otherId))).status).toBe(404);
  expect((await download(analysis(otherId))).status).toBe(404);
  expect((await download('no-such-id')).status).toBe(404);
  expect((await download(analysis(companyId, 'running', null))).status).toBe(409);
  expect((await download(analysis(companyId, 'unreadable', { raw: 'x' }))).status).toBe(409);
});
