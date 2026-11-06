// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * Access is asked, checked twice, then given (utils/accessRequests.js): a
 * visitor names their company in their own words and confirms their e-mail;
 * an administrator places the request in a company; a Test Manager of that
 * company confirms it; the person chooses their own password. The
 * administrator alone gives access only to the first Test Manager of a
 * company that has none.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-access-requests';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { randomUUID: uuidv4 } = require('node:crypto');
const { run, get } = require('../../src/db/db');

const app = express();
app.use(express.json());
app.use('/v1/auth', require('../../src/api/routes/auth'));
app.use('/v1/admin', require('../../src/api/routes/admin'));
app.use('/v1/company/users', require('../../src/api/routes/company-users'));

const PLAT = uuidv4();
const ACME = uuidv4();
const EMPTY = uuidv4();
const OTHER = uuidv4();
const ADMIN = uuidv4();
const TM = uuidv4();
const OTHER_TM = uuidv4();
const PASSWORD = 'MyOwnPassw0rd!';

function bearer(id, role, companyId) {
  const email = get('SELECT email FROM users WHERE id = ?', [id]).email;
  return `Bearer ${jwt.sign({ sub: id, email, companyId, role }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;
}
const asAdmin = () => bearer(ADMIN, 'administrator', PLAT);
const asTm = () => bearer(TM, 'test_manager', ACME);
const asOtherTm = () => bearer(OTHER_TM, 'test_manager', OTHER);

beforeAll(() => {
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Plat', ?)`, [PLAT, `plat-${PLAT.slice(0, 8)}`]);
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Acme Rail', ?)`, [ACME, `acme-${ACME.slice(0, 8)}`]);
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Empty Rail', ?)`, [EMPTY, `empty-${EMPTY.slice(0, 8)}`]);
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Other Rail', ?)`, [OTHER, `other-${OTHER.slice(0, 8)}`]);
  const add = (id, cid, role) => run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', ?)`,
    [id, cid, `${role}-${id.slice(0, 8)}@access.test`, role]);
  add(ADMIN, PLAT, 'administrator');
  add(TM, ACME, 'test_manager');
  add(OTHER_TM, OTHER, 'test_manager');
});

// A request whose e-mail is confirmed: { id, email }.
async function verifiedRequest(company = 'Acme, the rail one') {
  const email = `req-${uuidv4().slice(0, 8)}@access.test`;
  const asked = await request(app).post('/v1/auth/register/request').send({ email, name: 'Ada Lovelace', company });
  expect(asked.status).toBe(200);
  const token = asked.body.verificationUrl.match(/token=([^&]+)/)[1];
  expect((await request(app).post('/v1/auth/register/confirm').send({ token })).status).toBe(200);
  return { id: get('SELECT id FROM access_request WHERE email = ?', [email]).id, email };
}

function activationToken(email) {
  return get(`SELECT t.token FROM password_reset_tokens t JOIN users u ON u.id = t.user_id WHERE u.email = ?`, [email]).token;
}

