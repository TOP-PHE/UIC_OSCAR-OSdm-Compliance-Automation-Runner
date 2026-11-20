// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * api-oauth.test.js — #1342 PR 2: a Company API account signs in to the API
 * with OAuth 2.0 client credentials and private_key_jwt (RFC 7523).
 *
 *   - a Test Manager gives the account public keys (EC P-256 or RSA 2048+),
 *     never a private key, two active at most;
 *   - the token endpoint takes a signed assertion once, for OSCAR's address
 *     only, short-lived, and refuses everything else with invalid_client;
 *   - the access token reads the account's own runs on /v1/api, needs the
 *     scope runs:read, dies with a suspension, and opens no page.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-api-oauth';
process.env.APP_URL = 'https://oscar.test/';

const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { run, get } = require('../../src/db/db');
const { requireAuth } = require('../../src/api/middleware/auth');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/v1/company/api-accounts', require('../../src/api/routes/company-api-accounts'));
app.use('/v1/api/oauth', require('../../src/api/routes/api-oauth'));
app.use('/v1/api', require('../../src/api/routes/api'));
const sessionLimiter = require('express-rate-limit')({ windowMs: 60 * 1000, max: 1000, standardHeaders: true, legacyHeaders: false });
app.get('/v1/page-route', sessionLimiter, requireAuth, (req, res) => res.json({ ok: true }));

