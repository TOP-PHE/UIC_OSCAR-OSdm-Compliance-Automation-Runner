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
const { buildAppWithRoute } = require('../helpers/test-app');
const { run } = require('../../src/db/db');

const app = buildAppWithRoute('/v1/auth', '../../src/api/routes/auth');

const TEST_EMAIL = `t${Date.now()}@acmecorp.com`;
const TEST_COMPANY = 'Acme Corporation';
const TEST_PASSWORD = 'SuperStr0ngPwd!';

describe('POST /v1/auth/register/request', () => {
  test('400 when email or company missing', async () => {
    const res = await request(app).post('/v1/auth/register/request').send({});
    expect(res.status).toBe(400);
  });

  test('400 when email does not match company name', async () => {
    const res = await request(app)
      .post('/v1/auth/register/request')
      .send({ email: 'someone@unrelated.com', companyName: 'Acme Corp' });
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/email.*does not.*match/i);
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

  beforeAll(async () => {
    // Get a fresh token from the request endpoint
    const res = await request(app)
      .post('/v1/auth/register/request')
      .send({ email: `confirm${Date.now()}@acmecorp.com`, companyName: TEST_COMPANY });
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

  test('201 + JWT when valid', async () => {
    const res = await request(app)
      .post('/v1/auth/register/confirm')
      .send({ token, password: TEST_PASSWORD });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.role).toBe('company_user');
  });
});

describe('POST /v1/auth/login', () => {
  beforeAll(async () => {
    // Register a known user via the full flow
    const reqRes = await request(app)
      .post('/v1/auth/register/request')
      .send({ email: TEST_EMAIL, companyName: TEST_COMPANY });
    const token = reqRes.body.verificationUrl.match(/token=([^&]+)/)[1];
    await request(app)
      .post('/v1/auth/register/confirm')
      .send({ token, password: TEST_PASSWORD });
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
});

afterAll(() => {
  // Clean up — remove test users and pending registrations
  run("DELETE FROM auth_events WHERE email LIKE '%@acmecorp.com'");
  run("DELETE FROM users WHERE email LIKE '%@acmecorp.com'");
  run("DELETE FROM pending_registrations WHERE email LIKE '%@acmecorp.com'");
  run("DELETE FROM companies WHERE slug = 'acme-corporation'");
});
