// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * reports-routes.test.js — Integration tests for /v1/reports/*
 * (src/api/routes/reports.js — the report comparison / builder / trends routes).
 *
 * Covers as much of the (large) route file as practical:
 *   - Auth gating (401 without a token)
 *   - Templates CRUD: GET (empty → populated), POST (create + 400), DELETE (404 + happy path)
 *   - Trends: GET /trends/summary and GET /trends (with seeded assertions + validation)
 *   - Compare: POST /compare (validation, cross-tenant, non-COMPLETED, 404s, and the
 *     full happy path — seeding real encrypted .bru_results.json artifacts so the
 *     diff engine runs — plus the cached re-fetch branch)
 *   - Comparisons: GET /comparisons and GET /comparisons/:id (404 + happy path)
 *   - Configured report builder: POST /configured (validation, cross-tenant 403,
 *     and a fully-seeded structured report exercising suites/requests/events/matrix)
 *   - Request messages: GET /requests/:id/messages (400, 404, and a seeded request)
 *
 * The DB is the shared test SQLite (tests/setup.js sets JWT_SECRET + ENCRYPTION_KEY).
 * Everything seeded here uses a unique company uuid and the '@reports-routes-test.com'
 * email domain, and is cleaned up in afterAll.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-reports-routes';

const jwt     = require('jsonwebtoken');
const fs      = require('fs');
const path    = require('path');
const { randomUUID: uuidv4 } = require('node:crypto');
const request = require('supertest');
const { buildAppWithRoute } = require('../helpers/test-app');
const { run, get } = require('../../src/db/db');
const { encryptToFile } = require('../../src/utils/at-rest');

const app = buildAppWithRoute('/v1/reports', '../../src/api/routes/reports');

// ── Identities ────────────────────────────────────────────────────────────────
const companyId      = uuidv4();   // the tenant under test
const otherCompanyId = uuidv4();   // a foreign tenant (cross-tenant checks)
const userId         = uuidv4();   // company_user in companyId
const otherUserId    = uuidv4();   // company_user in otherCompanyId
const adminId        = uuidv4();   // platform (administrator)

// Runs: two COMPLETED runs with artifacts (for /compare), one non-completed run,
// and one COMPLETED run in the other company.
const runA        = uuidv4();
const runB        = uuidv4();
const runQueued   = uuidv4();
const runForeign  = uuidv4();

const ARTIFACTS_DIR = path.resolve(__dirname, '../../data/artifacts');
const dirsToClean   = [];

// Integer PK ids captured after seeding run_suites / run_requests.
let suiteId;
let requestPassId;   // a PASS request row (for /requests/:id/messages)

