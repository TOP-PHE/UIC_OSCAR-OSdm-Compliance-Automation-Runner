// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * runs-routes.test.js — Integration tests for /v1/runs/*
 *
 * Covers:
 *   - 401 without token
 *   - 403 for certification_user trying to delete
 *   - GET /v1/runs returns paginated list scoped to caller's company
 *   - DELETE /v1/runs/:id soft-deletes (status → DELETION_REQUESTED)
 *   - POST /v1/runs submission validation + a real (queue-only) happy path
 *   - GET /v1/runs/queue-status, POST /v1/runs/stop-all
 *   - GET /v1/runs/:id, /logs, /assertions, /requests, /requests/:reqId,
 *     /artifacts, /artifacts/:aid — seeded via a full run graph + an
 *     at-rest-encrypted artifact file (mirrors reports-routes.test.js)
 *   - POST/DELETE /v1/runs/:id/share (certifier-sharing toggle)
 *   - DELETE /v1/runs/:id/cancel
 *   - POST /v1/runs/bulk-admin-action (administrator-only batch ops)
 *   - GET /v1/runs/batch/:batchId and /reports.zip
 *
 * Does NOT exercise queue.enqueue → executeRun (worker tests live elsewhere);
 * POST / only asserts the DB rows + queue enqueue call, not actual Bruno
 * execution (BRU_CMD is a stub per tests/setup.js).
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-runs-routes';

const jwt     = require('jsonwebtoken');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const { randomUUID: uuidv4 } = require('node:crypto');
const request = require('supertest');
const { buildAppWithRoute } = require('../helpers/test-app');
const { run, get, colEncrypt } = require('../../src/db/db');
const { encryptToFile, encryptBuffer } = require('../../src/utils/at-rest');

const app = buildAppWithRoute('/v1/runs', '../../src/api/routes/runs');

const companyId = uuidv4();
const userId    = uuidv4();
const adminId   = uuidv4();
let runId;

function makeToken(role, uid = userId, cid = companyId) {
  return jwt.sign(
    { sub: uid, email: `${role}@test.com`, companyId: cid, role },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
}

beforeAll(() => {
  // Seed a company, two users, and one completed run we can interact with
  run(`INSERT OR IGNORE INTO companies (id, name, slug) VALUES (?, 'Runs Test Co', 'runs-test-co')`, [companyId]);
  run(
    `INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role)
     VALUES (?, ?, 'tester@test.com', 'x', 'company_user')`,
    [userId, companyId]
  );
  run(
    `INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role)
     VALUES (?, ?, 'admin@test.com', 'x', 'administrator')`,
    [adminId, companyId]
  );
  runId = uuidv4();
  run(
    `INSERT INTO runs (id, company_id, user_id, status, exit_code, started_at, completed_at)
     VALUES (?, ?, ?, 'COMPLETED', 0, datetime('now'), datetime('now'))`,
    [runId, companyId, userId]
  );
});

describe('GET /v1/runs', () => {
  test('401 without token', async () => {
    const res = await request(app).get('/v1/runs');
    expect(res.status).toBe(401);
  });

  test('200 returns paginated runs scoped to company', async () => {
    const token = makeToken('company_user');
    const res = await request(app)
      .get('/v1/runs')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.runs)).toBe(true);
    expect(res.body.runs.find(r => r.id === runId)).toBeTruthy();
    expect(res.body.total).toBeGreaterThanOrEqual(1);
  });

  test('respects limit and offset query params', async () => {
    const token = makeToken('company_user');
    const res = await request(app)
      .get('/v1/runs?limit=1&offset=0')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.runs.length).toBeLessThanOrEqual(1);
  });
});

