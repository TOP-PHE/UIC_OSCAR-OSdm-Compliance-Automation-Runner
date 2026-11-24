// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * login-lock.test.js — the sign-in's lock per e-mail address (#1421): ten
 * wrong passwords lock the address, the right one is refused while it lasts,
 * an address without an account answers the same, the owner gets one e-mail,
 * a password reset lifts it, and a series doubles. The rules alone are
 * unit/login-lock.test.js.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-login-lock';
// Many sign-ins from one address: the limit per address is not what this file tests.
process.env.AUTH_RATE_LIMIT_MAX = '1000';
// Each test signs in ten to twenty times, each a bcrypt check: on a busy
// machine that is more than Jest's default 10 seconds.
jest.setTimeout(60_000);

jest.mock('../../src/utils/mailer', () => ({
  ...jest.requireActual('../../src/utils/mailer'),
  sendAccountNotice: jest.fn(() => Promise.resolve({ devMode: true })),
}));

const express = require('express');
const bcrypt  = require('bcrypt');
const request = require('supertest');
const { randomUUID } = require('node:crypto');
const { run, get, all } = require('../../src/db/db');
const { sendAccountNotice } = require('../../src/utils/mailer');
const LoginLock = require('../../src/api/helpers/loginLock');

const app = express();
app.use(express.json());
app.use('/v1/auth', require('../../src/api/routes/auth'));
app.use((err, req, res, _next) => res.status(500).json({ status: 500, detail: err.message }));

const PASSWORD = 'Login-Lock-Pwd-1';
const COMPANY = randomUUID();

function addUser(role = 'company_user') {
  const id = randomUUID();
  const email = `${role}-${id.slice(0, 8)}@login-lock.example`;
  run('INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)',
    [id, COMPANY, email, bcrypt.hashSync(PASSWORD, 4), role]);
  return { id, email };
}

const signIn = (email, password) => request(app).post('/v1/auth/login').send({ email, password });
const lockRow = email => get('SELECT * FROM login_lock WHERE email_hash = ?', [LoginLock.keyOf(email)]);
const events = (email, type) => all('SELECT event_type FROM auth_events WHERE email = ? AND event_type LIKE ?', [email, type]).length;

async function wrongPasswords(email, n) {
  const answers = [];
  for (let i = 0; i < n; i++) answers.push(await signIn(email, `Wrong-Password-${i}`));
  return answers;
}

beforeAll(() => {
  run(`INSERT INTO companies (id, name, slug, auth_mode) VALUES (?, 'Login lock', ?, 'bearer')`, [COMPANY, `login-lock-${COMPANY.slice(0, 8)}`]);
});
beforeEach(() => sendAccountNotice.mockClear());

