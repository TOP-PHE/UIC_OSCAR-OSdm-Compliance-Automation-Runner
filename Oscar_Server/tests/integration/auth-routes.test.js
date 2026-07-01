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

const request = require('supertest');
const { randomUUID: uuidv4 } = require('node:crypto');
const { buildAppWithRoute } = require('../helpers/test-app');
const { run, get } = require('../../src/db/db');

const app = buildAppWithRoute('/v1/auth', '../../src/api/routes/auth');

const TEST_EMAIL = `t${Date.now()}@acmecorp.com`;
const TEST_COMPANY = 'Acme Corporation';
const TEST_COMPANY_SLUG = 'acme-corporation';
const TEST_PASSWORD = 'SuperStr0ngPwd!';

// Issue #449 — self-registration now targets a real, existing company (picked
// from the /register/companies dropdown) instead of matching the email
// against a free-text company name, so tests must seed one up front.
beforeAll(() => {
  run(`INSERT INTO companies (id, name, slug, auth_mode) VALUES (?, ?, ?, 'bearer')`,
    [uuidv4(), TEST_COMPANY, TEST_COMPANY_SLUG]);
});

describe('POST /v1/auth/register/request', () => {
  test('400 when email or company missing', async () => {
    const res = await request(app).post('/v1/auth/register/request').send({});
    expect(res.status).toBe(400);
  });

  test('400 when company does not exist', async () => {
    const res = await request(app)
      .post('/v1/auth/register/request')
      .send({ email: 'someone@unrelated.com', companyName: 'Not A Real Company' });
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/unknown company/i);
  });

  test('200 + dev verification URL when SMTP not configured', async () => {
    const res = await request(app)
      .post('/v1/auth/register/request')
      .send({ email: TEST_EMAIL, companyName: TEST_COMPANY });
    expect(res.status).toBe(200);
    expect(res.body.verificationUrl).toMatch(/\?token=/);
  });

  test('returns generic success for already-registered email (no enumeration)', async () => {
    // This email isn't registered yet, but the response should NOT reveal that
    const res = await request(app)
      .post('/v1/auth/register/request')
      .send({ email: 'never-existed@acmecorp.com', companyName: TEST_COMPANY });
    expect(res.status).toBe(200);
    expect(res.body.message).toBeTruthy();
    // No leak about whether the email existed or not
    expect(JSON.stringify(res.body).toLowerCase()).not.toMatch(/already/);
  });
});

describe('POST /v1/auth/register/confirm', () => {
  let token;
  const confirmEmail = `confirm${Date.now()}@acmecorp.com`;

  beforeAll(async () => {
    // Get a fresh token from the request endpoint
    const res = await request(app)
      .post('/v1/auth/register/request')
      .send({ email: confirmEmail, companyName: TEST_COMPANY });
    token = res.body.verificationUrl.match(/token=([^&]+)/)[1];
  });

  test('400 when password missing', async () => {
    const res = await request(app).post('/v1/auth/register/confirm').send({ token });
    expect(res.status).toBe(400);
  });

  test('400 when password too short', async () => {
    const res = await request(app)
      .post('/v1/auth/register/confirm')
      .send({ token, password: 'short' });
    expect(res.status).toBe(400);
  });

  test('400 when password lacks complexity', async () => {
    const res = await request(app)
      .post('/v1/auth/register/confirm')
      .send({ token, password: 'alllowercaseonly' });
    expect(res.status).toBe(400);
  });

  test('404 when token is invalid', async () => {
    const res = await request(app)
      .post('/v1/auth/register/confirm')
      .send({ token: '00000000-0000-0000-0000-000000000000', password: TEST_PASSWORD });
    expect(res.status).toBe(404);
  });

  test('201 + pending (no token) when valid — Test Manager approval required (#449)', async () => {
    const res = await request(app)
      .post('/v1/auth/register/confirm')
      .send({ token, password: TEST_PASSWORD });
    expect(res.status).toBe(201);
    expect(res.body.pending).toBe(true);
    expect(res.body.token).toBeUndefined();
    const created = get('SELECT status FROM users WHERE email = ?', [confirmEmail]);
    expect(created.status).toBe('pending');
  });
});

describe('POST /v1/auth/login', () => {
  beforeAll(async () => {
    // Register a known user via the full flow, then approve it directly
    // (bypassing the Test-Manager UI, which is exercised in
    // company-users-routes.test.js) so the login tests below can focus on
    // login behaviour rather than the approval flow itself.
    const reqRes = await request(app)
      .post('/v1/auth/register/request')
      .send({ email: TEST_EMAIL, companyName: TEST_COMPANY });
    const token = reqRes.body.verificationUrl.match(/token=([^&]+)/)[1];
    await request(app)
      .post('/v1/auth/register/confirm')
      .send({ token, password: TEST_PASSWORD });
    run("UPDATE users SET status = 'active' WHERE email = ?", [TEST_EMAIL]);
  });

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
    const reqRes = await request(app)
      .post('/v1/auth/register/request')
      .send({ email, companyName: TEST_COMPANY });
    const token = reqRes.body.verificationUrl.match(/token=([^&]+)/)[1];
    await request(app)
      .post('/v1/auth/register/confirm')
      .send({ token, password: TEST_PASSWORD });

    const res = await request(app)
      .post('/v1/auth/login')
      .send({ email, password: TEST_PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.detail).toMatch(/awaiting approval/i);
  });
});

afterAll(() => {
  // Clean up — remove test users and pending registrations
  run("DELETE FROM auth_events WHERE email LIKE '%@acmecorp.com'");
  run("DELETE FROM users WHERE email LIKE '%@acmecorp.com'");
  run("DELETE FROM pending_registrations WHERE email LIKE '%@acmecorp.com'");
  run("DELETE FROM companies WHERE slug = 'acme-corporation'");
});