describe('the double check', () => {
  test('administrator places, Test Manager confirms, the person chooses the password', async () => {
    const { id, email } = await verifiedRequest();
    const listed = await request(app).get('/v1/admin/access-requests').set('Authorization', asAdmin());
    expect(listed.body.requests.find(r => r.id === id)).toMatchObject({ email, name: 'Ada Lovelace', company_typed: 'Acme, the rail one', state: 'verified' });

    const placed = await request(app).post(`/v1/admin/access-requests/${id}/assign`).set('Authorization', asAdmin()).send({ company_id: ACME });
    expect(placed.body).toMatchObject({ assigned: true });
    expect(get('SELECT id FROM users WHERE email = ?', [email])).toBeUndefined();

    // Another company's Test Manager neither sees nor confirms it.
    expect((await request(app).get('/v1/company/users/access-requests').set('Authorization', asOtherTm())).body.requests).toEqual([]);
    expect((await request(app).post(`/v1/company/users/access-requests/${id}/confirm`).set('Authorization', asOtherTm()).send({ role: 'company_user' })).status).toBe(404);

    const mine = await request(app).get('/v1/company/users/access-requests').set('Authorization', asTm());
    expect(mine.body.requests.map(r => r.id)).toContain(id);
    const confirmed = await request(app).post(`/v1/company/users/access-requests/${id}/confirm`).set('Authorization', asTm()).send({ role: 'company_user' });
    expect(confirmed.status).toBe(200);
    const user = get('SELECT company_id, role, status FROM users WHERE email = ?', [email]);
    expect(user).toEqual({ company_id: ACME, role: 'company_user', status: 'active' });

    // Nobody knows a password yet; the person sets theirs and signs in.
    expect((await request(app).post('/v1/auth/login').send({ email, password: PASSWORD })).status).toBe(401);
    const token = activationToken(email);
    expect((await request(app).post('/v1/auth/password-reset/confirm').send({ token, password: PASSWORD })).status).toBe(200);
    expect((await request(app).post('/v1/auth/login').send({ email, password: PASSWORD })).status).toBe(200);
    expect(get('SELECT id FROM access_request WHERE id = ?', [id])).toBeUndefined();
  });

  test('a company with no Test Manager gets its first one from the administrator, when asked explicitly', async () => {
    const { id, email } = await verifiedRequest('Empty');
    const first = await request(app).post(`/v1/admin/access-requests/${id}/assign`).set('Authorization', asAdmin()).send({ company_id: EMPTY });
    expect(first.status).toBe(409);
    expect(first.body.needs_first_test_manager).toBe(true);
    expect(get('SELECT id FROM users WHERE email = ?', [email])).toBeUndefined();

    const done = await request(app).post(`/v1/admin/access-requests/${id}/assign`).set('Authorization', asAdmin()).send({ company_id: EMPTY, first_test_manager: true });
    expect(done.body).toMatchObject({ activated: true });
    expect(get('SELECT role, company_id FROM users WHERE email = ?', [email])).toEqual({ role: 'test_manager', company_id: EMPTY });
    expect(activationToken(email)).toBeTruthy();
  });

  test('refusals: by the administrator, or by the Test Manager of the company only', async () => {
    const one = await verifiedRequest();
    expect((await request(app).post(`/v1/admin/access-requests/${one.id}/refuse`).set('Authorization', asAdmin())).status).toBe(200);
    expect(get('SELECT id FROM access_request WHERE id = ?', [one.id])).toBeUndefined();

    const two = await verifiedRequest();
    await request(app).post(`/v1/admin/access-requests/${two.id}/assign`).set('Authorization', asAdmin()).send({ company_id: ACME });
    expect((await request(app).post(`/v1/company/users/access-requests/${two.id}/refuse`).set('Authorization', asOtherTm())).status).toBe(404);
    expect((await request(app).post(`/v1/company/users/access-requests/${two.id}/refuse`).set('Authorization', asTm())).status).toBe(200);
    expect(get('SELECT id FROM users WHERE email = ?', [two.email])).toBeUndefined();
  });

  test('a request is never placed in the platform or a provider, nor confirmed with another role', async () => {
    const { id } = await verifiedRequest();
    const { PLATFORM_SLUG } = require('../../src/api/helpers/shared');
    const platform = get('SELECT id FROM companies WHERE slug = ?', [PLATFORM_SLUG])?.id
      || (run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Platform', ?)`, [uuidv4(), PLATFORM_SLUG]), get('SELECT id FROM companies WHERE slug = ?', [PLATFORM_SLUG]).id);
    const provider = uuidv4();
    run(`INSERT INTO companies (id, name, slug, parent_id) VALUES (?, 'Acme provider', ?, ?)`, [provider, `prov-${provider.slice(0, 8)}`, ACME]);
    for (const companyId of [platform, provider, uuidv4()]) {
      const res = await request(app).post(`/v1/admin/access-requests/${id}/assign`).set('Authorization', asAdmin()).send({ company_id: companyId, first_test_manager: true });
      expect(res.status).toBe(400);
    }
    await request(app).post(`/v1/admin/access-requests/${id}/assign`).set('Authorization', asAdmin()).send({ company_id: ACME });
    expect((await request(app).post(`/v1/company/users/access-requests/${id}/confirm`).set('Authorization', asTm()).send({ role: 'administrator' })).status).toBe(400);
  });

  // 1.11.480: the public form sends one e-mail per address while its link is
  // valid, and cannot replace a request already confirmed.
  test('one link per address while it is valid; a new one once it expired', async () => {
    const email = `once-${uuidv4().slice(0, 8)}@access.test`;
    const first = await request(app).post('/v1/auth/register/request').send({ email, name: 'A', company: 'First' });
    expect(first.body.verificationUrl).toMatch(/token=/);
    const again = await request(app).post('/v1/auth/register/request').send({ email, name: 'B', company: 'Call this number' });
    expect(again.status).toBe(200);
    expect(again.body.verificationUrl).toBeUndefined();
    expect(again.body.message).toMatch(/^If your request can be handled/);
    expect(get('SELECT company_text FROM access_request WHERE email = ?', [email]).company_text).toBe('First');
    run(`UPDATE access_request SET token_expires_at = '2000-01-01T00:00:00.000Z' WHERE email = ?`, [email]);
    const later = await request(app).post('/v1/auth/register/request').send({ email, name: 'A', company: 'Second' });
    expect(later.body.verificationUrl).toMatch(/token=/);
    expect(get('SELECT company_text FROM access_request WHERE email = ?', [email]).company_text).toBe('Second');
    run('DELETE FROM access_request WHERE email = ?', [email]);
  });

  test('a confirmed request is not replaced by the form, and no e-mail goes out', async () => {
    const { id, email } = await verifiedRequest('Kept company');
    const asked = await request(app).post('/v1/auth/register/request').send({ email, name: 'Other', company: 'Other text' });
    expect(asked.status).toBe(200);
    expect(asked.body.verificationUrl).toBeUndefined();
    expect(get('SELECT id, state, company_text FROM access_request WHERE email = ?', [email])).toEqual({ id, state: 'verified', company_text: 'Kept company' });
    run('DELETE FROM access_request WHERE id = ?', [id]);
  });

  test('an unconfirmed e-mail is shown to the administrator, who can only refuse it', async () => {
    const email = `unverified-${uuidv4().slice(0, 8)}@access.test`;
    await request(app).post('/v1/auth/register/request').send({ email, name: 'U', company: 'X' });
    const listed = await request(app).get('/v1/admin/access-requests').set('Authorization', asAdmin());
    const shown = listed.body.requests.find(r => r.email === email);
    expect(shown).toMatchObject({ state: 'unverified', company_typed: 'X' });
    expect(Date.parse(shown.link_expires_at)).toBeGreaterThan(Date.now());
    expect(JSON.stringify(shown)).not.toMatch(/token/);
    // Not placed before its owner confirms it, and not shown to a Test Manager.
    const placed = await request(app).post(`/v1/admin/access-requests/${shown.id}/assign`).set('Authorization', asAdmin()).send({ company_id: ACME, first_test_manager: true });
    expect(placed.status).toBe(404);
    expect((await request(app).get('/v1/company/users/access-requests').set('Authorization', asTm())).body.requests.map(r => r.id)).not.toContain(shown.id);
    expect((await request(app).post(`/v1/admin/access-requests/${shown.id}/refuse`).set('Authorization', asAdmin())).status).toBe(200);
    expect(get('SELECT id FROM access_request WHERE id = ?', [shown.id])).toBeUndefined();
  });

  test('a tester cannot reach either side', async () => {
    const tester = uuidv4();
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'company_user')`, [tester, ACME, `t-${tester.slice(0, 8)}@access.test`]);
    expect((await request(app).get('/v1/admin/access-requests').set('Authorization', bearer(tester, 'company_user', ACME))).status).toBe(403);
    expect((await request(app).get('/v1/company/users/access-requests').set('Authorization', bearer(tester, 'company_user', ACME))).status).toBe(403);
  });
});

describe('the administrator approves a pending user alone only where no Test Manager is', () => {
  test('refused in a company with a Test Manager, allowed in one without', async () => {
    const withTm = uuidv4();
    const withoutTm = uuidv4();
    const fresh = uuidv4();
    run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Fresh', ?)`, [fresh, `fresh-${fresh.slice(0, 8)}`]);
    run(`INSERT INTO users (id, company_id, email, password_hash, role, status) VALUES (?, ?, ?, 'x', 'company_user', 'pending')`, [withTm, ACME, `p1-${withTm.slice(0, 8)}@access.test`]);
    run(`INSERT INTO users (id, company_id, email, password_hash, role, status) VALUES (?, ?, ?, 'x', 'company_user', 'pending')`, [withoutTm, fresh, `p2-${withoutTm.slice(0, 8)}@access.test`]);
    expect((await request(app).post(`/v1/admin/users/${withTm}/approve`).set('Authorization', asAdmin())).status).toBe(409);
    expect((await request(app).post(`/v1/admin/users/${withoutTm}/approve`).set('Authorization', asAdmin())).status).toBe(200);
  });
});
