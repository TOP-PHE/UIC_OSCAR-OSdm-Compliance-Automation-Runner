// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #540: provider grants belong to the company a user was in.
 */
process.env.JWT_SECRET = 'review-move-back';
const express = require('express'); const jwt = require('jsonwebtoken'); const request = require('supertest');
const { randomUUID: uuidv4 } = require('node:crypto');
const { run, get, transaction } = require('../../src/db/db');
const { canUseCompany, membershipChanged } = require('../../src/api/helpers/provider-access');
const { END_SESSIONS_SQL } = require('../../src/api/middleware/auth');
const app = express(); app.use(express.json()); app.use('/v1/admin', require('../../src/api/routes/admin'));

// An administrator no longer moves a company account (someone joins a company
// through its Test Manager), but a change of company still happens, and what
// follows from it (#540) must still hold. The move is made as the route made
// it: the company changed, the sessions ended, membershipChanged() in the same
// transaction.
function moveUser(userId, companyId) {
  transaction(() => {
    const before = get('SELECT * FROM users WHERE id = ?', [userId]);
    run(`UPDATE users SET company_id = ?, ${END_SESSIONS_SQL} WHERE id = ?`, [companyId, userId]);
    membershipChanged(userId, before);
  });
}
test('moving a tester out of the distributor ends their provider grants', async () => {
  const D = uuidv4(), E = uuidv4(), P = uuidv4(), U = uuidv4(), ADM = uuidv4();
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'D', ?)`, [D, `d-${D.slice(0, 8)}`]);
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'E', ?)`, [E, `e-${E.slice(0, 8)}`]);
  run(`INSERT INTO companies (id, name, slug, parent_id) VALUES (?, 'P', ?, ?)`, [P, `p-${P.slice(0, 8)}`, D]);
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'company_user')`, [U, D, `u-${U.slice(0, 8)}@x.example`]);
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'administrator')`, [ADM, D, `a-${ADM.slice(0, 8)}@x.example`]);
  run('INSERT INTO provider_access (company_id, user_id) VALUES (?, ?)', [P, U]);
  const tok = jwt.sign({ sub: ADM, email: 'a@x.example', companyId: D, role: 'administrator' }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
  const auth = { Authorization: `Bearer ${tok}` };
  // The administrator's move itself is refused, and changes nothing.
  expect((await request(app).patch(`/v1/admin/users/${U}`).set(auth).send({ company_id: E })).status).toBe(409);
  expect(get('SELECT company_id FROM users WHERE id = ?', [U]).company_id).toBe(D);
  expect(get('SELECT 1 AS x FROM provider_access WHERE company_id = ? AND user_id = ?', [P, U])).toBeTruthy();
  moveUser(U, E);
  expect(canUseCompany({ id: U, companyId: E, role: 'company_user' }, P)).toBe(false);
  expect(get('SELECT 1 AS x FROM provider_access WHERE company_id = ? AND user_id = ?', [P, U])).toBeUndefined();
  moveUser(U, D);
  expect(canUseCompany({ id: U, companyId: D, role: 'company_user' }, P)).toBe(false);  // a Test Manager must grant it again
});

test('a move carries the own-company credentials and drops the old providers\' sets', async () => {
  const D = uuidv4(), E = uuidv4(), P = uuidv4(), U = uuidv4(), ADM = uuidv4();
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'D', ?)`, [D, `d-${D.slice(0, 8)}`]);
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'E', ?)`, [E, `e-${E.slice(0, 8)}`]);
  run(`INSERT INTO companies (id, name, slug, parent_id) VALUES (?, 'P', ?, ?)`, [P, `p-${P.slice(0, 8)}`, D]);
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'company_user')`, [U, D, `u-${U.slice(0, 8)}@x.example`]);
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'administrator')`, [ADM, D, `a-${ADM.slice(0, 8)}@x.example`]);
  run(`INSERT INTO tester_credentials (user_id, company_id, access_token_enc) VALUES (?, ?, 'own'), (?, ?, 'prov')`, [U, D, U, P]);
  const tok = jwt.sign({ sub: ADM, email: 'a@x.example', companyId: D, role: 'administrator' }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
  expect((await request(app).patch(`/v1/admin/users/${U}`).set({ Authorization: `Bearer ${tok}` }).send({ company_id: E })).status).toBe(409);
  const { all } = require('../../src/db/db');
  expect(all('SELECT company_id, access_token_enc FROM tester_credentials WHERE user_id = ? ORDER BY access_token_enc', [U]))
    .toEqual([{ company_id: D, access_token_enc: 'own' }, { company_id: P, access_token_enc: 'prov' }]);
  moveUser(U, E);
  expect(all('SELECT company_id, access_token_enc FROM tester_credentials WHERE user_id = ?', [U]))
    .toEqual([{ company_id: E, access_token_enc: 'own' }]);
});

test('a role change ends provider grants', async () => {
  const D = uuidv4(), P = uuidv4(), U = uuidv4(), ADM = uuidv4();
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'D', ?)`, [D, `d-${D.slice(0, 8)}`]);
  run(`INSERT INTO companies (id, name, slug, parent_id) VALUES (?, 'P', ?, ?)`, [P, `p-${P.slice(0, 8)}`, D]);
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'company_user')`, [U, D, `u-${U.slice(0, 8)}@x.example`]);
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'administrator')`, [ADM, D, `a-${ADM.slice(0, 8)}@x.example`]);
  run('INSERT INTO provider_access (company_id, user_id) VALUES (?, ?)', [P, U]);
  const tok = jwt.sign({ sub: ADM, email: 'a@x.example', companyId: D, role: 'administrator' }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
  const auth = { Authorization: `Bearer ${tok}` };
  expect((await request(app).patch(`/v1/admin/users/${U}`).set(auth).send({ role: 'test_manager' })).status).toBe(200);
  expect((await request(app).patch(`/v1/admin/users/${U}`).set(auth).send({ role: 'company_user' })).status).toBe(200);
  expect(canUseCompany({ id: U, companyId: D, role: 'company_user' }, P)).toBe(false);
});
