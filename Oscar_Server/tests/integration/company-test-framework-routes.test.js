// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * company-test-framework-routes.test.js — Integration tests for the test
 * framework configuration routes (/v1/company/test-framework, Wizard Step 1).
 *
 * Covers:
 *   - Auth + role gating: 401 without a token; 403 for administrator + certifier
 *     on both read and write; test framework is test data (issue #60), so it is
 *     tester-readable but test_manager-write only.
 *   - GET returns 404 when nothing is configured; 200 with the decrypted config
 *     once a framework exists (config is encrypted at rest via colEncrypt).
 *   - PUT create → GET round-trip; PUT accepts both { config: {...} } and a bare
 *     config object; PUT update overwrites the previous config.
 *   - DELETE removes the framework (test_manager only; 403 for a tester).
 *   - The lazy salesFlows migration path on GET (applyFrameworkMigration) —
 *     an un-stamped config gets stamped with _salesFlowsMigratedAt on read.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-tf-routes';

const jwt     = require('jsonwebtoken');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');
const { randomUUID: uuidv4 } = require('node:crypto');
const request = require('supertest');
const { buildAppWithRoute } = require('../helpers/test-app');
const { run, colEncrypt } = require('../../src/db/db');
const { encryptBuffer } = require('../../src/utils/at-rest');

const app = buildAppWithRoute('/v1/company', '../../src/api/routes/company-test-framework');

// ── Seed data (unique uuids so this file never collides with other suites) ──────
const companyId = uuidv4();
const tmId       = uuidv4();
const testerId   = uuidv4();
const certId     = uuidv4();
const adminId    = uuidv4();

function makeToken(role, uid, cid = companyId) {
  return jwt.sign(
    { sub: uid, email: `${role}@tf-routes-test.com`, companyId: cid, role },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
}

beforeAll(() => {
  run(`INSERT OR IGNORE INTO companies (id, name, slug) VALUES (?, 'TF Route Test', ?)`, [companyId, `tf-route-test-${companyId}`]);
  run(`INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, 'tm@tf-routes-test.com', 'x', 'test_manager')`, [tmId, companyId]);
  run(`INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, 'tester@tf-routes-test.com', 'x', 'company_user')`, [testerId, companyId]);
  run(`INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, 'cert@tf-routes-test.com', 'x', 'certification_user')`, [certId, companyId]);
  run(`INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, 'admin@tf-routes-test.com', 'x', 'administrator')`, [adminId, companyId]);
});

// ── Auth + role gating ──────────────────────────────────────────────────────────
describe('test-framework — auth + role gating', () => {
  test('401 on GET without a token', async () => {
    const res = await request(app).get('/v1/company/test-framework');
    expect(res.status).toBe(401);
  });

  test('401 on PUT without a token', async () => {
    const res = await request(app).put('/v1/company/test-framework').send({ config: {} });
    expect(res.status).toBe(401);
  });

  test('403 on GET for certification_user (test data — no access)', async () => {
    const res = await request(app).get('/v1/company/test-framework')
      .set('Authorization', `Bearer ${makeToken('certification_user', certId)}`);
    expect(res.status).toBe(403);
  });

  test('403 on GET for administrator (test data — no access)', async () => {
    const res = await request(app).get('/v1/company/test-framework')
      .set('Authorization', `Bearer ${makeToken('administrator', adminId)}`);
    expect(res.status).toBe(403);
  });

  test('403 on PUT for certification_user (write is test_manager-only)', async () => {
    const res = await request(app).put('/v1/company/test-framework')
      .set('Authorization', `Bearer ${makeToken('certification_user', certId)}`)
      .send({ config: { hacked: true } });
    expect(res.status).toBe(403);
  });

  test('403 on PUT for administrator (write is test_manager-only)', async () => {
    const res = await request(app).put('/v1/company/test-framework')
      .set('Authorization', `Bearer ${makeToken('administrator', adminId)}`)
      .send({ config: { hacked: true } });
    expect(res.status).toBe(403);
  });

  test('403 on DELETE for a tester (write is test_manager-only)', async () => {
    const res = await request(app).delete('/v1/company/test-framework')
      .set('Authorization', `Bearer ${makeToken('company_user', testerId)}`);
    expect(res.status).toBe(403);
  });
});

// ── GET when nothing is configured ──────────────────────────────────────────────
describe('test-framework — GET with no config', () => {
  test('404 for a tester when no framework exists yet', async () => {
    const res = await request(app).get('/v1/company/test-framework')
      .set('Authorization', `Bearer ${makeToken('company_user', testerId)}`);
    expect(res.status).toBe(404);
    expect(res.body.title).toBe('Not Found');
  });
});

// ── PUT create / update + GET round-trip ────────────────────────────────────────
describe('test-framework — PUT create/update + GET', () => {
  test('200 test_manager creates a framework via { config: {...} }', async () => {
    const res = await request(app).put('/v1/company/test-framework')
      .set('Authorization', `Bearer ${makeToken('test_manager', tmId)}`)
      .send({ config: { profile: 'OTST', salesFlows: ['sale'], _salesFlowsMigratedAt: '2026-01-01T00:00:00.000Z' } });
    expect(res.status).toBe(200);
    expect(res.body.saved).toBe(true);
    expect(res.body.updated_at).toBeTruthy();
  });

  test('200 GET returns the decrypted config for a tester', async () => {
    const res = await request(app).get('/v1/company/test-framework')
      .set('Authorization', `Bearer ${makeToken('company_user', testerId)}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBeTruthy();
    expect(res.body.config.profile).toBe('OTST');
    expect(res.body.config.salesFlows).toEqual(['sale']);
    expect(res.body.created_at).toBeTruthy();
  });

  test('200 GET returns the same config for the test_manager', async () => {
    const res = await request(app).get('/v1/company/test-framework')
      .set('Authorization', `Bearer ${makeToken('test_manager', tmId)}`);
    expect(res.status).toBe(200);
    expect(res.body.config.profile).toBe('OTST');
  });

  test('200 PUT accepts a bare config object (no { config } wrapper) and overwrites', async () => {
    const res = await request(app).put('/v1/company/test-framework')
      .set('Authorization', `Bearer ${makeToken('test_manager', tmId)}`)
      .send({ profile: 'NHF', salesFlows: ['sale', 'refund'], _salesFlowsMigratedAt: '2026-01-01T00:00:00.000Z' });
    expect(res.status).toBe(200);
    expect(res.body.saved).toBe(true);

    const after = await request(app).get('/v1/company/test-framework')
      .set('Authorization', `Bearer ${makeToken('test_manager', tmId)}`);
    expect(after.status).toBe(200);
    // Update overwrote the previous config wholesale.
    expect(after.body.config.profile).toBe('NHF');
    expect(after.body.config.salesFlows).toEqual(['sale', 'refund']);
  });
});

// ── Lazy salesFlows migration on GET (applyFrameworkMigration) ──────────────────
describe('test-framework — lazy salesFlows migration on GET', () => {
  test('an un-stamped config gets stamped with _salesFlowsMigratedAt on read', async () => {
    // Write an encrypted framework row directly, WITHOUT the migration stamp,
    // to force the migration branch on the next GET.
    const legacy = colEncrypt(JSON.stringify({ profile: 'OTST', salesFlows: [] }));
    run(`UPDATE test_frameworks SET config = ? WHERE company_id = ?`, [legacy, companyId]);

    const res = await request(app).get('/v1/company/test-framework')
      .set('Authorization', `Bearer ${makeToken('test_manager', tmId)}`);
    expect(res.status).toBe(200);
    // The migration stamps the config so it runs only once per framework.
    expect(res.body.config._salesFlowsMigratedAt).toBeTruthy();
  });

  test('migration reads scenarios from the company datafile when present', async () => {
    // Point the company at a real encrypted datafile carrying scenarios, then
    // reset the framework to un-stamped so the migration reads + parses it.
    // Use mkdtempSync for a private (0700) temp dir — writing straight into
    // os.tmpdir() trips CodeQL's js/insecure-temporary-file.
    const dfDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-df-'));
    const dfPath = path.join(dfDir, 'datafile.enc');
    const plain  = Buffer.from(JSON.stringify({ scenarios: [{ code: 'X', name: 'x' }] }), 'utf8');
    fs.writeFileSync(dfPath, encryptBuffer(plain));
    run(`UPDATE companies SET datafile_path = ? WHERE id = ?`, [dfPath, companyId]);

    const legacy = colEncrypt(JSON.stringify({ profile: 'OTST', salesFlows: [] }));
    run(`UPDATE test_frameworks SET config = ? WHERE company_id = ?`, [legacy, companyId]);

    const res = await request(app).get('/v1/company/test-framework')
      .set('Authorization', `Bearer ${makeToken('test_manager', tmId)}`);
    expect(res.status).toBe(200);
    expect(res.body.config._salesFlowsMigratedAt).toBeTruthy();

    fs.rmSync(dfDir, { recursive: true, force: true });
    run(`UPDATE companies SET datafile_path = NULL WHERE id = ?`, [companyId]);
  });
});

// ── DELETE ──────────────────────────────────────────────────────────────────────
describe('test-framework — DELETE', () => {
  test('200 test_manager deletes the framework, then GET is 404', async () => {
    const del = await request(app).delete('/v1/company/test-framework')
      .set('Authorization', `Bearer ${makeToken('test_manager', tmId)}`);
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);

    const after = await request(app).get('/v1/company/test-framework')
      .set('Authorization', `Bearer ${makeToken('test_manager', tmId)}`);
    expect(after.status).toBe(404);
  });
});

// ── Cleanup ─────────────────────────────────────────────────────────────────────
afterAll(() => {
  const safeRun = (sql, params) => { try { run(sql, params); } catch (_) { /* ignore */ } };
  safeRun('DELETE FROM test_frameworks WHERE company_id = ?', [companyId]);
  safeRun('DELETE FROM auth_events WHERE company_id = ?', [companyId]);
  safeRun('DELETE FROM users WHERE company_id = ?', [companyId]);
  safeRun('DELETE FROM companies WHERE id = ?', [companyId]);
});
