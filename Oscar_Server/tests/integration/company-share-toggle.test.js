// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * company-share-toggle.test.js — Verify the company-wide
 * share_reports_with_certifier toggle was REMOVED in v1.11.15.
 *
 * Certifier visibility is now per-report (a test_manager shares individual
 * runs from the dashboard via POST /v1/runs/:id/share). This file guards the
 * removal:
 *   - GET /v1/company no longer exposes share_reports_with_certifier
 *   - PATCH /v1/company rejects the field with 400 + a pointer to the new model
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-share-toggle';

const jwt     = require('jsonwebtoken');
const { randomUUID: uuidv4 } = require('node:crypto');
const request = require('supertest');
const { buildAppWithRoute } = require('../helpers/test-app');
const { run, get } = require('../../src/db/db');

const app = buildAppWithRoute('/v1/company', '../../src/api/routes/company');

const companyId = uuidv4();
const tmId      = uuidv4();
const testerId  = uuidv4();
const adminId   = uuidv4();

function mkToken(uid, role, cid = companyId) {
  return jwt.sign(
    { sub: uid, email: `${role}@share-test.com`, companyId: cid, role },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
}

beforeAll(() => {
  run(`INSERT OR IGNORE INTO companies (id, name, slug) VALUES (?, ?, ?)`, [companyId, 'Share Co', 'share-co']);
  run(`INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role)
       VALUES (?, ?, ?, 'x', 'test_manager')`, [tmId, companyId, 'tm@share-test.com']);
  run(`INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role)
       VALUES (?, ?, ?, 'x', 'company_user')`, [testerId, companyId, 'tester@share-test.com']);
  run(`INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role)
       VALUES (?, ?, ?, 'x', 'administrator')`, [adminId, companyId, 'admin@share-test.com']);
});

describe('GET /v1/company no longer exposes share_reports_with_certifier (v1.11.15)', () => {
  test('the sanitised company response omits the removed toggle', async () => {
    const tk = mkToken(tmId, 'test_manager');
    const res = await request(app).get('/v1/company').set('Authorization', `Bearer ${tk}`);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('share_reports_with_certifier');
  });
});

describe('PATCH /v1/company rejects the removed share_reports_with_certifier field (v1.11.15)', () => {
  test('400 with a pointer to per-report sharing when test_manager sends it', async () => {
    const tk = mkToken(tmId, 'test_manager');
    const res = await request(app)
      .patch('/v1/company')
      .set('Authorization', `Bearer ${tk}`)
      .send({ share_reports_with_certifier: false });
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/per-report|removed in v1\.11\.15/i);
    // And it must NOT have persisted any change to the (retained) column.
    const row = get('SELECT share_reports_with_certifier AS s FROM companies WHERE id = ?', [companyId]);
    expect(row.s).toBe(1); // schema default, untouched
  });

  test('400 regardless of role (admin also rejected before any write)', async () => {
    const tk = mkToken(adminId, 'administrator', companyId);
    const res = await request(app)
      .patch(`/v1/company?company_id=${companyId}`)
      .set('Authorization', `Bearer ${tk}`)
      .send({ share_reports_with_certifier: true });
    expect(res.status).toBe(400);
  });
});

afterAll(() => {
  const safeRun = (sql, params) => { try { run(sql, params); } catch (_) { /* */ } };
  safeRun('DELETE FROM auth_events WHERE company_id = ?', [companyId]);
  safeRun('DELETE FROM users WHERE company_id = ?', [companyId]);
  safeRun('DELETE FROM companies WHERE id = ?', [companyId]);
});
