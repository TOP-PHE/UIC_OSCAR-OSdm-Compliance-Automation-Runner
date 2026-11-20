// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * company-api-accounts.test.js — #1342 PR 1: Company API accounts.
 *
 *   - only a Test Manager makes, lists, renames, suspends, resumes and
 *     deletes them, in their own company; the providers each must be the
 *     company's;
 *   - an account never has a session, never signs in, gets no reset link,
 *     and neither the company's user routes nor the administrator's change it;
 *   - its OSDM credentials are saved per company or provider it is given,
 *     and never shown;
 *   - testers read its runs; it reads its own runs only.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-api-accounts';

const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { run, get } = require('../../src/db/db');
const { requireAuth } = require('../../src/api/middleware/auth');
const { denyAdminAndCertifier } = require('../../src/api/helpers/shared');
const { canUserSeeRun, runScopeSql } = require('../../src/api/helpers/run-access');

const app = express();
app.use(express.json());
app.use('/v1/auth', require('../../src/api/routes/auth'));
app.use('/v1/company/users', require('../../src/api/routes/company-users'));
app.use('/v1/company/api-accounts', require('../../src/api/routes/company-api-accounts'));
app.use('/v1/admin', require('../../src/api/routes/admin'));
// A stand-in for the many page routes that only refuse administrators and certifiers.
const sessionLimiter = require('express-rate-limit')({ windowMs: 60 * 1000, max: 1000, standardHeaders: true, legacyHeaders: false });
app.put('/v1/page-route', sessionLimiter, requireAuth, (req, res) => {
  if (denyAdminAndCertifier(req, res)) return;
  res.json({ ok: true });
});

const companyId = crypto.randomUUID();
const providerId = crypto.randomUUID();
const provider2Id = crypto.randomUUID();
const otherId = crypto.randomUUID();
const otherProviderId = crypto.randomUUID();
const tag = companyId.slice(0, 8);
const user = (role, company = companyId) => ({ id: crypto.randomUUID(), email: `${role}-${crypto.randomUUID().slice(0, 6)}@accounts.test`, role, companyId: company });
const TM = user('test_manager');
const TESTER = user('company_user');
const TESTER2 = user('company_user');
const CERT = user('certification_user');
const ADMIN = user('administrator');
const OTHER_TM = user('test_manager', otherId);
const session = u => `Bearer ${jwt.sign({ sub: u.id, email: u.email, companyId: u.companyId, role: u.role }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;

beforeAll(() => {
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Accounts Co', ?)`, [companyId, `acc-${tag}`]);
  run(`INSERT INTO companies (id, name, slug, parent_id, api_base) VALUES (?, 'Acc Provider', ?, ?, 'https://provider.example/osdm')`, [providerId, `acc-p-${tag}`, companyId]);
  run(`INSERT INTO companies (id, name, slug, parent_id) VALUES (?, 'Acc Provider Two', ?, ?)`, [provider2Id, `acc-p2-${tag}`, companyId]);
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Other Co', ?)`, [otherId, `acc-o-${tag}`]);
  run(`INSERT INTO companies (id, name, slug, parent_id) VALUES (?, 'Other Provider', ?, ?)`, [otherProviderId, `acc-op-${tag}`, otherId]);
  for (const u of [TM, TESTER, TESTER2, CERT, ADMIN, OTHER_TM]) {
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', ?)`, [u.id, u.companyId, u.email, u.role]);
  }
});

const make = (body, u = TM) => request(app).post('/v1/company/api-accounts').set('Authorization', session(u)).send(body);
const call = (method, path, u = TM) => request(app)[method](`/v1/company/api-accounts${path}`).set('Authorization', session(u));

