// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * two-factor.test.js — the second factor of an account (#1414): the sign-in
 * of an administrator who must set one up, of an account that has one, an
 * account turning its own on and off, an administrator's reset, and the
 * command run on the server for the last administrator.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-two-factor';
// Many sign-ins from one address: the limits per address are not what this file tests.
process.env.AUTH_RATE_LIMIT_MAX = '1000';

const express = require('express');
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcrypt');
const request = require('supertest');
const { randomUUID } = require('node:crypto');
const { run, get, all } = require('../../src/db/db');
const T = require('../../src/utils/totp');
const { main: resetCommand } = require('../../src/cli/reset-mfa');

const app = express();
app.use(express.json());
app.use('/v1/auth', require('../../src/api/routes/auth'));
app.use('/v1/me/mfa', require('../../src/api/routes/me-mfa'));
app.use('/v1/admin', require('../../src/api/routes/admin'));
app.use((err, req, res, _next) => res.status(500).json({ status: 500, detail: err.message }));

const PASSWORD = 'Two-Factor-Pwd-1';
const PLATFORM = randomUUID();
const COMPANY = randomUUID();

function addUser(role, companyId = role === 'administrator' ? PLATFORM : COMPANY) {
  const id = randomUUID();
  const email = `${role}-${id.slice(0, 8)}@two-factor.example`;
  run('INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)',
    [id, companyId, email, bcrypt.hashSync(PASSWORD, 4), role]);
  return { id, email, role, companyId };
}

// A session as sessions.js signs one; `mfa` says it went through the factor.
function sessionOf(user, { mfa = false } = {}) {
  const claims = { sub: user.id, email: user.email, companyId: user.companyId, role: user.role, jti: randomUUID() };
  if (mfa) claims.mfa = true;
  return jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: '1h' });
}

const signIn = user => request(app).post('/v1/auth/login').send({ email: user.email, password: PASSWORD });
const codeAt = (secret, offset = 0) => T.hotp(T.base32Decode(secret), T.stepAt(Date.now()) + offset);
const row = id => get('SELECT * FROM users WHERE id = ?', [id]);
const events = (id, type) => all('SELECT event_type FROM auth_events WHERE user_id = ? AND event_type = ?', [id, type]).length;
const meMfa = token => request(app).get('/v1/me/mfa').set('Authorization', `Bearer ${token}`);

// Ending an account's sessions ends those signed before the second it
// happens in (sessions_valid_after, as for a password change): a session
// signed in that same second stays. Waiting for the next second makes the
// session the test holds an earlier one.
const nextSecond = () => new Promise(resolve => setTimeout(resolve, 1005 - (Date.now() % 1000)));

/** Signs an administrator in for the first time: the factor set up and on. */
async function setUpAdministrator(admin) {
  const first = await signIn(admin);
  const setup = await request(app).post('/v1/auth/mfa/setup').send({ mfa_token: first.body.mfa_token });
  const done = await request(app).post('/v1/auth/mfa/setup/confirm')
    .send({ mfa_token: first.body.mfa_token, code: codeAt(setup.body.secret) });
  expect(done.status).toBe(200);
  return { secret: setup.body.secret, token: done.body.token };
}

beforeAll(() => {
  run(`INSERT INTO companies (id, name, slug, auth_mode) VALUES (?, 'UIC 2FA', ?, 'bearer')`, [PLATFORM, `uic-2fa-${PLATFORM.slice(0, 8)}`]);
  run(`INSERT INTO companies (id, name, slug, auth_mode) VALUES (?, 'Operator 2FA', ?, 'bearer')`, [COMPANY, `operator-2fa-${COMPANY.slice(0, 8)}`]);
});

