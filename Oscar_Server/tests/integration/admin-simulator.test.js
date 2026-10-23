// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * admin-simulator.test.js — #930 PR 2: OSCAR's administrators manage the OSDM
 * simulator's accounts. The routes are run against the real simulator (its
 * own code from OSDM_Simulator/, on a loopback port), so the contract between
 * the two is what is tested, not a stub of it.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-admin-simulator';
process.env.ALLOW_PRIVATE_TARGETS = '1';

const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { buildAppWithRoute } = require('../helpers/test-app');
const { run, all, get } = require('../../src/db/db');

const SIM = path.join(__dirname, '..', '..', '..', 'OSDM_Simulator', 'src');
const { loadProviders } = require(path.join(SIM, 'config'));
const { createAccounts } = require(path.join(SIM, 'accounts'));
const { createAdmin } = require(path.join(SIM, 'admin'));
const { createTokenService } = require(path.join(SIM, 'tokens'));
const { createStore } = require(path.join(SIM, 'store'));
const { createApp } = require(path.join(SIM, 'app'));
const { createStats } = require(path.join(SIM, 'stats'));

const app = buildAppWithRoute('/v1/admin/simulator', '../../src/api/routes/admin-simulator');
const companyId = crypto.randomUUID();
const adminId = crypto.randomUUID();
const ADMIN_EMAIL = 'administrator@sim-admin-test.com';
const token = (role) => jwt.sign({ sub: adminId, email: role === 'administrator' ? ADMIN_EMAIL : `${role}@sim-admin-test.com`, companyId, role }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
const asAdmin = (r) => r.set('Authorization', `Bearer ${token('administrator')}`);

const KEY = crypto.randomBytes(32).toString('hex');
const SECRET = 'g1'.repeat(24);
let dir;
let server;
let base;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oscar-sim-admin-'));
  const clientsFile = path.join(dir, 'clients.json');
  fs.writeFileSync(clientsFile, JSON.stringify({ gamma: [{ client_id: 'gamma-one', client_secret: SECRET }] }));
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir);
  const providers = loadProviders(path.join(SIM, '..', 'providers'));
  const accounts = createAccounts({ dataDir, providers, clientsFile });
  const stats = createStats({ dataDir, providers, flushMs: 0 });
  const simApp = createApp({
    stats,
    providers,
    clients: accounts.clients,
    accounts,
    admin: createAdmin({ keySha256: crypto.createHash('sha256').update(KEY).digest('hex'), accounts, stats }),
    tokens: createTokenService(),
    store: createStore({ limits: { offer: 50, trip: 50, booking: 5, fulfillment: 50, idempotency: 50 }, ttlMs: 3600000 }),
    limits: { bodyBytes: 65536, offersPerClient: 50, bookingsPerClient: 5, ttlSeconds: 3600, requestsPerMinute: 10000 },
  });
  server = http.createServer(simApp);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  // Kept-alive connections must not hold the test file open.
  server.unref();
  server.on('connection', (socket) => socket.unref());
  base = `http://127.0.0.1:${server.address().port}`;
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Sim Admin Co', ?)`, [companyId, `sim-admin-${companyId.slice(0, 8)}`]);
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'administrator')`, [adminId, companyId, ADMIN_EMAIL]);
});

afterAll(async () => {
  run("DELETE FROM server_config WHERE key LIKE 'SIMULATOR_ADMIN_%'");
  run('DELETE FROM auth_events WHERE user_id = ?', [adminId]);
  run('DELETE FROM runs WHERE user_id = ?', [adminId]);
  run('DELETE FROM users WHERE id = ?', [adminId]);
  run('DELETE FROM companies WHERE id = ?', [companyId]);
  await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  fs.rmSync(dir, { recursive: true, force: true });
});

async function simulatorToken(id, secret) {
  const res = await fetch(`${base}/gamma/oauth/token`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  return res.status;
}

test('401 without a token, 403 for every other role', async () => {
  expect((await request(app).get('/v1/admin/simulator/accounts')).status).toBe(401);
  for (const role of ['company_user', 'test_manager', 'certification_user']) {
    const res = await request(app).get('/v1/admin/simulator/config').set('Authorization', `Bearer ${token(role)}`);
    expect([role, res.status]).toEqual([role, 403]);
  }
});

test('before a set-up, nothing is saved and every call says so', async () => {
  const cfg = await asAdmin(request(app).get('/v1/admin/simulator/config'));
  expect(cfg.body).toEqual({ url: null, keySet: false });
  const res = await asAdmin(request(app).get('/v1/admin/simulator/accounts'));
  expect(res.status).toBe(409);
  expect(res.body.detail).toMatch(/No simulator is set up/);
  const runs = await asAdmin(request(app).get('/v1/admin/simulator/runs'));
  expect(runs.status).toBe(409);
});

test('a wrong key, a wrong address or a bad value is tried and not saved', async () => {
  const wrong = await asAdmin(request(app).put('/v1/admin/simulator/config')).send({ url: base, key: 'x'.repeat(64) });
  expect(wrong.status).toBe(422);
  expect(wrong.body.detail).toMatch(/^Not saved: The simulator refused the key/);
  expect(JSON.stringify(wrong.body)).not.toContain('x'.repeat(64));
  const elsewhere = await asAdmin(request(app).put('/v1/admin/simulator/config')).send({ url: `${base}/nothing`, key: KEY });
  expect(elsewhere.status).toBe(422);
  expect(elsewhere.body.detail).toMatch(/no administration API at this address/);
  for (const body of [{ url: 'not a url', key: KEY }, { url: `${base}?q=1`, key: KEY }, { url: base, key: 'short' }, { url: base }]) {
    expect((await asAdmin(request(app).put('/v1/admin/simulator/config')).send(body)).status).toBe(400);
  }
  expect((await asAdmin(request(app).get('/v1/admin/simulator/config'))).body).toEqual({ url: null, keySet: false });
  // Nothing of what was tried stays behind.
  expect(get("SELECT COUNT(*) AS n FROM server_config WHERE key LIKE 'SIMULATOR_ADMIN_%'").n).toBe(0);
});

test('the right key is saved encrypted and never returned', async () => {
  const res = await asAdmin(request(app).put('/v1/admin/simulator/config')).send({ url: `${base}/`, key: KEY });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ url: base, keySet: true });
  const stored = all("SELECT key, value FROM server_config WHERE key LIKE 'SIMULATOR_ADMIN_%'");
  expect(JSON.stringify(stored)).not.toContain(KEY);
  expect(JSON.stringify((await asAdmin(request(app).get('/v1/admin/simulator/config'))).body)).not.toContain(KEY);
  // Saved again without a key: the stored one is kept, for the same address only.
  expect((await asAdmin(request(app).put('/v1/admin/simulator/config')).send({ url: base })).status).toBe(200);
  const moved = await asAdmin(request(app).put('/v1/admin/simulator/config')).send({ url: 'http://127.0.0.1:1' });
  expect(moved.status).toBe(400);
  expect(moved.body.detail).toMatch(/another address/);
});

test('the accounts list, then an account added, reset and deleted, as the simulator does it', async () => {
  const list = await asAdmin(request(app).get('/v1/admin/simulator/accounts'));
  expect(list.status).toBe(200);
  expect(list.headers['cache-control']).toBe('no-store');
  const gamma = list.body.providers.find((p) => p.provider === 'gamma');
  expect(gamma.accounts.map((a) => a.clientId)).toEqual(['gamma-one']);
  expect(Object.keys(gamma.accounts[0]).sort()).toEqual(['clientId', 'createdAt', 'lastTokenAt']);

  const added = await asAdmin(request(app).post('/v1/admin/simulator/accounts/gamma')).send({ kind: 'tstmgr' });
  expect(added.status).toBe(201);
  expect(added.body.clientId).toBe('gamma.tstmgr01');
  expect(added.body.clientSecret).toMatch(/^[0-9a-f]{64}$/);
  expect(await simulatorToken('gamma.tstmgr01', added.body.clientSecret)).toBe(200);

  const reset = await asAdmin(request(app).post('/v1/admin/simulator/accounts/gamma/gamma.tstmgr01/reset-secret'));
  expect(reset.status).toBe(200);
  expect(await simulatorToken('gamma.tstmgr01', added.body.clientSecret)).toBe(401);
  expect(await simulatorToken('gamma.tstmgr01', reset.body.clientSecret)).toBe(200);

  const deleted = await asAdmin(request(app).delete('/v1/admin/simulator/accounts/gamma/gamma.tstmgr01'));
  expect(deleted.body).toEqual({ provider: 'gamma', clientId: 'gamma.tstmgr01', deleted: true });
  expect(await simulatorToken('gamma.tstmgr01', reset.body.clientSecret)).toBe(401);
  expect(await simulatorToken('gamma-one', SECRET)).toBe(200);
});

test('the simulator\'s audit names the OSCAR administrator; OSCAR\'s audit has the change, never a secret', async () => {
  const added = await asAdmin(request(app).post('/v1/admin/simulator/accounts/gamma')).send({ clientId: 'gamma.audit' });
  const audit = await asAdmin(request(app).get('/v1/admin/simulator/audit'));
  expect(audit.body.entries[0]).toMatchObject({ by: ADMIN_EMAIL, action: 'account_added', provider: 'gamma', clientId: 'gamma.audit' });
  const ours = all("SELECT event_type FROM auth_events WHERE event_type LIKE 'simulator_%'").map((r) => r.event_type);
  expect(ours).toContain('simulator_account_added:gamma/gamma.audit');
  expect(JSON.stringify(ours)).not.toContain(added.body.clientSecret);
  expect(JSON.stringify(all("SELECT * FROM auth_events WHERE event_type LIKE 'simulator_%'"))).not.toContain(KEY);
});

test('the statistics: what each account did, field by field; a period not offered is refused before the simulator', async () => {
  expect(await simulatorToken('gamma-one', SECRET)).toBe(200);
  expect(await simulatorToken('gamma-one', 'wrong'.repeat(10))).toBe(401);
  const res = await asAdmin(request(app).get('/v1/admin/simulator/stats?days=7'));
  expect(res.status).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.body.days).toBe(7);
  expect(res.body.to).toBe(new Date().toISOString().slice(0, 10));
  const gamma = res.body.providers.find((p) => p.provider === 'gamma');
  const one = gamma.accounts.find((a) => a.clientId === 'gamma-one');
  expect(one.tokens).toBeGreaterThanOrEqual(1);
  // A wrong secret names no account the simulator knows: the provider's line.
  expect(gamma.unidentified.clientErrors).toBeGreaterThanOrEqual(1);
  expect(Object.keys(one).sort()).toEqual(['bookings', 'clientErrors', 'clientId', 'confirmations', 'exchanges', 'offers', 'refunds', 'requests', 'serverErrors', 'tokens']);
  expect(res.body.daily.length).toBe(1);
  for (const days of ['2', 'abc', '-1', '1000']) {
    const bad = await asAdmin(request(app).get(`/v1/admin/simulator/stats?days=${days}`));
    expect([days, bad.status]).toEqual([days, 400]);
  }
});

// A run of OSCAR's, its suite, request and checks: `failed` of them failed.
function seedRun({ apiBase, batchId, failed, queuedAt = null }) {
  const id = crypto.randomUUID();
  run(`INSERT INTO runs (id, company_id, user_id, status, api_base_used, batch_id, scenario_code, queued_at)
       VALUES (?, ?, ?, 'COMPLETED', ?, ?, 'SIM_X_38', COALESCE(?, datetime('now')))`, [id, companyId, adminId, apiBase, batchId, queuedAt]);
  const suite = run(`INSERT INTO run_suites (run_id, company_id, suite_name) VALUES (?, ?, 's')`, [id, companyId]).lastInsertRowid;
  const reqId = run(`INSERT INTO run_requests (suite_id, run_id, company_id, request_name) VALUES (?, ?, ?, 'r')`, [suite, id, companyId]).lastInsertRowid;
  for (let i = 0; i < failed + 1; i += 1) {
    run(`INSERT INTO run_assertions (request_id, suite_id, run_id, company_id, assertion_key, assertion_name, passed)
         VALUES (?, ?, ?, ?, ?, 'check', ?)`, [reqId, suite, id, companyId, `k${i}`, i < failed ? 0 : 1]);
  }
}

test('the test sets OSCAR sent to the simulator: per provider and user, from OSCAR\'s own runs', async () => {
  seedRun({ apiBase: `${base}/gamma`, batchId: 'batch-1', failed: 0 });
  seedRun({ apiBase: `${base}/gamma`, batchId: 'batch-1', failed: 2 });
  seedRun({ apiBase: `${base}/beta`, batchId: 'batch-2', failed: 1 });
  seedRun({ apiBase: 'https://provider.example.com/osdm', batchId: 'batch-3', failed: 5 });
  seedRun({ apiBase: `${base}/gamma`, batchId: 'batch-old', failed: 1, queuedAt: '2020-01-01 00:00:00' });
  const res = await asAdmin(request(app).get('/v1/admin/simulator/runs?days=7'));
  expect(res.status).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.body.providers).toEqual([
    { provider: 'beta', totals: { sets: 1, scenarios: 1, scenariosPerSet: 1, scenariosFailed: 1, failedChecks: 1 },
      users: [{ email: ADMIN_EMAIL, sets: 1, scenarios: 1, scenariosPerSet: 1, scenariosFailed: 1, failedChecks: 1 }] },
    { provider: 'gamma', totals: { sets: 1, scenarios: 2, scenariosPerSet: 2, scenariosFailed: 1, failedChecks: 2 },
      users: [{ email: ADMIN_EMAIL, sets: 1, scenarios: 2, scenariosPerSet: 2, scenariosFailed: 1, failedChecks: 2 }] },
  ]);
  expect(JSON.stringify(res.body)).not.toContain('SIM_X_38');
  expect((await asAdmin(request(app).get('/v1/admin/simulator/runs?days=3'))).status).toBe(400);
  expect((await request(app).get('/v1/admin/simulator/runs')).status).toBe(401);
});

test('the simulator\'s refusals come back with their status; bad values never reach it', async () => {
  const exists = await asAdmin(request(app).post('/v1/admin/simulator/accounts/gamma')).send({ clientId: 'gamma-one' });
  expect(exists.status).toBe(409);
  expect(exists.body.detail).toMatch(/already has an account/);
  const unknown = await asAdmin(request(app).delete('/v1/admin/simulator/accounts/gamma/nobody'));
  expect(unknown.status).toBe(404);
  for (const [method, url, body] of [
    ['post', '/v1/admin/simulator/accounts/Gamma', {}],
    ['post', '/v1/admin/simulator/accounts/gamma', { clientId: 'a:b' }],
    ['post', '/v1/admin/simulator/accounts/gamma', { clientId: 42 }],
    ['post', '/v1/admin/simulator/accounts/gamma', { kind: 'root' }],
    ['delete', '/v1/admin/simulator/accounts/gamma/a%3Ab', undefined],
  ]) {
    const res = await asAdmin(request(app)[method](url)).send(body);
    expect([url, res.status]).toEqual([url, 400]);
  }
  const before = (await asAdmin(request(app).get('/v1/admin/simulator/audit'))).body.entries.length;
  expect(before).toBeGreaterThan(0);
});

test('a key that stopped working is said plainly, and forgetting the set-up removes the key', async () => {
  run("UPDATE server_config SET value = ? WHERE key = 'SIMULATOR_ADMIN_KEY_ENC'", [require('../../src/db/db').encrypt('y'.repeat(64))]);
  const res = await asAdmin(request(app).get('/v1/admin/simulator/accounts'));
  expect(res.status).toBe(502);
  expect(res.body.detail).toMatch(/refused the key/);
  const gone = await asAdmin(request(app).delete('/v1/admin/simulator/config'));
  expect(gone.body).toEqual({ url: null, keySet: false });
  expect(get("SELECT COUNT(*) AS n FROM server_config WHERE key LIKE 'SIMULATOR_ADMIN_%'").n).toBe(0);
});
