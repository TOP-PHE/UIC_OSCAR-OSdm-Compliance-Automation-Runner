// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * What stops the run pods kept for a company or provider (#1309; part 1 =
 * #1316): an intrusion, another endpoint, new credentials.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-kept-pods-revocation';

const jwt = require('jsonwebtoken');
const { randomUUID: uuidv4 } = require('node:crypto');
const request = require('supertest');
const express = require('express');
const { run, get } = require('../../src/db/db');
const keptPods = require('../../src/worker/keptPods');
const { recordIntrusion } = require('../../src/utils/intrusion');

const app = express();
app.use(express.json());
app.use('/v1/company', require('../../src/api/routes/company'));
app.use('/v1/me/credentials', require('../../src/api/routes/me-credentials'));

const companyId = uuidv4();
const otherCompanyId = uuidv4();
const tmId = uuidv4();
const testerId = uuidv4();

const token = (id, role) => jwt.sign({ sub: id, email: `${id}@kept.test`, companyId, role },
  process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
const asTm = () => `Bearer ${token(tmId, 'test_manager')}`;
const asTester = () => `Bearer ${token(testerId, 'company_user')}`;

beforeAll(() => {
  run('INSERT INTO companies (id, name, slug, api_base) VALUES (?, ?, ?, ?)',
    [companyId, 'Kept Co', `kept-${companyId}`, 'https://provider-a.example/osdm/v3']);
  run('INSERT INTO companies (id, name, slug, api_base) VALUES (?, ?, ?, ?)',
    [otherCompanyId, 'Other Kept Co', `kept-${otherCompanyId}`, 'https://provider-z.example/osdm/v3']);
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'test_manager')`, [tmId, companyId, `${tmId}@kept.test`]);
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'company_user')`, [testerId, companyId, `${testerId}@kept.test`]);
});
afterEach(() => {
  for (const p of keptPods.snapshot()) keptPods.revokeCompany(p.companyId);
});

const podFor = (company, user) => keptPods.open({ companyId: company, userId: user, batchId: uuidv4() }).podId;
const podsLeft = () => keptPods.snapshot().map((p) => p.podId).sort();

describe('the pods kept for a company or provider are stopped', () => {
  test('by an intrusion: every pod of that company, whoever runs it', () => {
    const runId = uuidv4();
    run(`INSERT INTO runs (id, company_id, user_id, status) VALUES (?, ?, ?, 'RUNNING')`, [runId, companyId, testerId]);
    podFor(companyId, testerId);
    podFor(companyId, tmId);
    const elsewhere = podFor(otherCompanyId, uuidv4());
    const event = recordIntrusion({ runId, companyId, userId: testerId, kind: 'script', step: '01. POST Get Offer' }, async () => {});
    expect(event).toMatchObject({ run_id: runId, company_id: companyId });
    expect(podsLeft()).toEqual([elsewhere]);
    run('UPDATE companies SET endpoint_suspended_at = NULL, endpoint_suspended_reason = NULL WHERE id = ?', [companyId]);
  });

  test('by an intrusion even when it cannot be recorded', () => {
    podFor(companyId, testerId);
    // A run that does not exist: the security event cannot reference it.
    recordIntrusion({ runId: uuidv4(), companyId, userId: testerId, kind: 'script', step: null }, async () => {});
    expect(podsLeft()).toEqual([]);
    run('UPDATE companies SET endpoint_suspended_at = NULL, endpoint_suspended_reason = NULL WHERE id = ?', [companyId]);
  });

  test('by another endpoint saved; not by the same endpoint sent back', async () => {
    podFor(companyId, testerId);
    const echoed = await request(app).patch('/v1/company').set('Authorization', asTester())
      .send({ api_base: get('SELECT api_base FROM companies WHERE id = ?', [companyId]).api_base });
    expect(echoed.status).toBe(200);
    expect(podsLeft()).toHaveLength(1);
    const elsewhere = podFor(otherCompanyId, uuidv4());
    const changed = await request(app).patch('/v1/company').set('Authorization', asTm()).send({ api_base: 'https://provider-b.example/osdm' });
    expect(changed.status).toBe(200);
    expect(podsLeft()).toEqual([elsewhere]);
  });

  test('by new credentials: the pods of that user for that company only', async () => {
    const mine = podFor(companyId, testerId);
    const colleague = podFor(companyId, tmId);
    const mineElsewhere = podFor(otherCompanyId, testerId);
    const saved = await request(app).patch('/v1/me/credentials').set('Authorization', asTester())
      .send({ auth_mode: 'bearer', access_token: 'a-provider-token' });
    expect(saved.status).toBe(200);
    expect(podsLeft()).toEqual([colleague, mineElsewhere].sort());
    expect(podsLeft()).not.toContain(mine);
  });
});
