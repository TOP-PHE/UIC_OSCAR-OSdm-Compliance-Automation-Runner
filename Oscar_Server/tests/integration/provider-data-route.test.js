// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #540: GET /data/:filename does not reveal that a provider exists.
 */
// Review repro: GET /data/:filename discloses whether a provider (by slug) exists.
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { randomUUID: uuidv4 } = require('node:crypto');
jest.mock('../../src/worker/access-token');
process.env.PORT = '0';
const app = require('../../src/server');
const { run } = require('../../src/db/db');
const JWT_SECRET = process.env.JWT_SECRET;

const tag = uuidv4().slice(0, 8);
const D1 = uuidv4(), P1 = uuidv4(), D2 = uuidv4(), TM2 = uuidv4(), T2 = uuidv4();
const d1Slug = `rvw-d1-${tag}`;
const providerSlug = `${d1Slug}--oebb`;           // what freeSlug() would mint for "OEBB"
const tok = (uid, role) => jwt.sign({ sub: uid, email: `${uid}@rvw.example`, companyId: D2, role, jti: uuidv4() },
  JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });

beforeAll(() => {
  run('INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)', [D1, `D1 ${tag}`, d1Slug]);
  run('INSERT INTO companies (id, name, slug, parent_id) VALUES (?, ?, ?, ?)', [P1, 'OEBB', providerSlug, D1]);
  run('INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)', [D2, `D2 ${tag}`, `rvw-d2-${tag}`]);
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'test_manager')`, [TM2, D2, `${TM2}@rvw.example`]);
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'company_user')`, [T2, D2, `${T2}@rvw.example`]);
});
afterAll(() => {
  run('DELETE FROM users WHERE id IN (?, ?)', [TM2, T2]);
  run('DELETE FROM companies WHERE id = ?', [P1]);
  run('DELETE FROM companies WHERE id IN (?, ?)', [D1, D2]);
});

test('unauthenticated: a provider slug answers like an unknown one', async () => {
  const hit  = await request(app).get(`/data/${providerSlug}-datafile.json`);
  const miss = await request(app).get(`/data/${d1Slug}--sncf-datafile.json`);
  console.log('unauth existing:', hit.status, '| unauth unknown:', miss.status);
  expect(hit.status).toBe(404);
  expect(miss.status).toBe(404);
});

test('Test Manager of another distributor: a provider slug answers like an unknown one', async () => {
  const hit  = await request(app).get(`/data/${providerSlug}-datafile.json`).set('Authorization', `Bearer ${tok(TM2, 'test_manager')}`);
  const miss = await request(app).get(`/data/${d1Slug}--sncf-datafile.json`).set('Authorization', `Bearer ${tok(TM2, 'test_manager')}`);
  console.log('foreign TM existing:', hit.status, '| foreign TM unknown:', miss.status);
  expect(hit.status).toBe(404);
  expect(miss.status).toBe(404);
});

test('API rule for the same provider by id is 404 (contrast)', async () => {
  const res = await request(app).get('/v1/company').set('Authorization', `Bearer ${tok(T2, 'company_user')}`).set('X-Provider-Id', P1);
  expect(res.status).toBe(404);
});

test('provider names are hidden from the public company list (so the slug is the secret)', async () => {
  const res = await request(app).get('/v1/auth/register/companies');
  const slugs = res.body.companies.map(c => c.slug);
  expect(slugs).toContain(d1Slug);
  expect(slugs).not.toContain(providerSlug);
});