function makeToken(role, uid = userId, cid = companyId) {
  return jwt.sign(
    { sub: uid, email: `${role}@reports-routes-test.com`, companyId: cid, role },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
}

// Write a real at-rest-encrypted .bru_results.json for a run so the diff engine
// (src/reports/diff.js → parseResults) can read + decrypt it.
function seedResultsArtifact(runId, results) {
  const dir = path.join(ARTIFACTS_DIR, runId);
  fs.mkdirSync(dir, { recursive: true });
  dirsToClean.push(dir);
  encryptToFile(JSON.stringify(results), path.join(dir, '.bru_results.json'));
}

beforeAll(() => {
  // Companies + users
  run(`INSERT OR IGNORE INTO companies (id, name, slug) VALUES (?, 'Reports Route Test', 'reports-route-test')`, [companyId]);
  run(`INSERT OR IGNORE INTO companies (id, name, slug) VALUES (?, 'Reports Other Co',  'reports-other-co')`,  [otherCompanyId]);
  run(`INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, 'user@reports-routes-test.com', 'x', 'company_user')`, [userId, companyId]);
  run(`INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, 'other@reports-routes-test.com', 'x', 'company_user')`, [otherUserId, otherCompanyId]);
  run(`INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, 'admin@reports-routes-test.com', 'x', 'administrator')`, [adminId, companyId]);

  // ── Runs ──────────────────────────────────────────────────────────────────
  run(`INSERT INTO runs (id, company_id, user_id, status, api_base_used, scenario_code, env_name_used, queued_at, completed_at)
       VALUES (?, ?, ?, 'COMPLETED', 'https://a.example', 'SALE_A', 'OTST_Env', datetime('now'), datetime('now'))`, [runA, companyId, userId]);
  run(`INSERT INTO runs (id, company_id, user_id, status, api_base_used, scenario_code, env_name_used, queued_at, completed_at)
       VALUES (?, ?, ?, 'COMPLETED', 'https://b.example', 'SALE_B', 'OTST_Env', datetime('now'), datetime('now'))`, [runB, companyId, userId]);
  run(`INSERT INTO runs (id, company_id, user_id, status, queued_at)
       VALUES (?, ?, ?, 'QUEUED', datetime('now'))`, [runQueued, companyId, userId]);
  run(`INSERT INTO runs (id, company_id, user_id, status, queued_at, completed_at)
       VALUES (?, ?, ?, 'COMPLETED', datetime('now'), datetime('now'))`, [runForeign, otherCompanyId, otherUserId]);

  // Encrypted results artifacts so compareRuns() can diff runA vs runB.
  // runB flips one assertion from pass→fail and adds a new one, so the diff
  // exercises several categories (UNCHANGED_PASS, PASSED_TO_FAILED, ADDED).
  seedResultsArtifact(runA, [
    { suiteName: 'Suite1', filename: 'req1.bru', tests: [
      { name: 'status 200', status: 'passed' },
      { name: 'has offer',  status: 'passed' },
    ] },
  ]);
  seedResultsArtifact(runB, [
    { suiteName: 'Suite1', filename: 'req1.bru', tests: [
      { name: 'status 200', status: 'passed' },
      { name: 'has offer',  status: 'failed', error: 'missing offer' },
      { name: 'new check',  status: 'passed' },
    ] },
  ]);

  // ── run_suites / run_requests / run_assertions / run_events for runA ────────
  // Used by POST /configured (structured report) and /requests/:id/messages.
  run(`INSERT INTO run_suites (run_id, company_id, scenario_name, suite_name, total, passed, failed)
       VALUES (?, ?, 'Sale Scenario', '01-Common', 2, 1, 1)`, [runA, companyId]);
  suiteId = get(`SELECT id FROM run_suites WHERE run_id = ? AND suite_name = '01-Common'`, [runA]).id;

  // A PASS request (with stored request/response bodies for the messages endpoint)…
  run(`INSERT INTO run_requests
       (suite_id, run_id, company_id, request_name, http_method, http_url, http_status, duration_ms, result, vendor_capability, context, request_headers, request_body, response_headers, response_body)
       VALUES (?, ?, ?, 'Get Offers', 'GET', 'https://a.example/offers', 200, 42, 'PASS', 'IMPLEMENTED', ?, ?, ?, ?, ?)`,
    [suiteId, runA, companyId, JSON.stringify({ mode: 'sale' }),
     JSON.stringify({ Accept: 'application/json' }), '{"q":1}',
     JSON.stringify({ 'Content-Type': 'application/json' }), '{"offers":[]}']);
  requestPassId = get(`SELECT id FROM run_requests WHERE run_id = ? AND request_name = 'Get Offers'`, [runA]).id;

  // …and a FAIL request (so capability matrix + chain navigation have >1 row).
  run(`INSERT INTO run_requests
       (suite_id, run_id, company_id, request_name, http_method, http_url, http_status, duration_ms, result, vendor_capability, context)
       VALUES (?, ?, ?, 'Book Offer', 'POST', 'https://a.example/bookings', 500, 88, 'FAIL', 'ERROR', NULL)`,
    [suiteId, runA, companyId]);
  const requestFailId = get(`SELECT id FROM run_requests WHERE run_id = ? AND request_name = 'Book Offer'`, [runA]).id;

  // Assertions: one passing (on the PASS request), one failing (on the FAIL request).
  run(`INSERT INTO run_assertions
       (request_id, suite_id, run_id, company_id, assertion_key, assertion_name, category, domain, severity, passed)
       VALUES (?, ?, ?, ?, 'Suite1|Get Offers|status 200', 'status is 200', 'http_status', 'offer', 'major', 1)`,
    [requestPassId, suiteId, runA, companyId]);
  run(`INSERT INTO run_assertions
       (request_id, suite_id, run_id, company_id, assertion_key, assertion_name, category, domain, severity, passed, error_msg)
       VALUES (?, ?, ?, ?, 'Suite1|Book Offer|status 201', 'status is 201', 'http_status', 'booking', 'critical', 0, 'got 500')`,
    [requestFailId, suiteId, runA, companyId]);

  // Events: a normal log tied to a surviving request + a scenario milestone.
  run(`INSERT INTO run_events (run_id, level, message, category, phase, suite_name, request_name, event_kind)
       VALUES (?, 'info', 'requesting offers', 'http', 'execution', '01-Common', 'Get Offers', 'log')`, [runA]);
  run(`INSERT INTO run_events (run_id, level, message, event_kind, scenario_name, attempt_index, attempt_total)
       VALUES (?, 'info', 'scenario starting', 'scenario_start', 'Sale Scenario', 1, 1)`, [runA]);
});

// ── Auth ────────────────────────────────────────────────────────────────────
describe('reports — auth', () => {
  test('401 on GET /templates without a token', async () => {
    const res = await request(app).get('/v1/reports/templates');
    expect(res.status).toBe(401);
  });

  test('401 on POST /compare without a token', async () => {
    const res = await request(app).post('/v1/reports/compare').send({ run_a_id: runA, run_b_id: runB });
    expect(res.status).toBe(401);
  });
});

// ── Templates CRUD ────────────────────────────────────────────────────────────
describe('reports — templates', () => {
  let templateId;

  test('GET /templates returns an array (initially without our template)', async () => {
    const res = await request(app).get('/v1/reports/templates').set('Authorization', `Bearer ${makeToken('company_user')}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.templates)).toBe(true);
    expect(res.body.templates.find(t => t.name === 'My Template')).toBeUndefined();
  });

  test('400 POST /templates without a name', async () => {
    const res = await request(app).post('/v1/reports/templates')
      .set('Authorization', `Bearer ${makeToken('company_user')}`)
      .send({ config: { status: 'failed' } });
    expect(res.status).toBe(400);
  });

  test('201 POST /templates creates a template', async () => {
    const res = await request(app).post('/v1/reports/templates')
      .set('Authorization', `Bearer ${makeToken('company_user')}`)
      .send({ name: 'My Template', config: { status: 'failed', domains: ['offer'] } });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.name).toBe('My Template');
    expect(res.body.config.status).toBe('failed');
    templateId = res.body.id;
  });

  test('GET /templates now includes the created template (config parsed)', async () => {
    const res = await request(app).get('/v1/reports/templates').set('Authorization', `Bearer ${makeToken('company_user')}`);
    expect(res.status).toBe(200);
    const t = res.body.templates.find(x => x.id === templateId);
    expect(t).toBeTruthy();
    expect(t.config.status).toBe('failed');
    expect(t.created_by).toBe('user@reports-routes-test.com');
  });

  test('404 DELETE /templates/:id for an unknown id', async () => {
    const res = await request(app).delete(`/v1/reports/templates/${uuidv4()}`)
      .set('Authorization', `Bearer ${makeToken('company_user')}`);
    expect(res.status).toBe(404);
  });

  test('403 DELETE another user\'s template (non-platform)', async () => {
    const res = await request(app).delete(`/v1/reports/templates/${templateId}`)
      .set('Authorization', `Bearer ${makeToken('company_user', uuidv4())}`);
    expect(res.status).toBe(403);
  });

  test('200 DELETE own template', async () => {
    const res = await request(app).delete(`/v1/reports/templates/${templateId}`)
      .set('Authorization', `Bearer ${makeToken('company_user')}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });
});

// ── Trends ──────────────────────────────────────────────────────────────────
describe('reports — trends', () => {
  test('GET /trends/summary returns top_failures (includes the seeded failing assertion)', async () => {
    const res = await request(app).get('/v1/reports/trends/summary').set('Authorization', `Bearer ${makeToken('company_user')}`);
    expect(res.status).toBe(200);
    expect(res.body.company_id).toBe(companyId);
    expect(Array.isArray(res.body.top_failures)).toBe(true);
    const hit = res.body.top_failures.find(r => r.assertion_key === 'Suite1|Book Offer|status 201');
    expect(hit).toBeTruthy();
    expect(hit.fail_count).toBeGreaterThanOrEqual(1);
  });

  test('400 GET /trends without assertion_key', async () => {
    const res = await request(app).get('/v1/reports/trends').set('Authorization', `Bearer ${makeToken('company_user')}`);
    expect(res.status).toBe(400);
  });

  test('GET /trends returns points for a known assertion_key', async () => {
    const res = await request(app)
      .get('/v1/reports/trends?assertion_key=Suite1%7CBook%20Offer%7Cstatus%20201')
      .set('Authorization', `Bearer ${makeToken('company_user')}`);
    expect(res.status).toBe(200);
    expect(res.body.assertion_key).toBe('Suite1|Book Offer|status 201');
    expect(Array.isArray(res.body.points)).toBe(true);
    expect(res.body.points.length).toBeGreaterThanOrEqual(1);
    expect(res.body.points[0].passed).toBe(false);
    expect(res.body.points[0].severity).toBe('critical');
  });
});

// ── Compare ─────────────────────────────────────────────────────────────────
describe('reports — POST /compare', () => {
  test('400 when run ids are missing', async () => {
    const res = await request(app).post('/v1/reports/compare')
      .set('Authorization', `Bearer ${makeToken('company_user')}`).send({});
    expect(res.status).toBe(400);
  });

  test('400 when run_a_id === run_b_id', async () => {
    const res = await request(app).post('/v1/reports/compare')
      .set('Authorization', `Bearer ${makeToken('company_user')}`)
      .send({ run_a_id: runA, run_b_id: runA });
    expect(res.status).toBe(400);
  });

  test('404 when run A does not exist', async () => {
    const res = await request(app).post('/v1/reports/compare')
      .set('Authorization', `Bearer ${makeToken('company_user')}`)
      .send({ run_a_id: uuidv4(), run_b_id: runB });
    expect(res.status).toBe(404);
  });

  test('409 when a run is not COMPLETED', async () => {
    const res = await request(app).post('/v1/reports/compare')
      .set('Authorization', `Bearer ${makeToken('company_user')}`)
      .send({ run_a_id: runA, run_b_id: runQueued });
    expect(res.status).toBe(409);
  });

  test('404 cross-tenant: cannot compare a foreign run', async () => {
    // runForeign belongs to otherCompanyId; scoped query returns nothing → 404.
    const res = await request(app).post('/v1/reports/compare')
      .set('Authorization', `Bearer ${makeToken('company_user')}`)
      .send({ run_a_id: runA, run_b_id: runForeign });
    expect(res.status).toBe(404);
  });

  let comparisonId;

  test('201 computes + stores a diff for two COMPLETED runs', async () => {
    const res = await request(app).post('/v1/reports/compare')
      .set('Authorization', `Bearer ${makeToken('company_user')}`)
      .send({ run_a_id: runA, run_b_id: runB });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.cached).toBe(false);
    expect(res.body.summary).toBeTruthy();
    // runB dropped one assertion pass→fail and added one.
    expect(res.body.summary.passed_to_failed).toBeGreaterThanOrEqual(1);
    expect(res.body.summary.added).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(res.body.items)).toBe(true);
    comparisonId = res.body.id;
  });

  test('200 second compare returns the cached snapshot', async () => {
    const res = await request(app).post('/v1/reports/compare')
      .set('Authorization', `Bearer ${makeToken('company_user')}`)
      .send({ run_a_id: runA, run_b_id: runB });
    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(true);
    expect(res.body.id).toBe(comparisonId);
  });
});

