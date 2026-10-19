// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #872: POST /v1/me/credentials/test — "Test my credentials" in API Config.
 * A token by the path a run takes, then GET {api_base}/versions with it. Every
 * call goes to a local stub provider (token endpoint + OSDM API), never a real
 * one. The suite allows private targets (tests/setup.js), so 127.0.0.1 passes
 * urlPolicy.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-credentials-test';

const http = require('node:http');
const jwt = require('jsonwebtoken');
const { randomUUID: uuidv4 } = require('node:crypto');
const request = require('supertest');
const { buildAppWithRoute } = require('../helpers/test-app');
const { run, get, all, encrypt, colEncrypt } = require('../../src/db/db');
const { setCredentials } = require('../../src/utils/testerCredentials');

const app = buildAppWithRoute('/v1/me/credentials', '../../src/api/routes/me-credentials');
const TEST = '/v1/me/credentials/test';

const CLIENT_ID = 'stub-client';
const CLIENT_SECRET = 'stub-secret-value-42';
const TOKEN = 'issued-access-token-0123456789';
const BEARER = 'stored-bearer-token-9876543210';

// ── The stub provider ────────────────────────────────────────────────────────
const calls = [];
let tokenReply = null;   // (req, body) => { status, json?, text? }
let apiReply = null;     // (req) => { status, json?, text?, headers? }
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    calls.push({ method: req.method, url: req.url, headers: req.headers, body: raw });
    let r;
    if (req.url === '/token') r = tokenReply ? tokenReply(req, raw) : defaultToken(req);
    else if (req.url === '/osdm/versions') r = apiReply ? apiReply(req) : defaultApi(req);
    else r = { status: 404, json: { title: 'no such route' } };
    res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers || {}) });
    res.end(r.text ?? JSON.stringify(r.json));
  });
});
function defaultToken(req) {
  const basic = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;
  if (req.headers.authorization !== basic) return { status: 401, json: { error: 'invalid_client', error_description: 'bad client' } };
  return { status: 200, json: { access_token: TOKEN, token_type: 'Bearer', expires_in: 300 } };
}
function defaultApi(req) {
  const accepted = [`Bearer ${TOKEN}`, `Bearer ${BEARER}`];
  if (!accepted.includes(req.headers.authorization)) return { status: 401, json: { title: 'Unauthorized' } };
  return { status: 200, json: [{ version: '3.7.0' }, { version: '3.8.0', sunset: null }] };
}
let base;   // http://127.0.0.1:<port>

// ── Fixtures ─────────────────────────────────────────────────────────────────
const companyId = uuidv4();
const providerId = uuidv4();
const otherCompanyId = uuidv4();
const otherProviderId = uuidv4();
const bareId = uuidv4();          // a company with no endpoint

function token(role, uid, cid = companyId) {
  return `Bearer ${jwt.sign({ sub: uid, email: `${uid.slice(0, 8)}@cred-test.com`, companyId: cid, role },
    process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;
}

// A new user for each test: the route allows ten tests a minute per user.
function newUser(role = 'company_user', cid = companyId) {
  const id = uuidv4();
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', ?)`,
    [id, cid, `${id.slice(0, 8)}@cred-test.com`, role]);
  return id;
}
function oauth(uid, cid = companyId, over = {}) {
  setCredentials(uid, cid, {
    auth_mode: 'oauth2', token_url: `${base}/token`, oauth_profile: 'oauth2_basic',
    client_id_enc: encrypt(CLIENT_ID), client_secret_enc: encrypt(CLIENT_SECRET),
    requestor_enc: encrypt('req-of-tester'), ...over,
  });
}
const post = (uid, role = 'company_user', provider = '') =>
  request(app).post(TEST).set('Authorization', token(role, uid)).set('X-Provider-Id', provider).send();
const apiCalls = () => calls.filter(c => c.url === '/osdm/versions');
const auditOf = uid => all(`SELECT event_type FROM auth_events WHERE user_id = ?`, [uid]).map(r => r.event_type);

