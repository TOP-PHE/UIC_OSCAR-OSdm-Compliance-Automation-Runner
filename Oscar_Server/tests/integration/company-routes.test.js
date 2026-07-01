// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * company-routes.test.js — Integration tests for /v1/company/*
 *
 * Covers:
 *   - Authentication enforcement (401 without token)
 *   - GET  /v1/company           — returns company profile
 *   - PATCH /v1/company          — update api_base; rejects stray credential fields
 *   - PUT  /v1/company/datafile/json — save JSON body as datafile
 *   - DELETE /v1/company/datafile    — clear datafile
 *   - GET  /v1/company/datafile      — download datafile
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-company-routes';

const jwt     = require('jsonwebtoken');
const { randomUUID: uuidv4 } = require('node:crypto');
const request = require('supertest');
const { buildAppWithRoute } = require('../helpers/test-app');
const { run, get } = require('../../src/db/db');

const app = buildAppWithRoute('/v1/company', '../../src/api/routes/company');

// ── Seed data ─────────────────────────────────────────────────────────────────
const companyId  = uuidv4();
const testMgrId  = uuidv4();
const certUserId = uuidv4();
const testerId   = uuidv4();

function makeToken(role, uid = testMgrId, cid = companyId) {
  return jwt.sign(
    { sub: uid, email: `${role}@test-company.com`, companyId: cid, role },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
}

const VALID_DATAFILE = {
  scenarios:    [{ code: 'OTST_BKG_CREATE_1ADT_1LEG', name: 'Create 1-leg booking' }],
  scenariosToRun: ['OTST_BKG_CREATE_1ADT_1LEG']
};

beforeAll(() => {
  run(`INSERT OR IGNORE INTO companies (id, name, slug) VALUES (?, 'Company Route Test', 'company-route-test')`, [companyId]);
  run(
    `INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role)
     VALUES (?, ?, 'test_manager@test-company.com', 'x', 'test_manager')`,
    [testMgrId, companyId]
  );
  run(
    `INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role)
     VALUES (?, ?, 'cert_user@test-company.com', 'x', 'certification_user')`,
    [certUserId, companyId]
  );
  run(
    `INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role)
     VALUES (?, ?, 'tester@test-company.com', 'x', 'company_user')`,
    [testerId, companyId]
  );
});

// ── Authentication guard ──────────────────────────────────────────────────────
describe('Authentication guard', () => {
  test('401 on GET /v1/company without token', async () => {
    const res = await request(app).get('/v1/company');
    expect(res.status).toBe(401);
  });
});

// ── GET /v1/company ───────────────────────────────────────────────────────────
describe('GET /v1/company', () => {
  test('200 returns sanitised company profile', async () => {
    const token = makeToken('test_manager');
    const res = await request(app)
      .get('/v1/company')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(companyId);
    expect(res.body.name).toBe('Company Route Test');
    // No credential secrets in response
    expect(res.body.access_token_enc).toBeUndefined();
    expect(res.body.client_secret_enc).toBeUndefined();
  });
});

// ── PATCH /v1/company ─────────────────────────────────────────────────────────
describe('PATCH /v1/company', () => {
  test('400 when no update fields provided', async () => {
    const token = makeToken('test_manager');
    const res = await request(app)
      .patch('/v1/company')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  test('400 when stray credential field is included (moved to /v1/me/credentials)', async () => {
    const token = makeToken('test_manager');
    const res = await request(app)
      .patch('/v1/company')
      .set('Authorization', `Bearer ${token}`)
      .send({ access_token: 'some-token' });
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/v1\/me\/credentials/);
  });

  test('200 updates api_base successfully', async () => {
    const token = makeToken('test_manager');
    const res = await request(app)
      .patch('/v1/company')
      .set('Authorization', `Bearer ${token}`)
      .send({ api_base: 'https://api.example.com/v1' });
    expect(res.status).toBe(200);
    expect(res.body.api_base).toBe('https://api.example.com/v1');
  });

  test('400 when the retired share_reports_with_certifier field is sent', async () => {
    const token = makeToken('test_manager');
    const res = await request(app)
      .patch('/v1/company')
      .set('Authorization', `Bearer ${token}`)
      .send({ share_reports_with_certifier: true });
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/per-report/i);
  });
});

// ── PATCH /v1/company — extra_headers (issue #426) ────────────────────────────
describe('PATCH /v1/company — extra_headers', () => {
  test('403 for a non-test_manager (certification_user)', async () => {
    const token = makeToken('certification_user', certUserId);
    const res = await request(app)
      .patch('/v1/company')
      .set('Authorization', `Bearer ${token}`)
      .send({ extra_headers: [{ name: 'X-Foo', value: 'bar' }] });
    expect(res.status).toBe(403);
  });

  test('400 when extra_headers is not an array', async () => {
    const token = makeToken('test_manager');
    const res = await request(app)
      .patch('/v1/company')
      .set('Authorization', `Bearer ${token}`)
      .send({ extra_headers: 'not-an-array' });
    expect(res.status).toBe(400);
  });

  test('400 for an invalid header name', async () => {
    const token = makeToken('test_manager');
    const res = await request(app)
      .patch('/v1/company')
      .set('Authorization', `Bearer ${token}`)
      .send({ extra_headers: [{ name: 'bad header!!', value: 'x' }] });
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/invalid header name/i);
  });

  test('400 when a header value contains CR/LF (header injection)', async () => {
    const token = makeToken('test_manager');
    const res = await request(app)
      .patch('/v1/company')
      .set('Authorization', `Bearer ${token}`)
      .send({ extra_headers: [{ name: 'X-Foo', value: 'line1\r\nline2' }] });
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/CR or LF/i);
  });

  test('400 when there are too many headers', async () => {
    const token = makeToken('test_manager');
    const many = Array.from({ length: 26 }, (_, i) => ({ name: `X-H${i}`, value: 'v' }));
    const res = await request(app)
      .patch('/v1/company')
      .set('Authorization', `Bearer ${token}`)
      .send({ extra_headers: many });
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/too many/i);
  });

  test('200 sets, then clears (empty array -> null), extra_headers', async () => {
    const token = makeToken('test_manager');
    const set = await request(app)
      .patch('/v1/company')
      .set('Authorization', `Bearer ${token}`)
      .send({ extra_headers: [{ name: 'X-Requestor', value: '{{requestor}}' }] });
    expect(set.status).toBe(200);
    expect(set.body.extra_headers).toEqual([{ name: 'X-Requestor', value: '{{requestor}}' }]);

    const cleared = await request(app)
      .patch('/v1/company')
      .set('Authorization', `Bearer ${token}`)
      .send({ extra_headers: [] });
    expect(cleared.status).toBe(200);
    expect(cleared.body.extra_headers).toEqual([]);
    const row = get('SELECT extra_headers FROM companies WHERE id = ?', [companyId]);
    expect(row.extra_headers).toBeNull();
  });
});

