// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * api-keys.test.js — #503 PR 1: read-only API keys.
 *
 *   - only a Test Manager makes, lists and revokes keys, for the company or
 *     provider the request names; the key is answered once, never its hash;
 *   - a key works on /v1/api only, in the Authorization header only;
 *   - revoked, expired, wrong secret, creator no longer a Test Manager or no
 *     longer allowed in the company: the same 401;
 *   - a key reaches nothing but the routes /v1/api lists.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-api-keys';

const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { run, get, all } = require('../../src/db/db');
const { requireAuth } = require('../../src/api/middleware/auth');
const { canUserSeeRun } = require('../../src/api/helpers/run-access');

const app = express();
app.use(express.json());
app.use('/v1/company', require('../../src/api/routes/company-api-keys'));
app.use('/v1/api', require('../../src/api/routes/api'));
// A stand-in for any session route, rate-limited like the real ones.
const sessionLimiter = require('express-rate-limit')({ windowMs: 60 * 1000, max: 1000, standardHeaders: true, legacyHeaders: false });
app.get('/v1/session-only', sessionLimiter, requireAuth, (req, res) => res.json({ ok: true }));

const companyId = crypto.randomUUID();
const providerId = crypto.randomUUID();
const otherId = crypto.randomUUID();
const tag = companyId.slice(0, 8);
const user = (role, company = companyId) => ({ id: crypto.randomUUID(), email: `${role}-${crypto.randomUUID().slice(0, 6)}@keys.test`, role, companyId: company });
const TM = user('test_manager');
const TM2 = user('test_manager');
const TESTER = user('company_user');
const CERT = user('certification_user');
const OTHER_TM = user('test_manager', otherId);
const session = u => `Bearer ${jwt.sign({ sub: u.id, email: u.email, companyId: u.companyId, role: u.role }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;

beforeAll(() => {
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Keys Co', ?)`, [companyId, `keys-${tag}`]);
  run(`INSERT INTO companies (id, name, slug, parent_id) VALUES (?, 'Keys Provider', ?, ?)`, [providerId, `keys-p-${tag}`, companyId]);
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Other Co', ?)`, [otherId, `keys-o-${tag}`]);
  for (const u of [TM, TM2, TESTER, CERT, OTHER_TM]) {
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', ?)`, [u.id, u.companyId, u.email, u.role]);
  }
});

const make = (u = TM, body = { name: 'CI dashboard' }, provider) => {
  const r = request(app).post('/v1/company/api-keys').set('Authorization', session(u));
  if (provider) r.set('X-Provider-Id', provider);
  return r.send(body);
};
const asKey = (key, path = '/v1/api/key') => request(app).get(path).set('Authorization', `Bearer ${key}`);