// ── Comparisons listing / retrieval ───────────────────────────────────────────
describe('reports — comparisons', () => {
  test('GET /comparisons lists the stored comparison', async () => {
    const res = await request(app).get('/v1/reports/comparisons').set('Authorization', `Bearer ${makeToken('company_user')}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.comparisons)).toBe(true);
    const hit = res.body.comparisons.find(c => c.run_a_id === runA && c.run_b_id === runB);
    expect(hit).toBeTruthy();
  });

  test('GET /comparisons as a platform admin (no company scope) lists across companies', async () => {
    const res = await request(app).get('/v1/reports/comparisons').set('Authorization', `Bearer ${makeToken('administrator', adminId)}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.comparisons)).toBe(true);
  });

  test('404 GET /comparisons/:id for an unknown id', async () => {
    const res = await request(app).get(`/v1/reports/comparisons/${uuidv4()}`).set('Authorization', `Bearer ${makeToken('company_user')}`);
    expect(res.status).toBe(404);
  });

  test('GET /comparisons/:id returns the stored diff with run metadata', async () => {
    // Fetch the id via the list first.
    const list = await request(app).get('/v1/reports/comparisons').set('Authorization', `Bearer ${makeToken('company_user')}`);
    const id = list.body.comparisons.find(c => c.run_a_id === runA && c.run_b_id === runB).id;

    const res = await request(app).get(`/v1/reports/comparisons/${id}`).set('Authorization', `Bearer ${makeToken('company_user')}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
    expect(res.body.run_a.id).toBe(runA);
    expect(res.body.run_b.id).toBe(runB);
    expect(res.body.summary).toBeTruthy();
  });
});

// ── Configured report builder ─────────────────────────────────────────────────
describe('reports — POST /configured', () => {
  test('400 when run_ids is missing / not an array', async () => {
    const res = await request(app).post('/v1/reports/configured')
      .set('Authorization', `Bearer ${makeToken('company_user')}`).send({});
    expect(res.status).toBe(400);
  });

  test('403 when a run_id belongs to another company (non-platform)', async () => {
    const res = await request(app).post('/v1/reports/configured')
      .set('Authorization', `Bearer ${makeToken('company_user')}`)
      .send({ run_ids: [runForeign] });
    expect(res.status).toBe(403);
    expect(res.body.foreign_run_ids).toContain(runForeign);
  });

  test('200 builds a structured report for a seeded run', async () => {
    const res = await request(app).post('/v1/reports/configured')
      .set('Authorization', `Bearer ${makeToken('company_user')}`)
      .send({ run_ids: [runA], title: 'My Conformance Report' });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('My Conformance Report');
    expect(res.body.run_ids).toEqual([runA]);

    // Summary: 2 assertions seeded (1 pass, 1 fail).
    expect(res.body.summary.total).toBe(2);
    expect(res.body.summary.passed).toBe(1);
    expect(res.body.summary.failed).toBe(1);

    // Grouped rollups.
    expect(Array.isArray(res.body.by_domain)).toBe(true);
    expect(res.body.by_domain.find(d => d.domain === 'booking')).toBeTruthy();
    expect(Array.isArray(res.body.by_category)).toBe(true);

    // Suites → requests hierarchy.
    expect(res.body.suites.length).toBe(1);
    const suite = res.body.suites[0];
    expect(suite.suite_name).toBe('01-Common');
    expect(suite.requests.length).toBe(2);

    // Events: normal log (surviving request) + scenario milestone both survive.
    expect(Array.isArray(res.body.events)).toBe(true);
    expect(res.body.events.some(e => e.event_kind === 'scenario_start')).toBe(true);

    // Capability matrix built directly from run_requests (2 endpoints).
    expect(Array.isArray(res.body.capability_matrix)).toBe(true);
    expect(res.body.capability_matrix.length).toBe(2);

    // Raw assertions list.
    expect(res.body.assertions.length).toBe(2);
  });

  test('200 with status=passed filter returns only passing assertions', async () => {
    const res = await request(app).post('/v1/reports/configured')
      .set('Authorization', `Bearer ${makeToken('company_user')}`)
      .send({ run_ids: [runA], filters: { status: 'passed', domains: ['offer'], categories: ['http_status'], severities: ['major'] } });
    expect(res.status).toBe(200);
    expect(res.body.summary.total).toBe(1);
    expect(res.body.summary.passed).toBe(1);
    expect(res.body.summary.failed).toBe(0);
  });

  test('200 for a platform admin scoped to the company (skips ownership pre-check)', async () => {
    const res = await request(app).post('/v1/reports/configured')
      .set('Authorization', `Bearer ${makeToken('administrator', adminId)}`)
      .set('x-company-id', companyId)
      .send({ run_ids: [runA], filters: { status: 'failed' } });
    expect(res.status).toBe(200);
    expect(res.body.summary.failed).toBe(1);
    expect(res.body.summary.passed).toBe(0);
  });
});

// ── Request messages ──────────────────────────────────────────────────────────
describe('reports — GET /requests/:id/messages', () => {
  test('400 for a non-numeric request id', async () => {
    const res = await request(app).get('/v1/reports/requests/not-a-number/messages')
      .set('Authorization', `Bearer ${makeToken('company_user')}`);
    expect(res.status).toBe(400);
  });

  test('404 for an unknown numeric request id', async () => {
    const res = await request(app).get('/v1/reports/requests/999999999/messages')
      .set('Authorization', `Bearer ${makeToken('company_user')}`);
    expect(res.status).toBe(404);
  });

  test('200 returns the raw exchange + chain navigation for a seeded request', async () => {
    const res = await request(app).get(`/v1/reports/requests/${requestPassId}/messages`)
      .set('Authorization', `Bearer ${makeToken('company_user')}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(requestPassId);
    expect(res.body.request_name).toBe('Get Offers');
    expect(res.body.suite_name).toBe('01-Common');
    expect(res.body.http_method).toBe('GET');
    expect(res.body.req_body).toBe('{"q":1}');
    expect(res.body.resp_body).toBe('{"offers":[]}');
    expect(res.body.req_headers).toEqual({ Accept: 'application/json' });
    // Book Offer was inserted after Get Offers → it's the next id in the chain.
    expect(res.body.next_id).toBeTruthy();
    expect(res.body.total).toBeGreaterThanOrEqual(2);
  });

  test('200 with failed_only=true narrows the chain', async () => {
    const res = await request(app).get(`/v1/reports/requests/${requestPassId}/messages?failed_only=true`)
      .set('Authorization', `Bearer ${makeToken('company_user')}`);
    expect(res.status).toBe(200);
    expect(res.body.failed_only).toBe(true);
  });

  test('403 when a non-platform user requests another company\'s request', async () => {
    const res = await request(app).get(`/v1/reports/requests/${requestPassId}/messages`)
      .set('Authorization', `Bearer ${makeToken('company_user', otherUserId, otherCompanyId)}`);
    expect(res.status).toBe(403);
  });
});

