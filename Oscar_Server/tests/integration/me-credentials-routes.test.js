// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * me-credentials-routes.test.js — Integration tests for /v1/me/credentials
 *
 * Covers:
 *   - Authentication enforcement (401 without token)
 *   - GET  /v1/me/credentials   — returns sanitised credential profile (no secrets)
 *   - PATCH /v1/me/credentials  — validation + successful update + cache invalidation
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-me-creds';

const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const request = require('supertest');
const { buildAppWithRoute } = require('../helpers/test-app');
const { run, get } = require('../../src/db/db');

const app = buildAppWithRoute('/v1/me/credentials', '../../src/api/routes/me-credentials');

// ── Seed data ─────────────────────────────────────────────────────────────────
const companyId = uuidv4();
const userId    = uuidv4();

function makeToken(uid = userId, cid = companyId, role = 'company_user') {
  return jwt.sign(
    { sub: uid, email: 'tester@me-creds-test.com', companyId: cid, role },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
}

beforeAll(() => {
  run(`INSERT OR IGNORE INTO companies (id, name, slug) VALUES (?, 'Me Creds Co', 'me-creds-co')`, [companyId]);
  run(
    `INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role)
     VALUES (?, ?, 'tester@me-creds-test.com', 'x', 'company_user')`,
    [userId, companyId]
  );
});

// ── Authentication guard ──────────────────────────────────────────────────────
describe('Authentication guard', () => {
  test('401 on GET without token', async () => {
    const res = await request(app).get('/v1/me/credentials');
    expect(res.status).toBe(401);
  });

  test('401 on PATCH without token', async () => {
    const res = await request(app)
      .patch('/v1/me/credentials')
      .send({ auth_mode: 'bearer' });
    expect(res.status).toBe(401);
  });
});

// ── GET /v1/me/credentials ────────────────────────────────────────────────────
describe('GET /v1/me/credentials', () => {
  test('200 returns sanitised credential profile', async () => {
    const token = makeToken();
    const res = await request(app)
      .get('/v1/me/credentials')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    // Booleans for "is set?" — no raw secret values
    expect(typeof res.body.has_token).toBe('boolean');
    expect(typeof res.body.has_client_id).toBe('boolean');
    expect(typeof res.body.has_client_secret).toBe('boolean');
    expect(res.body.auth_mode).toBe('bearer');
    // Raw encrypted fields must NOT be present
    expect(res.body.access_token_enc).toBeUndefined();
    expect(res.body.client_secret_enc).toBeUndefined();
  });
});

// ── PATCH /v1/me/credentials ──────────────────────────────────────────────────
describe('PATCH /v1/me/credentials', () => {
  test('400 when no fields are provided', async () => {
    const token = makeToken();
    const res = await request(app)
      .patch('/v1/me/credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/no fields/i);
  });

  test('400 when auth_mode is invalid', async () => {
    const token = makeToken();
    const res = await request(app)
      .patch('/v1/me/credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({ auth_mode: 'unknown_mode' });
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/auth_mode/);
  });

  test('400 when oauth_profile is invalid', async () => {
    const token = makeToken();
    const res = await request(app)
      .patch('/v1/me/credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({ oauth_profile: 'not_a_real_profile' });
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/oauth_profile/);
  });

  test('400 when oauth_custom_template is invalid JSON', async () => {
    const token = makeToken();
    const res = await request(app)
      .patch('/v1/me/credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({ oauth_custom_template: 'not-json{' });
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/valid JSON/);
  });

  test('200 updates auth_mode successfully', async () => {
    const token = makeToken();
    const res = await request(app)
      .patch('/v1/me/credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({ auth_mode: 'oauth2' });
    expect(res.status).toBe(200);
    expect(res.body.auth_mode).toBe('oauth2');
  });

  test('200 stores encrypted access_token and reflects has_token: true', async () => {
    const token = makeToken();
    const res = await request(app)
      .patch('/v1/me/credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({ auth_mode: 'bearer', access_token: 'my-secret-bearer-token' });
    expect(res.status).toBe(200);
    expect(res.body.has_token).toBe(true);
    // Raw value must never be returned
    expect(res.body.access_token).toBeUndefined();
    expect(res.body.access_token_enc).toBeUndefined();
    // DB should have an encrypted value, not plaintext
    const row = get('SELECT access_token_enc FROM users WHERE id = ?', [userId]);
    expect(row.access_token_enc).toBeTruthy();
    expect(row.access_token_enc).not.toBe('my-secret-bearer-token');
  });

  test('200 setting auth credentials clears the token cache', async () => {
    // First seed a fake cached token
    run(
      `UPDATE users SET cached_token_enc = 'fake-cache', cached_token_expires_at = '2099-01-01T00:00:00Z' WHERE id = ?`,
      [userId]
    );
    const token = makeToken();
    const res = await request(app)
      .patch('/v1/me/credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({ client_id: 'new-client-id' });
    expect(res.status).toBe(200);
    // Cache must have been wiped
    expect(res.body.has_cached_token).toBe(false);
    const row = get('SELECT cached_token_enc FROM users WHERE id = ?', [userId]);
    expect(row.cached_token_enc).toBeNull();
  });

  test('200 setting oauth_scope to null clears the field', async () => {
    const token = makeToken();
    const res = await request(app)
      .patch('/v1/me/credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({ oauth_scope: null });
    expect(res.status).toBe(200);
    expect(res.body.oauth_scope).toBeNull();
  });

  test('200 stores subscription_key as encrypted', async () => {
    const token = makeToken();
    const res = await request(app)
      .patch('/v1/me/credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({ subscription_key: 'my-sub-key' });
    expect(res.status).toBe(200);
    expect(res.body.has_subscription_key).toBe(true);
    const row = get('SELECT subscription_key_enc FROM users WHERE id = ?', [userId]);
    expect(row.subscription_key_enc).not.toBe('my-sub-key');
  });
});

// ── Cleanup ───────────────────────────────────────────────────────────────────
// FK-safe cascade. Credential updates write to auth_events; without clearing
// those first the DELETE FROM users throws "FOREIGN KEY constraint failed".
afterAll(() => {
  const safeRun = (sql, params) => { try { run(sql, params); } catch (_) { /* ignore */ } };
  safeRun('DELETE FROM auth_events WHERE company_id = ?', [companyId]);
  safeRun('DELETE FROM users WHERE company_id = ?', [companyId]);
  safeRun('DELETE FROM companies WHERE id = ?', [companyId]);
});
