// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #827 PR A: the provider's set-up checklist, imported per company or
 * provider and told to the AI analysis. No AI service is called here.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-ai-checklist';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const jwt     = require('jsonwebtoken');
const { randomUUID: uuidv4 } = require('node:crypto');
const request = require('supertest');
const { run, get, colEncrypt, encrypt } = require('../../src/db/db');
const A = require('../../src/utils/aiAccess');
const { buildZip } = require('../../src/utils/zip');

const app = express();
app.use(express.json());
app.use('/v1/company', require('../../src/api/routes/company-ai-analysis'));
app.use('/v1/company', require('../../src/api/routes/company-ai-analysis-results'));
app.use('/v1/company', require('../../src/api/routes/company-ai-checklist'));

const companyId = uuidv4();
const providerId = uuidv4();
const otherId = uuidv4();
const tmId = uuidv4();
const otherTmId = uuidv4();
const testerId = uuidv4();
const BASE = '/v1/company/ai-analysis';
const ALPHA = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'Documentation', 'Server_Operations', 'Simulator checklists',
  'OSCAR_Test_Config_Checklist_Simulator_alpha.docx'));

function token(role, uid, cid = companyId) {
  return `Bearer ${jwt.sign({ sub: uid, email: `${role}-${uid.slice(0, 4)}@ai-cl.com`, companyId: cid, role },
    process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;
}
const tm = () => token('test_manager', tmId);
const upload = (auth, buf, name = 'filled.docx', provider = '') => request(app).post(`${BASE}/checklist`).set('Authorization', auth)
  .set('X-Provider-Id', provider).attach('checklist', buf, { filename: name, contentType: 'application/octet-stream' });

beforeAll(() => {
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'AI CL', 'ai-cl')`, [companyId]);
  run(`INSERT INTO companies (id, name, slug, parent_id) VALUES (?, 'AI CL Provider', 'ai-cl-provider', ?)`, [providerId, companyId]);
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'AI CL Other', 'ai-cl-other')`, [otherId]);
  for (const [id, cid, role] of [[tmId, companyId, 'test_manager'], [testerId, companyId, 'company_user'], [otherTmId, otherId, 'test_manager']]) {
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', ?)`, [id, cid, `${id}@ai-cl.com`, role]);
  }
});

describe('#827 PR A who may import', () => {
  test('testers and certifiers are refused before the file is read; another company\'s provider is not found', async () => {
    for (const t of [token('company_user', testerId), token('certification_user', uuidv4())]) {
      expect((await upload(t, ALPHA)).status).toBe(403);
      expect((await request(app).get(`${BASE}/checklist`).set('Authorization', t)).status).toBe(403);
    }
    expect((await upload(token('test_manager', otherTmId, otherId), ALPHA, 'f.docx', providerId)).status).toBe(404);
    expect(get('SELECT COUNT(*) AS n FROM provider_checklist').n).toBe(0);
  });
});