const TOKEN_URL = 'https://oscar.test/v1/api/oauth/token';
const companyId = crypto.randomUUID();
const providerId = crypto.randomUUID();
const tag = companyId.slice(0, 8);
const TM = { id: crypto.randomUUID(), email: `tm-${tag}@oauth.test`, role: 'test_manager', companyId };
const session = u => `Bearer ${jwt.sign({ sub: u.id, email: u.email, companyId: u.companyId, role: u.role }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;
const ec = () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pemOf = key => key.export({ type: 'spki', format: 'pem' });

const KEY = ec();
const OTHER_KEY = ec();
let account;

beforeAll(async () => {
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'OAuth Co', ?)`, [companyId, `oauth-${tag}`]);
  run(`INSERT INTO companies (id, name, slug, parent_id) VALUES (?, 'OAuth Provider', ?, ?)`, [providerId, `oauth-p-${tag}`, companyId]);
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'test_manager')`, [TM.id, companyId, TM.email]);
  account = (await manage('post', '').send({ name: 'CI', providers: [providerId] })).body;
  const added = await manage('post', `/${account.id}/keys`).send({ public_key: pemOf(KEY.publicKey) });
  expect(added.status).toBe(201);
});

function manage(method, path) {
  return request(app)[method](`/v1/company/api-accounts${path}`).set('Authorization', session(TM));
}

function assertion(claims = {}, { key = KEY.privateKey, algorithm = 'ES256', header = {} } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({ iss: account.id, sub: account.id, aud: TOKEN_URL, jti: crypto.randomUUID(), iat: now, exp: now + 60, ...claims },
    key, { algorithm, header: { alg: algorithm, ...header } });
}

function askToken(fields) {
  return request(app).post('/v1/api/oauth/token').type('form').send({
    grant_type: 'client_credentials',
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    ...fields,
  });
}
const tokenFor = async (fields = {}) => (await askToken({ client_assertion: assertion(), ...fields })).body.access_token;
const api = (token, path) => request(app).get(`/v1/api${path}`).set('Authorization', `Bearer ${token}`);

describe('the account\'s public keys', () => {
  test('the account names its client id and the token endpoint, the key its fingerprint', async () => {
    const res = await manage('get', `/${account.id}/keys`);
    expect(res.body).toMatchObject({ client_id: account.id, token_url: TOKEN_URL, active_keys: 1, max_active_keys: 2, algorithms: ['ES256', 'PS256'] });
    expect(res.body.keys[0]).toMatchObject({ alg: 'ES256', state: 'active', created_by: TM.email });
    expect(res.body.keys[0].fingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('refused: a private key, not a key, a short RSA key, the same key twice, a third active key', async () => {
    const priv = KEY.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const refused = await manage('post', `/${account.id}/keys`).send({ public_key: priv });
    expect(refused.status).toBe(400);
    expect(refused.body.detail).toContain('private key');
    expect((await manage('post', `/${account.id}/keys`).send({ public_key: 'hello' })).status).toBe(400);
    const small = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
    expect((await manage('post', `/${account.id}/keys`).send({ public_key: pemOf(small.publicKey) })).status).toBe(400);
    expect((await manage('post', `/${account.id}/keys`).send({ public_key: pemOf(KEY.publicKey) })).status).toBe(409);
    const second = await manage('post', `/${account.id}/keys`).send({ public_key: pemOf(OTHER_KEY.publicKey) });
    expect(second.status).toBe(201);
    expect((await manage('post', `/${account.id}/keys`).send({ public_key: pemOf(ec().publicKey) })).status).toBe(409);
    await manage('delete', `/${account.id}/keys/${second.body.id}`);
  });
});

describe('the token endpoint', () => {
  test('a signed assertion gives a 15-minute bearer token with both scopes, never cached', async () => {
    const res = await askToken({ client_assertion: assertion(), client_id: account.id });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ token_type: 'Bearer', expires_in: 900, scope: 'runs:read runs:write' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(get('SELECT last_used_at FROM api_account_key WHERE user_id = ? AND revoked_at IS NULL', [account.id]).last_used_at).toBeTruthy();
  });

  test('an RSA key signs with PS256', async () => {
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const added = await manage('post', `/${account.id}/keys`).send({ public_key: pemOf(rsa.publicKey) });
    expect(added.body.alg).toBe('PS256');
    const res = await askToken({ client_assertion: assertion({}, { key: rsa.privateKey, algorithm: 'PS256' }) });
    expect(res.status).toBe(200);
    await manage('delete', `/${account.id}/keys/${added.body.id}`);
  });

  test('an assertion is taken once', async () => {
    const once = assertion();
    expect((await askToken({ client_assertion: once })).status).toBe(200);
    const again = await askToken({ client_assertion: once });
    expect(again.status).toBe(401);
    expect(again.body.error).toBe('invalid_client');
  });

  test.each([
    ['another audience', () => assertion({ aud: 'https://elsewhere.example/token' })],
    ['an expired assertion', () => assertion({ iat: Math.floor(Date.now() / 1000) - 600, exp: Math.floor(Date.now() / 1000) - 300 })],
    ['one living ten minutes', () => assertion({ exp: Math.floor(Date.now() / 1000) + 600 })],
    ['no jti', () => assertion({ jti: undefined })],
    ['iss and sub that differ', () => assertion({ sub: crypto.randomUUID() })],
    ['a key the account does not have', () => assertion({}, { key: ec().privateKey })],
    ['an unknown account', () => assertion({ iss: crypto.randomUUID(), sub: crypto.randomUUID() })],
    ['HS256 keyed with the public key', () => jwt.sign({ iss: account.id, sub: account.id, aud: TOKEN_URL, jti: crypto.randomUUID(), exp: Math.floor(Date.now() / 1000) + 60 }, pemOf(KEY.publicKey), { algorithm: 'HS256' })],
    ['an unsigned assertion', () => jwt.sign({ iss: account.id, sub: account.id, aud: TOKEN_URL, jti: crypto.randomUUID(), exp: Math.floor(Date.now() / 1000) + 60 }, null, { algorithm: 'none' })],
  ])('refused: %s, as invalid_client', async (_, make) => {
    const res = await askToken({ client_assertion: make() });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'invalid_client' });
  });

  test('refused: JSON, another grant, no assertion type, an unknown scope, a client_id that is not the assertion\'s', async () => {
    const json = await request(app).post('/v1/api/oauth/token').send({ grant_type: 'client_credentials' });
    expect(json.body.error).toBe('invalid_request');
    expect((await askToken({ grant_type: 'password', client_assertion: assertion() })).body.error).toBe('unsupported_grant_type');
    expect((await askToken({ client_assertion_type: 'x', client_assertion: assertion() })).body.error).toBe('invalid_client');
    expect((await askToken({ client_assertion: assertion(), scope: 'runs:read admin' })).body.error).toBe('invalid_scope');
    expect((await askToken({ client_assertion: assertion(), client_id: crypto.randomUUID() })).body.error).toBe('invalid_client');
  });

  test('a revoked key signs nothing any more', async () => {
    const third = ec();
    const added = await manage('post', `/${account.id}/keys`).send({ public_key: pemOf(third.publicKey) });
    await manage('delete', `/${account.id}/keys/${added.body.id}`);
    expect((await askToken({ client_assertion: assertion({}, { key: third.privateKey }) })).status).toBe(401);
  });
});

describe('the access token on /v1/api', () => {
  const runOf = (userId, company) => {
    const id = crypto.randomUUID();
    run(`INSERT INTO runs (id, company_id, user_id, status, batch_id, scenario_code) VALUES (?, ?, ?, 'COMPLETED', ?, 'OTST_X')`, [id, company, userId, `b-${tag}`]);
    return id;
  };

  test('it names the account, and reads the runs it launched, never another\'s', async () => {
    const token = await tokenFor();
    const me = await api(token, '/key');
    expect(me.body).toMatchObject({ kind: 'company_api_account', name: 'CI', client_id: account.id,
      company: { id: companyId, name: 'OAuth Co' }, providers: [{ id: providerId, name: 'OAuth Provider' }], scopes: ['runs:read', 'runs:write'] });
    const own = runOf(account.id, providerId);
    const tms = runOf(TM.id, providerId);
    const list = await api(token, '/runs');
    expect(list.body.runs.map(r => r.id)).toEqual([own]);
    expect((await api(token, `/runs/${own}`)).status).toBe(200);
    expect((await api(token, `/runs/${tms}`)).status).toBe(404);
    const batch = await api(token, `/batches/b-${tag}`);
    expect(batch.body.runs.map(r => r.id)).toEqual([own]);
    expect((await api(token, '/queue')).body.runs).toEqual([]);
  });

  test('without runs:read it reads nothing', async () => {
    const token = await tokenFor({ scope: 'runs:write' });
    const res = await api(token, '/runs');
    expect(res.status).toBe(403);
    expect(res.headers['www-authenticate']).toContain('insufficient_scope');
  });

  test('it opens no page, and a session opens no API', async () => {
    const token = await tokenFor();
    expect((await request(app).get('/v1/page-route').set('Authorization', `Bearer ${token}`)).status).toBe(401);
    expect((await request(app).get('/v1/api/runs').set('Authorization', session(TM))).status).toBe(401);
  });

  test('a suspension ends every token at once; after a resume, only a new one works', async () => {
    const token = await tokenFor();
    expect((await api(token, '/runs')).status).toBe(200);
    // sessions_valid_after counts in whole seconds: suspend in the next second.
    await new Promise(r => setTimeout(r, 1100));
    await manage('post', `/${account.id}/suspend`);
    expect((await api(token, '/runs')).status).toBe(401);
    expect((await askToken({ client_assertion: assertion() })).status).toBe(401);
    await manage('post', `/${account.id}/resume`);
    expect((await api(token, '/runs')).status).toBe(401);
    await new Promise(r => setTimeout(r, 1100));
    expect((await api(await tokenFor(), '/runs')).status).toBe(200);
  });
});

describe('OSCAR\'s address', () => {
  test('in production without APP_URL the endpoint says it cannot check aud', async () => {
    const before = { APP_URL: process.env.APP_URL, NODE_ENV: process.env.NODE_ENV };
    delete process.env.APP_URL;
    process.env.NODE_ENV = 'production';
    try {
      const res = await askToken({ client_assertion: assertion() });
      expect(res.status).toBe(503);
    } finally {
      process.env.APP_URL = before.APP_URL;
      process.env.NODE_ENV = before.NODE_ENV;
    }
  });
});