beforeAll(async () => {
  await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${stub.address().port}`;
  const headers = colEncrypt(JSON.stringify([{ name: 'X-Dedicated', value: 'for {{requestor}}' }]));
  run(`INSERT INTO companies (id, name, slug, api_base, extra_headers) VALUES (?, 'Cred Test', 'cred-test', ?, ?)`, [companyId, `${base}/osdm/`, headers]);
  run(`INSERT INTO companies (id, name, slug, parent_id, api_base) VALUES (?, 'Cred Provider', 'cred-provider', ?, ?)`, [providerId, companyId, `${base}/osdm`]);
  run(`INSERT INTO companies (id, name, slug, api_base) VALUES (?, 'Other Co', 'cred-other', ?)`, [otherCompanyId, `${base}/osdm`]);
  run(`INSERT INTO companies (id, name, slug, parent_id, api_base) VALUES (?, 'Other Provider', 'cred-other-provider', ?, ?)`, [otherProviderId, otherCompanyId, `${base}/osdm`]);
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Bare Co', 'cred-bare')`, [bareId]);
  run('INSERT INTO test_frameworks (id, company_id, config) VALUES (?, ?, ?)',
    [uuidv4(), companyId, colEncrypt(JSON.stringify({ osdmVersion: '3.8' }))]);
});

afterAll(async () => {
  await new Promise(resolve => stub.close(resolve));
});

beforeEach(() => {
  calls.length = 0;
  tokenReply = null;
  apiReply = null;
});