describe('an administrator without a second factor', () => {
  test('gets no session from the password: the sign-in asks to set one up', async () => {
    const admin = addUser('administrator');
    const res = await signIn(admin);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mfa: 'setup', mfa_token: expect.any(String) });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(events(admin.id, 'login_password_ok_setup')).toBe(1);
    expect(events(admin.id, 'login_success')).toBe(0);
  });

  test('sets it up: a secret, its address and QR code, then the first code signs in', async () => {
    const admin = addUser('administrator');
    const { body: { mfa_token } } = await signIn(admin);
    const setup = await request(app).post('/v1/auth/mfa/setup').send({ mfa_token });
    expect(setup.status).toBe(200);
    expect(setup.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.body.otpauth_uri).toContain(`secret=${setup.body.secret}`);
    expect(setup.body.otpauth_uri).toContain(encodeURIComponent(admin.email));
    expect(setup.body.qr).toMatch(/^data:image\/svg\+xml;base64,/);
    // Kept pending and encrypted, not on yet.
    const pending = row(admin.id);
    expect(pending.mfa_pending_enc).toBeTruthy();
    expect(pending.mfa_pending_enc).not.toContain(setup.body.secret);
    expect(pending.mfa_enabled_at).toBeNull();

    const wrong = await request(app).post('/v1/auth/mfa/setup/confirm').send({ mfa_token, code: '000000' === codeAt(setup.body.secret) ? '111111' : '000000' });
    expect(wrong.status).toBe(403);

    const done = await request(app).post('/v1/auth/mfa/setup/confirm').send({ mfa_token, code: codeAt(setup.body.secret) });
    expect(done.status).toBe(200);
    expect(done.body.user).toMatchObject({ id: admin.id, role: 'administrator' });
    expect(jwt.decode(done.body.token).mfa).toBe(true);
    expect(done.headers['set-cookie'].join(';')).toMatch(/oscar_session=/);
    const on = row(admin.id);
    expect(on.mfa_enabled_at).toBeTruthy();
    expect(on.mfa_pending_enc).toBeNull();
    expect(on.mfa_secret_enc).not.toContain(setup.body.secret);
    expect(events(admin.id, 'mfa_enabled')).toBe(1);
    expect((await meMfa(done.body.token)).body).toMatchObject({ enabled: true, required: true });
  });

  test('an administrator cannot turn the factor off; another administrator resets it', async () => {
    const admin = addUser('administrator');
    const { secret, token } = await setUpAdministrator(admin);
    const off = await request(app).delete('/v1/me/mfa').set('Authorization', `Bearer ${token}`)
      .send({ password: PASSWORD, code: codeAt(secret, 1) });
    expect(off.status).toBe(403);
    expect(row(admin.id).mfa_enabled_at).toBeTruthy();
  });
});

describe('an account whose factor is on', () => {
  test('signs in with the password, then a code; a code is never accepted twice', async () => {
    const admin = addUser('administrator');
    const { secret } = await setUpAdministrator(admin);
    const first = await signIn(admin);
    expect(first.body).toEqual({ mfa: 'verify', mfa_token: expect.any(String) });
    const used = T.stepAt(Date.now());
    const replay = await request(app).post('/v1/auth/mfa/verify').send({ mfa_token: first.body.mfa_token, code: T.hotp(T.base32Decode(secret), row(admin.id).mfa_last_step) });
    expect(replay.status).toBe(403);
    const ok = await request(app).post('/v1/auth/mfa/verify').send({ mfa_token: first.body.mfa_token, code: codeAt(secret, 1) });
    expect(ok.status).toBe(200);
    expect(jwt.decode(ok.body.token).mfa).toBe(true);
    expect(row(admin.id).mfa_last_step).toBeGreaterThanOrEqual(used);
  });

  test('a session that did not go through the factor is refused at every request', async () => {
    const admin = addUser('administrator');
    await setUpAdministrator(admin);
    expect((await meMfa(sessionOf(admin))).status).toBe(401);
    expect((await meMfa(sessionOf(admin, { mfa: true }))).status).toBe(200);
  });

  test('ten wrong codes stop the account\'s codes, the right one included', async () => {
    const admin = addUser('administrator');
    const { secret } = await setUpAdministrator(admin);
    const { body: { mfa_token } } = await signIn(admin);
    const right = codeAt(secret, 1);
    const wrongCode = right === '123456' ? '654321' : '123456';
    for (let i = 0; i < 10; i++) {
      expect((await request(app).post('/v1/auth/mfa/verify').send({ mfa_token, code: wrongCode })).status).toBe(403);
    }
    const locked = await request(app).post('/v1/auth/mfa/verify').send({ mfa_token, code: right });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    expect(row(admin.id).mfa_last_step).not.toBe(T.stepAt(Date.now()) + 1);
  });

  test('a code that is not six digits does not count against the account', async () => {
    const admin = addUser('administrator');
    const { secret } = await setUpAdministrator(admin);
    const { body: { mfa_token } } = await signIn(admin);
    const res = await request(app).post('/v1/auth/mfa/verify').send({ mfa_token, code: '12ab' });
    expect(res.status).toBe(400);
    expect(row(admin.id).mfa_failures).toBe(0);
    expect((await request(app).post('/v1/auth/mfa/verify').send({ mfa_token, code: codeAt(secret, 1) })).status).toBe(200);
  });
});

