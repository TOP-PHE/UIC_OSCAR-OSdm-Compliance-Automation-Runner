// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #540: provider access is decided on the user as stored, not on the token.
 */
// Review repro: canUseCompany() trusts the JWT role/companyId, so a demoted or
// moved Test Manager keeps every provider of the old distributor for the token's
// life (8h), even though provider_access is DB-checked for testers.
process.env.JWT_SECRET = 'test-jwt-secret-review-stale-role';
const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { randomUUID: uuidv4 } = require('node:crypto');
const { run, get } = require('../../src/db/db');

const app = express();
app.use(express.json());
app.use('/v1/company/users', require('../../src/api/routes/company-users'));
app.use('/v1/company', require('../../src/api/routes/company'));
app.use('/v1/runs', require('../../src/api/routes/runs'));
app.use('/v1/admin', require('../../src/api/routes/admin'));

const tag = uuidv4().slice(0, 8);
const D1 = uuidv4(), P1 = uuidv4(), D2 = uuidv4(), TM1 = uuidv4(), TMb = uuidv4(), TMc = uuidv4(), ADM = uuidv4(), RUN = uuidv4();
const sign = (sub, companyId, role) => jwt.sign({ sub, email: `${sub}@rvw.example`, companyId, role, jti: uuidv4() },
  process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '8h' });

beforeAll(() => {
  run('INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)', [D1, `D1 ${tag}`, `rvs-d1-${tag}`]);
  run('INSERT INTO companies (id, name, slug, parent_id) VALUES (?, ?, ?, ?)', [P1, `P1 ${tag}`, `rvs-d1-${tag}--p1`, D1]);
  run('INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)', [D2, `D2 ${tag}`, `rvs-d2-${tag}`]);
  for (const [id, role] of [[TM1, 'test_manager'], [TMb, 'test_manager'], [TMc, 'test_manager']]) {
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', ?)`, [id, D1, `${id}@rvw.example`, role]);
  }
  const platform = get("SELECT id FROM companies WHERE slug = 'oscar-platform'") || get('SELECT id FROM companies LIMIT 1');
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'administrator')`, [ADM, platform.id, `${ADM}@rvw.example`]);
  run(`INSERT INTO runs (id, company_id, user_id, status) VALUES (?, ?, ?, 'COMPLETED')`, [RUN, P1, TM1]);
});
afterAll(() => {
  run('DELETE FROM runs WHERE id = ?', [RUN]);
  run('DELETE FROM auth_events WHERE user_id IN (?, ?, ?, ?) OR company_id IN (?, ?, ?)', [TM1, TMb, TMc, ADM, D1, D2, P1]);
  run('DELETE FROM users WHERE id IN (?, ?, ?, ?)', [TM1, TMb, TMc, ADM]);
  run('DELETE FROM companies WHERE id = ?', [P1]);
  run('DELETE FROM companies WHERE id IN (?, ?)', [D1, D2]);
});

test('a Test Manager demoted since signing in loses the providers at once', async () => {
  const oldTok = sign(TMb, D1, 'test_manager');
  const demote = await request(app).patch(`/v1/company/users/${TMb}`)
    .set('Authorization', `Bearer ${sign(TM1, D1, 'test_manager')}`).send({ role: 'company_user' });
  expect(demote.status).toBe(200);
  expect(get('SELECT role FROM users WHERE id = ?', [TMb]).role).toBe('company_user');
  expect(get('SELECT 1 AS x FROM provider_access WHERE user_id = ?', [TMb])).toBeFalsy();

  const res = await request(app).get('/v1/company').set('Authorization', `Bearer ${oldTok}`).set('X-Provider-Id', P1);
  const r2  = await request(app).get(`/v1/runs/${RUN}`).set('Authorization', `Bearer ${oldTok}`);
  console.log('demoted, provider company:', res.status, '| provider run:', r2.status);
  expect(res.status).toBe(404);
  expect(r2.status).toBe(404);
});

test('a Test Manager moved to another distributor loses the old distributor\'s providers at once', async () => {
  const oldTok = sign(TMc, D1, 'test_manager');
  const move = await request(app).patch(`/v1/admin/users/${TMc}`)
    .set('Authorization', `Bearer ${sign(ADM, get('SELECT company_id FROM users WHERE id = ?', [ADM]).company_id, 'administrator')}`)
    .send({ company_id: D2 });
  console.log('admin move status:', move.status, move.body?.detail || '');
  expect(get('SELECT company_id FROM users WHERE id = ?', [TMc]).company_id).toBe(D2);
  const res = await request(app).get('/v1/company/datafile').set('Authorization', `Bearer ${oldTok}`).set('X-Provider-Id', P1);
  const r2  = await request(app).get(`/v1/runs/${RUN}`).set('Authorization', `Bearer ${oldTok}`);
  console.log('moved, provider datafile:', res.status, '| provider run:', r2.status);
  expect(res.body.detail).toBe('Provider not found.');
  expect(r2.status).toBe(404);
});