// ── PUT /v1/company/datafile/json ─────────────────────────────────────────────
describe('PUT /v1/company/datafile/json', () => {
  test('401 without token', async () => {
    const res = await request(app)
      .put('/v1/company/datafile/json')
      .send(VALID_DATAFILE);
    expect(res.status).toBe(401);
  });

  test('403 for certification_user', async () => {
    const token = makeToken('certification_user', certUserId);
    const res = await request(app)
      .put('/v1/company/datafile/json')
      .set('Authorization', `Bearer ${token}`)
      .send(VALID_DATAFILE);
    expect(res.status).toBe(403);
  });

  test('400 when body is not an object', async () => {
    const token = makeToken('test_manager');
    const res = await request(app)
      .put('/v1/company/datafile/json')
      .set('Authorization', `Bearer ${token}`)
      .send([]);
    expect(res.status).toBe(400);
  });

  test('400 when scenarios array is missing', async () => {
    const token = makeToken('test_manager');
    const res = await request(app)
      .put('/v1/company/datafile/json')
      .set('Authorization', `Bearer ${token}`)
      .send({ scenariosToRun: [] });
    expect(res.status).toBe(400);
  });

  test('400 when scenariosToRun array is missing', async () => {
    const token = makeToken('test_manager');
    const res = await request(app)
      .put('/v1/company/datafile/json')
      .set('Authorization', `Bearer ${token}`)
      .send({ scenarios: [] });
    expect(res.status).toBe(400);
  });

  test('200 saves datafile and returns summary', async () => {
    const token = makeToken('test_manager');
    const res = await request(app)
      .put('/v1/company/datafile/json')
      .set('Authorization', `Bearer ${token}`)
      .send(VALID_DATAFILE);
    expect(res.status).toBe(200);
    expect(res.body.hash).toBeTruthy();
    expect(res.body.scenarios_count).toBe(1);
    expect(res.body.to_run_count).toBe(1);
    expect(res.body.filename).toMatch(/datafile\.json$/);
    // Verify DB was updated
    const company = get('SELECT datafile_hash FROM companies WHERE id = ?', [companyId]);
    expect(company.datafile_hash).toBe(res.body.hash);
  });
});