describe('making and managing an account', () => {
  test('a Test Manager makes one: a user of role api_client, a made-up .invalid e-mail, its providers', async () => {
    const res = await make({ name: 'CI Nightly', providers: [providerId] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'CI Nightly', status: 'active', created_by: TM.email, providers: [{ id: providerId, name: 'Acc Provider' }] });
    expect(res.body.account_email).toMatch(/^ci-nightly\.[0-9a-f]{8}@api-account\.invalid$/);
    expect(res.body.credentials).toEqual([
      { company_id: companyId, company_name: 'Accounts Co', set: false },
      { company_id: providerId, company_name: 'Acc Provider', set: false },
    ]);
    const stored = get('SELECT role, status, company_id, password_hash FROM users WHERE id = ?', [res.body.id]);
    expect(stored).toMatchObject({ role: 'api_client', status: 'active', company_id: companyId });
    expect(stored.password_hash).toMatch(/^\$2[aby]\$12\$/);
    expect(get('SELECT granted_by FROM provider_access WHERE company_id = ? AND user_id = ?', [providerId, res.body.id]).granted_by).toBe(TM.email);
  });

  test('the list is the company\'s, whatever provider the request names', async () => {
    const res = await call('get', '').set('X-Provider-Id', providerId);
    expect(res.status).toBe(200);
    expect(res.body.company).toEqual({ id: companyId, name: 'Accounts Co' });
    expect(res.body.accounts.map(a => a.name)).toContain('CI Nightly');
  });

  test('refused: a tester, a certifier, an administrator', async () => {
    for (const u of [TESTER, CERT, ADMIN]) {
      const res = await make({ name: 'Not mine' }, u);
      expect([403, 404]).toContain(res.status);
    }
    expect(get("SELECT COUNT(*) AS n FROM api_account WHERE name = 'Not mine'").n).toBe(0);
  });

  test('refused: a bad name, a name taken (any case), a provider of another company', async () => {
    expect((await make({ name: '' })).status).toBe(400);
    expect((await make({ name: 'a\nb' })).status).toBe(400);
    expect((await make({ name: 'x'.repeat(61) })).status).toBe(400);
    expect((await make({ name: 'ci nightly' })).status).toBe(409);
    expect((await make({ name: 'Foreign', providers: [otherProviderId] })).status).toBe(400);
    expect((await make({ name: 'Foreign', providers: 'all' })).status).toBe(400);
  });

  test('another company\'s Test Manager sees none and reaches none', async () => {
    const mine = (await make({ name: 'Private' })).body;
    const list = await call('get', '', OTHER_TM);
    expect(list.body.accounts.map(a => a.id)).not.toContain(mine.id);
    expect((await call('get', `/${mine.id}`, OTHER_TM)).status).toBe(404);
    expect((await call('post', `/${mine.id}/suspend`, OTHER_TM)).status).toBe(404);
    expect((await call('delete', `/${mine.id}`, OTHER_TM)).status).toBe(404);
  });

  test('rename, set its providers (a provider taken away loses its grant), suspend, resume', async () => {
    const acc = (await make({ name: 'Rename me', providers: [providerId] })).body;
    let res = await call('patch', `/${acc.id}`).send({ name: 'Renamed', providers: [provider2Id] });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed');
    expect(res.body.providers).toEqual([{ id: provider2Id, name: 'Acc Provider Two' }]);
    expect(get('SELECT 1 AS ok FROM provider_access WHERE company_id = ? AND user_id = ?', [providerId, acc.id])).toBeUndefined();

    res = await call('post', `/${acc.id}/suspend`);
    expect(res.body).toMatchObject({ status: 'suspended', suspended_by: TM.email });
    expect(get('SELECT status FROM users WHERE id = ?', [acc.id]).status).toBe('suspended');
    res = await call('post', `/${acc.id}/resume`);
    expect(res.body).toMatchObject({ status: 'active', suspended_at: null, suspended_by: null });
    expect((await call('patch', `/${acc.id}`).send({})).status).toBe(400);
  });

  test('deleting an account deletes its runs', async () => {
    const acc = (await make({ name: 'Short lived' })).body;
    const runId = crypto.randomUUID();
    run(`INSERT INTO runs (id, company_id, user_id, status) VALUES (?, ?, ?, 'COMPLETED')`, [runId, companyId, acc.id]);
    const res = await call('delete', `/${acc.id}`);
    expect(res.body).toEqual({ deleted: true, id: acc.id });
    expect(get('SELECT 1 AS ok FROM users WHERE id = ?', [acc.id])).toBeUndefined();
    expect(get('SELECT 1 AS ok FROM api_account WHERE user_id = ?', [acc.id])).toBeUndefined();
    expect(get('SELECT 1 AS ok FROM runs WHERE id = ?', [runId])).toBeUndefined();
  });
});

