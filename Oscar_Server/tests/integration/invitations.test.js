// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * Nobody chooses another person's password, and a company is joined through
 * its own Test Manager (decision 3, part B). An administrator or a Test
 * Manager invites: the person receives a link to choose their password. The
 * administrator cannot take a company over: it does not change a company
 * account's e-mail, does not move anyone into a company, does not name a Test
 * Manager where the company has one, and brings a first Test Manager only into
 * a new company. Certifiers belong to the UIC.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-invitations';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { randomUUID: uuidv4 } = require('node:crypto');
const { run, get } = require('../../src/db/db');
const { ensurePlatformCompany } = require('../../src/api/helpers/shared');

const app = express();
app.use(express.json());
app.use('/v1/auth', require('../../src/api/routes/auth'));
app.use('/v1/admin', require('../../src/api/routes/admin'));
app.use('/v1/company/users', require('../../src/api/routes/company-users'));

const PLAT = ensurePlatformCompany().id;
const ACME = uuidv4();
const NEW_CO = uuidv4();
const USED_CO = uuidv4();
const ADMIN = uuidv4();
const TM = uuidv4();
const TESTER = uuidv4();
const USED_TESTER = uuidv4();
const PASSWORD = 'ChosenByMe123!';

const mail = s => `${s}-${uuidv4().slice(0, 8)}@invite.test`;
function bearer(id) {
  const u = get('SELECT email, role, company_id FROM users WHERE id = ?', [id]);
  return `Bearer ${jwt.sign({ sub: id, email: u.email, companyId: u.company_id, role: u.role }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;
}
const add = (id, cid, role, email = mail(role)) =>
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', ?)`, [id, cid, email, role]);
const tokenOf = email => get(`SELECT t.token FROM password_reset_tokens t JOIN users u ON u.id = t.user_id WHERE u.email = ?`, [email])?.token;

beforeAll(() => {
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Acme', ?)`, [ACME, `acme-${ACME.slice(0, 8)}`]);
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'New Co', ?)`, [NEW_CO, `new-${NEW_CO.slice(0, 8)}`]);
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Used Co', ?)`, [USED_CO, `used-${USED_CO.slice(0, 8)}`]);
  add(ADMIN, PLAT, 'administrator');
  add(TM, ACME, 'test_manager');
  add(TESTER, ACME, 'company_user');
  add(USED_TESTER, USED_CO, 'company_user');   // a company with people but no Test Manager
});

describe('invitations: the person chooses their own password', () => {
  test('a password sent by an administrator or a Test Manager is refused', async () => {
    const byAdmin = await request(app).post('/v1/admin/users').set('Authorization', bearer(ADMIN)).send({ email: mail('x'), role: 'certification_user', password: PASSWORD });
    const byTm = await request(app).post('/v1/company/users').set('Authorization', bearer(TM)).send({ email: mail('y'), role: 'company_user', password: PASSWORD });
    expect([byAdmin.status, byTm.status]).toEqual([400, 400]);
  });

  test('a Test Manager invites; the link lets the person choose the password and sign in', async () => {
    const email = mail('tester');
    const res = await request(app).post('/v1/company/users').set('Authorization', bearer(TM)).send({ email, role: 'company_user' });
    expect(res.status).toBe(201);
    expect(get('SELECT company_id FROM users WHERE email = ?', [email]).company_id).toBe(ACME);
    expect((await request(app).post('/v1/auth/password-reset/confirm').send({ token: tokenOf(email), password: PASSWORD })).status).toBe(200);
    expect((await request(app).post('/v1/auth/login').send({ email, password: PASSWORD })).status).toBe(200);
  });

  test('certifiers and administrators are invited into the UIC (platform) company', async () => {
    const email = mail('certifier');
    const res = await request(app).post('/v1/admin/users').set('Authorization', bearer(ADMIN)).send({ email, role: 'certification_user', company_id: ACME });
    expect(res.status).toBe(201);
    expect(get('SELECT company_id FROM users WHERE email = ?', [email]).company_id).toBe(PLAT);
  });
});

