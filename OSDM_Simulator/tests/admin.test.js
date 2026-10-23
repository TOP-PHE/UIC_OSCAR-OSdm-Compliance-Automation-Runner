// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #930: the accounts kept in a data folder, and the administration API the
// OSCAR server calls with its key to change them while the simulator runs.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { SECRETS, REAL_SECRETS, PROVIDERS_DIR, tempDir, writeClientsFile, basic, call, offerRequest, bookingRequest } = require('./helpers');
const { ConfigError, loadProviders, loadSettings } = require('../src/config');
const { createAccounts, ACCOUNTS_FILE, AUDIT_FILE } = require('../src/accounts');
const { createAdmin } = require('../src/admin');
const { createTokenService } = require('../src/tokens');
const { createStore } = require('../src/store');
const { createApp } = require('../src/app');
const { start } = require('../server');

const providers = loadProviders(PROVIDERS_DIR);
// The key the OSCAR server holds; the simulator only its digest.
const KEY = 'k'.repeat(20) + crypto.randomBytes(16).toString('hex');
const KEY_SHA256 = crypto.createHash('sha256').update(KEY).digest('hex');
const ACTOR = 'admin@oscar.example';

// A file's mode and text, read through one descriptor.
function modeAndText(file) {
  const fd = fs.openSync(file, 'r');
  try {
    return { mode: fs.fstatSync(fd).mode & 0o777, text: fs.readFileSync(fd, 'utf8') };
  } finally {
    fs.closeSync(fd);
  }
}

