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
 *
 * Does NOT exercise queue.enqueue → executeRun (worker tests live elsewhere).
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-runs-routes';

const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const request = require('supertest');
const { buildAppWithRoute } = require('../helpers/test-app');
const { run, get } = require('../../src/db/db');

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

afterAll(() => {
  // Clean up
  run('DELETE FROM run_artifacts WHERE run_id IN (SELECT id FROM runs WHERE company_id = ?)', [companyId]);
  run('DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE company_id = ?)', [companyId]);
  run('DELETE FROM runs WHERE company_id = ?', [companyId]);
  run('DELETE FROM users WHERE company_id = ?', [companyId]);
  run('DELETE FROM companies WHERE id = ?', [companyId]);
});