describe('an account', () => {
  test('nine wrong passwords answer 401; the tenth locks the address for 15 minutes (429)', async () => {
    const user = addUser();
    const answers = await wrongPasswords(user.email, 10);
    expect(answers.slice(0, 9).map(r => r.status)).toEqual(Array(9).fill(401));
    const tenth = answers[9];
    expect(tenth.status).toBe(429);
    expect(tenth.headers['retry-after']).toBe('900');
    expect(tenth.body.detail).toBe('Too many wrong passwords for this address. Sign-in is paused for 15 minutes; a password reset lifts the pause.');
    expect(events(user.email, 'login_locked:900s')).toBe(1);
  });

  test('while locked, the right password is refused too, and not checked', async () => {
    const user = addUser();
    await wrongPasswords(user.email, 10);
    const compare = jest.spyOn(bcrypt, 'compare');
    try {
      const right = await signIn(user.email, PASSWORD);
      expect(right.status).toBe(429);
      expect(Number(right.headers['retry-after'])).toBeGreaterThan(890);
      expect(right.body.token).toBeUndefined();
      expect(compare).not.toHaveBeenCalled();
    } finally {
      compare.mockRestore();
    }
    expect(events(user.email.toLowerCase(), 'login_refused_locked')).toBe(1);
  });

  test('the address is counted as the sign-in reads it, whatever its case', async () => {
    const user = addUser();
    await wrongPasswords(user.email.toUpperCase(), 10);
    expect((await signIn(user.email, PASSWORD)).status).toBe(429);
  });

  test('its owner gets one e-mail per lock, naming the wait and the reset', async () => {
    const user = addUser();
    await wrongPasswords(user.email, 12);
    expect(sendAccountNotice).toHaveBeenCalledTimes(1);
    const notice = sendAccountNotice.mock.calls[0][0];
    expect(notice.to).toBe(user.email);
    expect(notice.subject).toBe('OSCAR — sign-in to your account is paused');
    expect(notice.lines[0]).toContain('for 15 minutes, until ');
    expect(notice.url).toMatch(/\/forgot-password\.html$/);
  });

  test('a right password before the tenth clears the count', async () => {
    const user = addUser();
    await wrongPasswords(user.email, 9);
    expect((await signIn(user.email, PASSWORD)).status).toBe(200);
    expect(lockRow(user.email)).toMatchObject({ failures: 0, locked_until: 0 });
    const again = await wrongPasswords(user.email, 9);
    expect(again.map(r => r.status)).toEqual(Array(9).fill(401));
  });

  test('a password reset carried through lifts the lock', async () => {
    const user = addUser();
    await wrongPasswords(user.email, 10);
    const token = randomUUID();
    run('INSERT INTO password_reset_tokens (id, user_id, token, expires_at, requested_ip) VALUES (?, ?, ?, ?, NULL)',
      [randomUUID(), user.id, token, new Date(Date.now() + 3600_000).toISOString()]);
    const reset = await request(app).post('/v1/auth/password-reset/confirm').send({ token, password: 'Another-Pwd-123' });
    expect(reset.status).toBe(200);
    expect(lockRow(user.email)).toBeUndefined();
    expect((await signIn(user.email, 'Another-Pwd-123')).status).toBe(200);
  });

  test('a lock within 24 hours of the last one\'s end lasts twice as long', async () => {
    const user = addUser();
    await wrongPasswords(user.email, 10);
    // The first lock ended a minute ago.
    const now = Math.floor(Date.now() / 1000);
    run('UPDATE login_lock SET locked_until = ? WHERE email_hash = ?', [now - 60, LoginLock.keyOf(user.email)]);
    const answers = await wrongPasswords(user.email, 10);
    expect(answers[9].status).toBe(429);
    expect(answers[9].headers['retry-after']).toBe('1800');
    expect(answers[9].body.detail).toContain('paused for 30 minutes');
    expect(lockRow(user.email).lock_level).toBe(2);
  });

  test('a Company API account is locked like any address, with no e-mail', async () => {
    const account = addUser('api_client');
    const answers = await wrongPasswords(account.email, 10);
    expect(answers[9].status).toBe(429);
    expect(sendAccountNotice).not.toHaveBeenCalled();
  });
});

describe('an address without an account', () => {
  test('answers exactly as an account does: the same statuses, waits and words', async () => {
    const user = addUser();
    const nobody = `nobody-${randomUUID().slice(0, 8)}@login-lock.example`;
    const userAnswers = await wrongPasswords(user.email, 11);
    const nobodyAnswers = await wrongPasswords(nobody, 11);
    // The wait is compared apart: the eleventh is answered a moment after
    // the lock, and that moment may cross a second for one series only.
    const strip = r => ({ status: r.status, waits: 'retry-after' in r.headers, body: r.body });
    expect(nobodyAnswers.map(strip)).toEqual(userAnswers.map(strip));
    const waits = [userAnswers, nobodyAnswers].map(a => a.slice(9).map(r => Number(r.headers['retry-after'])));
    expect(waits[1][0]).toBe(waits[0][0]);   // the tenth: the lock's length, exactly
    expect(Math.abs(waits[1][1] - waits[0][1])).toBeLessThanOrEqual(1);
    expect(nobodyAnswers[10].status).toBe(429);
    expect(sendAccountNotice).toHaveBeenCalledTimes(1);   // the account's owner only
  });
});

describe('the table', () => {
  test('holds no address, only its SHA-256', async () => {
    const nobody = `kept-${randomUUID().slice(0, 8)}@login-lock.example`;
    await wrongPasswords(nobody, 1);
    const rows = all('SELECT * FROM login_lock');
    expect(JSON.stringify(rows)).not.toContain('@login-lock.example');
    expect(lockRow(nobody).email_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('loses the rows that no longer matter', async () => {
    const nobody = `old-${randomUUID().slice(0, 8)}@login-lock.example`;
    await wrongPasswords(nobody, 1);
    run('UPDATE login_lock SET expires_at = 1 WHERE email_hash = ?', [LoginLock.keyOf(nobody)]);
    LoginLock._resetPrune();
    await wrongPasswords(`trigger-${randomUUID().slice(0, 8)}@login-lock.example`, 1);
    expect(lockRow(nobody)).toBeUndefined();
  });
});