describe('the challenge of a sign-in', () => {
  test('is never a session, and a session is never a challenge', async () => {
    const admin = addUser('administrator');
    const { body: { mfa_token } } = await signIn(admin);
    expect((await meMfa(mfa_token)).status).toBe(401);
    const asChallenge = await request(app).post('/v1/auth/mfa/setup').send({ mfa_token: sessionOf(admin) });
    expect(asChallenge.status).toBe(401);
    // Signed with the session secret itself, it is refused as well.
    const forged = jwt.sign({ sub: admin.id, purpose: 'setup', jti: randomUUID() }, process.env.JWT_SECRET, { audience: 'oscar-mfa', expiresIn: '5m' });
    expect((await request(app).post('/v1/auth/mfa/setup').send({ mfa_token: forged })).status).toBe(401);
  });

  test('is for one step: a set-up challenge does not verify, a verify challenge does not set up', async () => {
    const admin = addUser('administrator');
    const { secret } = await setUpAdministrator(admin);
    const verifying = (await signIn(admin)).body.mfa_token;
    expect((await request(app).post('/v1/auth/mfa/setup').send({ mfa_token: verifying })).status).toBe(401);
    expect((await request(app).post('/v1/auth/mfa/setup/confirm').send({ mfa_token: verifying, code: codeAt(secret, 1) })).status).toBe(401);
    const other = addUser('administrator');
    const settingUp = (await signIn(other)).body.mfa_token;
    expect((await request(app).post('/v1/auth/mfa/verify').send({ mfa_token: settingUp, code: '123456' })).status).toBe(401);
  });

  test('ends with the account\'s sessions', async () => {
    const admin = addUser('administrator');
    const { secret } = await setUpAdministrator(admin);
    const { body: { mfa_token } } = await signIn(admin);
    run("UPDATE users SET sessions_valid_after = CAST(strftime('%s','now') AS INTEGER) + 1 WHERE id = ?", [admin.id]);
    expect((await request(app).post('/v1/auth/mfa/verify').send({ mfa_token, code: codeAt(secret, 1) })).status).toBe(401);
  });
});

describe('an account that may turn the factor on', () => {
  test('signs in with its password alone until it does', async () => {
    const tester = addUser('company_user');
    const res = await signIn(tester);
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(jwt.decode(res.body.token).mfa).toBeUndefined();
    expect((await meMfa(res.body.token)).body).toEqual({ enabled: false, required: false, enabled_at: null });
  });

  test('turns it on with its password and a first code; its other sessions end', async () => {
    const tester = addUser('company_user');
    const before = sessionOf(tester);
    const refused = await request(app).post('/v1/me/mfa/setup').set('Authorization', `Bearer ${before}`).send({ password: 'not-the-password' });
    expect(refused.status).toBe(403);
    const setup = await request(app).post('/v1/me/mfa/setup').set('Authorization', `Bearer ${before}`).send({ password: PASSWORD });
    expect(setup.status).toBe(200);
    await nextSecond();
    const on = await request(app).post('/v1/me/mfa/confirm').set('Authorization', `Bearer ${before}`).send({ code: codeAt(setup.body.secret) });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ enabled: true, required: false });
    expect(jwt.decode(on.body.token).mfa).toBe(true);
    expect((await meMfa(before)).status).toBe(401);
    expect((await meMfa(on.body.token)).status).toBe(200);
    expect((await signIn(tester)).body.mfa).toBe('verify');
    expect(events(tester.id, 'mfa_enabled')).toBe(1);
  });

  test('turns it off with its password and a code; the sign-in asks the password only again', async () => {
    const tester = addUser('company_user');
    const setup = await request(app).post('/v1/me/mfa/setup').set('Authorization', `Bearer ${sessionOf(tester)}`).send({ password: PASSWORD });
    const on = await request(app).post('/v1/me/mfa/confirm').set('Authorization', `Bearer ${sessionOf(tester)}`).send({ code: codeAt(setup.body.secret) });
    const token = on.body.token;
    const badCode = await request(app).delete('/v1/me/mfa').set('Authorization', `Bearer ${token}`).send({ password: PASSWORD, code: '999999' === codeAt(setup.body.secret, 1) ? '888888' : '999999' });
    expect(badCode.status).toBe(403);
    await nextSecond();
    const off = await request(app).delete('/v1/me/mfa').set('Authorization', `Bearer ${token}`).send({ password: PASSWORD, code: codeAt(setup.body.secret, 1) });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ enabled: false });
    expect((await meMfa(token)).status).toBe(401);
    expect((await meMfa(off.body.token)).status).toBe(200);
    expect((await signIn(tester)).body.token).toBeTruthy();
    expect(row(tester.id).mfa_secret_enc).toBeNull();
  });
});

