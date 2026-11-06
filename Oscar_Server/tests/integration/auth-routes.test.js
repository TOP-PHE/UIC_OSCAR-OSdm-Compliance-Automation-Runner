// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * auth-routes.test.js — Integration tests for /v1/auth/*
 *
 * Exercises the registration → confirm → login flow end-to-end against
 * the real Express router (no mocks except SMTP, which falls back to dev
 * mode and returns the verification URL directly).
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-auth-routes';
process.env.PLATFORM_BOOTSTRAP_TOKEN = 'test-bootstrap-token';

const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcrypt');
const request = require('supertest');
const { randomUUID: uuidv4 } = require('node:crypto');
const { buildAppWithRoute } = require('../helpers/test-app');
const { run, get } = require('../../src/db/db');

const app = buildAppWithRoute('/v1/auth', '../../src/api/routes/auth');

const TEST_EMAIL = `t${Date.now()}@acmecorp.com`;
const TEST_COMPANY = 'Acme Corporation';
const TEST_COMPANY_SLUG = 'acme-corporation';
const TEST_PASSWORD = 'SuperStr0ngPwd!';
const COMPANY_ID = uuidv4();

// Mint a session JWT the same shape auth.js's signToken produces, for the
// authenticated endpoints (/me, /logout, /sso-check).
function sessionToken({ id, email, role }) {
  return jwt.sign({ sub: id, email, companyId: COMPANY_ID, role, jti: uuidv4() },
    process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
}

// A user stored with a known password, as an accepted access request leaves
// it once its owner has chosen the password (access-requests.test.js runs
// the request itself).
function addUser(email, status = 'active') {
  run(`INSERT INTO users (id, company_id, email, password_hash, role, status) VALUES (?, ?, ?, ?, 'company_user', ?)`,
    [uuidv4(), COMPANY_ID, email, bcrypt.hashSync(TEST_PASSWORD, 4), status]);
}

beforeAll(() => {
  run(`INSERT INTO companies (id, name, slug, auth_mode) VALUES (?, ?, ?, 'bearer')`,
    [COMPANY_ID, TEST_COMPANY, TEST_COMPANY_SLUG]);
});

describe('POST /v1/auth/register/request', () => {
  test('400 when email, name or company missing', async () => {
    expect((await request(app).post('/v1/auth/register/request').send({})).status).toBe(400);
    expect((await request(app).post('/v1/auth/register/request').send({ email: 'a@b.example', name: 'A' })).status).toBe(400);
  });

  test('a company nobody knows is not told: the same answer', async () => {
    const res = await request(app)
      .post('/v1/auth/register/request')
      .send({ email: 'someone@unrelated.com', name: 'Someone', company: 'Not A Real Company' });
    expect(res.status).toBe(200);
    expect(res.body.verificationUrl).toMatch(/\?token=/);
  });

  test('an e-mail that has an account gets the same message and no link', async () => {
    const email = `known${Date.now()}@acmecorp.com`;
    addUser(email);
    const res = await request(app)
      .post('/v1/auth/register/request')
      .send({ email, name: 'Known', company: TEST_COMPANY });
    expect(res.status).toBe(200);
    expect(res.body.message).toBeTruthy();
    expect(res.body.verificationUrl).toBeUndefined();
    expect(JSON.stringify(res.body).toLowerCase()).not.toMatch(/already/);
  });
});

describe('POST /v1/auth/register/confirm', () => {
  test('400 without a token, 404 for an unknown one', async () => {
    expect((await request(app).post('/v1/auth/register/confirm').send({})).status).toBe(400);
    expect((await request(app).post('/v1/auth/register/confirm').send({ token: '00000000-0000-0000-0000-000000000000' })).status).toBe(404);
  });

  test('confirms the e-mail and makes no account, even with a password sent', async () => {
    const email = `confirm${Date.now()}@acmecorp.com`;
    const reqRes = await request(app).post('/v1/auth/register/request').send({ email, name: 'C', company: TEST_COMPANY });
    const token = reqRes.body.verificationUrl.match(/token=([^&]+)/)[1];
    const res = await request(app).post('/v1/auth/register/confirm').send({ token, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    expect(get('SELECT id FROM users WHERE email = ?', [email])).toBeUndefined();
    expect(get('SELECT state FROM access_request WHERE email = ?', [email]).state).toBe('verified');
  });
});

describe('POST /v1/auth/login', () => {
  beforeAll(() => addUser(TEST_EMAIL));

  test('400 when email or password missing', async () => {
    const res = await request(app).post('/v1/auth/login').send({});
    expect(res.status).toBe(400);
  });

  test('401 with wrong password', async () => {
    const res = await request(app)
      .post('/v1/auth/login')
      .send({ email: TEST_EMAIL, password: 'WrongPassword123' });
    expect(res.status).toBe(401);
  });

  test('401 with non-existent email', async () => {
    const res = await request(app)
      .post('/v1/auth/login')
      .send({ email: 'no-such-user@acmecorp.com', password: TEST_PASSWORD });
    expect(res.status).toBe(401);
  });

  test('200 + JWT with correct credentials', async () => {
    const res = await request(app)
      .post('/v1/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.email).toBe(TEST_EMAIL);
    expect(res.body.company).toBeTruthy();
  });

  test('403 when account is still pending approval (#449)', async () => {
    const email = `pending${Date.now()}@acmecorp.com`;
    addUser(email, 'pending');
    const res = await request(app)
      .post('/v1/auth/login')
      .send({ email, password: TEST_PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.detail).toMatch(/awaiting approval/i);
  });
});

describe('no list of companies is shown', () => {
  test('GET /v1/auth/register/companies does not exist', async () => {
    expect((await request(app).get('/v1/auth/register/companies')).status).toBe(404);
  });
});

// ── GET /v1/auth/register/check-token ─────────────────────────────────────────
describe('GET /v1/auth/register/check-token', () => {
  test('400 without a token', async () => {
    const res = await request(app).get('/v1/auth/register/check-token');
    expect(res.status).toBe(400);
  });

  test('404 for an unknown token', async () => {
    const res = await request(app).get('/v1/auth/register/check-token?token=' + uuidv4());
    expect(res.status).toBe(404);
  });

  test('200 returns the email and the company as typed', async () => {
    const email = `checktok${Date.now()}@acmecorp.com`;
    const reqRes = await request(app).post('/v1/auth/register/request')
      .send({ email, name: 'Check', company: 'Acme as I write it' });
    const token = reqRes.body.verificationUrl.match(/token=([^&]+)/)[1];
    const res = await request(app).get('/v1/auth/register/check-token?token=' + token);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe(email);
    expect(res.body.companyName).toBe('Acme as I write it');
  });
});

// ── Password reset (issue #15) ────────────────────────────────────────────────
describe('password reset flow', () => {
  const email = `pwreset${Date.now()}@acmecorp.com`;

  beforeAll(() => addUser(email));

  test('request returns a generic success even for an unknown email (no enumeration)', async () => {
    const res = await request(app).post('/v1/auth/password-reset/request').send({ email: 'nobody-here@acmecorp.com' });
    expect(res.status).toBe(200);
    expect(res.body.message).toBeTruthy();
  });

  test('check-token 400 without token, 404 for unknown', async () => {
    expect((await request(app).get('/v1/auth/password-reset/check-token')).status).toBe(400);
    expect((await request(app).get('/v1/auth/password-reset/check-token?token=' + uuidv4())).status).toBe(404);
  });

  test('request → check-token → confirm sets a new password', async () => {
    const reqRes = await request(app).post('/v1/auth/password-reset/request').send({ email });
    expect(reqRes.status).toBe(200);
    // dev mode returns the reset URL directly
    const token = reqRes.body.resetUrl.match(/token=([^&]+)/)[1];

    const check = await request(app).get('/v1/auth/password-reset/check-token?token=' + token);
    expect(check.status).toBe(200);
    expect(check.body.email).toBe(email);

    const NEW_PW = 'BrandNewP4ss!';
    const conf = await request(app).post('/v1/auth/password-reset/confirm').send({ token, password: NEW_PW });
    expect(conf.status).toBe(200);

    // The token is single-use: reusing it now 404s.
    const reuse = await request(app).post('/v1/auth/password-reset/confirm').send({ token, password: NEW_PW });
    expect(reuse.status).toBe(404);

    // The new password works.
    const login = await request(app).post('/v1/auth/login').send({ email, password: NEW_PW });
    expect(login.status).toBe(200);
  });

  test('confirm 404 for an unknown token', async () => {
    const res = await request(app).post('/v1/auth/password-reset/confirm').send({ token: uuidv4(), password: TEST_PASSWORD });
    expect(res.status).toBe(404);
  });
});

// ── POST /v1/auth/bootstrap/platform-user ─────────────────────────────────────
describe('POST /v1/auth/bootstrap/platform-user', () => {
  const bootEmail = `bootadmin${Date.now()}@acmecorp.com`;
  const hdr = { 'x-platform-bootstrap-token': process.env.PLATFORM_BOOTSTRAP_TOKEN };

  test('401 with a wrong bootstrap token', async () => {
    const res = await request(app).post('/v1/auth/bootstrap/platform-user')
      .set('x-platform-bootstrap-token', 'wrong')
      .send({ email: bootEmail, password: 'Str0ngPlatformPw!', role: 'administrator' });
    expect(res.status).toBe(401);
  });

  test('400 for a non-platform role', async () => {
    const res = await request(app).post('/v1/auth/bootstrap/platform-user').set(hdr)
      .send({ email: bootEmail, password: 'Str0ngPlatformPw!', role: 'company_user' });
    expect(res.status).toBe(400);
  });

  test('201 creates an administrator, then 409 on duplicate email', async () => {
    const ok = await request(app).post('/v1/auth/bootstrap/platform-user').set(hdr)
      .send({ email: bootEmail, password: 'Str0ngPlatformPw!', role: 'administrator' });
    expect(ok.status).toBe(201);
    expect(ok.body.user.role).toBe('administrator');

    const dup = await request(app).post('/v1/auth/bootstrap/platform-user').set(hdr)
      .send({ email: bootEmail, password: 'Str0ngPlatformPw!', role: 'administrator' });
    expect(dup.status).toBe(409);
  });
});

// ── Authenticated endpoints: /me, /logout, /sso-check ─────────────────────────
describe('authenticated endpoints', () => {
  const meUser = { id: uuidv4(), email: `me${Date.now()}@acmecorp.com`, role: 'company_user' };
  const adminUser = { id: uuidv4(), email: `ssoadmin${Date.now()}@acmecorp.com`, role: 'administrator' };

  beforeAll(() => {
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'company_user')`, [meUser.id, COMPANY_ID, meUser.email]);
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'administrator')`, [adminUser.id, COMPANY_ID, adminUser.email]);
  });

  test('GET /me 401 without a token', async () => {
    expect((await request(app).get('/v1/auth/me')).status).toBe(401);
  });

  test('GET /me returns the user + company for a valid token', async () => {
    const res = await request(app).get('/v1/auth/me').set('Authorization', `Bearer ${sessionToken(meUser)}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(meUser.email);
    expect(res.body.company.id).toBe(COMPANY_ID);
  });

  test('POST /logout revokes the session', async () => {
    const res = await request(app).post('/v1/auth/logout').set('Authorization', `Bearer ${sessionToken(meUser)}`);
    expect(res.status).toBe(200);
    expect(res.body.logged_out).toBe(true);
  });

  test('GET /sso-check 401 for a non-administrator', async () => {
    const res = await request(app).get('/v1/auth/sso-check').set('Authorization', `Bearer ${sessionToken(meUser)}`);
    expect(res.status).toBe(401);
  });

  test('GET /sso-check 200 for an administrator, echoing identity headers', async () => {
    const res = await request(app).get('/v1/auth/sso-check').set('Authorization', `Bearer ${sessionToken(adminUser)}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.headers['x-user-email']).toBe(adminUser.email);
    expect(res.headers['x-user-role']).toBe('administrator');
  });
});

afterAll(() => {
  // Clean up — remove test users and pending registrations
  run("DELETE FROM auth_events WHERE email LIKE '%@acmecorp.com'");
  run("DELETE FROM password_reset_tokens WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@acmecorp.com')");
  run("DELETE FROM users WHERE email LIKE '%@acmecorp.com'");
  run("DELETE FROM pending_registrations WHERE email LIKE '%@acmecorp.com'");
  run("DELETE FROM companies WHERE slug = 'acme-corporation'");
});