describe('managing keys', () => {
  test('a Test Manager makes a key: answered once, with the prefix as hint and the default lifetime', async () => {
    const res = await make();
    expect(res.status).toBe(201);
    expect(res.body.key).toMatch(/^oscar_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    expect(res.body.hint).toBe(`${res.body.key.slice(0, 14)}_…`);
    expect(res.body).toMatchObject({ name: 'CI dashboard', scopes: ['runs:read'], state: 'active', created_by: TM.email });
    const days = (Date.parse(res.body.expires_at + 'Z') - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThan(90.1);

    const list = await request(app).get('/v1/company/api-keys').set('Authorization', session(TM2));
    expect(list.status).toBe(200);
    expect(list.body.company).toEqual({ id: companyId, name: 'Keys Co' });
    const text = JSON.stringify(list.body);
    expect(text).not.toContain(res.body.key.slice(15));
    expect(text).not.toContain(get('SELECT secret_hash FROM api_key WHERE id = ?', [res.body.id]).secret_hash);
    expect(list.body.keys.map(k => k.id)).toContain(res.body.id);
  });

  test('only the hash of the secret is stored', async () => {
    const res = await make(TM, { name: 'hash check' });
    const row = get('SELECT * FROM api_key WHERE id = ?', [res.body.id]);
    const secret = res.body.key.slice(15);
    expect(row.secret_hash).toBe(crypto.createHash('sha256').update(secret).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(secret);
  });

  test.each([
    ['a tester', TESTER],
    ['a certifier', CERT],
  ])('%s can neither make nor list keys', async (_label, u) => {
    expect((await make(u)).status).toBe(403);
    expect((await request(app).get('/v1/company/api-keys').set('Authorization', session(u))).status).toBe(403);
  });

  test.each([
    [{}, 'needs a name'],
    [{ name: '   ' }, 'needs a name'],
    [{ name: 'x'.repeat(81) }, 'at most 80'],
    [{ name: 'k', expires_in_days: 366 }, 'from 1 to 365'],
    [{ name: 'k', expires_in_days: 0 }, 'from 1 to 365'],
    [{ name: 'k', expires_in_days: 1.5 }, 'from 1 to 365'],
  ])('a key %j is refused', async (body, why) => {
    const res = await make(TM, body);
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain(why);
  });

  test('a key for a provider belongs to the provider, and the company does not list it', async () => {
    const res = await make(TM, { name: 'provider key', expires_in_days: 30 }, providerId);
    expect(res.status).toBe(201);
    expect(get('SELECT company_id FROM api_key WHERE id = ?', [res.body.id]).company_id).toBe(providerId);
    const own = await request(app).get('/v1/company/api-keys').set('Authorization', session(TM));
    expect(own.body.keys.map(k => k.id)).not.toContain(res.body.id);
    expect((await asKey(res.body.key)).body.company).toEqual({ id: providerId, name: 'Keys Provider' });
  });

  test('another company can neither see nor revoke a key, and a provider that is not ours is a 404', async () => {
    const res = await make();
    expect((await request(app).delete(`/v1/company/api-keys/${res.body.id}`).set('Authorization', session(OTHER_TM))).status).toBe(404);
    expect((await make(OTHER_TM, { name: 'x' }, providerId)).status).toBe(404);
    expect((await asKey(res.body.key)).status).toBe(200);
  });

  test('revoking is immediate, audited, and done once', async () => {
    const res = await make();
    expect((await asKey(res.body.key)).status).toBe(200);
    const del = await request(app).delete(`/v1/company/api-keys/${res.body.id}`).set('Authorization', session(TM2));
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ state: 'revoked', revoked_by: TM2.email });
    expect((await asKey(res.body.key)).status).toBe(401);
    await request(app).delete(`/v1/company/api-keys/${res.body.id}`).set('Authorization', session(TM));
    expect(get('SELECT revoked_by FROM api_key WHERE id = ?', [res.body.id]).revoked_by).toBe(TM2.id);
    const events = all("SELECT event_type FROM auth_events WHERE company_id = ? AND event_type LIKE 'api_key_%'", [companyId]).map(e => e.event_type);
    expect(events).toContain('api_key_created');
    expect(events.filter(e => e === 'api_key_revoked').length).toBeGreaterThanOrEqual(1);
  });
});

describe('using a key', () => {
  let key;
  let keyId;
  beforeAll(async () => {
    const res = await make(TM, { name: 'reader' });
    key = res.body.key;
    keyId = res.body.id;
  });

  test('it describes itself and records its use', async () => {
    const res = await asKey(key);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'reader', company: { id: companyId, name: 'Keys Co' }, scopes: ['runs:read'] });
    expect(res.body).not.toHaveProperty('key');
    expect(get('SELECT last_used_at FROM api_key WHERE id = ?', [keyId]).last_used_at).toBeTruthy();
  });

  test.each([
    ['no key', null],
    ['a wrong secret', () => key.slice(0, 15) + 'A'.repeat(43)],
    ['an unknown prefix', () => 'oscar_00000000_' + key.slice(15)],
    ['a malformed key', () => key + 'x'],
    ['a session token', () => session(TM).slice(7)],
  ])('%s is a 401', async (_label, value) => {
    const r = request(app).get('/v1/api/key');
    const k = typeof value === 'function' ? value() : value;
    if (k) r.set('Authorization', `Bearer ${k}`);
    const res = await r;
    expect(res.status).toBe(401);
    expect(res.body.detail).toBe('Missing, invalid, expired or revoked API key.');
  });

  test('a key in a cookie or in the URL is not read', async () => {
    expect((await request(app).get('/v1/api/key').set('Cookie', `oscar_session=${key}`)).status).toBe(401);
    expect((await request(app).get(`/v1/api/key?api_key=${encodeURIComponent(key)}`)).status).toBe(401);
    expect((await request(app).get(`/v1/api/key?key=${encodeURIComponent(key)}`)).status).toBe(401);
  });

  test('a session route refuses a key, and says where keys go', async () => {
    const res = await request(app).get('/v1/session-only').set('Authorization', `Bearer ${key}`);
    expect(res.status).toBe(401);
    expect(res.body.detail).toContain('/v1/api');
    expect((await request(app).get('/v1/company/api-keys').set('Authorization', `Bearer ${key}`)).status).toBe(401);
  });

  test('a key opens nothing the API does not list: other paths and other methods are 404', async () => {
    expect((await asKey(key, '/v1/api/runs')).status).toBe(404);
    expect((await request(app).post('/v1/api/key').set('Authorization', `Bearer ${key}`)).status).toBe(404);
    expect((await request(app).delete('/v1/api/key').set('Authorization', `Bearer ${key}`)).status).toBe(404);
    // Unauthenticated, the same paths are a 401: nothing is told before the key.
    expect((await request(app).get('/v1/api/runs')).status).toBe(401);
  });

  test('an expired key is a 401', async () => {
    const res = await make(TM, { name: 'short' });
    run("UPDATE api_key SET expires_at = datetime('now', '-1 second') WHERE id = ?", [res.body.id]);
    expect((await asKey(res.body.key)).status).toBe(401);
  });

  test('a key stops when its creator is no longer an active Test Manager', async () => {
    const creator = user('test_manager');
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'test_manager')`, [creator.id, companyId, creator.email]);
    const own = (await make(creator, { name: 'demoted' })).body.key;
    const prov = (await make(creator, { name: 'demoted provider' }, providerId)).body.key;
    expect((await asKey(own)).status).toBe(200);
    expect((await asKey(prov)).status).toBe(200);
    run("UPDATE users SET role = 'company_user' WHERE id = ?", [creator.id]);
    expect((await asKey(own)).status).toBe(401);
    expect((await asKey(prov)).status).toBe(401);
    run("UPDATE users SET role = 'test_manager', status = 'pending' WHERE id = ?", [creator.id]);
    expect((await asKey(own)).status).toBe(401);
    run("UPDATE users SET status = 'active', company_id = ? WHERE id = ?", [otherId, creator.id]);
    expect((await asKey(own)).status).toBe(401);
    expect((await asKey(prov)).status).toBe(401);
  });
});

describe('canUserSeeRun with a key (#503)', () => {
  const runIn = (company) => {
    const id = crypto.randomUUID();
    run(`INSERT INTO runs (id, company_id, user_id, status) VALUES (?, ?, ?, 'COMPLETED')`, [id, company, TM.id]);
    return id;
  };

  test('the key\'s own company only: not its providers, not another company', () => {
    const own = runIn(companyId);
    const prov = runIn(providerId);
    const other = runIn(otherId);
    const asKeyOf = c => ({ id: TM.id, keyCompanyId: c, role: 'api_key' });
    expect(canUserSeeRun(own, asKeyOf(companyId))?.id).toBe(own);
    expect(canUserSeeRun(prov, asKeyOf(companyId))).toBeNull();
    expect(canUserSeeRun(other, asKeyOf(companyId))).toBeNull();
    expect(canUserSeeRun(prov, asKeyOf(providerId))?.id).toBe(prov);
    expect(canUserSeeRun(own, { id: TM.id, keyCompanyId: '', role: 'api_key' })).toBeNull();
    // The session field is not what a key is judged on.
    expect(canUserSeeRun(own, { id: TM.id, companyId, role: 'api_key' })).toBeNull();
  });
});
