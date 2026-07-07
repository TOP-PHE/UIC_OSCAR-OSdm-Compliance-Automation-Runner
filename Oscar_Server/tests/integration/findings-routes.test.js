// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * findings-routes.test.js — Integration tests for "Test Findings & Open Points"
 * (/v1/company/findings) plus the knownDeviations projection into the datafile.
 *
 * Covers:
 *   - Auth + role gating (read = vendor users; write = test_manager only; no admin/certifier)
 *   - Finding CRUD + threaded comments (status auto-advances on first reply)
 *   - baseline_in_run guard (only enforces with a step + numeric expected_status)
 *   - buildProjection() mapping over a real DB
 *   - End-to-end: a baselined finding lands in the datafile's knownDeviations[]
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-findings-routes';

const jwt     = require('jsonwebtoken');
const fs      = require('fs');
const { randomUUID: uuidv4 } = require('node:crypto');
const request = require('supertest');
const { buildAppWithRoute } = require('../helpers/test-app');
const { run, get } = require('../../src/db/db');
const { buildProjection } = require('../../src/utils/knownDeviationProjection');

const findingsApp = buildAppWithRoute('/v1/company', '../../src/api/routes/company-findings');
const companyApp  = buildAppWithRoute('/v1/company', '../../src/api/routes/company');   // for the e2e datafile loop

// ── Seed data ─────────────────────────────────────────────────────────────────
const companyId     = uuidv4();
const projCompanyId = uuidv4();
const tmId          = uuidv4();
const testerId      = uuidv4();
const certId        = uuidv4();

