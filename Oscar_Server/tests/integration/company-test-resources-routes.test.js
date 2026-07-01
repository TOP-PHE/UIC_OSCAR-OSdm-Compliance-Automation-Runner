// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * company-test-resources-routes.test.js — integration tests for
 * /v1/company/test-resources (CRUD) plus the two vendor-calling endpoints
 * (discover-timetable, reprobe-offers).
 *
 * Covers:
 *   - Auth + role gating (read = vendor users; write = test_manager only;
 *     admin/certifier denied — issue #60)
 *   - CRUD: resource_type validation, encrypted `data` round-trip, tenant
 *     isolation on PUT/DELETE
 *   - discover-timetable / reprobe-offers: guard + validation branches, and a
 *     happy path with bearer creds + a stubbed global.fetch (no real vendor)
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-test-resources-routes';

const jwt     = require('jsonwebtoken');
const { randomUUID: uuidv4 } = require('node:crypto');
const request = require('supertest');
const { buildAppWithRoute } = require('../helpers/test-app');
const { run, get, all, encrypt } = require('../../src/db/db');

const app = buildAppWithRoute('/v1/company', '../../src/api/routes/company-test-resources');

const companyId      = uuidv4();   // has api_base (for discover/reprobe)
const noApiCompanyId = uuidv4();   // no api_base
const otherCompanyId = uuidv4();   // for cross-tenant checks
const tmId           = uuidv4();
const testerId       = uuidv4();
const certId         = uuidv4();
const adminId        = uuidv4();
const tmNoApiId      = uuidv4();

function makeToken(role, uid, cid = companyId) {
  return jwt.sign(
    { sub: uid, email: `${role}@tr-routes-test.com`, companyId: cid, role },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
}

beforeAll(() => {
  run(`INSERT OR IGNORE INTO companies (id, name, slug, api_base) VALUES (?, 'TR Test', 'tr-test', 'https://vendor.example/osdm')`, [companyId]);
  run(`INSERT OR IGNORE INTO companies (id, name, slug) VALUES (?, 'TR NoApi', 'tr-noapi')`, [noApiCompanyId]);
  run(`INSERT OR IGNORE INTO companies (id, name, slug, api_base) VALUES (?, 'TR Other', 'tr-other', 'https://other.example/osdm')`, [otherCompanyId]);
  // test_manager with BEARER creds → resolveAccessToken returns without network.
  run(`INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role, auth_mode, access_token_enc) VALUES (?, ?, 'test_manager@tr-routes-test.com', 'x', 'test_manager', 'bearer', ?)`, [tmId, companyId, encrypt('stub-bearer-token')]);
  run(`INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, 'company_user@tr-routes-test.com', 'x', 'company_user')`, [testerId, companyId]);
  run(`INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, 'certification_user@tr-routes-test.com', 'x', 'certification_user')`, [certId, companyId]);
  run(`INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, 'administrator@tr-routes-test.com', 'x', 'administrator')`, [adminId, companyId]);
  run(`INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role, auth_mode, access_token_enc) VALUES (?, ?, 'tm2@tr-routes-test.com', 'x', 'test_manager', 'bearer', ?)`, [tmNoApiId, noApiCompanyId, encrypt('stub-bearer-token')]);
});

// ── Auth + role gating ────────────────────────────────────────────────────────
describe('test-resources — auth + role gating', () => {
  test('401 on GET without token', async () => {
    const res = await request(app).get('/v1/company/test-resources');
    expect(res.status).toBe(401);
  });

  test('403 on GET for administrator and certification_user (admin/certifier denied)', async () => {
    const a = await request(app).get('/v1/company/test-resources').set('Authorization', `Bearer ${makeToken('administrator', adminId)}`);
    expect(a.status).toBe(403);
    const c = await request(app).get('/v1/company/test-resources').set('Authorization', `Bearer ${makeToken('certification_user', certId)}`);
    expect(c.status).toBe(403);
  });

  test('200 on GET for a tester (read allowed)', async () => {
    const res = await request(app).get('/v1/company/test-resources').set('Authorization', `Bearer ${makeToken('company_user', testerId)}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('403 on POST for a tester (write = test_manager only)', async () => {
    const res = await request(app).post('/v1/company/test-resources')
      .set('Authorization', `Bearer ${makeToken('company_user', testerId)}`)
      .send({ resource_type: 'TRAIN', label: 'x' });
    expect(res.status).toBe(403);
  });
});

// ── CRUD ──────────────────────────────────────────────────────────────────────
describe('test-resources — CRUD', () => {
  const auth = () => `Bearer ${makeToken('test_manager', tmId)}`;
  let createdId;

  test('400 when resource_type is missing/invalid', async () => {
    const bad = await request(app).post('/v1/company/test-resources').set('Authorization', auth()).send({ label: 'x' });
    expect(bad.status).toBe(400);
    const bad2 = await request(app).post('/v1/company/test-resources').set('Authorization', auth()).send({ resource_type: 'PLANE', label: 'x' });
    expect(bad2.status).toBe(400);
  });

  test('400 when label is blank', async () => {
    const res = await request(app).post('/v1/company/test-resources').set('Authorization', auth()).send({ resource_type: 'TRAIN', label: '   ' });
    expect(res.status).toBe(400);
  });

  test('201 create trims label and round-trips the encrypted data blob', async () => {
    const res = await request(app).post('/v1/company/test-resources').set('Authorization', auth())
      .send({ resource_type: 'TRAIN', label: '  Demo IC  ', data: { originURN: 'urn:uic:stn:8500010', vehicleNumber: 'IC1' } });
    expect(res.status).toBe(201);
    expect(res.body.label).toBe('Demo IC');
    expect(res.body.resource_type).toBe('TRAIN');
    expect(res.body.data.vehicleNumber).toBe('IC1');
    createdId = res.body.id;
    // the on-disk column is encrypted, not plaintext JSON
    const raw = get('SELECT data FROM test_resources WHERE id = ?', [createdId]).data;
    expect(raw).not.toContain('IC1');
  });

  test('201 create accepts MULTIMODAL too', async () => {
    const res = await request(app).post('/v1/company/test-resources').set('Authorization', auth())
      .send({ resource_type: 'MULTIMODAL', label: 'Multi', data: {} });
    expect(res.status).toBe(201);
  });

  test('GET lists the created resource with data decrypted to an object', async () => {
    const res = await request(app).get('/v1/company/test-resources').set('Authorization', auth());
    expect(res.status).toBe(200);
    const row = res.body.find(r => r.id === createdId);
    expect(row).toBeTruthy();
    expect(typeof row.data).toBe('object');
    expect(row.data.originURN).toBe('urn:uic:stn:8500010');
  });

  test('PUT updates label + data (test_manager only)', async () => {
    const res = await request(app).put(`/v1/company/test-resources/${createdId}`).set('Authorization', auth())
      .send({ label: '  Renamed IC  ', data: { vehicleNumber: 'IC2' } });
    expect(res.status).toBe(200);
    expect(res.body.label).toBe('Renamed IC');
    expect(res.body.data.vehicleNumber).toBe('IC2');
  });

  test('PUT/DELETE 404 for an unknown id', async () => {
    const put = await request(app).put(`/v1/company/test-resources/${uuidv4()}`).set('Authorization', auth()).send({ label: 'x' });
    expect(put.status).toBe(404);
    const del = await request(app).delete(`/v1/company/test-resources/${uuidv4()}`).set('Authorization', auth());
    expect(del.status).toBe(404);
  });

  test('DELETE 404 for a resource in another company (tenant isolation)', async () => {
    const foreignId = uuidv4();
    run(`INSERT INTO test_resources (id, company_id, resource_type, label, data) VALUES (?, ?, 'TRAIN', 'foreign', '{}')`, [foreignId, otherCompanyId]);
    const res = await request(app).delete(`/v1/company/test-resources/${foreignId}`).set('Authorization', auth());
    expect(res.status).toBe(404);
    run('DELETE FROM test_resources WHERE id = ?', [foreignId]);
  });

  test('DELETE removes the resource', async () => {
    const res = await request(app).delete(`/v1/company/test-resources/${createdId}`).set('Authorization', auth());
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });
});

// ── discover-timetable ────────────────────────────────────────────────────────
describe('test-resources — discover-timetable', () => {
  test('403 for a non-test_manager', async () => {
    const res = await request(app).post('/v1/company/test-resources/discover-timetable')
      .set('Authorization', `Bearer ${makeToken('company_user', testerId)}`)
      .send({ originURN: 'urn:uic:stn:8500010', destinationURN: 'urn:uic:stn:8503000' });
    expect(res.status).toBe(403);
  });

  test('400 when origin/destination missing', async () => {
    const res = await request(app).post('/v1/company/test-resources/discover-timetable')
      .set('Authorization', `Bearer ${makeToken('test_manager', tmId)}`).send({});
    expect(res.status).toBe(400);
  });

  test('400 when the company has no api_base', async () => {
    const res = await request(app).post('/v1/company/test-resources/discover-timetable')
      .set('Authorization', `Bearer ${makeToken('test_manager', tmNoApiId, noApiCompanyId)}`)
      .send({ originURN: 'urn:uic:stn:8500010', destinationURN: 'urn:uic:stn:8503000' });
    expect(res.status).toBe(400);
  });

  test('502 when every vendor day returns non-2xx', async () => {
    const origFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 500, text: async () => 'err' });
    try {
      const res = await request(app).post('/v1/company/test-resources/discover-timetable')
        .set('Authorization', `Bearer ${makeToken('test_manager', tmId)}`)
        .send({ originURN: 'urn:uic:stn:8500010', destinationURN: 'urn:uic:stn:8503000', days: 1 });
      expect(res.status).toBe(502);
      expect(Array.isArray(res.body.dayResults)).toBe(true);
    } finally { global.fetch = origFetch; }
  });

  test('200 happy path — vendor returns an (empty) offers payload', async () => {
    const origFetch = global.fetch;
    global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ trips: [] }) });
    try {
      const res = await request(app).post('/v1/company/test-resources/discover-timetable')
        .set('Authorization', `Bearer ${makeToken('test_manager', tmId)}`)
        .send({ originURN: 'urn:uic:stn:8500010', destinationURN: 'urn:uic:stn:8503000', days: 1 });
      expect(res.status).toBe(200);
      expect(res.body.summary).toBeTruthy();
      expect(Array.isArray(res.body.created)).toBe(true);
      expect(Array.isArray(res.body.dayResults)).toBe(true);
    } finally { global.fetch = origFetch; }
  });
});

// ── reprobe-offers ─────────────────────────────────────────────────────────────
describe('test-resources — reprobe-offers', () => {
  test('403 for a non-test_manager', async () => {
    const res = await request(app).post('/v1/company/test-resources/reprobe-offers')
      .set('Authorization', `Bearer ${makeToken('company_user', testerId)}`);
    expect(res.status).toBe(403);
  });

  test('400 when the company has no api_base', async () => {
    const res = await request(app).post('/v1/company/test-resources/reprobe-offers')
      .set('Authorization', `Bearer ${makeToken('test_manager', tmNoApiId, noApiCompanyId)}`);
    expect(res.status).toBe(400);
  });

  test('200 happy path with a seeded TRAIN route + stubbed vendor', async () => {
    // Seed a TRAIN resource with an O&D so reprobe has a route to probe.
    const trainId = uuidv4();
    const { colEncrypt } = require('../../src/db/db');
    run(`INSERT INTO test_resources (id, company_id, resource_type, label, data) VALUES (?, ?, 'TRAIN', 'Probe me', ?)`,
      [trainId, companyId, colEncrypt(JSON.stringify({ originURN: 'urn:uic:stn:8500010', destinationURN: 'urn:uic:stn:8503000' }))]);
    const origFetch = global.fetch;
    global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ trips: [] }) });
    try {
      const res = await request(app).post('/v1/company/test-resources/reprobe-offers')
        .set('Authorization', `Bearer ${makeToken('test_manager', tmId)}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.routes)).toBe(true);
    } finally {
      global.fetch = origFetch;
      run('DELETE FROM test_resources WHERE id = ?', [trainId]);
    }
  });
});

afterAll(() => {
  run("DELETE FROM test_resources WHERE company_id IN (?, ?, ?)", [companyId, noApiCompanyId, otherCompanyId]);
  run("DELETE FROM users WHERE email LIKE '%@tr-routes-test.com'");
  run('DELETE FROM companies WHERE id IN (?, ?, ?)', [companyId, noApiCompanyId, otherCompanyId]);
});
