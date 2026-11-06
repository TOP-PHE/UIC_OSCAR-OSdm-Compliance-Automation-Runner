// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * A session token stands for the user as stored now: each request reads the
 * user again. A user who is deleted, not active, demoted, moved to another
 * company, or whose password was changed after the token was signed, is
 * refused with 401 (sessionUser in middleware/auth.js).
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-session-recheck';

const jwt     = require('jsonwebtoken');
const { randomUUID: uuidv4 } = require('node:crypto');
const request = require('supertest');
const { buildAppWithRoute } = require('../helpers/test-app');
const { run, get } = require('../../src/db/db');
const { sessionUser } = require('../../src/api/middleware/auth');

const app = buildAppWithRoute('/v1/company/users', '../../src/api/routes/company-users');
// A password is changed only by its owner, through a reset link.
app.use('/v1/auth', require('../../src/api/routes/auth'));

const companyId = uuidv4();
const otherCompanyId = uuidv4();

// Signed a minute ago, so that a change made now is after it.
function tokenOf(id, role, cid, ageSeconds = 60) {
  const iat = Math.floor(Date.now() / 1000) - ageSeconds;
  return jwt.sign(
    { sub: id, email: `${id}@session.test`, companyId: cid, role, iat },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
}

function addUser(role, cid = companyId, status = 'active') {
  const id = uuidv4();
  run(`INSERT INTO users (id, company_id, email, password_hash, role, status) VALUES (?, ?, ?, 'x', ?, ?)`,
    [id, cid, `${id}@session.test`, role, status]);
  return id;
}

const listAs = tk => request(app).get('/v1/company/users').set('Authorization', `Bearer ${tk}`);

beforeAll(() => {
  run('INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)', [companyId, 'Session Co', `session-${companyId}`]);
  run('INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)', [otherCompanyId, 'Other Co', `other-${otherCompanyId}`]);
});

describe('a session follows the stored user', () => {
  test('a current token works', async () => {
    const tm = addUser('test_manager');
    expect((await listAs(tokenOf(tm, 'test_manager', companyId))).status).toBe(200);
  });

  test('a demoted Test Manager cannot send another Test Manager a reset link with an older token', async () => {
    const tm1 = addUser('test_manager');
    const tm2 = addUser('test_manager');
    const oldToken = tokenOf(tm2, 'test_manager', companyId);
    const demote = await request(app).patch(`/v1/company/users/${tm2}`)
      .set('Authorization', `Bearer ${tokenOf(tm1, 'test_manager', companyId)}`)
      .send({ role: 'company_user' });
    expect(demote.status).toBe(200);

    const reset = await request(app).post(`/v1/company/users/${tm1}/send-reset`)
      .set('Authorization', `Bearer ${oldToken}`);
    expect(reset.status).toBe(401);
    expect(get('SELECT COUNT(*) AS n FROM password_reset_tokens WHERE user_id = ?', [tm1]).n).toBe(0);
  });

  test('a token signed before a demotion stays refused after the user is promoted again', async () => {
    const tm1 = addUser('test_manager');
    const tm2 = addUser('test_manager');
    const oldToken = tokenOf(tm2, 'test_manager', companyId);
    const auth = `Bearer ${tokenOf(tm1, 'test_manager', companyId, 120)}`;
    await request(app).patch(`/v1/company/users/${tm2}`).set('Authorization', auth).send({ role: 'company_user' });
    // The Test Manager's own token is signed before the change too, but the
    // change was to someone else: only tm2's sessions end.
    await request(app).patch(`/v1/company/users/${tm2}`).set('Authorization', auth).send({ role: 'test_manager' });
    expect((await listAs(oldToken)).status).toBe(401);
  });

  test('a deleted user is refused', async () => {
    const tm1 = addUser('test_manager');
    const tm2 = addUser('test_manager');
    const oldToken = tokenOf(tm2, 'test_manager', companyId);
    const del = await request(app).delete(`/v1/company/users/${tm2}`)
      .set('Authorization', `Bearer ${tokenOf(tm1, 'test_manager', companyId)}`);
    expect(del.status).toBe(200);
    const create = await request(app).post('/v1/company/users')
      .set('Authorization', `Bearer ${oldToken}`)
      .send({ email: `${uuidv4()}@session.test`, role: 'test_manager' });
    expect(create.status).toBe(401);
  });

  test('a password reset ends the sessions signed before it', async () => {
    const tm1 = addUser('test_manager');
    const tm2 = addUser('test_manager');
    const oldToken = tokenOf(tm2, 'test_manager', companyId);
    // The Test Manager sends the link; only its owner chooses the password.
    const sent = await request(app).post(`/v1/company/users/${tm2}/send-reset`)
      .set('Authorization', `Bearer ${tokenOf(tm1, 'test_manager', companyId)}`);
    expect(sent.status).toBe(200);
    const link = get('SELECT token FROM password_reset_tokens WHERE user_id = ?', [tm2]);
    expect(link).toBeTruthy();
    const reset = await request(app).post('/v1/auth/password-reset/confirm')
      .send({ token: link.token, password: 'NewPassword123' });
    expect(reset.status).toBe(200);
    expect(get('SELECT password_hash FROM users WHERE id = ?', [tm2]).password_hash).not.toBe('x');
    expect((await listAs(oldToken)).status).toBe(401);
    // A session signed after the reset works.
    expect((await listAs(tokenOf(tm2, 'test_manager', companyId, -1))).status).toBe(200);
  });

  test('a user moved to another company is refused with the old company in the token', async () => {
    const tm = addUser('test_manager');
    const oldToken = tokenOf(tm, 'test_manager', companyId);
    run('UPDATE users SET company_id = ? WHERE id = ?', [otherCompanyId, tm]);
    expect((await listAs(oldToken)).status).toBe(401);
  });

  test('a pending user is refused', async () => {
    const tm = addUser('test_manager', companyId, 'pending');
    expect((await listAs(tokenOf(tm, 'test_manager', companyId))).status).toBe(401);
  });

  test('a token naming a role the user does not hold is refused', async () => {
    const tester = addUser('company_user');
    expect((await listAs(tokenOf(tester, 'test_manager', companyId))).status).toBe(401);
  });
});

describe('sessionUser()', () => {
  test('takes e-mail, role and company from the stored row', () => {
    const tm = addUser('test_manager');
    const user = sessionUser({ sub: tm, email: 'forged@x', role: 'test_manager', companyId, iat: 1 });
    expect(user).toEqual({ id: tm, email: `${tm}@session.test`, companyId, role: 'test_manager' });
  });

  test('refuses a payload without a subject', () => {
    expect(sessionUser({ role: 'test_manager', companyId })).toBeNull();
    expect(sessionUser(null)).toBeNull();
  });

  test('an older role name in the token still matches its stored form', () => {
    const tester = addUser('company_user');
    expect(sessionUser({ sub: tester, role: 'member', companyId, iat: 1 })?.role).toBe('company_user');
  });

  test('the migration added the column', () => {
    const tm = addUser('test_manager');
    expect(get('SELECT sessions_valid_after FROM users WHERE id = ?', [tm])).toEqual({ sessions_valid_after: null });
  });
});