// ── POST /v1/company/datafile (multipart file upload) ────────────────────────
describe('POST /v1/company/datafile', () => {
  const jsonBuffer = Buffer.from(JSON.stringify(VALID_DATAFILE), 'utf8');

  test('401 without token', async () => {
    const res = await request(app)
      .post('/v1/company/datafile')
      .attach('datafile', jsonBuffer, 'datafile.json');
    expect(res.status).toBe(401);
  });

  test('403 for a non-test_manager (tester)', async () => {
    // NOTE: certification_user is deliberately NOT used here. It's a platform
    // role (isPlatformRole), so multer's filename callback looks for an
    // explicit company_id (header/query/body) instead of req.user.companyId —
    // without one it throws inside the upload middleware (a pre-existing
    // ordering quirk: multer runs before this route's own requireTestManager
    // check), surfacing as 500 rather than the clean 403 this test wants. A
    // tester is not a platform role, so the upload succeeds and the route's
    // own guard is what returns 403 — the actual branch this test targets.
    const token = makeToken('company_user', testerId);
    const res = await request(app)
      .post('/v1/company/datafile')
      .set('Authorization', `Bearer ${token}`)
      .attach('datafile', jsonBuffer, 'datafile.json');
    expect(res.status).toBe(403);
  });

  test('400 when no file is attached', async () => {
    const token = makeToken('test_manager');
    const res = await request(app)
      .post('/v1/company/datafile')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/no file uploaded/i);
  });

  test('400 when the uploaded file is not valid JSON', async () => {
    const token = makeToken('test_manager');
    const res = await request(app)
      .post('/v1/company/datafile')
      .set('Authorization', `Bearer ${token}`)
      .attach('datafile', Buffer.from('{ not valid json', 'utf8'), 'datafile.json');
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/not valid json/i);
  });

  test('200 uploads, encrypts, and hashes the datafile', async () => {
    const token = makeToken('test_manager');
    const res = await request(app)
      .post('/v1/company/datafile')
      .set('Authorization', `Bearer ${token}`)
      .attach('datafile', jsonBuffer, 'datafile.json');
    expect(res.status).toBe(200);
    expect(res.body.hash).toBeTruthy();
    expect(res.body.filename).toMatch(/-datafile\.json$/);

    const company = get('SELECT datafile_hash, datafile_path FROM companies WHERE id = ?', [companyId]);
    expect(company.datafile_hash).toBe(res.body.hash);
    expect(company.datafile_path).toBeTruthy();

    // The uploaded plaintext is not stored as-is on disk — it's encrypted.
    const onDisk = require('fs').readFileSync(company.datafile_path, 'utf8');
    expect(onDisk).not.toContain('OTST_BKG_CREATE_1ADT_1LEG');

    // And it round-trips back out through GET /datafile.
    const downloaded = await request(app)
      .get('/v1/company/datafile')
      .set('Authorization', `Bearer ${token}`);
    expect(downloaded.status).toBe(200);
    expect(downloaded.body.scenarios[0].code).toBe('OTST_BKG_CREATE_1ADT_1LEG');
  });
});

