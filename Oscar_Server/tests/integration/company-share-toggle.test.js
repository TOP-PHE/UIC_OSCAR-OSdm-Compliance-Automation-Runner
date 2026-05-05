// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * company-share-toggle.test.js — Verify the v15 share_reports_with_certifier
 * flag is honoured at the right places.
 *
 *   - Default value is true (backward compatibility)
 *   - Only test_manager can change it via PATCH /v1/company
 *   - Sanitised company response includes the boolean
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-share-toggle';

const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
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

describe('GET /v1/company exposes share_reports_with_certifier', () => {
  test('defaults to true on a freshly-created company', async () => {
    const tk = mkToken(tmId, 'test_manager');
    const res = await request(app).get('/v1/company').set('Authorization', `Bearer ${tk}`);
    expect(res.status).toBe(200);
    expect(res.body.share_reports_with_certifier).toBe(true);
  });
});

describe('PATCH /v1/company { share_reports_with_certifier } authorisation', () => {
  test('200 when test_manager flips the flag to false', async () => {
    const tk = mkToken(tmId, 'test_manager');
    const res = await request(app)
      .patch('/v1/company')
      .set('Authorization', `Bearer ${tk}`)
      .send({ share_reports_with_certifier: false });
    expect(res.status).toBe(200);
    expect(res.body.share_reports_with_certifier).toBe(false);
    // Verify it persisted
    const row = get('SELECT share_reports_with_certifier AS s FROM companies WHERE id = ?', [companyId]);
    expect(row.s).toBe(0);
  });

  test('200 when test_manager flips it back to true', async () => {
    const tk = mkToken(tmId, 'test_manager');
    const res = await request(app)
      .patch('/v1/company')
      .set('Authorization', `Bearer ${tk}`)
      .send({ share_reports_with_certifier: true });
    expect(res.status).toBe(200);
    expect(res.body.share_reports_with_certifier).toBe(true);
  });

  test('403 when administrator tries to flip the flag', async () => {
    // Admin can target the company via query param via the platform-role path.
    const tk = mkToken(adminId, 'administrator', companyId);
    const res = await request(app)
      .patch(`/v1/company?company_id=${companyId}`)
      .set('Authorization', `Bearer ${tk}`)
      .send({ share_reports_with_certifier: false });
    expect(res.status).toBe(403);
    expect(res.body.detail).toMatch(/Only test_manager/);
  });

  test('400 when the flag value is not a boolean', async () => {
    const tk = mkToken(tmId, 'test_manager');
    const res = await request(app)
      .patch('/v1/company')
      .set('Authorization', `Bearer ${tk}`)
      .send({ share_reports_with_certifier: 'no' });
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/boolean/);
  });
});

afterAll(() => {
  const safeRun = (sql, params) => { try { run(sql, params); } catch (_) { /* */ } };
  safeRun('DELETE FROM auth_events WHERE company_id = ?', [companyId]);
  safeRun('DELETE FROM users WHERE company_id = ?', [companyId]);
  safeRun('DELETE FROM companies WHERE id = ?', [companyId]);
});