// ── Cleanup ───────────────────────────────────────────────────────────────────
afterAll(() => {
  const safe = (sql, p) => { try { run(sql, p); } catch (_) { /* ignore */ } };
  const bothCompanies = [companyId, otherCompanyId];
  safe('DELETE FROM report_comparisons WHERE company_id IN (?, ?)', bothCompanies);
  safe('DELETE FROM report_templates   WHERE company_id IN (?, ?)', bothCompanies);
  safe('DELETE FROM run_assertions WHERE company_id IN (?, ?)', bothCompanies);
  safe('DELETE FROM run_events     WHERE run_id IN (SELECT id FROM runs WHERE company_id IN (?, ?))', bothCompanies);
  safe('DELETE FROM run_requests   WHERE company_id IN (?, ?)', bothCompanies);
  safe('DELETE FROM run_suites     WHERE company_id IN (?, ?)', bothCompanies);
  safe('DELETE FROM run_artifacts  WHERE run_id IN (SELECT id FROM runs WHERE company_id IN (?, ?))', bothCompanies);
  safe('DELETE FROM runs           WHERE company_id IN (?, ?)', bothCompanies);
  safe('DELETE FROM users          WHERE company_id IN (?, ?)', bothCompanies);
  safe('DELETE FROM companies      WHERE id IN (?, ?)', bothCompanies);
  dirsToClean.forEach(d => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* ignore */ } });
});