describe("an administrator's reset", () => {
  test('removes the factor, ends the sessions and is audited', async () => {
    const admin = addUser('administrator');
    const tester = addUser('company_user');
    const setup = await request(app).post('/v1/me/mfa/setup').set('Authorization', `Bearer ${sessionOf(tester)}`).send({ password: PASSWORD });
    const on = await request(app).post('/v1/me/mfa/confirm').set('Authorization', `Bearer ${sessionOf(tester)}`).send({ code: codeAt(setup.body.secret) });
    await nextSecond();
    const res = await request(app).post(`/v1/admin/users/${tester.id}/mfa/reset`).set('Authorization', `Bearer ${sessionOf(admin)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: tester.id, email: tester.email, mfa_reset: true });
    expect(row(tester.id).mfa_enabled_at).toBeNull();
    expect((await meMfa(on.body.token)).status).toBe(401);
    expect(get('SELECT COUNT(*) AS n FROM auth_events WHERE user_id = ? AND event_type = ?', [admin.id, `mfa_reset:${tester.email}`]).n).toBe(1);
    expect((await request(app).post(`/v1/admin/users/${tester.id}/mfa/reset`).set('Authorization', `Bearer ${sessionOf(admin)}`)).status).toBe(409);
    expect((await request(app).post(`/v1/admin/users/${randomUUID()}/mfa/reset`).set('Authorization', `Bearer ${sessionOf(admin)}`)).status).toBe(404);
  });

  test('is for administrators only', async () => {
    const tester = addUser('company_user');
    const manager = addUser('test_manager');
    const res = await request(app).post(`/v1/admin/users/${tester.id}/mfa/reset`).set('Authorization', `Bearer ${sessionOf(manager)}`);
    expect(res.status).toBe(403);
  });

  test('the users list says who has a factor', async () => {
    const admin = addUser('administrator');
    const other = addUser('administrator');
    await setUpAdministrator(other);
    const list = await request(app).get('/v1/admin/users').query({ q: other.email }).set('Authorization', `Bearer ${sessionOf(admin)}`);
    expect(list.body.users.find(u => u.id === other.id).mfa_enabled).toBe(true);
  });
});

describe('the command for the last administrator', () => {
  const lines = [];
  const log = line => lines.push(line);

  test('removes the factor of the account named, and ends its sessions', async () => {
    const admin = addUser('administrator');
    const { token } = await setUpAdministrator(admin);
    await nextSecond();
    expect(resetCommand([admin.email.toUpperCase()], { log })).toBe(0);
    expect(lines.at(-1)).toMatch(/second factor removed; every session of the account ended; a new one is set up at the next sign-in/);
    const after = row(admin.id);
    expect([after.mfa_secret_enc, after.mfa_enabled_at, after.mfa_last_step]).toEqual([null, null, null]);
    expect((await meMfa(token)).status).toBe(401);
    expect(events(admin.id, 'mfa_reset_by_command')).toBe(1);
    expect((await signIn(admin)).body.mfa).toBe('setup');
  });

  test('says what is wrong with its arguments or the account', () => {
    expect(resetCommand([], { log })).toBe(2);
    expect(resetCommand(['a@b.example', 'extra'], { log })).toBe(2);
    expect(resetCommand(['nobody@two-factor.example'], { log })).toBe(1);
    expect(lines.at(-1)).toMatch(/no account with the e-mail/);
    expect(resetCommand(['a@b.example'], { log, file: 'C:/no/such/oscar.db' })).toBe(1);
  });
});

describe('/v1/auth/me', () => {
  test('says whether the factor is on and required', async () => {
    const admin = addUser('administrator');
    const { token } = await setUpAdministrator(admin);
    const me = await request(app).get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.body.user.mfa).toMatchObject({ enabled: true, required: true });
    expect(me.body.user.mfa_secret_enc).toBeUndefined();
  });
});