describe('#827 PR A importing', () => {
  test('nothing imported yet', async () => {
    const res = await request(app).get(`${BASE}/checklist`).set('Authorization', tm());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ checklist: null });
  });

  test('a filled checklist: its answers are kept encrypted, never the API Config or contact ones', async () => {
    const res = await upload(tm(), ALPHA, 'Alpha <filled>.docx');
    expect(res.status).toBe(200);
    expect(res.body.checklist).toMatchObject({ fileName: 'Alpha <filled>.docx', answers: 277, cut: 0 });
    expect(res.body.checklist.sent['info.pastDeparture']).toEqual(['REFUSED']);
    const row = get('SELECT * FROM provider_checklist WHERE company_id = ?', [companyId]);
    expect(row.answer_count).toBe(277);
    expect(row.answers_enc).not.toContain('pastDeparture');
    expect(JSON.stringify(res.body)).not.toContain('simulator-host');
    expect(get("SELECT COUNT(*) AS n FROM auth_events WHERE event_type = 'provider_checklist_imported:277'").n).toBe(1);
  });

  test('per company or provider: the provider has none until one is imported for it', async () => {
    const res = await request(app).get(`${BASE}/checklist`).set('Authorization', tm()).set('X-Provider-Id', providerId);
    expect(res.body.checklist).toBeNull();
  });

  test('files that are not a filled checklist are refused and change nothing', async () => {
    expect((await upload(tm(), Buffer.from('%PDF-1.4'), 'a.pdf')).status).toBe(400);
    const notZip = await upload(tm(), Buffer.from('hello'));
    expect(notZip.status).toBe(400);
    expect(notZip.body.detail).toContain('not a Word file');
    const empty = await upload(tm(), buildZip([{ name: 'word/document.xml', data: '<w:document/>' }]));
    expect(empty.body.detail).toContain('No answer found');
    expect((await request(app).post(`${BASE}/checklist`).set('Authorization', tm())).status).toBe(400);
    expect(get('SELECT answer_count FROM provider_checklist WHERE company_id = ?', [companyId]).answer_count).toBe(277);
  });

  test('the preview tells the model the checklist and the declared version', async () => {
    run(`INSERT INTO ai_access_request (id, company_id, user_id, state, text_version, text_hash) VALUES (?, ?, ?, 'approved', ?, 'h')`,
      [uuidv4(), companyId, tmId, A.COMMITMENT.version]);
    run(`INSERT INTO ai_config (company_id, user_id, connector, base_url, model, api_key_enc, tested_at)
         VALUES (?, ?, 'anthropic', 'https://ai.example', 'claude-sonnet-5-5', ?, datetime('now'))`, [companyId, tmId, encrypt('sk-ant-x-0123456789')]);
    run(`INSERT INTO test_frameworks (id, company_id, config) VALUES (?, ?, ?)`, [uuidv4(), companyId, colEncrypt(JSON.stringify({ osdmVersion: '3.6' }))]);
    const runId = uuidv4();
    run(`INSERT INTO runs (id, company_id, user_id, status, batch_id, scenario_code, queued_at, completed_at) VALUES (?, ?, ?, 'COMPLETED', 'b1', 'NHF_SALE_DEPARTURE_IN_PAST_SPEC', datetime('now'), datetime('now'))`,
      [runId, companyId, tmId]);
    const suite = run(`INSERT INTO run_suites (run_id, company_id, scenario_name, suite_name) VALUES (?, ?, 'S', 'x')`, [runId, companyId]).lastInsertRowid;
    const reqId = run(`INSERT INTO run_requests (suite_id, run_id, company_id, request_name, http_status) VALUES (?, ?, ?, '01. POST Get Offer', 200)`,
      [suite, runId, companyId]).lastInsertRowid;
    run(`INSERT INTO run_assertions (request_id, suite_id, run_id, company_id, assertion_key, assertion_name, passed) VALUES (?, ?, ?, ?, 'k', 'refused', 0)`,
      [reqId, suite, runId, companyId]);
    const res = await request(app).post(`${BASE}/preview`).set('Authorization', tm()).send({ batches: ['b1'] });
    expect(res.status).toBe(200);
    const input = JSON.parse(res.body.input);
    expect(input.provider.declaredOsdmVersion).toBe('3.6');
    expect(input.provider.checklist['info.pastDeparture']).toEqual(['REFUSED']);
    expect(input.scenarios[0].purpose).toContain("A departure yesterday");
    expect(res.body.instructions).toContain('The provider declares OSDM 3.6');
    expect(res.body.input).not.toContain('simulator-host');
  });

  test('removing it: 204, then 404, and the preview no longer has it', async () => {
    expect((await request(app).delete(`${BASE}/checklist`).set('Authorization', tm())).status).toBe(204);
    expect((await request(app).delete(`${BASE}/checklist`).set('Authorization', tm())).status).toBe(404);
    const res = await request(app).post(`${BASE}/preview`).set('Authorization', tm()).send({ batches: ['b1'] });
    expect(JSON.parse(res.body.input).provider.checklist).toBeNull();
  });
});