function makeToken(role, uid, cid = companyId) {
  return jwt.sign(
    { sub: uid, email: `${role}@findings-test.com`, companyId: cid, role },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
}

beforeAll(() => {
  run(`INSERT OR IGNORE INTO companies (id, name, slug) VALUES (?, 'Findings Route Test', 'findings-route-test')`, [companyId]);
  run(`INSERT OR IGNORE INTO companies (id, name, slug) VALUES (?, 'Findings Proj Test',  'findings-proj-test')`,  [projCompanyId]);
  run(`INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, 'tm@findings-test.com', 'x', 'test_manager')`, [tmId, companyId]);
  run(`INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, 'tester@findings-test.com', 'x', 'company_user')`, [testerId, companyId]);
  run(`INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, 'cert@findings-test.com', 'x', 'certification_user')`, [certId, companyId]);
});

// ── Auth + role gating ────────────────────────────────────────────────────────
describe('findings — auth + role gating', () => {
  test('401 on GET /findings without token', async () => {
    const res = await request(findingsApp).get('/v1/company/findings');
    expect(res.status).toBe(401);
  });

  test('403 on GET /findings for certification_user', async () => {
    const res = await request(findingsApp).get('/v1/company/findings').set('Authorization', `Bearer ${makeToken('certification_user', certId)}`);
    expect(res.status).toBe(403);
  });

  test('200 on GET /findings for a tester (read allowed)', async () => {
    const res = await request(findingsApp).get('/v1/company/findings').set('Authorization', `Bearer ${makeToken('company_user', testerId)}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.findings)).toBe(true);
  });

  test('403 when a tester tries to create a finding (write is test_manager-only)', async () => {
    const res = await request(findingsApp)
      .post('/v1/company/findings')
      .set('Authorization', `Bearer ${makeToken('company_user', testerId)}`)
      .send({ title: 'tester should not be able to write' });
    expect(res.status).toBe(403);
  });
});

// ── CRUD + threading ──────────────────────────────────────────────────────────
describe('findings — CRUD + threading', () => {
  let createdId;

  test('400 when creating without a title', async () => {
    const res = await request(findingsApp)
      .post('/v1/company/findings')
      .set('Authorization', `Bearer ${makeToken('test_manager', tmId)}`)
      .send({ observed: 'no title here' });
    expect(res.status).toBe(400);
  });

  test('201 creates a finding with defaults', async () => {
    const res = await request(findingsApp)
      .post('/v1/company/findings')
      .set('Authorization', `Bearer ${makeToken('test_manager', tmId)}`)
      .send({ title: 'GET passenger returns 501', step: 'GET Passenger', expectedStatus: 501, category: 'not_supported', severity: 'not_supported', baselineInRun: true });
    expect(res.status).toBe(201);
    expect(res.body.finding.id).toBeTruthy();
    expect(res.body.finding.title).toBe('GET passenger returns 501');
    expect(res.body.finding.status).toBe('open');
    expect(res.body.finding.category).toBe('not_supported');
    expect(res.body.finding.baselineInRun).toBe(true);   // has step + numeric status
    createdId = res.body.finding.id;
  });

  test('200 list includes the new finding with commentCount 0', async () => {
    const res = await request(findingsApp).get('/v1/company/findings').set('Authorization', `Bearer ${makeToken('test_manager', tmId)}`);
    expect(res.status).toBe(200);
    const f = res.body.findings.find(x => x.id === createdId);
    expect(f).toBeTruthy();
    expect(f.commentCount).toBe(0);
  });

  test('201 posting a reply moves status open → discussing', async () => {
    const post = await request(findingsApp)
      .post(`/v1/company/findings/${createdId}/comments`)
      .set('Authorization', `Bearer ${makeToken('test_manager', tmId)}`)
      .send({ body: 'Agreed — this is a core-endpoint gap, raising upstream.' });
    expect(post.status).toBe(201);
    expect(post.body.comment.body).toMatch(/core-endpoint gap/);

    const thread = await request(findingsApp).get(`/v1/company/findings/${createdId}`).set('Authorization', `Bearer ${makeToken('test_manager', tmId)}`);
    expect(thread.status).toBe(200);
    expect(thread.body.finding.status).toBe('discussing');
    expect(thread.body.comments.length).toBe(1);
  });

  test('200 PATCH classifies the finding', async () => {
    const res = await request(findingsApp)
      .patch(`/v1/company/findings/${createdId}`)
      .set('Authorization', `Bearer ${makeToken('test_manager', tmId)}`)
      .send({ category: 'provider_deviation', severity: 'minor', status: 'resolved' });
    expect(res.status).toBe(200);
    expect(res.body.finding.category).toBe('provider_deviation');
    expect(res.body.finding.severity).toBe('minor');
    expect(res.body.finding.status).toBe('resolved');
  });

  test('baseline guard: cannot baseline a finding without a step + status', async () => {
    const created = await request(findingsApp)
      .post('/v1/company/findings')
      .set('Authorization', `Bearer ${makeToken('test_manager', tmId)}`)
      .send({ title: 'a prose-only open point' });
    expect(created.status).toBe(201);
    expect(created.body.finding.baselineInRun).toBe(false);

    const patched = await request(findingsApp)
      .patch(`/v1/company/findings/${created.body.finding.id}`)
      .set('Authorization', `Bearer ${makeToken('test_manager', tmId)}`)
      .send({ baselineInRun: true });   // no step / expectedStatus → must be refused
    expect(patched.status).toBe(200);
    expect(patched.body.finding.baselineInRun).toBe(false);
  });

  test('404 GET a missing finding', async () => {
    const res = await request(findingsApp).get('/v1/company/findings/does-not-exist').set('Authorization', `Bearer ${makeToken('test_manager', tmId)}`);
    expect(res.status).toBe(404);
  });

  test('200 DELETE removes the finding (then 404)', async () => {
    const del = await request(findingsApp).delete(`/v1/company/findings/${createdId}`).set('Authorization', `Bearer ${makeToken('test_manager', tmId)}`);
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);
    const after = await request(findingsApp).get(`/v1/company/findings/${createdId}`).set('Authorization', `Bearer ${makeToken('test_manager', tmId)}`);
    expect(after.status).toBe(404);
  });
});

// ── scenario_code (#447 — link a finding to the scenario that revealed it) ────
describe('findings — scenarioCode', () => {
  test('201 create carries scenarioCode through create → list → thread', async () => {
    const created = await request(findingsApp)
      .post('/v1/company/findings')
      .set('Authorization', `Bearer ${makeToken('test_manager', tmId)}`)
      .send({ title: 'NHF refund window mismatch', scenarioCode: 'NHF_RFND_SRCH_CRIT_2ADT_2LEG' });
    expect(created.status).toBe(201);
    expect(created.body.finding.scenarioCode).toBe('NHF_RFND_SRCH_CRIT_2ADT_2LEG');

    const list = await request(findingsApp).get('/v1/company/findings').set('Authorization', `Bearer ${makeToken('test_manager', tmId)}`);
    const row = list.body.findings.find(f => f.id === created.body.finding.id);
    expect(row.scenarioCode).toBe('NHF_RFND_SRCH_CRIT_2ADT_2LEG');

    const thread = await request(findingsApp).get(`/v1/company/findings/${created.body.finding.id}`).set('Authorization', `Bearer ${makeToken('test_manager', tmId)}`);
    expect(thread.body.finding.scenarioCode).toBe('NHF_RFND_SRCH_CRIT_2ADT_2LEG');
  });

  test('scenarioCode is null when not given, and PATCH can set / clear it', async () => {
    const created = await request(findingsApp)
      .post('/v1/company/findings')
      .set('Authorization', `Bearer ${makeToken('test_manager', tmId)}`)
      .send({ title: 'not tied to a scenario yet' });
    expect(created.body.finding.scenarioCode).toBeNull();

    const patched = await request(findingsApp)
      .patch(`/v1/company/findings/${created.body.finding.id}`)
      .set('Authorization', `Bearer ${makeToken('test_manager', tmId)}`)
      .send({ scenarioCode: 'OTST_SALE_PATCH_SRCH_CRIT_1ADT_1LEG' });
    expect(patched.body.finding.scenarioCode).toBe('OTST_SALE_PATCH_SRCH_CRIT_1ADT_1LEG');

    const cleared = await request(findingsApp)
      .patch(`/v1/company/findings/${created.body.finding.id}`)
      .set('Authorization', `Bearer ${makeToken('test_manager', tmId)}`)
      .send({ scenarioCode: null });
    expect(cleared.body.finding.scenarioCode).toBeNull();
  });
});

// ── buildProjection over a real DB ────────────────────────────────────────────
describe('buildProjection', () => {
  test('includes only baselined findings that carry a step + numeric status', () => {
    run(`INSERT INTO finding (id, company_id, title, step, expected_status, baseline_in_run) VALUES (?,?,?,?,?,1)`,
      [uuidv4(), projCompanyId, 'GET passenger 501', 'GET Passenger', 501]);
    run(`INSERT INTO finding (id, company_id, title, step, expected_status, baseline_in_run) VALUES (?,?,?,?,?,0)`,
      [uuidv4(), projCompanyId, 'not baselined', 'Some Step', 500]);
    run(`INSERT INTO finding (id, company_id, title, expected_status, baseline_in_run) VALUES (?,?,?,?,1)`,
      [uuidv4(), projCompanyId, 'baselined but no step', 404]);

    const proj = buildProjection(projCompanyId);
    expect(proj).toEqual([{ step: 'GET Passenger', expectedStatus: 501, note: 'GET passenger 501', active: true }]);
  });

  test('empty for an unknown company', () => {
    expect(buildProjection('no-such-company')).toEqual([]);
  });
});

// ── End-to-end: a baselined finding lands in the served datafile ──────────────
describe('projection end-to-end (datafile knownDeviations)', () => {
  test('a baselined finding appears in GET /v1/company/datafile', async () => {
    const tmToken = makeToken('test_manager', tmId);

    // 1. Save a datafile through the real company route (encrypts on disk).
    const put = await request(companyApp)
      .put('/v1/company/datafile/json')
      .set('Authorization', `Bearer ${tmToken}`)
      .send({ scenarios: [{ code: 'X', name: 'x' }], scenariosToRun: ['X'] });
    expect(put.status).toBe(200);

    // 2. Open a baselined finding — its creation reprojects the datafile.
    const created = await request(findingsApp)
      .post('/v1/company/findings')
      .set('Authorization', `Bearer ${tmToken}`)
      .send({ title: 'baseline me', step: 'GET Passenger', expectedStatus: 501, baselineInRun: true });
    expect(created.status).toBe(201);

    // 3. The served datafile now carries the projected knownDeviations entry.
    const df = await request(companyApp).get('/v1/company/datafile').set('Authorization', `Bearer ${tmToken}`);
    expect(df.status).toBe(200);
    expect(Array.isArray(df.body.knownDeviations)).toBe(true);
    const hit = df.body.knownDeviations.find(d => d.step === 'GET Passenger' && Number(d.expectedStatus) === 501);
    expect(hit).toBeTruthy();
    expect(hit.active).toBe(true);
  });
});

// ── Cleanup ───────────────────────────────────────────────────────────────────
afterAll(() => {
  const safeRun = (sql, params) => { try { run(sql, params); } catch (_) { /* ignore */ } };
  const company = get('SELECT datafile_path FROM companies WHERE id = ?', [companyId]);
  if (company && company.datafile_path) { try { fs.unlinkSync(company.datafile_path); } catch (_) { /* ignore */ } }
  safeRun('DELETE FROM finding_comment WHERE finding_id IN (SELECT id FROM finding WHERE company_id IN (?, ?))', [companyId, projCompanyId]);
  safeRun('DELETE FROM finding WHERE company_id IN (?, ?)', [companyId, projCompanyId]);
  safeRun('DELETE FROM auth_events WHERE company_id = ?', [companyId]);
  safeRun('DELETE FROM users WHERE company_id = ?', [companyId]);
  safeRun('DELETE FROM companies WHERE id IN (?, ?)', [companyId, projCompanyId]);
});