describe('DELETE /v1/runs/:id', () => {
  let deletableRunId;
  beforeEach(() => {
    deletableRunId = uuidv4();
    run(
      `INSERT INTO runs (id, company_id, user_id, status, exit_code, started_at, completed_at)
       VALUES (?, ?, ?, 'COMPLETED', 0, datetime('now'), datetime('now'))`,
      [deletableRunId, companyId, userId]
    );
  });

  test('401 without token', async () => {
    const res = await request(app).delete(`/v1/runs/${deletableRunId}`);
    expect(res.status).toBe(401);
  });

  test('certification_user cannot delete (403)', async () => {
    const token = makeToken('certification_user', uuidv4(), companyId);
    const res = await request(app)
      .delete(`/v1/runs/${deletableRunId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  test('owner soft-deletes → DELETION_REQUESTED', async () => {
    const token = makeToken('company_user');
    const res = await request(app)
      .delete(`/v1/runs/${deletableRunId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('DELETION_REQUESTED');
    const after = get('SELECT status FROM runs WHERE id = ?', [deletableRunId]);
    expect(after.status).toBe('DELETION_REQUESTED');
  });

  test('admin soft-deletes → DELETED_BY_ADMIN', async () => {
    const token = makeToken('administrator', adminId, companyId);
    const res = await request(app)
      .delete(`/v1/runs/${deletableRunId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('DELETED_BY_ADMIN');
  });

  test('404 for non-existent run', async () => {
    const token = makeToken('company_user');
    const res = await request(app)
      .delete(`/v1/runs/${uuidv4()}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe('POST /v1/runs/bulk-delete', () => {
  let bulkRunIds;
  beforeEach(() => {
    bulkRunIds = [uuidv4(), uuidv4()];
    bulkRunIds.forEach(id => {
      run(
        `INSERT INTO runs (id, company_id, user_id, status, exit_code, started_at, completed_at)
         VALUES (?, ?, ?, 'COMPLETED', 0, datetime('now'), datetime('now'))`,
        [id, companyId, userId]
      );
    });
  });

  test('400 when run_ids missing or not an array', async () => {
    const token = makeToken('company_user');
    const res = await request(app)
      .post('/v1/runs/bulk-delete')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  test('200 deletes multiple runs in one call', async () => {
    const token = makeToken('company_user');
    const res = await request(app)
      .post('/v1/runs/bulk-delete')
      .set('Authorization', `Bearer ${token}`)
      .send({ run_ids: bulkRunIds });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toEqual(expect.arrayContaining(bulkRunIds));
    expect(res.body.new_status).toBe('DELETION_REQUESTED');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Extended coverage — second, independent tenant so seed data never collides
// with the fixture above. Unique email domain per the CI-safety convention.
// ═══════════════════════════════════════════════════════════════════════════

const covCompanyId      = uuidv4();   // primary tenant under test
const covOtherCompanyId = uuidv4();   // foreign tenant (cross-tenant checks)
const covUserId         = uuidv4();   // company_user (tester) in covCompanyId
const covTmId           = uuidv4();   // test_manager in covCompanyId
const covAdminId        = uuidv4();   // administrator (platform)
const covCertifierId    = uuidv4();   // certification_user (platform)
const covOtherUserId    = uuidv4();   // company_user in covOtherCompanyId

const EMAIL_DOMAIN = 'runs-routes-coverage-test.com';

function covToken(role, uid, cid = covCompanyId) {
  return jwt.sign(
    { sub: uid, email: `${role}-${uid}@${EMAIL_DOMAIN}`, companyId: cid, role },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
}

// A fully-populated COMPLETED run (suites/requests/assertions/events + a real
// encrypted .bru_results.json artifact) so the detail-drilldown endpoints have
// something to return.
const covRunFull     = uuidv4();
const covRunQueued   = uuidv4();
const covRunForeign  = uuidv4();
const covBatchId     = uuidv4();
const covBatchRunA   = uuidv4();
const covBatchRunB   = uuidv4();

const COV_ARTIFACTS_DIR = path.resolve(__dirname, '../../data/artifacts');
const covArtifactDirs   = [];   // data/artifacts/<runId> dirs to rm in afterAll
const covDatafileDirs   = [];   // private mkdtemp dirs holding company datafiles

let covSuiteId;
let covRequestPassId;
let covRequestFailId;
let covArtifactId;

beforeAll(() => {
  // ── Companies + users ───────────────────────────────────────────────────
  run(`INSERT OR IGNORE INTO companies (id, name, slug) VALUES (?, 'Runs Coverage Co', 'runs-coverage-co')`, [covCompanyId]);
  run(`INSERT OR IGNORE INTO companies (id, name, slug) VALUES (?, 'Runs Coverage Other Co', 'runs-coverage-other-co')`, [covOtherCompanyId]);
  run(`INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'company_user')`,
    [covUserId, covCompanyId, `tester-${covUserId}@${EMAIL_DOMAIN}`]);
  run(`INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'test_manager')`,
    [covTmId, covCompanyId, `tm-${covTmId}@${EMAIL_DOMAIN}`]);
  run(`INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'administrator')`,
    [covAdminId, covCompanyId, `admin-${covAdminId}@${EMAIL_DOMAIN}`]);
  run(`INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'certification_user')`,
    [covCertifierId, covCompanyId, `certifier-${covCertifierId}@${EMAIL_DOMAIN}`]);
  run(`INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'company_user')`,
    [covOtherUserId, covOtherCompanyId, `other-${covOtherUserId}@${EMAIL_DOMAIN}`]);

  // ── Runs ────────────────────────────────────────────────────────────────
  run(`INSERT INTO runs (id, company_id, user_id, status, api_base_used, scenario_code, env_name_used, batch_id, queued_at, started_at, completed_at, exit_code)
       VALUES (?, ?, ?, 'COMPLETED', 'https://cov.example', 'COV_SCEN', 'OTST_Env', ?, datetime('now'), datetime('now'), datetime('now'), 0)`,
    [covRunFull, covCompanyId, covUserId, covBatchId]);
  run(`INSERT INTO runs (id, company_id, user_id, status, queued_at)
       VALUES (?, ?, ?, 'QUEUED', datetime('now'))`, [covRunQueued, covCompanyId, covUserId]);
  run(`INSERT INTO runs (id, company_id, user_id, status, queued_at, completed_at)
       VALUES (?, ?, ?, 'COMPLETED', datetime('now'), datetime('now'))`, [covRunForeign, covOtherCompanyId, covOtherUserId]);

  // Batch pair — two runs sharing covBatchId, for GET /batch/:batchId(.zip)
  run(`INSERT INTO runs (id, company_id, user_id, status, scenario_code, env_name_used, batch_id, queued_at, started_at, completed_at, exit_code)
       VALUES (?, ?, ?, 'COMPLETED', 'BATCH_A', 'OTST_Env', ?, datetime('now'), datetime('now'), datetime('now'), 0)`,
    [covBatchRunA, covCompanyId, covUserId, covBatchId]);
  run(`INSERT INTO runs (id, company_id, user_id, status, scenario_code, env_name_used, batch_id, queued_at, started_at, completed_at, exit_code)
       VALUES (?, ?, ?, 'FAILED', 'BATCH_B', 'OTST_Env', ?, datetime('now'), datetime('now'), datetime('now'), 1)`,
    [covBatchRunB, covCompanyId, covUserId, covBatchId]);

  // ── run_suites / run_requests / run_assertions / run_events for covRunFull ─
  run(`INSERT INTO run_suites (run_id, company_id, scenario_name, suite_name, total, passed, failed)
       VALUES (?, ?, 'Coverage Scenario', '01-Common', 2, 1, 1)`, [covRunFull, covCompanyId]);
  covSuiteId = get(`SELECT id FROM run_suites WHERE run_id = ? AND suite_name = '01-Common'`, [covRunFull]).id;

  run(`INSERT INTO run_requests
       (suite_id, run_id, company_id, request_name, http_method, http_url, http_status, duration_ms, result, vendor_capability, context, request_headers, request_body, response_headers, response_body)
       VALUES (?, ?, ?, 'Get Offers', 'GET', 'https://cov.example/offers', 200, 10, 'PASS', 'IMPLEMENTED', ?, ?, ?, ?, ?)`,
    [covSuiteId, covRunFull, covCompanyId, JSON.stringify({ mode: 'sale' }),
     JSON.stringify({ Accept: 'application/json' }), '{"q":1}',
     JSON.stringify({ 'Content-Type': 'application/json' }), '{"offers":[]}']);
  covRequestPassId = get(`SELECT id FROM run_requests WHERE run_id = ? AND request_name = 'Get Offers'`, [covRunFull]).id;

  run(`INSERT INTO run_requests
       (suite_id, run_id, company_id, request_name, http_method, http_url, http_status, duration_ms, result, vendor_capability, context, parent_request_id)
       VALUES (?, ?, ?, 'Book Offer', 'POST', 'https://cov.example/bookings', 500, 20, 'FAIL', 'ERROR', NULL, ?)`,
    [covSuiteId, covRunFull, covCompanyId, covRequestPassId]);
  covRequestFailId = get(`SELECT id FROM run_requests WHERE run_id = ? AND request_name = 'Book Offer'`, [covRunFull]).id;

  run(`INSERT INTO run_assertions
       (request_id, suite_id, run_id, company_id, assertion_key, assertion_name, category, domain, severity, passed)
       VALUES (?, ?, ?, ?, 'Suite1|Get Offers|status 200', 'status is 200', 'http_status', 'offer', 'major', 1)`,
    [covRequestPassId, covSuiteId, covRunFull, covCompanyId]);
  run(`INSERT INTO run_assertions
       (request_id, suite_id, run_id, company_id, assertion_key, assertion_name, category, domain, severity, passed, error_msg)
       VALUES (?, ?, ?, ?, 'Suite1|Book Offer|status 201', 'status is 201', 'http_status', 'booking', 'critical', 0, 'got 500')`,
    [covRequestFailId, covSuiteId, covRunFull, covCompanyId]);

  run(`INSERT INTO run_events (run_id, level, message, category, phase, suite_name, request_name)
       VALUES (?, 'info', 'requesting offers', 'http', 'execution', '01-Common', 'Get Offers')`, [covRunFull]);
  run(`INSERT INTO run_events (run_id, level, message, category, phase, suite_name, request_name)
       VALUES (?, 'error', 'booking failed hard', 'http', 'execution', '01-Common', 'Book Offer')`, [covRunFull]);

  // ── Encrypted .bru_results.json artifact under data/artifacts/<runId>/ ────
  // Mirrors reports-routes.test.js's seeding technique so GET /:id/artifacts*
  // can decrypt a real file.
  const artDir = path.join(COV_ARTIFACTS_DIR, covRunFull);
  fs.mkdirSync(artDir, { recursive: true });
  covArtifactDirs.push(artDir);
  encryptToFile(JSON.stringify([{ suiteName: '01-Common', filename: 'req1.bru', tests: [{ name: 'status 200', status: 'passed' }] }]),
    path.join(artDir, '.bru_results.json'));
  covArtifactId = uuidv4();
  run(`INSERT INTO run_artifacts (id, run_id, type, filename, path) VALUES (?, ?, 'json_results', '.bru_results.json', ?)`,
    [covArtifactId, covRunFull, path.join(artDir, '.bru_results.json')]);

  // Also give the batch runs an artifact each, so /batch/:batchId/reports.zip
  // has something to bundle.
  for (const rid of [covBatchRunA, covBatchRunB]) {
    const dir = path.join(COV_ARTIFACTS_DIR, rid);
    fs.mkdirSync(dir, { recursive: true });
    covArtifactDirs.push(dir);
    const fpath = path.join(dir, '.bru_results.json');
    encryptToFile(JSON.stringify([{ suiteName: '01-Common', filename: 'req1.bru', tests: [{ name: 'ok', status: 'passed' }] }]), fpath);
    run(`INSERT INTO run_artifacts (id, run_id, type, filename, path) VALUES (?, ?, 'json_results', '.bru_results.json', ?)`,
      [uuidv4(), rid, fpath]);
  }
});

describe('POST /v1/runs — submission validation', () => {
  test('401 without token', async () => {
    const res = await request(app).post('/v1/runs').send({});
    expect(res.status).toBe(401);
  });

  test('403 certification_user cannot start runs', async () => {
    const token = covToken('certification_user', covCertifierId);
    const res = await request(app)
      .post('/v1/runs')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(403);
  });

  test('400 platform user without company_id (no targetCompanyId resolvable)', async () => {
    const token = covToken('administrator', covAdminId);
    const res = await request(app)
      .post('/v1/runs')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  test('404 company not found (platform user targets a bogus company_id)', async () => {
    const token = covToken('administrator', covAdminId);
    const res = await request(app)
      .post('/v1/runs')
      .set('Authorization', `Bearer ${token}`)
      .send({ company_id: uuidv4() });
    expect(res.status).toBe(404);
  });

  test('400 missing api_base / datafile / credentials', async () => {
    // covCompanyId has no api_base, no datafile_path, and covUserId has no
    // access_token_enc — every "missing" branch should fire.
    const token = covToken('company_user', covUserId);
    const res = await request(app)
      .post('/v1/runs')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.missing).toEqual(expect.arrayContaining([
      expect.stringContaining('OSDM API endpoint'),
      expect.stringContaining('Bearer token'),
      expect.stringContaining('data file'),
    ]));
  });

  describe('with api_base + bearer token configured', () => {
    const submitCompanyId = uuidv4();
    const submitUserId    = uuidv4();

    beforeAll(() => {
      run(`INSERT INTO companies (id, name, slug, api_base) VALUES (?, 'Runs Coverage Submit Co', 'runs-coverage-submit-co', 'https://submit.example')`,
        [submitCompanyId]);
      run(`INSERT INTO users (id, company_id, email, password_hash, role, auth_mode, access_token_enc)
           VALUES (?, ?, ?, 'x', 'company_user', 'bearer', ?)`,
        [submitUserId, submitCompanyId, `submit-${submitUserId}@${EMAIL_DOMAIN}`, colEncrypt('tok-123')]);
    });

    afterAll(() => {
      run('DELETE FROM runs WHERE company_id = ?', [submitCompanyId]);
      run('DELETE FROM users WHERE company_id = ?', [submitCompanyId]);
      run('DELETE FROM companies WHERE id = ?', [submitCompanyId]);
    });

    test('400 when the configured datafile_path does not exist on disk', async () => {
      run(`UPDATE companies SET datafile_path = ? WHERE id = ?`, ['/no/such/datafile.json', submitCompanyId]);
      const token = covToken('company_user', submitUserId, submitCompanyId);
      const res = await request(app)
        .post('/v1/runs')
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.missing).toEqual(expect.arrayContaining([expect.stringContaining('data file')]));
    });

    test('400 when the datafile cannot be parsed', async () => {
      const dfDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-cov-df-bad-'));
      covDatafileDirs.push(dfDir);
      const dfPath = path.join(dfDir, 'datafile.enc');
      fs.writeFileSync(dfPath, Buffer.from('not json at all', 'utf8'));
      // A non-JSON, non-OSCAR1-prefixed file falls through decryptFromFile as
      // legacy plaintext, then JSON.parse throws — hits the catch branch.
      run(`UPDATE companies SET datafile_path = ? WHERE id = ?`, [dfPath, submitCompanyId]);

      const token = covToken('company_user', submitUserId, submitCompanyId);
      const res = await request(app)
        .post('/v1/runs')
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.detail).toMatch(/Could not parse data file/);
    });

    test('400 when scenariosToRun resolves to an empty list', async () => {
      const dfDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-cov-df-empty-'));
      covDatafileDirs.push(dfDir);
      const dfPath = path.join(dfDir, 'datafile.enc');
      const plain  = JSON.stringify({ scenarios: [{ code: 'A' }], scenariosToRun: ['NOT_A_REAL_CODE'] });
      fs.writeFileSync(dfPath, encryptBuffer(Buffer.from(plain, 'utf8')));
      run(`UPDATE companies SET datafile_path = ? WHERE id = ?`, [dfPath, submitCompanyId]);

      const token = covToken('company_user', submitUserId, submitCompanyId);
      const res = await request(app)
        .post('/v1/runs')
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.detail).toMatch(/No scenarios to run/);
    });

    test('202 happy path — scenariosToRun ALL enqueues one QUEUED run per scenario', async () => {
      const dfDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-cov-df-ok-'));
      covDatafileDirs.push(dfDir);
      const dfPath = path.join(dfDir, 'datafile.enc');
      const plain  = JSON.stringify({
        scenarios: [{ code: 'SCEN_A' }, { code: 'SCEN_B' }],
        scenariosToRun: 'ALL',
      });
      fs.writeFileSync(dfPath, encryptBuffer(Buffer.from(plain, 'utf8')));
      run(`UPDATE companies SET datafile_path = ? WHERE id = ?`, [dfPath, submitCompanyId]);

      const token = covToken('company_user', submitUserId, submitCompanyId);
      const res = await request(app)
        .post('/v1/runs')
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(202);
      expect(res.body.parallel).toBe(true);
      expect(res.body.batch_id).toBeTruthy();
      expect(res.body.runs.length).toBe(2);
      expect(res.body.runs.every(r => r.status === 'QUEUED')).toBe(true);

      const dbRows = get('SELECT COUNT(*) AS n FROM runs WHERE batch_id = ?', [res.body.batch_id]);
      expect(dbRows.n).toBe(2);
    });
  });
});

describe('GET /v1/runs — role-scoped listing', () => {
  test('administrator sees only the deletion lifecycle queue, not covRunFull', async () => {
    const token = covToken('administrator', covAdminId);
    const res = await request(app).get('/v1/runs').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.runs.find(r => r.id === covRunFull)).toBeUndefined();
    expect(res.body.notice).toMatch(/data-lifecycle queue/);
  });

  test('certifier sees nothing until the run is shared (platform-wide, no x-company-id)', async () => {
    // Omitting x-company-id / company_id leaves req.companyId falsy, which is
    // what routes the certifier into the shared_with_certifier_at-gated
    // platform-wide branch (isPlatform && !req.companyId) rather than the
    // company-scoped "own runs" branch used by test_manager/tester.
    const token = covToken('certification_user', covCertifierId, covCompanyId);
    const res = await request(app)
      .get('/v1/runs')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.runs.find(r => r.id === covRunFull)).toBeUndefined();
  });

  test('test_manager sees every run in the company (elevated viewer)', async () => {
    const token = covToken('test_manager', covTmId);
    const res = await request(app).get('/v1/runs').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.runs.find(r => r.id === covRunFull)).toBeTruthy();
  });

  test('plain tester sees only runs they own', async () => {
    const foreignOwnerRun = uuidv4();
    run(`INSERT INTO runs (id, company_id, user_id, status, queued_at, completed_at)
         VALUES (?, ?, ?, 'COMPLETED', datetime('now'), datetime('now'))`,
      [foreignOwnerRun, covCompanyId, covTmId]);
    const token = covToken('company_user', covUserId);
    const res = await request(app).get('/v1/runs').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.runs.find(r => r.id === covRunFull)).toBeTruthy();
    expect(res.body.runs.find(r => r.id === foreignOwnerRun)).toBeUndefined();
    run('DELETE FROM runs WHERE id = ?', [foreignOwnerRun]);
  });
});

describe('GET /v1/runs/queue-status', () => {
  test('401 without token', async () => {
    const res = await request(app).get('/v1/runs/queue-status');
    expect(res.status).toBe(401);
  });

  test('200 shape: company_id, concurrent_limit, slots, runs (includes the QUEUED run)', async () => {
    const token = covToken('company_user', covUserId);
    const res = await request(app).get('/v1/runs/queue-status').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.company_id).toBe(covCompanyId);
    expect(typeof res.body.concurrent_limit).toBe('number');
    expect(typeof res.body.slots_used).toBe('number');
    expect(typeof res.body.slots_available).toBe('number');
    const queuedEntry = res.body.runs.find(r => r.id === covRunQueued);
    expect(queuedEntry).toBeTruthy();
    expect(queuedEntry.status).toBe('QUEUED');
    expect(queuedEntry.position).toBeGreaterThanOrEqual(1);
  });

  test('falls back to concurrentLimit=1 when the stored framework config is unparsable', async () => {
    // Covers the try/catch around JSON.parse(colDecrypt(tfRow.config)) —
    // a row exists but its config isn't valid JSON.
    run(`INSERT OR IGNORE INTO test_frameworks (id, company_id, config) VALUES (?, ?, 'not json')`,
      [uuidv4(), covCompanyId]);
    const token = covToken('company_user', covUserId);
    const res = await request(app).get('/v1/runs/queue-status').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.concurrent_limit).toBe(1);
    run('DELETE FROM test_frameworks WHERE company_id = ?', [covCompanyId]);
  });
});

describe('POST /v1/runs/stop-all', () => {
  test('403 certification_user cannot stop runs', async () => {
    const token = covToken('certification_user', covCertifierId);
    const res = await request(app).post('/v1/runs/stop-all').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  test('0 stopped when caller has no active runs', async () => {
    const loneUserId = uuidv4();
    run(`INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'company_user')`,
      [loneUserId, covCompanyId, `lone-${loneUserId}@${EMAIL_DOMAIN}`]);
    const token = covToken('company_user', loneUserId);
    const res = await request(app).post('/v1/runs/stop-all').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.stopped).toBe(0);
    expect(res.body.scope).toBe('own');
    run('DELETE FROM users WHERE id = ?', [loneUserId]);
  });

  test('200 cancels the caller\'s own QUEUED run (own scope)', async () => {
    const stopUserId = uuidv4();
    const stopRunId  = uuidv4();
    run(`INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'company_user')`,
      [stopUserId, covCompanyId, `stop-${stopUserId}@${EMAIL_DOMAIN}`]);
    run(`INSERT INTO runs (id, company_id, user_id, status, queued_at) VALUES (?, ?, ?, 'QUEUED', datetime('now'))`,
      [stopRunId, covCompanyId, stopUserId]);

    const token = covToken('company_user', stopUserId);
    const res = await request(app).post('/v1/runs/stop-all').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.stopped).toBe(1);
    expect(res.body.queued_cancelled).toBe(1);
    expect(res.body.scope).toBe('own');

    const after = get('SELECT status FROM runs WHERE id = ?', [stopRunId]);
    expect(after.status).toBe('CANCELLED');

    run('DELETE FROM runs WHERE id = ?', [stopRunId]);
    // stop-all best-effort audit-logs to auth_events (FK on user_id, no
    // cascade) — must clear it before the user row or the delete FK-fails.
    run('DELETE FROM auth_events WHERE user_id = ?', [stopUserId]);
    run('DELETE FROM users WHERE id = ?', [stopUserId]);
  });

  test('administrator scope is platform-wide', async () => {
    const token = covToken('administrator', covAdminId);
    const res = await request(app).post('/v1/runs/stop-all').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('platform');
  });
});

describe('GET /v1/runs/:id — run detail', () => {
  test('401 without token', async () => {
    const res = await request(app).get(`/v1/runs/${covRunFull}`);
    expect(res.status).toBe(401);
  });

  test('404 for a non-existent run', async () => {
    const token = covToken('company_user', covUserId);
    const res = await request(app).get(`/v1/runs/${uuidv4()}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  test('404 cross-tenant (foreign company cannot see this company\'s run)', async () => {
    const token = covToken('company_user', covOtherUserId, covOtherCompanyId);
    const res = await request(app).get(`/v1/runs/${covRunFull}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  test('200 owner sees full run detail', async () => {
    const token = covToken('company_user', covUserId);
    const res = await request(app).get(`/v1/runs/${covRunFull}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(covRunFull);
    expect(res.body.status).toBe('COMPLETED');
  });
});

describe('GET /v1/runs/:id/logs', () => {
  test('404 for a non-existent run', async () => {
    const token = covToken('company_user', covUserId);
    const res = await request(app).get(`/v1/runs/${uuidv4()}/logs`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  test('200 returns decrypted events for the run', async () => {
    const token = covToken('company_user', covUserId);
    const res = await request(app).get(`/v1/runs/${covRunFull}/logs`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.run_id).toBe(covRunFull);
    expect(res.body.status).toBe('COMPLETED');
    expect(res.body.events.length).toBeGreaterThanOrEqual(2);
    expect(res.body.events.some(e => e.message === 'requesting offers')).toBe(true);
    expect(typeof res.body.has_more).toBe('boolean');
  });

  test('200 with search= narrows to matching messages', async () => {
    const token = covToken('company_user', covUserId);
    const res = await request(app)
      .get(`/v1/runs/${covRunFull}/logs?search=booking`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.events.every(e => e.message.toLowerCase().includes('booking'))).toBe(true);
    expect(res.body.events.some(e => e.message === 'booking failed hard')).toBe(true);
  });

  test('200 with category filter', async () => {
    const token = covToken('company_user', covUserId);
    const res = await request(app)
      .get(`/v1/runs/${covRunFull}/logs?category=http`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.events.length).toBeGreaterThanOrEqual(2);
  });
});

describe('GET /v1/runs/:id/assertions', () => {
  test('404 for a non-existent run', async () => {
    const token = covToken('company_user', covUserId);
    const res = await request(app).get(`/v1/runs/${uuidv4()}/assertions`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  test('200 returns nested suites → requests → assertions with summary + breakdowns', async () => {
    const token = covToken('company_user', covUserId);
    const res = await request(app).get(`/v1/runs/${covRunFull}/assertions`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.run_id).toBe(covRunFull);
    expect(res.body.summary.total).toBe(2);
    expect(res.body.summary.passed).toBe(1);
    expect(res.body.summary.failed).toBe(1);
    expect(Array.isArray(res.body.by_category)).toBe(true);
    expect(Array.isArray(res.body.by_domain)).toBe(true);
    expect(res.body.suites.length).toBe(1);
    expect(res.body.suites[0].requests.length).toBe(2);
    // Decrypted bodies survive the round trip.
    const getOffers = res.body.suites[0].requests.find(r => r.request_name === 'Get Offers');
    expect(getOffers.request_body).toBe('{"q":1}');
    expect(getOffers.response_body).toBe('{"offers":[]}');
  });

  test('200 with status=failed filters assertions to only failing ones', async () => {
    const token = covToken('company_user', covUserId);
    const res = await request(app)
      .get(`/v1/runs/${covRunFull}/assertions?status=failed`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const allAssertions = res.body.suites.flatMap(s => s.requests.flatMap(r => r.assertions));
    expect(allAssertions.length).toBe(1);
    expect(allAssertions[0].passed).toBe(0);
  });

  test('200 with suite= filters to a named suite', async () => {
    const token = covToken('company_user', covUserId);
    const res = await request(app)
      .get(`/v1/runs/${covRunFull}/assertions?suite=01-Common`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.suites.length).toBe(1);
  });
});

describe('GET /v1/runs/:id/requests', () => {
  test('404 for a non-existent run', async () => {
    const token = covToken('company_user', covUserId);
    const res = await request(app).get(`/v1/runs/${uuidv4()}/requests`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  test('200 lists both requests with metadata only (no bodies)', async () => {
    const token = covToken('company_user', covUserId);
    const res = await request(app).get(`/v1/runs/${covRunFull}/requests`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.filter).toBe('all');
    expect(res.body.requests.every(r => r.has_request_body !== undefined)).toBe(true);
  });

  test('200 with status_filter=failed narrows to the non-2xx / failed-assertion request', async () => {
    const token = covToken('company_user', covUserId);
    const res = await request(app)
      .get(`/v1/runs/${covRunFull}/requests?status_filter=failed`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.requests.length).toBe(1);
    expect(res.body.requests[0].request_name).toBe('Book Offer');
  });

  test('200 with scenario= filters by scenario_name', async () => {
    const token = covToken('company_user', covUserId);
    const res = await request(app)
      .get(`/v1/runs/${covRunFull}/requests?scenario=${encodeURIComponent('Coverage Scenario')}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.scenario).toBe('Coverage Scenario');
    expect(res.body.total).toBe(2);
  });
});

describe('GET /v1/runs/:id/requests/:reqId', () => {
  test('404 for a non-existent run', async () => {
    const token = covToken('company_user', covUserId);
    const res = await request(app).get(`/v1/runs/${uuidv4()}/requests/${covRequestPassId}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  test('404 for a non-existent request id on a valid run', async () => {
    const token = covToken('company_user', covUserId);
    const res = await request(app).get(`/v1/runs/${covRunFull}/requests/999999999`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  test('200 returns full body/headers + children chain for the parent request', async () => {
    const token = covToken('company_user', covUserId);
    const res = await request(app).get(`/v1/runs/${covRunFull}/requests/${covRequestPassId}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.request.id).toBe(covRequestPassId);
    expect(res.body.request.request_body).toBe('{"q":1}');
    expect(res.body.request.response_body).toBe('{"offers":[]}');
    expect(res.body.parent).toBeNull();
    expect(res.body.children.length).toBe(1);
    expect(res.body.children[0].id).toBe(covRequestFailId);
  });

  test('200 returns the parent summary for the child request', async () => {
    const token = covToken('company_user', covUserId);
    const res = await request(app).get(`/v1/runs/${covRunFull}/requests/${covRequestFailId}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.request.id).toBe(covRequestFailId);
    expect(res.body.parent).toBeTruthy();
    expect(res.body.parent.id).toBe(covRequestPassId);
    expect(res.body.children.length).toBe(0);
  });
});

describe('GET /v1/runs/:id/artifacts and /:id/artifacts/:aid', () => {
  test('404 for a non-existent run (list)', async () => {
    const token = covToken('company_user', covUserId);
    const res = await request(app).get(`/v1/runs/${uuidv4()}/artifacts`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  test('200 lists the seeded artifact', async () => {
    const token = covToken('company_user', covUserId);
    const res = await request(app).get(`/v1/runs/${covRunFull}/artifacts`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.run_id).toBe(covRunFull);
    expect(res.body.artifacts.length).toBe(1);
    expect(res.body.artifacts[0].id).toBe(covArtifactId);
    expect(res.body.artifacts[0].type).toBe('json_results');
  });

  test('404 for a non-existent artifact id', async () => {
    const token = covToken('company_user', covUserId);
    const res = await request(app).get(`/v1/runs/${covRunFull}/artifacts/${uuidv4()}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  test('200 downloads + decrypts the artifact content', async () => {
    const token = covToken('company_user', covUserId);
    const res = await request(app).get(`/v1/runs/${covRunFull}/artifacts/${covArtifactId}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const parsed = JSON.parse(res.text);
    expect(parsed[0].suiteName).toBe('01-Common');
  });
});

describe('POST /v1/runs/:id/share and DELETE /v1/runs/:id/share', () => {
  test('403 non-test_manager cannot share', async () => {
    const token = covToken('company_user', covUserId);
    const res = await request(app).post(`/v1/runs/${covRunFull}/share`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  test('404 for a non-existent run', async () => {
    const token = covToken('test_manager', covTmId);
    const res = await request(app).post(`/v1/runs/${uuidv4()}/share`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  test('409 when the run is not in a terminal status', async () => {
    // Use a freshly-seeded QUEUED run rather than the shared covRunQueued
    // fixture — the earlier stop-all describe block's "platform-wide" admin
    // test cancels every active run, so covRunQueued may no longer be QUEUED
    // by the time this describe block runs.
    const nonTerminalId = uuidv4();
    run(`INSERT INTO runs (id, company_id, user_id, status, queued_at) VALUES (?, ?, ?, 'QUEUED', datetime('now'))`,
      [nonTerminalId, covCompanyId, covUserId]);

    const token = covToken('test_manager', covTmId);
    const res = await request(app).post(`/v1/runs/${nonTerminalId}/share`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(409);

    run('DELETE FROM runs WHERE id = ?', [nonTerminalId]);
  });

  test('200 shares a COMPLETED run — sets shared_with_certifier_at', async () => {
    const token = covToken('test_manager', covTmId);
    const res = await request(app).post(`/v1/runs/${covRunFull}/share`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.run.shared_with_certifier_at).toBeTruthy();

    const row = get('SELECT shared_with_certifier_at, shared_with_certifier_by FROM runs WHERE id = ?', [covRunFull]);
    expect(row.shared_with_certifier_at).toBeTruthy();
    // Plain substring check — a dynamically-built regex here would be an
    // unanchored host/domain match (CodeQL js/incomplete-url-substring-sanitization).
    expect(row.shared_with_certifier_by).toContain(EMAIL_DOMAIN);
  });

  test('after sharing, the certifier can now see the run in the platform-wide list', async () => {
    const token = covToken('certification_user', covCertifierId, covCompanyId);
    const res = await request(app)
      .get('/v1/runs')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.runs.find(r => r.id === covRunFull)).toBeTruthy();
  });

  test('403 non-test_manager cannot revoke', async () => {
    const token = covToken('company_user', covUserId);
    const res = await request(app).delete(`/v1/runs/${covRunFull}/share`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  test('404 DELETE /share for a non-existent run', async () => {
    const token = covToken('test_manager', covTmId);
    const res = await request(app).delete(`/v1/runs/${uuidv4()}/share`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  test('200 revokes sharing — clears shared_with_certifier_at', async () => {
    const token = covToken('test_manager', covTmId);
    const res = await request(app).delete(`/v1/runs/${covRunFull}/share`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.run.shared_with_certifier_at).toBeNull();

    const row = get('SELECT shared_with_certifier_at FROM runs WHERE id = ?', [covRunFull]);
    expect(row.shared_with_certifier_at).toBeNull();
  });
});

describe('DELETE /v1/runs/:id/cancel', () => {
  test('403 certification_user cannot cancel', async () => {
    const token = covToken('certification_user', covCertifierId);
    const res = await request(app).delete(`/v1/runs/${covRunQueued}/cancel`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  test('404 for a non-existent run', async () => {
    const token = covToken('company_user', covUserId);
    const res = await request(app).delete(`/v1/runs/${uuidv4()}/cancel`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  test('409 cancelling a COMPLETED run is a conflict', async () => {
    const token = covToken('company_user', covUserId);
    const res = await request(app).delete(`/v1/runs/${covRunFull}/cancel`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(409);
  });

  test('200 cancels a QUEUED run', async () => {
    const cancellableId = uuidv4();
    run(`INSERT INTO runs (id, company_id, user_id, status, queued_at) VALUES (?, ?, ?, 'QUEUED', datetime('now'))`,
      [cancellableId, covCompanyId, covUserId]);

    const token = covToken('company_user', covUserId);
    const res = await request(app).delete(`/v1/runs/${cancellableId}/cancel`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');

    const row = get('SELECT status FROM runs WHERE id = ?', [cancellableId]);
    expect(row.status).toBe('CANCELLED');
    run('DELETE FROM runs WHERE id = ?', [cancellableId]);
  });
});

describe('POST /v1/runs/bulk-admin-action', () => {
  test('403 non-administrator cannot perform bulk admin actions', async () => {
    const token = covToken('test_manager', covTmId);
    const res = await request(app)
      .post('/v1/runs/bulk-admin-action')
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'soft_delete', run_ids: [covRunFull] });
    expect(res.status).toBe(403);
  });

  test('400 invalid action', async () => {
    const token = covToken('administrator', covAdminId);
    const res = await request(app)
      .post('/v1/runs/bulk-admin-action')
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'not_a_real_action', run_ids: [covRunFull] });
    expect(res.status).toBe(400);
  });

  test('400 empty run_ids', async () => {
    const token = covToken('administrator', covAdminId);
    const res = await request(app)
      .post('/v1/runs/bulk-admin-action')
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'soft_delete', run_ids: [] });
    expect(res.status).toBe(400);
  });

  test('200 soft_delete flags a run DELETED_BY_ADMIN, then restore brings it back', async () => {
    const targetId = uuidv4();
    run(`INSERT INTO runs (id, company_id, user_id, status, queued_at, completed_at)
         VALUES (?, ?, ?, 'COMPLETED', datetime('now'), datetime('now'))`,
      [targetId, covCompanyId, covUserId]);

    const adminToken = covToken('administrator', covAdminId);
    const softDel = await request(app)
      .post('/v1/runs/bulk-admin-action')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ action: 'soft_delete', run_ids: [targetId] });
    expect(softDel.status).toBe(200);
    expect(softDel.body.processed.find(p => p.id === targetId).new_status).toBe('DELETED_BY_ADMIN');

    let row = get('SELECT status, previous_status FROM runs WHERE id = ?', [targetId]);
    expect(row.status).toBe('DELETED_BY_ADMIN');
    expect(row.previous_status).toBe('COMPLETED');

    const restore = await request(app)
      .post('/v1/runs/bulk-admin-action')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ action: 'restore', run_ids: [targetId] });
    expect(restore.status).toBe(200);
    expect(restore.body.processed.find(p => p.id === targetId).new_status).toBe('COMPLETED');

    row = get('SELECT status, previous_status, deleted_by FROM runs WHERE id = ?', [targetId]);
    expect(row.status).toBe('COMPLETED');
    expect(row.previous_status).toBeNull();
    expect(row.deleted_by).toBeNull();

    run('DELETE FROM runs WHERE id = ?', [targetId]);
  });

  test('not_found + skipped entries for a bogus id and an already-terminal confirm_delete', async () => {
    const adminToken = covToken('administrator', covAdminId);
    const res = await request(app)
      .post('/v1/runs/bulk-admin-action')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ action: 'confirm_delete', run_ids: [uuidv4(), covRunFull] });
    expect(res.status).toBe(200);
    expect(res.body.not_found.length).toBe(1);
    // covRunFull is COMPLETED, not DELETION_REQUESTED — confirm_delete skips it.
    expect(res.body.skipped.find(s => s.id === covRunFull)).toBeTruthy();
  });
});

describe('GET /v1/runs/batch/:batchId', () => {
  test('404 for an unknown batch id', async () => {
    const token = covToken('company_user', covUserId);
    const res = await request(app).get(`/v1/runs/batch/${uuidv4()}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  test('200 aggregates status across every run sharing the batch id', async () => {
    const token = covToken('company_user', covUserId);
    const res = await request(app).get(`/v1/runs/batch/${covBatchId}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.batch_id).toBe(covBatchId);
    // covRunFull(COMPLETED) + covBatchRunA(COMPLETED) + covBatchRunB(FAILED) = 3
    expect(res.body.total).toBe(3);
    expect(res.body.completed).toBe(2);
    expect(res.body.failed).toBe(1);
    expect(res.body.runs.length).toBe(3);
  });
});

describe('GET /v1/runs/batch/:batchId/reports.zip', () => {
  test('404 for an unknown batch id', async () => {
    const token = covToken('company_user', covUserId);
    const res = await request(app).get(`/v1/runs/batch/${uuidv4()}/reports.zip`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  test('200 streams a zip archive bundling every run\'s artifacts in the batch', async () => {
    const token = covToken('company_user', covUserId);
    const res = await request(app)
      .get(`/v1/runs/batch/${covBatchId}/reports.zip`)
      .set('Authorization', `Bearer ${token}`)
      .buffer(true)
      .parse((response, cb) => {
        const chunks = [];
        response.on('data', c => chunks.push(c));
        response.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename=/);
    // Local file header signature 'PK\x03\x04' at the very start of a zip.
    expect(res.body.slice(0, 4).toString('hex')).toBe('504b0304');
  });
});

afterAll(() => {
  const safe = (sql, p) => { try { run(sql, p); } catch (_) { /* ignore */ } };
  const covCompanies = [covCompanyId, covOtherCompanyId];
  safe('DELETE FROM run_assertions WHERE company_id IN (?, ?)', covCompanies);
  safe('DELETE FROM run_events     WHERE run_id IN (SELECT id FROM runs WHERE company_id IN (?, ?))', covCompanies);
  safe('DELETE FROM run_requests   WHERE company_id IN (?, ?)', covCompanies);
  safe('DELETE FROM run_suites     WHERE company_id IN (?, ?)', covCompanies);
  safe('DELETE FROM run_artifacts  WHERE run_id IN (SELECT id FROM runs WHERE company_id IN (?, ?))', covCompanies);
  safe('DELETE FROM runs           WHERE company_id IN (?, ?)', covCompanies);
  // stop-all / share / bulk-admin-action best-effort audit-log to auth_events
  // (FK on user_id/company_id, no cascade) — must clear before users/companies.
  safe('DELETE FROM auth_events    WHERE company_id IN (?, ?)', covCompanies);
  safe('DELETE FROM users          WHERE company_id IN (?, ?)', covCompanies);
  safe('DELETE FROM companies      WHERE id IN (?, ?)', covCompanies);
  covArtifactDirs.forEach(d => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* ignore */ } });
  covDatafileDirs.forEach(d => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* ignore */ } });
});

afterAll(() => {
  // Clean up
  run('DELETE FROM run_artifacts WHERE run_id IN (SELECT id FROM runs WHERE company_id = ?)', [companyId]);
  run('DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE company_id = ?)', [companyId]);
  run('DELETE FROM runs WHERE company_id = ?', [companyId]);
  run('DELETE FROM users WHERE company_id = ?', [companyId]);
  run('DELETE FROM companies WHERE id = ?', [companyId]);
});