describe('it never reaches a page', () => {
  let acc;
  beforeAll(async () => { acc = (await make({ name: 'Locked out' })).body; });
  const accountPrincipal = () => ({ id: acc.id, email: acc.account_email, companyId, role: 'api_client' });

  test('a session token naming it, however well signed, is refused everywhere', async () => {
    const res = await request(app).put('/v1/page-route').set('Authorization', session(accountPrincipal()));
    expect(res.status).toBe(401);
    // The same token claiming another role is refused too: the role is read from the database.
    const asTester = await request(app).put('/v1/page-route').set('Authorization', session({ ...accountPrincipal(), role: 'company_user' }));
    expect(asTester.status).toBe(401);
  });

  test('it does not sign in, and no reset link is made for it', async () => {
    const login = await request(app).post('/v1/auth/login').send({ email: acc.account_email, password: 'anything-at-all' });
    expect(login.status).toBe(401);
    const reset = await request(app).post('/v1/auth/password-reset/request').send({ email: acc.account_email });
    expect(reset.status).toBe(200);
    expect(get('SELECT COUNT(*) AS n FROM password_reset_tokens WHERE user_id = ?', [acc.id]).n).toBe(0);
  });

  test('the company\'s user routes neither list nor change it', async () => {
    const list = await request(app).get('/v1/company/users').set('Authorization', session(TM));
    expect(list.status).toBe(200);
    expect(list.body.users.map(u => u.id)).not.toContain(acc.id);
    expect((await request(app).patch(`/v1/company/users/${acc.id}`).set('Authorization', session(TM)).send({ role: 'test_manager' })).status).toBe(404);
    expect((await request(app).post(`/v1/company/users/${acc.id}/send-reset`).set('Authorization', session(TM))).status).toBe(404);
    expect((await request(app).delete(`/v1/company/users/${acc.id}`).set('Authorization', session(TM))).status).toBe(404);
    expect(get('SELECT role FROM users WHERE id = ?', [acc.id]).role).toBe('api_client');
  });

  test('the administrator lists it and changes nothing of it', async () => {
    const list = await request(app).get('/v1/admin/users').set('Authorization', session(ADMIN));
    expect(list.body.users.find(u => u.id === acc.id)?.role).toBe('api_client');
    for (const [method, path, body] of [
      ['patch', '', { role: 'test_manager' }],
      ['post', '/send-reset', {}],
      ['post', '/generate-reset-link', {}],
      ['post', '/reset-password', { new_password: 'Abcdefgh1234' }],
      ['delete', '', {}],
    ]) {
      const res = await request(app)[method](`/v1/admin/users/${acc.id}${path}`).set('Authorization', session(ADMIN)).send(body);
      expect(res.status).toBe(409);
    }
    expect(get('SELECT role, status FROM users WHERE id = ?', [acc.id])).toEqual({ role: 'api_client', status: 'active' });
  });
});

describe('its OSDM credentials', () => {
  let acc;
  beforeAll(async () => { acc = (await make({ name: 'With credentials', providers: [providerId] })).body; });
  const creds = (method, provider) => call(method, `/${acc.id}/credentials`).set('X-Provider-Id', provider);

  test('saved for a provider it is given, tied to that endpoint, never shown', async () => {
    const res = await creds('patch', providerId).send({ auth_mode: 'bearer', access_token: '  secret-token \n', requestor: 'ci' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ auth_mode: 'bearer', has_token: true, has_requestor: true, credentials_endpoint: 'https://provider.example' });
    expect(JSON.stringify(res.body)).not.toContain('secret-token');
    const row = get('SELECT access_token_enc FROM tester_credentials WHERE user_id = ? AND company_id = ?', [acc.id, providerId]);
    expect(row.access_token_enc).not.toContain('secret-token');
    const view = (await call('get', `/${acc.id}`)).body;
    expect(view.credentials.find(c => c.company_id === providerId).set).toBe(true);
    expect((await creds('get', providerId)).body.has_token).toBe(true);
  });

  test('refused for a provider it is not given, and the same checks as a tester\'s own', async () => {
    expect((await creds('patch', provider2Id).send({ access_token: 'x' })).status).toBe(409);
    expect((await creds('get', provider2Id)).status).toBe(409);
    expect((await creds('patch', providerId).send({ auth_mode: 'basic' })).status).toBe(400);
    expect((await creds('patch', providerId).send({ token_url: 'not a url' })).status).toBe(400);
    expect((await creds('patch', providerId).send({})).status).toBe(400);
    // A provider the Test Manager's company does not have: enforceTenant's 404.
    expect((await creds('get', otherProviderId)).status).toBe(404);
  });
});

describe('its runs', () => {
  let acc;
  const runOf = (userId, company = companyId) => {
    const id = crypto.randomUUID();
    run(`INSERT INTO runs (id, company_id, user_id, status) VALUES (?, ?, ?, 'COMPLETED')`, [id, company, userId]);
    return id;
  };
  beforeAll(async () => { acc = (await make({ name: 'Runner', providers: [providerId] })).body; });

  test('a tester reads them, as a Test Manager\'s; never a colleague tester\'s', () => {
    const accountRun = runOf(acc.id, providerId);
    run('INSERT OR IGNORE INTO provider_access (company_id, user_id, granted_by) VALUES (?, ?, ?)', [providerId, TESTER.id, TM.email]);
    expect(canUserSeeRun(accountRun, TESTER)?.id).toBe(accountRun);
    expect(canUserSeeRun(runOf(TESTER2.id), TESTER)).toBeNull();
    const scope = runScopeSql(TESTER);
    expect(scope.sql).toContain("role IN ('test_manager', 'api_client')");
  });

  test('the account reads the runs it launched, in a company it may use, and no one else\'s', () => {
    const principal = { id: acc.id, companyId, role: 'api_client' };
    const own = runOf(acc.id, providerId);
    expect(canUserSeeRun(own, principal)?.id).toBe(own);
    expect(canUserSeeRun(runOf(TM.id), principal)).toBeNull();
    expect(canUserSeeRun(runOf(acc.id, provider2Id), principal)).toBeNull();
    expect(runScopeSql(principal)).toEqual({ sql: ' AND r.user_id = ?', params: [acc.id] });
  });
});