// A simulator on a data folder with the administration key, and its clock.
async function startWithData({ dataDir = tempDir(), clientsFile = writeClientsFile(REAL_SECRETS) } = {}) {
  const clock = { ms: Date.parse('2026-11-02T09:00:00Z') };
  const now = () => clock.ms;
  const accounts = createAccounts({ dataDir, providers, clientsFile, now });
  const limits = { bodyBytes: 64 * 1024, offersPerClient: 50, bookingsPerClient: 5, ttlSeconds: 3600, requestsPerMinute: 10000 };
  const app = createApp({
    providers,
    clients: accounts.clients,
    accounts,
    admin: createAdmin({ keySha256: KEY_SHA256, accounts, now }),
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

// An administration request; `key: null` sends none, `actor: null` no actor.
async function request(base, method, url, { key = KEY, actor = ACTOR, body, headers = {} } = {}) {
  const h = { ...headers };
  if (key !== null) h.Authorization = `Bearer ${key}`;
  if (actor !== null) h['X-Admin-Actor'] = actor;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
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
  const { mode, text } = modeAndText(path.join(dataDir, ACCOUNTS_FILE));
  for (const list of Object.values(REAL_SECRETS)) for (const c of list) assert.equal(text.includes(c.client_secret), false);
  assert.equal(mode, 0o600);
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

test('with a data folder the server needs accounts or the key, and names what it did', async (t) => {
  const empty = tempDir();
  assert.throws(() => start({ SIM_PORT: '0', SIM_DATA_DIR: empty, SIM_CLIENTS_FILE: path.join(empty, 'none.json') }), /no account/);
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  const keyed = start({ SIM_PORT: '0', SIM_DATA_DIR: empty, SIM_CLIENTS_FILE: path.join(empty, 'none.json'), SIM_ADMIN_KEY_SHA256: KEY_SHA256 });
  await new Promise((resolve) => keyed.on('listening', resolve));
  keyed.close();
  const server = start({ SIM_PORT: '0', SIM_DATA_DIR: tempDir(), SIM_CLIENTS_FILE: writeClientsFile(REAL_SECRETS) });
  await new Promise((resolve) => server.on('listening', resolve));
  server.close();
  assert.ok(lines.some((l) => /^Imported \d+ accounts from /.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /administration API is closed/.test(l)), lines.join('\n'));
});

test('the key setting is the SHA-256 of the key, and it needs a data folder', () => {
  assert.equal(loadSettings({ SIM_DATA_DIR: '/d', SIM_ADMIN_KEY_SHA256: KEY_SHA256.toUpperCase() }, '/b').adminKeySha256, KEY_SHA256);
  assert.equal(loadSettings({}, '/b').adminKeySha256, null);
  assert.throws(() => loadSettings({ SIM_DATA_DIR: '/d', SIM_ADMIN_KEY_SHA256: KEY }, '/b'), /64 hex characters/);
  assert.throws(() => loadSettings({ SIM_ADMIN_KEY_SHA256: KEY_SHA256 }, '/b'), /needs SIM_DATA_DIR/);
});

test('"admin" cannot be a provider key', () => {
  const { checkProvider } = require('../src/config');
  assert.throws(() => checkProvider('admin', {}), /not a usable provider key/);
});

test('without the key there is no administration API: /admin is a 404 like any unknown path', async () => {
  const { startSimulator } = require('./helpers');
  const sim = await startSimulator();
  try {
    assert.equal((await request(sim.base, 'GET', '/admin/api/accounts')).status, 404);
  } finally {
    await sim.close();
  }
});

test('only the key opens the API; an OSDM token does not, and the key does not open the OSDM API', async () => {
  const sim = await startWithData();
  try {
    for (const key of [null, '', 'wrong', `${KEY}x`, KEY.slice(1), KEY_SHA256]) {
      const res = await request(sim.base, 'GET', '/admin/api/accounts', { key });
      assert.equal(res.status, 401, String(key));
      assert.equal(res.body.code, 'ADMIN_KEY_REFUSED');
    }
    const { token } = await tokenWith(sim.base, 'alpha', SECRETS.alpha[0].client_id, SECRETS.alpha[0].client_secret);
    assert.equal((await request(sim.base, 'GET', '/admin/api/accounts', { key: token })).status, 401);
    assert.equal((await versions(sim.base, 'alpha', KEY)).status, 401);
    assert.equal((await request(sim.base, 'GET', '/admin/api/accounts')).status, 200);
  } finally {
    await sim.close();
  }
});

test('a request names its administrator in printable text', async () => {
  const sim = await startWithData();
  try {
    for (const actor of [null, '', 'a'.repeat(121), 'line\u00e9']) {
      const res = await request(sim.base, 'GET', '/admin/api/accounts', { actor });
      assert.equal(res.status, 400, JSON.stringify(actor));
      assert.equal(res.body.code, 'ADMIN_ACTOR');
    }
  } finally {
    await sim.close();
  }
});

test('wrong keys are limited per address: after ten, the right key is refused for 15 minutes', async () => {
  const sim = await startWithData();
  try {
    for (let i = 0; i < 10; i += 1) assert.equal((await request(sim.base, 'GET', '/admin/api/accounts', { key: `wrong${i}` })).status, 401);
    const blocked = await request(sim.base, 'GET', '/admin/api/accounts');
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('retry-after'), '900');
    sim.clock.ms += 15 * 60 * 1000;
    assert.equal((await request(sim.base, 'GET', '/admin/api/accounts')).status, 200);
  } finally {
    await sim.close();
  }
});

test('a body is JSON: a form post is refused', async () => {
  const sim = await startWithData();
  try {
    const res = await fetch(`${sim.base}/admin/api/accounts/alpha`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'X-Admin-Actor': ACTOR, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'clientId=alpha.form',
    });
    assert.equal(res.status, 415);
    assert.equal(sim.accounts.clients.get('alpha').has('alpha.form'), false);
  } finally {
    await sim.close();
  }
});

test('the accounts list names every provider and account, never a secret or a digest', async () => {
  const sim = await startWithData();
  try {
    await tokenWith(sim.base, 'beta', SECRETS.beta[0].client_id, SECRETS.beta[0].client_secret);
    const { body } = await request(sim.base, 'GET', '/admin/api/accounts');
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
    const named = await request(sim.base, 'POST', '/admin/api/accounts/gamma', { body: { clientId: 'gamma.partner' } });
    assert.equal(named.status, 201);
    assert.equal(named.body.clientId, 'gamma.partner');
    assert.match(named.body.clientSecret, /^[0-9a-f]{64}$/);
    const { status, token } = await tokenWith(sim.base, 'gamma', 'gamma.partner', named.body.clientSecret);
    assert.equal(status, 200);
    assert.equal((await versions(sim.base, 'gamma', token)).status, 200);
    // Named in the make-clients.js way when no id is given.
    const t1 = await request(sim.base, 'POST', '/admin/api/accounts/gamma', { body: {} });
    const m1 = await request(sim.base, 'POST', '/admin/api/accounts/gamma', { body: { kind: 'tstmgr' } });
    const t2 = await request(sim.base, 'POST', '/admin/api/accounts/gamma');
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
      const res = await request(sim.base, 'POST', url, { body });
      assert.equal(res.status, status, `${url} ${JSON.stringify(body)}`);
      assert.equal(res.body.code, code);
    }
    assert.equal((await request(sim.base, 'DELETE', '/admin/api/accounts/alpha/nobody')).status, 404);
    assert.equal((await request(sim.base, 'POST', '/admin/api/accounts/alpha/nobody/reset-secret')).status, 404);
    assert.equal(fs.readFileSync(path.join(sim.dataDir, ACCOUNTS_FILE), 'utf8'), before);
  } finally {
    await sim.close();
  }
});

test('a reset secret ends the old secret and its tokens; the other accounts and their bookings stay', async () => {
  const sim = await startWithData();
  try {
    const [one, two] = SECRETS.alpha;
    const oldToken = (await tokenWith(sim.base, 'alpha', one.client_id, one.client_secret)).token;
    const otherToken = (await tokenWith(sim.base, 'alpha', two.client_id, two.client_secret)).token;
    const offers = (await call(sim.base, otherToken, 'POST', '/alpha/offers', offerRequest())).body.offers;
    const booking = (await call(sim.base, otherToken, 'POST', '/alpha/bookings', bookingRequest(offers[0]))).body.booking;
    const reset = await request(sim.base, 'POST', `/admin/api/accounts/alpha/${one.client_id}/reset-secret`);
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
    const { client_id: id, client_secret: secret } = SECRETS.gamma[0];
    const token = (await tokenWith(sim.base, 'gamma', id, secret)).token;
    const deleted = await request(sim.base, 'DELETE', `/admin/api/accounts/gamma/${id}`);
    assert.deepEqual(deleted.body, { provider: 'gamma', clientId: id, deleted: true });
    assert.equal((await versions(sim.base, 'gamma', token)).status, 401);
    assert.equal((await tokenWith(sim.base, 'gamma', id, secret)).status, 401);
    const again = await request(sim.base, 'POST', '/admin/api/accounts/gamma', { body: { clientId: id } });
    assert.equal(again.status, 201);
    assert.equal((await versions(sim.base, 'gamma', token)).status, 401);
    // The same id on another provider is another account, untouched.
    const beta = await tokenWith(sim.base, 'beta', 'same-id', SECRETS.beta[1].client_secret);
    await request(sim.base, 'DELETE', '/admin/api/accounts/alpha/same-id');
    assert.equal((await versions(sim.base, 'beta', beta.token)).status, 200);
  } finally {
    await sim.close();
  }
});

test('every change is in the audit, with the OSCAR administrator who asked, and no secret', async () => {
  const sim = await startWithData();
  try {
    await request(sim.base, 'GET', '/admin/api/accounts', { key: 'wrong' });
    const added = await request(sim.base, 'POST', '/admin/api/accounts/beta', { body: { clientId: 'beta.new' } });
    const reset = await request(sim.base, 'POST', '/admin/api/accounts/beta/beta.new/reset-secret', { actor: 'other@oscar.example' });
    await request(sim.base, 'DELETE', '/admin/api/accounts/beta/beta.new');
    const { body } = await request(sim.base, 'GET', '/admin/api/audit');
    assert.deepEqual(body.entries.map((e) => [e.action, e.by]), [
      ['account_deleted', ACTOR], ['secret_reset', 'other@oscar.example'], ['account_added', ACTOR],
      ['admin_key_refused', '?'], ['imported_clients_file', 'system'],
    ]);
    assert.equal(body.entries[0].clientId, 'beta.new');
    const text = fs.readFileSync(path.join(sim.dataDir, AUDIT_FILE), 'utf8');
    for (const s of [added.body.clientSecret, reset.body.clientSecret, KEY]) assert.equal(text.includes(s), false);
  } finally {
    await sim.close();
  }
});

test('the routes answer 404 and 405 like the rest of the simulator', async () => {
  const sim = await startWithData();
  try {
    assert.equal((await request(sim.base, 'GET', '/admin')).status, 404);
    assert.equal((await request(sim.base, 'GET', '/admin/api/nothing')).status, 404);
    assert.equal((await request(sim.base, 'PUT', '/admin/api/accounts')).status, 405);
    assert.equal((await request(sim.base, 'GET', '/admin/api/accounts/alpha/alpha-one/reset-secret')).status, 405);
    assert.equal((await request(sim.base, 'POST', '/admin/api/accounts/alpha/alpha-one/other')).status, 404);
  } finally {
    await sim.close();
  }
});

