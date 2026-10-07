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
const adminId    = uuidv4();

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
  run(
    `INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role)
     VALUES (?, NULL, 'admin@platform.test', 'x', 'administrator')`,
    [adminId]
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

  // S5 (v1.11.211): api_base is fetched by every run, so a non-public endpoint
  // is a request-forgery primitive. The suite runs with ALLOW_PRIVATE_TARGETS=1
  // (tests/setup.js), so turn it off here to see the policy.
  describe('S5 — the endpoint must be a public https address', () => {
    const PRIOR = process.env.ALLOW_PRIVATE_TARGETS;
    beforeEach(() => { process.env.ALLOW_PRIVATE_TARGETS = ''; });
    afterEach(() => { process.env.ALLOW_PRIVATE_TARGETS = PRIOR; });

    test.each([
      'http://api.example.com/v1',            // not https
      'https://127.0.0.1/osdm',               // loopback
      'https://10.1.2.3/osdm',                // private
      'https://169.254.169.254/latest',       // cloud metadata
      'https://oscar:3001/data/x-datafile.json', // a Docker service name
      'https://localhost/osdm',
    ])('rejects %s and stores nothing', async (bad) => {
      const token = makeToken('test_manager');
      const before = get('SELECT api_base FROM companies WHERE id = ?', [companyId]).api_base;
      const res = await request(app).patch('/v1/company')
        .set('Authorization', `Bearer ${token}`).send({ api_base: bad });
      expect(res.status).toBe(400);
      expect(res.body.detail).toContain('public host');
      expect(get('SELECT api_base FROM companies WHERE id = ?', [companyId]).api_base).toBe(before);
    });

    test('still accepts a public https endpoint', async () => {
      const token = makeToken('test_manager');
      const res = await request(app).patch('/v1/company')
        .set('Authorization', `Bearer ${token}`).send({ api_base: 'https://api.vendor.com/osdm' });
      expect(res.status).toBe(200);
      expect(res.body.api_base).toBe('https://api.vendor.com/osdm');
    });
  });
});