// ── DELETE /v1/company/datafile ───────────────────────────────────────────────
describe('DELETE /v1/company/datafile', () => {
  test('403 for certification_user', async () => {
    const token = makeToken('certification_user', certUserId);
    const res = await request(app)
      .delete('/v1/company/datafile')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  test('200 clears datafile', async () => {
    const token = makeToken('test_manager');
    const res = await request(app)
      .delete('/v1/company/datafile')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    // Verify DB cleared
    const company = get('SELECT datafile_hash, datafile_path FROM companies WHERE id = ?', [companyId]);
    expect(company.datafile_hash).toBeNull();
    expect(company.datafile_path).toBeNull();
  });
});

// ── GET /v1/company/datafile ──────────────────────────────────────────────────
describe('GET /v1/company/datafile', () => {
  test('404 when no datafile is configured', async () => {
    const token = makeToken('test_manager');
    const res = await request(app)
      .get('/v1/company/datafile')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  test('200 returns datafile when configured', async () => {
    // Re-save a datafile so we can download it
    const token = makeToken('test_manager');
    await request(app)
      .put('/v1/company/datafile/json')
      .set('Authorization', `Bearer ${token}`)
      .send(VALID_DATAFILE);

    const res = await request(app)
      .get('/v1/company/datafile')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.scenarios).toBeDefined();
  });
});

// ── Cleanup ───────────────────────────────────────────────────────────────────
// Dependent rows accumulate during the test run (auth_events from credential
// updates, possibly runs/run_* if the test creates any). We have to delete
// in FK-safe order or SQLite will throw "FOREIGN KEY constraint failed".
// Each error is swallowed individually so a partial cleanup still proceeds —
// the test process gets its own temp DB anyway, but a clean teardown helps
// when running tests in series locally.
afterAll(() => {
  const company = get('SELECT datafile_path FROM companies WHERE id = ?', [companyId]);
  if (company && company.datafile_path) {
    try { require('fs').unlinkSync(company.datafile_path); } catch (_) { /* ignore */ }
  }
  const safeRun = (sql, params) => { try { run(sql, params); } catch (_) { /* ignore */ } };
  // Children of users — cleared first
  safeRun('DELETE FROM auth_events WHERE company_id = ?', [companyId]);
  // Children of runs — cleared before runs themselves
  safeRun('DELETE FROM run_artifacts WHERE run_id IN (SELECT id FROM runs WHERE company_id = ?)', [companyId]);
  safeRun('DELETE FROM run_events    WHERE run_id IN (SELECT id FROM runs WHERE company_id = ?)', [companyId]);
  safeRun('DELETE FROM run_assertions WHERE run_id IN (SELECT id FROM runs WHERE company_id = ?)', [companyId]);
  safeRun('DELETE FROM run_requests   WHERE run_id IN (SELECT id FROM runs WHERE company_id = ?)', [companyId]);
  safeRun('DELETE FROM run_suites     WHERE run_id IN (SELECT id FROM runs WHERE company_id = ?)', [companyId]);
  safeRun('DELETE FROM runs WHERE company_id = ?', [companyId]);
  safeRun('DELETE FROM test_resources  WHERE company_id = ?', [companyId]);
  safeRun('DELETE FROM test_frameworks WHERE company_id = ?', [companyId]);
  safeRun('DELETE FROM users WHERE company_id = ?', [companyId]);
  safeRun('DELETE FROM companies WHERE id = ?', [companyId]);
});