describe('the administrator does not take a company over', () => {
  test('an invitation into a company with a Test Manager goes to that Test Manager', async () => {
    const email = mail('placed');
    const res = await request(app).post('/v1/admin/users').set('Authorization', bearer(ADMIN)).send({ email, role: 'test_manager', company_id: ACME });
    expect(res.status).toBe(202);
    expect(get('SELECT id FROM users WHERE email = ?', [email])).toBeUndefined();
    expect(get('SELECT state, company_id FROM access_request WHERE email = ?', [email])).toEqual({ state: 'assigned', company_id: ACME });
  });

  test('a first Test Manager only into a new company', async () => {
    const intoUsed = await request(app).post('/v1/admin/users').set('Authorization', bearer(ADMIN)).send({ email: mail('tm'), role: 'test_manager', company_id: USED_CO });
    expect(intoUsed.status).toBe(409);
    const tester = await request(app).post('/v1/admin/users').set('Authorization', bearer(ADMIN)).send({ email: mail('t'), role: 'company_user', company_id: NEW_CO });
    expect(tester.status).toBe(409);
    const email = mail('first');
    const first = await request(app).post('/v1/admin/users').set('Authorization', bearer(ADMIN)).send({ email, role: 'test_manager', company_id: NEW_CO });
    expect(first.status).toBe(201);
    expect(get('SELECT role FROM users WHERE email = ?', [email]).role).toBe('test_manager');
  });

  test('no e-mail change, no move into a company, no Test Manager named over the company\'s own', async () => {
    const patch = (id, body) => request(app).patch(`/v1/admin/users/${id}`).set('Authorization', bearer(ADMIN)).send(body);
    expect((await patch(TESTER, { email: mail('mine') })).status).toBe(409);
    expect((await patch(TESTER, { role: 'company_user', company_id: NEW_CO })).status).toBe(409);
    expect((await patch(TESTER, { role: 'test_manager' })).status).toBe(409);
    const cert = uuidv4();
    add(cert, PLAT, 'certification_user');
    expect((await patch(cert, { role: 'test_manager', company_id: ACME })).status).toBe(409);
    expect(get('SELECT company_id, role FROM users WHERE id = ?', [TESTER])).toEqual({ company_id: ACME, role: 'company_user' });
    // Where the company has no Test Manager, one of its own people may be named.
    expect((await patch(USED_TESTER, { role: 'test_manager' })).status).toBe(200);
  });

  test('a company account\'s password: a link to its owner, never set by, nor handed to, the administrator', async () => {
    expect((await request(app).post(`/v1/admin/users/${TESTER}/reset-password`).set('Authorization', bearer(ADMIN)).send({ new_password: PASSWORD })).status).toBe(403);
    expect((await request(app).post(`/v1/admin/users/${TESTER}/generate-reset-link`).set('Authorization', bearer(ADMIN))).status).toBe(403);
    const sent = await request(app).post(`/v1/admin/users/${TESTER}/send-reset`).set('Authorization', bearer(ADMIN));
    expect(sent.status).toBe(200);
    expect(JSON.stringify(sent.body)).not.toMatch(/token|reset-password\.html/);
    expect(tokenOf(get('SELECT email FROM users WHERE id = ?', [TESTER]).email)).toBeTruthy();
  });

  test('the first Test Manager of an access request: a new company only', async () => {
    const email = mail('req');
    const asked = await request(app).post('/v1/auth/register/request').send({ email, name: 'R', company: 'Used' });
    const token = asked.body.verificationUrl.match(/token=([^&]+)/)[1];
    await request(app).post('/v1/auth/register/confirm').send({ token });
    const id = get('SELECT id FROM access_request WHERE email = ?', [email]).id;
    const other = uuidv4();
    run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Has data', ?)`, [other, `data-${other.slice(0, 8)}`]);
    run(`INSERT INTO test_frameworks (id, company_id, config) VALUES (?, ?, '{}')`, [uuidv4(), other]);
    const res = await request(app).post(`/v1/admin/access-requests/${id}/assign`).set('Authorization', bearer(ADMIN)).send({ company_id: other, first_test_manager: true });
    expect(res.status).toBe(409);
    expect(get('SELECT id FROM users WHERE email = ?', [email])).toBeUndefined();
  });
});

describe('a Test Manager sends a reset link, never sets a password', () => {
  test('send-reset for their own company only; the old route is gone', async () => {
    expect((await request(app).post(`/v1/company/users/${TESTER}/send-reset`).set('Authorization', bearer(TM))).status).toBe(200);
    expect((await request(app).post(`/v1/company/users/${USED_TESTER}/send-reset`).set('Authorization', bearer(TM))).status).toBe(404);
    expect((await request(app).post(`/v1/company/users/${TESTER}/reset-password`).set('Authorization', bearer(TM)).send({ new_password: PASSWORD })).status).toBe(404);
  });
});