// ── PATCH /v1/company — extra_headers (issue #426) ────────────────────────────
describe('PATCH /v1/company — only a Test Manager changes the API endpoint (#544)', () => {
  // api_base is shared by the whole company: every request of every run goes
  // to it with the bearer token of the tester who started the run. A tester who
  // could change it would send colleagues' runs, and their tokens, anywhere.
  const STORED = 'https://provider.example/osdm';
  const ELSEWHERE = 'https://elsewhere.example/collect';
  const storedEndpoint = () => get('SELECT api_base FROM companies WHERE id = ?', [companyId]).api_base;
  const auditCount = () => get(
    `SELECT COUNT(*) AS n FROM auth_events WHERE company_id = ? AND event_type LIKE 'company_update%'`, [companyId]).n;
  const patchAs = (role, uid, body, query = '') => request(app)
    .patch(`/v1/company${query}`)
    .set('Authorization', `Bearer ${makeToken(role, uid)}`)
    .send(body);

  beforeEach(() => {
    run('UPDATE companies SET api_base = ? WHERE id = ?', [STORED, companyId]);
  });

  test('403 for a tester who sends another endpoint, and nothing is stored', async () => {
    const before = auditCount();
    const res = await patchAs('company_user', testerId, { api_base: ELSEWHERE });
    expect(res.status).toBe(403);
    expect(res.body.detail).toMatch(/Test Manager/);
    expect(storedEndpoint()).toBe(STORED);
    expect(auditCount()).toBe(before);
  });

  test('403 for a tester when the company has no endpoint yet', async () => {
    run('UPDATE companies SET api_base = NULL WHERE id = ?', [companyId]);
    const res = await patchAs('company_user', testerId, { api_base: ELSEWHERE });
    expect(res.status).toBe(403);
    expect(storedEndpoint()).toBeNull();
  });

  test('403 for a tester whose endpoint differs only in case, scheme or path', async () => {
    for (const other of ['https://PROVIDER.example/osdm', `${STORED}/v2`, 'http://provider.example/osdm']) {
      const res = await patchAs('company_user', testerId, { api_base: other });
      expect([other, res.status]).toEqual([other, 403]);
    }
    expect(storedEndpoint()).toBe(STORED);
  });

  // The API Config page sent the endpoint it had loaded with every save, by
  // every role, until 1.11.207. A page left open across the upgrade still
  // does; that must not stop a tester from saving their own credentials.
  test('200 and no write when a tester sends back the endpoint that is stored', async () => {
    const before = auditCount();
    for (const echo of [STORED, `  ${STORED}  `]) {
      const res = await patchAs('company_user', testerId, { api_base: echo });
      expect(res.status).toBe(200);
      expect(res.body.api_base).toBe(STORED);
    }
    expect(storedEndpoint()).toBe(STORED);
    expect(auditCount()).toBe(before);
  });

  test('200 for the Test Manager, with an audit entry', async () => {
    const before = auditCount();
    const res = await patchAs('test_manager', testMgrId, { api_base: ELSEWHERE });
    expect(res.status).toBe(200);
    expect(storedEndpoint()).toBe(ELSEWHERE);
    expect(auditCount()).toBe(before + 1);
  });

  test('the Test Manager\'s endpoint is stored trimmed', async () => {
    const res = await patchAs('test_manager', testMgrId, { api_base: `  ${ELSEWHERE}\n` });
    expect(res.status).toBe(200);
    expect(storedEndpoint()).toBe(ELSEWHERE);
  });

  test('400, not a crash, when the endpoint is not a string', async () => {
    for (const bad of [42, { url: ELSEWHERE }, [ELSEWHERE], true]) {
      const res = await patchAs('test_manager', testMgrId, { api_base: bad });
      expect([JSON.stringify(bad), res.status]).toEqual([JSON.stringify(bad), 400]);
    }
    expect(storedEndpoint()).toBe(STORED);
  });

  test('200 for an administrator who names the company, as before', async () => {
    const res = await patchAs('administrator', uuidv4(), { api_base: ELSEWHERE }, `?company_id=${companyId}`);
    expect(res.status).toBe(200);
    expect(storedEndpoint()).toBe(ELSEWHERE);
  });

  test('403 for a certifier, as before', async () => {
    const res = await patchAs('certification_user', certUserId, { api_base: ELSEWHERE }, `?company_id=${companyId}`);
    expect(res.status).toBe(403);
    expect(storedEndpoint()).toBe(STORED);
  });
});

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

  // S6 (v1.11.213): values are vendor secrets — encrypted at rest, and withheld
  // from everyone except the owning Test Manager.
  describe('S6 — dedicated-header values are encrypted and not leaked', () => {
    const SECRET = 'sk-live-abcdef0123456789';
    beforeEach(async () => {
      await request(app).patch('/v1/company')
        .set('Authorization', `Bearer ${makeToken('test_manager')}`)
        .send({ extra_headers: [{ name: 'X-Api-Key', value: SECRET }] });
    });
    afterEach(async () => {
      await request(app).patch('/v1/company')
        .set('Authorization', `Bearer ${makeToken('test_manager')}`)
        .send({ extra_headers: [] });
    });

    test('stored encrypted at rest — the DB column is the enc:v1 envelope, not the plaintext secret', () => {
      const row = get('SELECT extra_headers FROM companies WHERE id = ?', [companyId]);
      expect(row.extra_headers.startsWith('enc:v1:')).toBe(true);
      expect(row.extra_headers).not.toContain(SECRET);
    });

    test('the owning Test Manager gets the value back (to edit it)', async () => {
      const res = await request(app).get('/v1/company')
        .set('Authorization', `Bearer ${makeToken('test_manager')}`);
      expect(res.body.extra_headers).toEqual([{ name: 'X-Api-Key', value: SECRET }]);
    });

    test('a tester (company_user) sees the name but not the value', async () => {
      const res = await request(app).get('/v1/company')
        .set('Authorization', `Bearer ${makeToken('company_user', testerId)}`);
      expect(res.status).toBe(200);
      expect(res.body.extra_headers).toEqual([{ name: 'X-Api-Key', value: '', has_value: true }]);
      expect(JSON.stringify(res.body)).not.toContain(SECRET);
    });

    test('a platform administrator targeting the company sees the name but not the value', async () => {
      const res = await request(app).get(`/v1/company?company_id=${companyId}`)
        .set('Authorization', `Bearer ${makeToken('administrator', adminId)}`);
      expect(res.status).toBe(200);
      expect(res.body.extra_headers).toEqual([{ name: 'X-Api-Key', value: '', has_value: true }]);
      expect(JSON.stringify(res.body)).not.toContain(SECRET);
    });

    test('a certification_user cannot read company settings at all (no leak path)', async () => {
      const res = await request(app).get(`/v1/company?company_id=${companyId}`)
        .set('Authorization', `Bearer ${makeToken('certification_user', certUserId)}`);
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain(SECRET);
    });

    test('a platform administrator editing the headers gets the response masked too', async () => {
      const ADMIN_SECRET = 'admin-set-sk-7777';
      const res = await request(app).patch(`/v1/company?company_id=${companyId}`)
        .set('Authorization', `Bearer ${makeToken('administrator', adminId)}`)
        .send({ extra_headers: [{ name: 'X-Admin-Set', value: ADMIN_SECRET }] });
      expect(res.status).toBe(200);
      expect(res.body.extra_headers).toEqual([{ name: 'X-Admin-Set', value: '', has_value: true }]);
      expect(JSON.stringify(res.body)).not.toContain(ADMIN_SECRET);
      // …and it was still stored (encrypted), readable by the owning TM.
      const asTm = await request(app).get('/v1/company').set('Authorization', `Bearer ${makeToken('test_manager')}`);
      expect(asTm.body.extra_headers).toEqual([{ name: 'X-Admin-Set', value: ADMIN_SECRET }]);
    });
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
    const token = makeToken('company_user', testerId);
    const res = await request(app)
      .post('/v1/company/datafile')
      .set('Authorization', `Bearer ${token}`)
      .attach('datafile', jsonBuffer, 'datafile.json');
    expect(res.status).toBe(403);
  });

  // S2 (v1.11.195). This used to be a NOTE explaining why the test above
  // avoided certification_user: multer ran before the role guard, so for a
  // platform role with no company id the upload middleware threw and the
  // caller got a 500. The note called that an "ordering quirk". It was the
  // symptom of the vulnerability — the same ordering let multer write the
  // upload over a company's live datafile before anyone checked the role.
  // The guard now runs first, so the case the note steered around is a clean
  // 403 like any other.
  test('403, not 500, for a certification_user with no company id', async () => {
    const token = makeToken('certification_user', certUserId);
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
