// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #930: the accounts kept in a data folder and the administration API that
// changes them while the simulator runs.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { SECRETS, REAL_SECRETS, PROVIDERS_DIR, tempDir, writeClientsFile, basic, call, offerRequest, bookingRequest } = require('./helpers');
const { ConfigError, loadProviders } = require('../src/config');
const { createAccounts, ACCOUNTS_FILE, AUDIT_FILE } = require('../src/accounts');
const { createAdmin, hashPassword, passwordMatches, COOKIE } = require('../src/admin');
const { createTokenService } = require('../src/tokens');
const { createStore } = require('../src/store');
const { createApp } = require('../src/app');
const { start } = require('../server');
const { changeAdmins } = require('../scripts/make-admin');

const providers = loadProviders(PROVIDERS_DIR);
const PASSWORD = 'correct-horse-battery-staple-0123';

async function writeAdmins(dir, list) {
  const admins = [];
  for (const [name, password] of list) admins.push({ name, password: await hashPassword(password) });
  fs.writeFileSync(path.join(dir, 'admins.json'), JSON.stringify({ format: 1, admins }));
}

// A simulator on a data folder, with an administrator "ada", and its clock.
async function startWithData({ dataDir = tempDir(), clientsFile = writeClientsFile(REAL_SECRETS), admins = [['ada', PASSWORD]] } = {}) {
  if (admins.length) await writeAdmins(dataDir, admins);
  const clock = { ms: Date.parse('2026-11-02T09:00:00Z') };
  const now = () => clock.ms;
  const accounts = createAccounts({ dataDir, providers, clientsFile, now });
  const limits = { bodyBytes: 64 * 1024, offersPerClient: 50, bookingsPerClient: 5, ttlSeconds: 3600, requestsPerMinute: 10000 };
  const app = createApp({
    providers,
    clients: accounts.clients,
    accounts,
    admin: createAdmin({ dataDir, accounts, now }),
    tokens: createTokenService({ now }),
    store: createStore({ limits: { offer: 50, trip: 50, booking: 5, fulfillment: 50, idempotency: 50 }, ttlMs: 3600000, now }),
    limits,
    now,
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  server.on('connection', (socket) => socket.unref());
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, clock, dataDir, accounts,
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
  };
}

async function request(base, method, url, { cookie, csrf, body, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.Cookie = cookie;
  if (csrf) h['X-CSRF-Token'] = csrf;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
}

async function signIn(base, name = 'ada', password = PASSWORD) {
  const res = await request(base, 'POST', '/admin/api/login', { body: { name, password } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return { cookie, csrf: res.body.csrfToken, setCookie: res.headers.get('set-cookie') };
}

async function tokenWith(base, provider, id, secret) {
  const res = await fetch(`${base}/${provider}/oauth/token`, {
    method: 'POST',
    headers: { Authorization: basic({ client_id: id, client_secret: secret }), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  return { status: res.status, token: (await res.json()).access_token };
}

const versions = (base, provider, token) => call(base, token, 'GET', `/${provider}/versions`);

test('the first start with a data folder imports the clients file: digests only, one audit line', async () => {
  const dataDir = tempDir();
  const clientsFile = writeClientsFile(REAL_SECRETS);
  const accounts = createAccounts({ dataDir, providers, clientsFile, now: () => Date.parse('2026-11-02T09:00:00Z') });
  const total = Object.values(REAL_SECRETS).reduce((n, list) => n + list.length, 0);
  assert.equal(accounts.imported, total);
  assert.equal(accounts.count(), total);
  const text = fs.readFileSync(path.join(dataDir, ACCOUNTS_FILE), 'utf8');
  for (const list of Object.values(REAL_SECRETS)) for (const c of list) assert.equal(text.includes(c.client_secret), false);
  assert.equal(fs.statSync(path.join(dataDir, ACCOUNTS_FILE)).mode & 0o777, 0o600);
  assert.deepEqual(accounts.auditTail().map((e) => e.action), ['imported_clients_file']);
  // The next start reads the data folder and leaves the clients file alone,
  // even when it has changed since.
  fs.writeFileSync(clientsFile, JSON.stringify({ alpha: [SECRETS.alpha[0]] }));
  const again = createAccounts({ dataDir, providers, clientsFile });
  assert.equal(again.imported, null);
  assert.equal(again.count(), total);
});

test('a data folder that is missing stops the start with a message', () => {
  const missing = path.join(tempDir(), 'none');
  assert.throws(() => createAccounts({ dataDir: missing, providers }), (e) => e instanceof ConfigError && /does not exist/.test(e.message));
});

test('an accounts file that is wrong stops the start', () => {
  const cases = [
    ['{', /not valid JSON/],
    [JSON.stringify({ format: 2, providers: {} }), /format 1/],
    [JSON.stringify({ format: 1, providers: { nobody: [] } }), /unknown provider/],
    [JSON.stringify({ format: 1, providers: { alpha: [{ clientId: 'a:b', secretSha256: '0'.repeat(64), createdAt: 1 }] } }), /not valid/],
    [JSON.stringify({ format: 1, providers: { alpha: [{ clientId: 'abc', secretSha256: 'x', createdAt: 1 }] } }), /not valid/],
    [JSON.stringify({ format: 1, providers: { alpha: [1, 2].map(() => ({ clientId: 'abc', secretSha256: '0'.repeat(64), createdAt: 1 })) } }), /twice/],
  ];
  for (const [content, message] of cases) {
    const dataDir = tempDir();
    fs.writeFileSync(path.join(dataDir, ACCOUNTS_FILE), content);
    assert.throws(() => createAccounts({ dataDir, providers }), (e) => e instanceof ConfigError && message.test(e.message));
  }
});

test('with a data folder the server needs accounts or an administrator, and names what it did', async (t) => {
  const empty = tempDir();
  assert.throws(() => start({ SIM_PORT: '0', SIM_DATA_DIR: empty, SIM_CLIENTS_FILE: path.join(empty, 'none.json') }), /no account and no administrator/);
  const dataDir = tempDir();
  await writeAdmins(dataDir, [['ada', PASSWORD]]);
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  const server = start({ SIM_PORT: '0', SIM_DATA_DIR: dataDir, SIM_CLIENTS_FILE: writeClientsFile(REAL_SECRETS) });
  await new Promise((resolve) => server.on('listening', resolve));
  server.close();
  assert.ok(lines.some((l) => /^Imported \d+ accounts from /.test(l)), lines.join('\n'));
});

test('"admin" cannot be a provider key', () => {
  const { checkProvider } = require('../src/config');
  assert.throws(() => checkProvider('admin', {}), /not a usable provider key/);
});

test('without a data folder there is no administration API: /admin is a 404 like any unknown path', async () => {
  const { startSimulator } = require('./helpers');
  const sim = await startSimulator();
  try {
    assert.equal((await request(sim.base, 'POST', '/admin/api/login', { body: { name: 'ada', password: PASSWORD } })).status, 404);
  } finally {
    await sim.close();
  }
});

test('a sign-in gives a strict session cookie and a CSRF token; a wrong one gives neither', async () => {
  const sim = await startWithData();
  try {
    for (const body of [{ name: 'ada', password: 'wrong' }, { name: 'nobody', password: PASSWORD }, {}, { name: ['ada'], password: PASSWORD }]) {
      const refused = await request(sim.base, 'POST', '/admin/api/login', { body });
      assert.equal(refused.status, 401);
      assert.equal(refused.headers.get('set-cookie'), null);
    }
    const { cookie, csrf, setCookie } = await signIn(sim.base);
    assert.match(setCookie, new RegExp(`^${COOKIE}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800$`));
    assert.match(csrf, /^[A-Za-z0-9_-]{43}$/);
    const session = await request(sim.base, 'GET', '/admin/api/session', { cookie });
    assert.deepEqual(session.body, { name: 'ada', csrfToken: csrf });
    assert.equal((await request(sim.base, 'GET', '/admin/api/session')).status, 401);
    assert.equal((await request(sim.base, 'GET', '/admin/api/session', { cookie: `${COOKIE}=forged` })).status, 401);
    // A JSON body only: a form post from another site cannot sign in.
    const form = await fetch(`${sim.base}/admin/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'name=ada' });
    assert.equal(form.status, 415);
  } finally {
    await sim.close();
  }
});

test('an OSDM token does not open the administration API, and a session does not open the OSDM API', async () => {
  const sim = await startWithData();
  try {
    const { token } = await tokenWith(sim.base, 'alpha', SECRETS.alpha[0].client_id, SECRETS.alpha[0].client_secret);
    const res = await fetch(`${sim.base}/admin/api/accounts`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 401);
    const { cookie } = await signIn(sim.base);
    assert.equal((await request(sim.base, 'GET', '/alpha/versions', { cookie })).status, 401);
  } finally {
    await sim.close();
  }
});

test('failed sign-ins are limited per address: the eleventh is refused even with the right password', async () => {
  const sim = await startWithData();
  try {
    for (let i = 0; i < 10; i += 1) {
      assert.equal((await request(sim.base, 'POST', '/admin/api/login', { body: { name: `x${i}x`, password: 'wrong' } })).status, 401);
    }
    const blocked = await request(sim.base, 'POST', '/admin/api/login', { body: { name: 'ada', password: PASSWORD } });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('retry-after'), '900');
    sim.clock.ms += 15 * 60 * 1000;
    await signIn(sim.base);
  } finally {
    await sim.close();
  }
});

test('a change needs the session\'s CSRF token and this origin', async () => {
  const sim = await startWithData();
  try {
    const { cookie, csrf } = await signIn(sim.base);
    assert.equal((await request(sim.base, 'POST', '/admin/api/accounts/alpha', { cookie, body: {} })).status, 403);
    assert.equal((await request(sim.base, 'POST', '/admin/api/accounts/alpha', { cookie, csrf: 'x'.repeat(43), body: {} })).status, 403);
    const foreign = await request(sim.base, 'POST', '/admin/api/accounts/alpha', { cookie, csrf, body: {}, headers: { Origin: 'https://elsewhere.example' } });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.body.code, 'FOREIGN_ORIGIN');
    assert.equal((await request(sim.base, 'DELETE', `/admin/api/accounts/alpha/${SECRETS.alpha[0].client_id}`, { cookie })).status, 403);
    assert.equal((await request(sim.base, 'POST', '/admin/api/logout', { cookie })).status, 403);
    // Nothing changed.
    assert.equal(sim.accounts.count(), Object.values(REAL_SECRETS).reduce((n, l) => n + l.length, 0));
    const same = await request(sim.base, 'POST', '/admin/api/accounts/alpha', { cookie, csrf, body: {}, headers: { Origin: sim.base } });
    assert.equal(same.status, 201);
  } finally {
    await sim.close();
  }
});

test('the accounts list names every provider and account, never a secret or a digest', async () => {
  const sim = await startWithData();
  try {
    const { cookie } = await signIn(sim.base);
    await tokenWith(sim.base, 'beta', SECRETS.beta[0].client_id, SECRETS.beta[0].client_secret);
    const { body } = await request(sim.base, 'GET', '/admin/api/accounts', { cookie });
    assert.deepEqual(body.providers.map((p) => p.provider), [...providers.keys()]);
    const beta = body.providers.find((p) => p.provider === 'beta');
    assert.equal(beta.osdmVersion, '3.7.0');
    assert.deepEqual(beta.accounts.map((a) => a.clientId), ['beta-one', 'same-id']);
    assert.equal(beta.accounts[0].lastTokenAt, '2026-11-02T09:00:00.000Z');
    assert.equal(beta.accounts[1].lastTokenAt, null);
    const text = JSON.stringify(body);
    for (const list of Object.values(REAL_SECRETS)) for (const c of list) assert.equal(text.includes(c.client_secret), false);
    assert.equal(/[0-9a-f]{64}/.test(text), false);
  } finally {
    await sim.close();
  }
});

test('an added account works at once; its secret is answered once and stored as a digest', async () => {
  const sim = await startWithData();
  try {
    const { cookie, csrf } = await signIn(sim.base);
    const named = await request(sim.base, 'POST', '/admin/api/accounts/gamma', { cookie, csrf, body: { clientId: 'gamma.partner' } });
    assert.equal(named.status, 201);
    assert.equal(named.body.clientId, 'gamma.partner');
    assert.match(named.body.clientSecret, /^[0-9a-f]{64}$/);
    const { status, token } = await tokenWith(sim.base, 'gamma', 'gamma.partner', named.body.clientSecret);
    assert.equal(status, 200);
    assert.equal((await versions(sim.base, 'gamma', token)).status, 200);
    // Named in the make-clients.js way when no id is given.
    const t1 = await request(sim.base, 'POST', '/admin/api/accounts/gamma', { cookie, csrf, body: {} });
    const m1 = await request(sim.base, 'POST', '/admin/api/accounts/gamma', { cookie, csrf, body: { kind: 'tstmgr' } });
    const t2 = await request(sim.base, 'POST', '/admin/api/accounts/gamma', { cookie, csrf });
    assert.deepEqual([t1.body.clientId, m1.body.clientId, t2.body.clientId], ['gamma.tst01', 'gamma.tstmgr01', 'gamma.tst02']);
    // Kept across a restart, as digests.
    const text = fs.readFileSync(path.join(sim.dataDir, ACCOUNTS_FILE), 'utf8');
    assert.equal(text.includes(named.body.clientSecret), false);
    const reread = createAccounts({ dataDir: sim.dataDir, providers });
    assert.ok(reread.clients.get('gamma').has('gamma.partner'));
  } finally {
    await sim.close();
  }
});

test('an account that cannot be made is refused, and nothing is written', async () => {
  const sim = await startWithData();
  try {
    const { cookie, csrf } = await signIn(sim.base);
    const before = fs.readFileSync(path.join(sim.dataDir, ACCOUNTS_FILE), 'utf8');
    const cases = [
      ['/admin/api/accounts/alpha', { clientId: 'alpha-one' }, 409, 'ACCOUNT_EXISTS'],
      ['/admin/api/accounts/alpha', { clientId: 'has:colon' }, 400, 'INVALID_CLIENT_ID'],
      ['/admin/api/accounts/alpha', { clientId: 'a b c' }, 400, 'INVALID_CLIENT_ID'],
      ['/admin/api/accounts/alpha', { clientId: 42 }, 400, 'INVALID_CLIENT_ID'],
      ['/admin/api/accounts/alpha', { kind: 'root' }, 400, 'INVALID_KIND'],
      ['/admin/api/accounts/nobody', {}, 404, 'UNKNOWN_PROVIDER'],
      ['/admin/api/accounts/plain', {}, 404, 'UNKNOWN_PROVIDER'],
    ];
    for (const [url, body, status, code] of cases) {
      const res = await request(sim.base, 'POST', url, { cookie, csrf, body });
      assert.equal(res.status, status, `${url} ${JSON.stringify(body)}`);
      assert.equal(res.body.code, code);
    }
    assert.equal((await request(sim.base, 'DELETE', '/admin/api/accounts/alpha/nobody', { cookie, csrf })).status, 404);
    assert.equal((await request(sim.base, 'POST', '/admin/api/accounts/alpha/nobody/reset-secret', { cookie, csrf })).status, 404);
    assert.equal(fs.readFileSync(path.join(sim.dataDir, ACCOUNTS_FILE), 'utf8'), before);
  } finally {
    await sim.close();
  }
});

test('a reset secret ends the old secret and its tokens; the other accounts and their bookings stay', async () => {
  const sim = await startWithData();
  try {
    const { cookie, csrf } = await signIn(sim.base);
    const [one, two] = SECRETS.alpha;
    const oldToken = (await tokenWith(sim.base, 'alpha', one.client_id, one.client_secret)).token;
    const otherToken = (await tokenWith(sim.base, 'alpha', two.client_id, two.client_secret)).token;
    const offers = (await call(sim.base, otherToken, 'POST', '/alpha/offers', offerRequest())).body.offers;
    const booking = (await call(sim.base, otherToken, 'POST', '/alpha/bookings', bookingRequest(offers[0]))).body.booking;
    const reset = await request(sim.base, 'POST', `/admin/api/accounts/alpha/${one.client_id}/reset-secret`, { cookie, csrf });
    assert.equal(reset.status, 200);
    assert.notEqual(reset.body.clientSecret, one.client_secret);
    // Same clock millisecond: the tag of the secret, not the time, ends the old token.
    assert.equal((await versions(sim.base, 'alpha', oldToken)).status, 401);
    assert.equal((await tokenWith(sim.base, 'alpha', one.client_id, one.client_secret)).status, 401);
    const fresh = await tokenWith(sim.base, 'alpha', one.client_id, reset.body.clientSecret);
    assert.equal((await versions(sim.base, 'alpha', fresh.token)).status, 200);
    assert.equal((await versions(sim.base, 'alpha', otherToken)).status, 200);
    assert.equal((await call(sim.base, otherToken, 'GET', `/alpha/bookings/${booking.id}`)).status, 200);
  } finally {
    await sim.close();
  }
});

test('a deleted account loses its tokens, and an account made again with its id does not get them back', async () => {
  const sim = await startWithData();
  try {
    const { cookie, csrf } = await signIn(sim.base);
    const { client_id: id, client_secret: secret } = SECRETS.gamma[0];
    const token = (await tokenWith(sim.base, 'gamma', id, secret)).token;
    const deleted = await request(sim.base, 'DELETE', `/admin/api/accounts/gamma/${id}`, { cookie, csrf });
    assert.deepEqual(deleted.body, { provider: 'gamma', clientId: id, deleted: true });
    assert.equal((await versions(sim.base, 'gamma', token)).status, 401);
    assert.equal((await tokenWith(sim.base, 'gamma', id, secret)).status, 401);
    const again = await request(sim.base, 'POST', '/admin/api/accounts/gamma', { cookie, csrf, body: { clientId: id } });
    assert.equal(again.status, 201);
    assert.equal((await versions(sim.base, 'gamma', token)).status, 401);
    // The same id on another provider is another account, untouched.
    const beta = await tokenWith(sim.base, 'beta', 'same-id', SECRETS.beta[1].client_secret);
    await request(sim.base, 'DELETE', '/admin/api/accounts/alpha/same-id', { cookie, csrf });
    assert.equal((await versions(sim.base, 'beta', beta.token)).status, 200);
  } finally {
    await sim.close();
  }
});

test('every change is in the audit, with who made it, and no secret', async () => {
  const sim = await startWithData();
  try {
    const { cookie, csrf } = await signIn(sim.base);
    await request(sim.base, 'POST', '/admin/api/login', { body: { name: 'ada', password: 'wrong' } });
    const added = await request(sim.base, 'POST', '/admin/api/accounts/beta', { cookie, csrf, body: { clientId: 'beta.new' } });
    const reset = await request(sim.base, 'POST', '/admin/api/accounts/beta/beta.new/reset-secret', { cookie, csrf });
    await request(sim.base, 'DELETE', '/admin/api/accounts/beta/beta.new', { cookie, csrf });
    const { body } = await request(sim.base, 'GET', '/admin/api/audit', { cookie });
    assert.deepEqual(body.entries.map((e) => [e.action, e.by]), [
      ['account_deleted', 'ada'], ['secret_reset', 'ada'], ['account_added', 'ada'],
      ['sign_in_refused', 'ada'], ['signed_in', 'ada'], ['imported_clients_file', 'system'],
    ]);
    assert.equal(body.entries[0].clientId, 'beta.new');
    const text = fs.readFileSync(path.join(sim.dataDir, AUDIT_FILE), 'utf8');
    for (const s of [added.body.clientSecret, reset.body.clientSecret, PASSWORD, 'wrong']) assert.equal(text.includes(s), false);
  } finally {
    await sim.close();
  }
});

test('the administrators are read at each sign-in: one added runs at once, one removed is signed out', async () => {
  const sim = await startWithData();
  try {
    const ada = await signIn(sim.base);
    const password = await changeAdmins(sim.dataDir, 'add', 'bob');
    const bob = await signIn(sim.base, 'bob', password);
    await changeAdmins(sim.dataDir, 'remove', 'ada');
    assert.equal((await request(sim.base, 'GET', '/admin/api/accounts', { cookie: ada.cookie })).status, 401);
    assert.equal((await request(sim.base, 'GET', '/admin/api/accounts', { cookie: bob.cookie })).status, 200);
    const newPassword = await changeAdmins(sim.dataDir, 'reset', 'bob');
    assert.equal((await request(sim.base, 'POST', '/admin/api/login', { body: { name: 'bob', password } })).status, 401);
    await signIn(sim.base, 'bob', newPassword);
  } finally {
    await sim.close();
  }
});

test('a session ends after 30 idle minutes, after 8 hours in any case, and at sign-out', async () => {
  const sim = await startWithData();
  try {
    let s = await signIn(sim.base);
    sim.clock.ms += 29 * 60 * 1000;
    assert.equal((await request(sim.base, 'GET', '/admin/api/session', { cookie: s.cookie })).status, 200);
    sim.clock.ms += 31 * 60 * 1000;
    assert.equal((await request(sim.base, 'GET', '/admin/api/session', { cookie: s.cookie })).status, 401);
    s = await signIn(sim.base);
    for (let i = 0; i < 17; i += 1) {
      sim.clock.ms += 29 * 60 * 1000;
      await request(sim.base, 'GET', '/admin/api/session', { cookie: s.cookie });
    }
    assert.equal((await request(sim.base, 'GET', '/admin/api/session', { cookie: s.cookie })).status, 401);
    s = await signIn(sim.base);
    const out = await request(sim.base, 'POST', '/admin/api/logout', { cookie: s.cookie, csrf: s.csrf });
    assert.equal(out.status, 200);
    assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await request(sim.base, 'GET', '/admin/api/session', { cookie: s.cookie })).status, 401);
  } finally {
    await sim.close();
  }
});

test('the routes answer 404 and 405 like the rest of the simulator', async () => {
  const sim = await startWithData();
  try {
    const { cookie, csrf } = await signIn(sim.base);
    assert.equal((await request(sim.base, 'GET', '/admin', { cookie })).status, 404);
    assert.equal((await request(sim.base, 'GET', '/admin/api/nothing', { cookie })).status, 404);
    assert.equal((await request(sim.base, 'GET', '/admin/api/login')).status, 405);
    assert.equal((await request(sim.base, 'PUT', '/admin/api/accounts', { cookie, csrf })).status, 405);
    assert.equal((await request(sim.base, 'GET', '/admin/api/accounts/alpha/alpha-one/reset-secret', { cookie })).status, 405);
    assert.equal((await request(sim.base, 'POST', '/admin/api/accounts/alpha/alpha-one/other', { cookie, csrf })).status, 404);
  } finally {
    await sim.close();
  }
});

test('passwords are kept as scrypt digests that only the password matches', async () => {
  const stored = await hashPassword(PASSWORD);
  assert.match(stored, /^scrypt:16384:8:1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
  assert.equal(stored.includes(PASSWORD), false);
  assert.equal(await passwordMatches(stored, PASSWORD), true);
  assert.equal(await passwordMatches(stored, `${PASSWORD}x`), false);
  assert.equal(await passwordMatches(undefined, PASSWORD), false);
  assert.equal(await passwordMatches('scrypt:1:1:1:AAAA:AAAA', PASSWORD), false);
  assert.notEqual(await hashPassword(PASSWORD), stored);
});

test('make-admin refuses a bad name, a second add, a reset or removal of no one; it writes for its owner only', async () => {
  const dir = path.join(tempDir(), 'data');
  await assert.rejects(changeAdmins(dir, 'add', 'x'), /A name is/);
  await assert.rejects(changeAdmins(dir, 'add', '../etc'), /A name is/);
  const password = await changeAdmins(dir, 'add', 'ada');
  assert.match(password, /^[A-Za-z0-9_-]{32}$/);
  await assert.rejects(changeAdmins(dir, 'add', 'ada'), /already an administrator/);
  await assert.rejects(changeAdmins(dir, 'reset', 'bob'), /not an administrator/);
  await assert.rejects(changeAdmins(dir, 'remove', 'bob'), /not an administrator/);
  const file = path.join(dir, 'admins.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, 'utf8').includes(password), false);
  assert.equal(await changeAdmins(dir, 'remove', 'ada'), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).admins, []);
});