describe('POST /v1/me/credentials/test (#872)', () => {
  test('OAuth2: a fresh token, the provider accepts it and lists its versions', async () => {
    const uid = newUser();
    oauth(uid);
    const res = await post(uid);
    expect(res.status).toBe(200);
    expect(res.body.token).toEqual({ ok: true, mode: 'oauth2', profile: 'oauth2_basic', expiresInSeconds: expect.any(Number) });
    expect(res.body.token.expiresInSeconds).toBeGreaterThan(290);
    expect(res.body.token.expiresInSeconds).toBeLessThanOrEqual(300);
    expect(res.body.api).toEqual({
      ok: true, outcome: 'accepted', status: 200, versions: ['3.7.0', '3.8.0'], versionsReadable: true,
      frameworkVersion: '3.8', frameworkVersionListed: true,
    });
    expect(res.body.outcome).toBe('accepted');
    expect(res.body.summary).toBe("The provider accepted the token (GET /versions answered 200). It lists OSDM 3.7.0, 3.8.0. Your Test Framework's version 3.8 is among them.");
    // The token is never in the answer.
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    expect(JSON.stringify(res.body)).not.toContain(CLIENT_SECRET);
    // The API call is the one a run sends: token, requestor, dedicated headers.
    expect(apiCalls()).toHaveLength(1);
    const sent = apiCalls()[0].headers;
    expect(sent.authorization).toBe(`Bearer ${TOKEN}`);
    expect(sent.accept).toBe('application/json');
    expect(sent.requestor).toBe('req-of-tester');
    expect(sent['x-dedicated']).toBe('for req-of-tester');
    // It writes what a run writes: the token cache, for this (user, company).
    const row = get('SELECT cached_token_enc, cached_token_expires_at FROM tester_credentials WHERE user_id = ? AND company_id = ?', [uid, companyId]);
    expect(row.cached_token_enc).toBeTruthy();
    expect(row.cached_token_expires_at).toBeTruthy();
    expect(auditOf(uid)).toEqual(['credentials_tested:accepted']);
  });

  test('a cached token is not reused: the token endpoint is always asked', async () => {
    const uid = newUser();
    oauth(uid);
    await post(uid);
    await post(uid);
    expect(calls.filter(c => c.url === '/token')).toHaveLength(2);
  });

  test('the token endpoint refuses: its status is said, no secret, and the API is not called', async () => {
    const uid = newUser();
    oauth(uid, companyId, { client_secret_enc: encrypt('wrong-secret-value') });
    const res = await post(uid);
    expect(res.status).toBe(200);
    expect(res.body.token.ok).toBe(false);
    expect(res.body.token.error).toContain('HTTP 401');
    expect(res.body.token.error).toContain('invalid_client');
    expect(res.body.api).toEqual({ ok: false, outcome: 'not_tried' });
    expect(res.body.outcome).toBe('token_failed');
    expect(res.body.summary).toMatch(/^No token: /);
    expect(apiCalls()).toHaveLength(0);
    expect(JSON.stringify(res.body)).not.toContain('wrong-secret-value');
    expect(auditOf(uid)).toEqual(['credentials_tested:token_failed']);
  });

  test('a token endpoint that echoes a secret back has it masked in the message', async () => {
    const uid = newUser();
    oauth(uid);
    tokenReply = () => ({ status: 400, text: `client ${CLIENT_ID} with secret ${CLIENT_SECRET} is not known` });
    const res = await post(uid);
    expect(res.body.token.ok).toBe(false);
    expect(res.body.token.error).toContain('HTTP 400');
    expect(JSON.stringify(res.body)).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(res.body)).not.toContain(CLIENT_ID);
    expect(res.body.token.error).toContain('client *** with secret *** is not known');
  });

  test('a token answer without the token field is not quoted: it may hold the token under another name', async () => {
    const uid = newUser();
    oauth(uid, companyId, { oauth_profile: 'paxone_json' });
    tokenReply = () => ({ status: 200, json: { jwt: TOKEN } });
    const res = await post(uid);
    expect(res.body.token.ok).toBe(false);
    expect(res.body.token.error).toMatch(/did not contain a recognised token field/);
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
  });

  test('the provider refuses the token (401)', async () => {
    const uid = newUser();
    oauth(uid);
    apiReply = () => ({ status: 401, json: { title: 'Unauthorized', detail: 'token unknown' } });
    const res = await post(uid);
    expect(res.body.token.ok).toBe(true);
    expect(res.body.api).toEqual({ ok: false, outcome: 'token_refused', status: 401, frameworkVersion: '3.8' });
    expect(res.body.summary).toBe('The provider refused the token: GET /versions answered 401.');
    expect(auditOf(uid)).toEqual(['credentials_tested:token_refused']);
  });

  test('the provider does not offer /versions (501): the token was not refused', async () => {
    const uid = newUser();
    oauth(uid);
    apiReply = () => ({ status: 501, json: { title: 'Not Implemented' } });
    const res = await post(uid);
    expect(res.body.api).toEqual({ ok: true, outcome: 'not_offered', status: 501, frameworkVersion: '3.8' });
    expect(res.body.summary).toMatch(/not refused, but the provider does not offer GET \/versions \(it answered 501\)/);
  });

  test('a redirect is not followed', async () => {
    const uid = newUser();
    oauth(uid);
    apiReply = () => ({ status: 302, json: {}, headers: { location: `${base}/elsewhere` } });
    const res = await post(uid);
    expect(res.body.api.outcome).toBe('redirect');
    expect(res.body.api.status).toBe(302);
    expect(calls.some(c => c.url === '/elsewhere')).toBe(false);
  });

  test('an answer that is not a version list is said so', async () => {
    const uid = newUser();
    oauth(uid);
    apiReply = () => ({ status: 200, text: '<html>Request Rejected</html>', headers: { 'content-type': 'text/html' } });
    const res = await post(uid);
    expect(res.body.api).toMatchObject({ ok: true, outcome: 'accepted', versions: [], versionsReadable: false });
    expect(res.body.summary).toContain('Its answer is not a list of OSDM versions.');
  });

  test('the answer is read up to 64 KB only', async () => {
    const uid = newUser();
    oauth(uid);
    const big = JSON.stringify(Array.from({ length: 8000 }, (_, i) => ({ version: `3.${i}.0` })));
    expect(big.length).toBeGreaterThan(64 * 1024);
    apiReply = () => ({ status: 200, text: big });
    const res = await post(uid);
    // Cut at 64 KB, the list no longer parses.
    expect(res.body.api).toMatchObject({ outcome: 'accepted', versions: [], versionsReadable: false });
  });

  test('no answer at all: the kind of failure is said, not the address', async () => {
    const closed = http.createServer();
    await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
    const port = closed.address().port;
    await new Promise(resolve => closed.close(resolve));
    const cid = uuidv4();
    run(`INSERT INTO companies (id, name, slug, api_base) VALUES (?, 'Closed Co', 'cred-closed', ?)`, [cid, `http://127.0.0.1:${port}/osdm?key=abc`]);
    const uid = newUser('company_user', cid);
    oauth(uid, cid);
    const res = await request(app).post(TEST).set('Authorization', token('company_user', uid, cid)).send();
    expect(res.body.api).toEqual({ ok: false, outcome: 'no_answer', error: 'No answer (ECONNREFUSED).' });
    expect(res.body.summary).toBe('No answer (ECONNREFUSED).');
    expect(JSON.stringify(res.body)).not.toContain('key=abc');
  });

  test('a bearer token: its stored value is sent and never answered back', async () => {
    const uid = newUser();
    setCredentials(uid, companyId, { auth_mode: 'bearer', access_token_enc: encrypt(BEARER) });
    const res = await post(uid);
    expect(res.body.token).toEqual({ ok: true, mode: 'bearer', profile: null });
    expect(res.body.api.outcome).toBe('accepted');
    expect(apiCalls()[0].headers.authorization).toBe(`Bearer ${BEARER}`);
    expect(JSON.stringify(res.body)).not.toContain(BEARER);
  });

  test('no credentials saved: the resolver says what is missing', async () => {
    const uid = newUser();
    const res = await post(uid);
    expect(res.body.token).toEqual({ ok: false, mode: 'bearer', profile: null, error: 'Bearer token not configured. Set it in your profile.' });
    expect(apiCalls()).toHaveLength(0);
  });

  test('OAuth2 with fields missing: the resolver names them', async () => {
    const uid = newUser();
    setCredentials(uid, companyId, { auth_mode: 'oauth2', oauth_profile: 'oauth2_post', client_id_enc: encrypt(CLIENT_ID) });
    const res = await post(uid);
    expect(res.body.token.ok).toBe(false);
    expect(res.body.token.error).toMatch(/missing: token_url, client_secret/);
  });

  test('no endpoint saved: the API is not called, and the answer says so', async () => {
    const uid = newUser('company_user', bareId);
    oauth(uid, bareId);
    const res = await request(app).post(TEST).set('Authorization', token('company_user', uid, bareId)).send();
    expect(res.status).toBe(200);
    expect(res.body.token.ok).toBe(true);
    expect(res.body.api).toEqual({ ok: false, outcome: 'no_endpoint' });
    expect(res.body.summary).toBe('No OSDM endpoint is saved here, so the API was not called.');
    expect(apiCalls()).toHaveLength(0);
    expect(auditOf(uid)).toEqual(['credentials_tested:no_endpoint']);
  });

  test('a provider is tested with the credentials kept for it, not the company\'s', async () => {
    const uid = newUser('test_manager');
    oauth(uid, providerId);   // nothing for the company itself
    const own = await post(uid, 'test_manager', '');
    expect(own.body.token.ok).toBe(false);
    const provider = await post(uid, 'test_manager', providerId);
    expect(provider.body.token.ok).toBe(true);
    expect(provider.body.api.outcome).toBe('accepted');
    // The provider has no Test Framework: no version to compare.
    expect(provider.body.api.frameworkVersion).toBeUndefined();
    expect(get('SELECT cached_token_enc FROM tester_credentials WHERE user_id = ? AND company_id = ?', [uid, providerId]).cached_token_enc).toBeTruthy();
  });

  test('another company\'s provider is not found', async () => {
    const uid = newUser('test_manager');
    oauth(uid, companyId);
    const res = await post(uid, 'test_manager', otherProviderId);
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  test.each([['administrator'], ['certification_user']])('%s is refused', async (role) => {
    const uid = newUser(role);
    oauth(uid);
    const res = await post(uid, role);
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
    expect(auditOf(uid)).toEqual([]);
  });

  test('no session, no test', async () => {
    const res = await request(app).post(TEST).send();
    expect(res.status).toBe(401);
  });

  test('ten tests a minute per user', async () => {
    const uid = newUser();
    const other = newUser();
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await post(uid)).status);
    expect(statuses.slice(0, 10).every(s => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
    // Another user has a limit of their own.
    expect((await post(other)).status).toBe(200);
  });
});
