// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #1025: data file writes are counted per user and company or provider, not per
 * address. A Test Manager setting up several providers ran out of a shared
 * 20-write budget. The requests here are refused by the route itself (an
 * unknown reference name, 400), after the limiter has counted them, so nothing
 * is written.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-datafile-write-limit';

const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const request = require('supertest');
const { buildAppWithRoute } = require('../helpers/test-app');
const { run } = require('../../src/db/db');
const { MAX_WRITES } = require('../../src/utils/datafileWriteLimit');

const app = buildAppWithRoute('/v1/company', '../../src/api/routes/company');

const companyId  = crypto.randomUUID();
const providerId = crypto.randomUUID();
const tmId       = crypto.randomUUID();
const otherTmId  = crypto.randomUUID();

const token = (uid) => jwt.sign(
  { sub: uid, email: `tm-${uid}@write-limit.test`, companyId, role: 'test_manager' },
  process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });

beforeAll(() => {
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Write Limit Co', ?)`, [companyId, `write-limit-${companyId.slice(0, 8)}`]);
  run(`INSERT INTO companies (id, name, slug, parent_id) VALUES (?, 'Write Limit Provider', ?, ?)`, [providerId, `write-limit-p-${providerId.slice(0, 8)}`, companyId]);
  for (const id of [tmId, otherTmId]) {
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'test_manager')`, [id, companyId, `tm-${id}@write-limit.test`]);
  }
});

afterAll(() => {
  run('DELETE FROM auth_events WHERE company_id IN (?, ?)', [companyId, providerId]);
  run('DELETE FROM companies WHERE id IN (?, ?)', [providerId, companyId]);
  run('DELETE FROM users WHERE id IN (?, ?)', [tmId, otherTmId]);
});

const write = (uid, provider) => {
  const r = request(app).put('/v1/company/reference').set('Authorization', `Bearer ${token(uid)}`);
  if (provider) r.set('X-Provider-Id', provider);
  return r.send({ name: 'not-a-reference' });
};

test('the limit is per user and company or provider, and its 429 says how long to wait', async () => {
  for (let i = 0; i < MAX_WRITES; i++) {
    const res = await write(tmId);
    expect(res.status).toBe(400);
  }
  const refused = await write(tmId);
  expect(refused.status).toBe(429);
  expect(refused.body.detail).toContain('for this company or provider');
  expect(refused.body.detail).toMatch(/Try again in \d+ minutes?\./);
  expect(refused.body.detail).toContain('Unsaved edits stay on the page');

  // The same person on a provider, and a colleague on the company, still write.
  expect((await write(tmId, providerId)).status).toBe(400);
  expect((await write(otherTmId)).status).toBe(400);
});
