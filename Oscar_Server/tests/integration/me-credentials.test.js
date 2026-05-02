// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * me-credentials.test.js — Integration tests for /v1/me/credentials
 *
 * NOTE: Requires Node.js 22+ (node:sqlite) for the database layer.
 *
 * Covers:
 *   - 401 without auth token
 *   - GET / returns sanitized credential projection (no secret values)
 *   - PATCH / with invalid auth_mode → 400
 *   - PATCH / with invalid oauth_profile → 400
 *   - PATCH / with invalid oauth_custom_template JSON → 400
 *   - PATCH / with no updatable fields → 400
 *   - PATCH / updates auth_mode and returns updated projection
 *   - PATCH / with access_token stores encrypted value, shows has_token: true
 *   - PATCH / with auth-related field clears cached token
 *   - PATCH / with subscription_key stores it correctly
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-me-credentials';

const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const request = require('supertest');
const { buildAppWithRoute } = require('../helpers/test-app');
const { run, get } = require('../../src/db/db');

const app = buildAppWithRoute('/v1/me/credentials', '../../src/api/routes/me-credentials');

// ── Test fixtures ─────────────────────────────────────────────────────────────

const companyId = uuidv4();
const userId    = uuidv4();

function makeToken(uid = userId) {
  return jwt.sign(
    { sub: uid, email: 'cred-user@me-test.com', companyId, role: 'company_user' },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
}

beforeAll(() => {
  run(`INSERT OR IGNORE INTO companies (id, name, slug) VALUES (?, 'Me Test Co', 'me-test-co')`, [companyId]);
  run(
    `INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role)
     VALUES (?, ?, 'cred-user@me-test.com', '$2b$12$fakehash', 'company_user')`,
    [userId, companyId]
  );
});

afterAll(() => {
  run('DELETE FROM auth_events WHERE user_id = ?', [userId]);
  run('DELETE FROM users WHERE id = ?', [userId]);
  run('DELETE FROM companies WHERE id = ?', [companyId]);
});

// ── Auth protection ───────────────────────────────────────────────────────────

describe('GET /v1/me/credentials — auth', () => {
  test('401 without token', async () => {
    const res = await request(app).get('/v1/me/credentials');
    expect(res.status).toBe(401);
  });

  test('401 with invalid token', async () => {
    const res = await request(app)
      .get('/v1/me/credentials')
      .set('Authorization', 'Bearer invalid.token.here');
    expect(res.status).toBe(401);
  });
});

// ── GET /v1/me/credentials ────────────────────────────────────────────────────

describe('GET /v1/me/credentials', () => {
  test('200 returns sanitized credential projection', async () => {
    const token = makeToken();
    const res = await request(app)
      .get('/v1/me/credentials')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    // Sanitized: booleans for secrets, not the actual values
    expect(res.body).toHaveProperty('auth_mode');
    expect(res.body).toHaveProperty('has_token');
    expect(res.body).toHaveProperty('has_client_id');
    expect(res.body).toHaveProperty('has_client_secret');
    expect(res.body).toHaveProperty('has_extra');
    expect(res.body).toHaveProperty('has_cached_token');
    expect(res.body).toHaveProperty('has_requestor');
    expect(res.body).toHaveProperty('has_subscription_key');
  });

  test('no raw secret values are exposed', async () => {
    const token = makeToken();
    const res = await request(app)
      .get('/v1/me/credentials')
      .set('Authorization', `Bearer ${token}`);
    const body = JSON.stringify(res.body);
    // Encrypted column suffix never appears in the projection — the route
    // returns has_* booleans instead. The other assertions are deliberately
    // narrow: a bare 'secret' substring matches the legitimate has_client_secret
    // field name and would yield false positives.
    expect(body).not.toContain('_enc');
    expect(body).not.toContain('password');
    expect(body).not.toContain('access_token_enc');
    expect(body).not.toContain('client_secret_enc');
  });

  test('404 when user does not exist', async () => {
    const ghostToken = jwt.sign(
      { sub: uuidv4(), email: 'ghost@me-test.com', companyId, role: 'company_user' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    const res = await request(app)
      .get('/v1/me/credentials')
      .set('Authorization', `Bearer ${ghostToken}`);
    expect(res.status).toBe(404);
  });
});

// ── PATCH /v1/me/credentials — validation ────────────────────────────────────

describe('PATCH /v1/me/credentials — validation errors', () => {
  test('400 when no updatable fields provided', async () => {
    const token = makeToken();
    const res = await request(app)
      .patch('/v1/me/credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/no fields to update/i);
  });

  test('400 when auth_mode is invalid', async () => {
    const token = makeToken();
    const res = await request(app)
      .patch('/v1/me/credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({ auth_mode: 'api_key' });
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/auth_mode/i);
  });

  test('400 when oauth_profile is invalid', async () => {
    const token = makeToken();
    const res = await request(app)
      .patch('/v1/me/credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({ oauth_profile: 'unknown_profile' });
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/oauth_profile/i);
  });

  test('400 when oauth_custom_template is invalid JSON', async () => {
    const token = makeToken();
    const res = await request(app)
      .patch('/v1/me/credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({ oauth_custom_template: 'not-valid-json{' });
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/oauth_custom_template/i);
  });
});

// ── PATCH /v1/me/credentials — successful updates ────────────────────────────

describe('PATCH /v1/me/credentials — updates', () => {
  test('200 updates auth_mode to oauth2', async () => {
    const token = makeToken();
    const res = await request(app)
      .patch('/v1/me/credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({ auth_mode: 'oauth2' });
    expect(res.status).toBe(200);
    expect(res.body.auth_mode).toBe('oauth2');
  });

  test('200 updates back to bearer auth_mode', async () => {
    const token = makeToken();
    const res = await request(app)
      .patch('/v1/me/credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({ auth_mode: 'bearer' });
    expect(res.status).toBe(200);
    expect(res.body.auth_mode).toBe('bearer');
  });

  test('access_token is stored encrypted and has_token becomes true', async () => {
    const token = makeToken();
    const res = await request(app)
      .patch('/v1/me/credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({ access_token: 'my-bearer-token-value' });
    expect(res.status).toBe(200);
    expect(res.body.has_token).toBe(true);
    // Raw token should NOT appear in response
    const raw = get('SELECT access_token_enc FROM users WHERE id = ?', [userId]);
    expect(raw.access_token_enc).not.toBe('my-bearer-token-value');
    expect(raw.access_token_enc).toBeTruthy(); // encrypted value is stored
  });

  test('client_id and client_secret become has_client_id and has_client_secret', async () => {
    const token = makeToken();
    const res = await request(app)
      .patch('/v1/me/credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({ client_id: 'client-123', client_secret: 'super-secret' });
    expect(res.status).toBe(200);
    expect(res.body.has_client_id).toBe(true);
    expect(res.body.has_client_secret).toBe(true);
  });

  test('updating an auth field clears the cached token', async () => {
    // First set a fake cached token
    run(`UPDATE users SET cached_token_enc = 'fake-cached', cached_token_expires_at = '2099-01-01' WHERE id = ?`, [userId]);
    const verifyBefore = get('SELECT cached_token_enc FROM users WHERE id = ?', [userId]);
    expect(verifyBefore.cached_token_enc).toBe('fake-cached');

    const token = makeToken();
    await request(app)
      .patch('/v1/me/credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({ auth_mode: 'oauth2' });

    const after = get('SELECT cached_token_enc, cached_token_expires_at FROM users WHERE id = ?', [userId]);
    expect(after.cached_token_enc).toBeNull();
    expect(after.cached_token_expires_at).toBeNull();
  });

  test('subscription_key is stored and has_subscription_key becomes true', async () => {
    const token = makeToken();
    const res = await request(app)
      .patch('/v1/me/credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({ subscription_key: 'sub-key-abc123' });
    expect(res.status).toBe(200);
    expect(res.body.has_subscription_key).toBe(true);
  });

  test('subscription_key null clears the stored key', async () => {
    const token = makeToken();
    // First ensure it's set
    await request(app)
      .patch('/v1/me/credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({ subscription_key: 'will-be-cleared' });
    // Now clear it
    const res = await request(app)
      .patch('/v1/me/credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({ subscription_key: null });
    expect(res.status).toBe(200);
    expect(res.body.has_subscription_key).toBe(false);
  });

  test('oauth_profile is updated and returned', async () => {
    const token = makeToken();
    const res = await request(app)
      .patch('/v1/me/credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({ oauth_profile: 'oauth2_post' });
    expect(res.status).toBe(200);
    expect(res.body.oauth_profile).toBe('oauth2_post');
  });

  test('oauth_custom_template is stored as valid JSON string', async () => {
    const token = makeToken();
    const template = JSON.stringify({ method: 'POST', body: {} });
    const res = await request(app)
      .patch('/v1/me/credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({ oauth_custom_template: template });
    expect(res.status).toBe(200);
    expect(res.body.oauth_custom_template).toBe(template);
  });

  test('oauth_scope null clears the scope', async () => {
    // First set a scope
    const token = makeToken();
    await request(app)
      .patch('/v1/me/credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({ oauth_scope: 'read:all' });
    // Now clear it
    const res = await request(app)
      .patch('/v1/me/credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({ oauth_scope: null });
    expect(res.status).toBe(200);
    expect(res.body.oauth_scope).toBeNull();
  });
});
