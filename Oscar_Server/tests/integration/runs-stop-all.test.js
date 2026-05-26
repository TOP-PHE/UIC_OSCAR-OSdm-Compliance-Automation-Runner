// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * runs-stop-all.test.js — Integration tests for POST /v1/runs/stop-all
 * (Emergency Stop).
 *
 * Permission matrix under test:
 *   - 401 without a token
 *   - 403 for certification_user
 *   - company_user (tester)  → cancels ONLY the runs they launched
 *   - test_manager           → ALSO only their OWN runs (cannot stop teammates)
 *   - administrator          → ALL active runs across EVERY company (platform-wide)
 *   - no active runs         → stopped: 0
 *
 * No real Bruno child exists in tests, so processes_killed is 0 — the DB CANCEL
 * still applies, which is what these tests assert.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-stop-all';

const jwt = require('jsonwebtoken');
const { randomUUID: uuidv4 } = require('node:crypto');
const request = require('supertest');
const { buildAppWithRoute } = require('../helpers/test-app');
const { run, get } = require('../../src/db/db');

const app = buildAppWithRoute('/v1/runs', '../../src/api/routes/runs');

const companyA   = uuidv4();
const companyB   = uuidv4();
const testerId   = uuidv4();
const tester2Id  = uuidv4();
const managerId  = uuidv4();
const adminId    = uuidv4();
const certifierId = uuidv4();
const userBId    = uuidv4();

function makeToken(role, uid, companyId = companyA) {
  return jwt.sign(
    { sub: uid, email: `${role}@stopall.test`, companyId, role },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
}

beforeAll(() => {
  run("INSERT OR IGNORE INTO companies (id, name, slug) VALUES (?, 'StopAll A', 'stopall-a')", [companyA]);
  run("INSERT OR IGNORE INTO companies (id, name, slug) VALUES (?, 'StopAll B', 'stopall-b')", [companyB]);
  const seedUser = (id, companyId, role, email) =>
    run('INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, \'x\', ?)',
      [id, companyId, email, role]);
  seedUser(testerId,    companyA, 'company_user',       'tester1@stopall.test');
  seedUser(tester2Id,   companyA, 'company_user',       'tester2@stopall.test');
  seedUser(managerId,   companyA, 'test_manager',       'manager@stopall.test');
  seedUser(adminId,     companyA, 'administrator',      'admin@stopall.test');
  seedUser(certifierId, companyA, 'certification_user', 'certifier@stopall.test');
  seedUser(userBId,     companyB, 'company_user',       'userb@stopall.test');
});

function insertRun(userId, companyId, status) {
  const id = uuidv4();
  run('INSERT INTO runs (id, company_id, user_id, status) VALUES (?, ?, ?, ?)', [id, companyId, userId, status]);
  return id;
}
const statusOf = (id) => get('SELECT status FROM runs WHERE id = ?', [id]).status;
const park = (id) => run("UPDATE runs SET status = 'COMPLETED' WHERE id = ?", [id]); // keep tests isolated

describe('POST /v1/runs/stop-all', () => {
  test('401 without token', async () => {
    const res = await request(app).post('/v1/runs/stop-all');
    expect(res.status).toBe(401);
  });

  test('403 for certification_user', async () => {
    const res = await request(app).post('/v1/runs/stop-all')
      .set('Authorization', `Bearer ${makeToken('certification_user', certifierId)}`);
    expect(res.status).toBe(403);
  });

  test('tester stops only their OWN runs (teammate untouched)', async () => {
    const mineRunning = insertRun(testerId, companyA, 'RUNNING');
    const mineQueued  = insertRun(testerId, companyA, 'QUEUED');
    const teammate    = insertRun(tester2Id, companyA, 'RUNNING');

    const res = await request(app).post('/v1/runs/stop-all')
      .set('Authorization', `Bearer ${makeToken('company_user', testerId)}`);

    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('own');
    expect(res.body.running_cancelled).toBe(1);
    expect(res.body.queued_cancelled).toBe(1);
    expect(statusOf(mineRunning)).toBe('CANCELLED');
    expect(statusOf(mineQueued)).toBe('CANCELLED');
    expect(statusOf(teammate)).toBe('RUNNING');

    park(teammate);
  });

  test('test_manager stops only their OWN runs (cannot stop a teammate)', async () => {
    const mgrRun    = insertRun(managerId, companyA, 'RUNNING');
    const tester1Run = insertRun(testerId, companyA, 'RUNNING');

    const res = await request(app).post('/v1/runs/stop-all')
      .set('Authorization', `Bearer ${makeToken('test_manager', managerId)}`);

    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('own');
    expect(res.body.running_cancelled).toBe(1);
    expect(statusOf(mgrRun)).toBe('CANCELLED');
    expect(statusOf(tester1Run)).toBe('RUNNING');   // teammate untouched — admin-only power

    park(tester1Run);
  });

  test('administrator stops ALL active runs across EVERY company', async () => {
    const aRun = insertRun(testerId, companyA, 'RUNNING');
    const bRun = insertRun(userBId,  companyB, 'QUEUED');

    const res = await request(app).post('/v1/runs/stop-all')
      .set('Authorization', `Bearer ${makeToken('administrator', adminId)}`);

    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('platform');
    expect(res.body.stopped).toBeGreaterThanOrEqual(2);
    expect(statusOf(aRun)).toBe('CANCELLED');
    expect(statusOf(bRun)).toBe('CANCELLED');   // cross-company
  });

  test('no active runs → stopped: 0', async () => {
    const res = await request(app).post('/v1/runs/stop-all')
      .set('Authorization', `Bearer ${makeToken('administrator', adminId)}`);
    expect(res.status).toBe(200);
    expect(res.body.stopped).toBe(0);
  });
});
