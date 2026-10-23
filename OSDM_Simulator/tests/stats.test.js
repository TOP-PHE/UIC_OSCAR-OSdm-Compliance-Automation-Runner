// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #930 PR 3: what each account does on the simulator, counted per day.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { SECRETS, REAL_SECRETS, PROVIDERS_DIR, tempDir, writeClientsFile, basic, call, offerRequest, bookingRequest } = require('./helpers');
const { ConfigError, loadProviders } = require('../src/config');
const { createAccounts } = require('../src/accounts');
const { createAdmin } = require('../src/admin');
const { createStats, countersOf, STATS_FILE } = require('../src/stats');
const { createTokenService } = require('../src/tokens');
const { createStore } = require('../src/store');
const { createApp } = require('../src/app');

const providers = loadProviders(PROVIDERS_DIR);
const KEY = crypto.randomBytes(32).toString('hex');
const KEY_SHA256 = crypto.createHash('sha256').update(KEY).digest('hex');

async function startWithStats({ dataDir = tempDir() } = {}) {
  const clock = { ms: Date.parse('2026-11-02T09:00:00Z') };
  const now = () => clock.ms;
  const accounts = createAccounts({ dataDir, providers, clientsFile: writeClientsFile(REAL_SECRETS), now });
  const stats = createStats({ dataDir, providers, now, flushMs: 0 });
  const app = createApp({
    providers,
    clients: accounts.clients,
    accounts,
    stats,
    admin: createAdmin({ keySha256: KEY_SHA256, accounts, stats, now }),
    tokens: createTokenService({ now }),
    store: createStore({ limits: { offer: 50, trip: 50, booking: 5, fulfillment: 50, idempotency: 50 }, ttlMs: 3600000, now }),
    limits: { bodyBytes: 64 * 1024, offersPerClient: 50, bookingsPerClient: 5, ttlSeconds: 3600, requestsPerMinute: 10000 },
    now,
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  server.on('connection', (socket) => socket.unref());
  return {
    base: `http://127.0.0.1:${server.address().port}`, clock, dataDir, stats,
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
  };
}

async function tokenWith(base, provider, client) {
  const res = await fetch(`${base}/${provider}/oauth/token`, {
    method: 'POST',
    headers: { Authorization: basic(client), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  return (await res.json()).access_token;
}

async function statsOf(base, query = '') {
  const res = await fetch(`${base}/admin/api/stats${query}`, { headers: { Authorization: `Bearer ${KEY}`, 'X-Admin-Actor': 'admin@oscar.example' } });
  return { status: res.status, body: await res.json() };
}

const accountOf = (body, provider, clientId) => body.providers.find((p) => p.provider === provider).accounts.find((a) => a.clientId === clientId);

test('what a request counts for, from its method, path and status', () => {
  const c = (method, segments, status) => countersOf({ method, segments, status }).sort();
  assert.deepEqual(c('POST', ['oauth', 'token'], 200), ['tokens']);
  assert.deepEqual(c('POST', ['oauth', 'token'], 401), ['clientErrors']);
  assert.deepEqual(c('POST', ['offers'], 200), ['offers', 'requests']);
  assert.deepEqual(c('POST', ['bookings'], 200), ['bookings', 'requests']);
  assert.deepEqual(c('POST', ['bookings', 'B1', 'fulfillments'], 200), ['confirmations', 'requests']);
  assert.deepEqual(c('PATCH', ['bookings', 'B1', 'refund-offers', 'R1'], 200), ['refunds', 'requests']);
  assert.deepEqual(c('POST', ['bookings', 'B1', 'exchange-operations'], 200), ['exchanges', 'requests']);
  assert.deepEqual(c('GET', ['bookings', 'B1'], 200), ['requests']);
  assert.deepEqual(c('POST', ['bookings'], 400), ['clientErrors', 'requests']);
  assert.deepEqual(c('POST', ['offers'], 500), ['requests', 'serverErrors']);
});

test('a sale is counted for its account; a refused request for its provider only; the administration is not counted', async () => {
  const sim = await startWithStats();
  try {
    const one = SECRETS.alpha[0];
    const token = await tokenWith(sim.base, 'alpha', one);
    const offers = (await call(sim.base, token, 'POST', '/alpha/offers', offerRequest())).body.offers;
    const booking = (await call(sim.base, token, 'POST', '/alpha/bookings', bookingRequest(offers[0]))).body.booking;
    await call(sim.base, token, 'POST', `/alpha/bookings/${booking.id}/fulfillments`, {});
    await call(sim.base, token, 'GET', `/alpha/bookings/${booking.id}`);
    await call(sim.base, token, 'GET', '/alpha/bookings/nothing');
    await call(sim.base, 'not-a-token', 'GET', '/alpha/versions');
    await tokenWith(sim.base, 'alpha', { client_id: one.client_id, client_secret: 'wrong'.repeat(10) });
    const { status, body } = await statsOf(sim.base);
    assert.equal(status, 200);
    assert.deepEqual([body.from, body.to], ['2026-10-04', '2026-11-02']);
    assert.deepEqual(accountOf(body, 'alpha', one.client_id), {
      clientId: one.client_id, tokens: 1, requests: 5, offers: 1, bookings: 1, confirmations: 1,
      refunds: 0, exchanges: 0, clientErrors: 1, serverErrors: 0,
    });
    const alpha = body.providers.find((p) => p.provider === 'alpha');
    assert.equal(alpha.unidentified.clientErrors, 2);
    assert.equal(alpha.unidentified.requests, 1);
    assert.equal(alpha.totals.requests, 6);
    assert.deepEqual(body.daily.map((d) => [d.day, d.requests]), [['2026-11-02', 6]]);
    assert.equal(body.providers.find((p) => p.provider === 'beta').accounts.length, 0);
  } finally {
    await sim.close();
  }
});

test('counts are kept per day, written to the data folder, read back, and only what is counted is written', async () => {
  const sim = await startWithStats();
  try {
    await tokenWith(sim.base, 'gamma', SECRETS.gamma[0]);
    sim.clock.ms += 86400000;
    // The next day, with a token of that day.
    const token = await tokenWith(sim.base, 'gamma', SECRETS.gamma[0]);
    await call(sim.base, token, 'POST', '/gamma/offers', offerRequest());
    sim.stats.flush();
    const text = fs.readFileSync(path.join(sim.dataDir, STATS_FILE), 'utf8');
    for (const s of ['urn:uic', SECRETS.gamma[0].client_secret, '127.0.0.1', '/gamma/', 'departureTime']) {
      assert.equal(text.includes(s), false, s);
    }
    const again = createStats({ dataDir: sim.dataDir, providers, now: () => sim.clock.ms, flushMs: 0 });
    const body = again.query({ from: '2026-11-02', to: '2026-11-03' });
    assert.deepEqual(body.daily.map((d) => [d.day, d.tokens, d.offers]), [['2026-11-02', 1, 0], ['2026-11-03', 1, 1]]);
    assert.equal(again.query({ from: '2026-11-02', to: '2026-11-02' }).providers.find((p) => p.provider === 'gamma').totals.offers, 0);
  } finally {
    await sim.close();
  }
});

test('days older than the retention are dropped when written', () => {
  const dataDir = tempDir();
  const clock = { ms: Date.parse('2026-01-01T12:00:00Z') };
  const stats = createStats({ dataDir, providers, now: () => clock.ms, retentionDays: 10, flushMs: 0 });
  stats.record({ provider: 'alpha', client: 'alpha-one', method: 'POST', segments: ['offers'], status: 200 });
  clock.ms += 11 * 86400000;
  stats.record({ provider: 'alpha', client: 'alpha-one', method: 'POST', segments: ['offers'], status: 200 });
  stats.flush();
  const days = Object.keys(JSON.parse(fs.readFileSync(path.join(dataDir, STATS_FILE), 'utf8')).days);
  assert.deepEqual(days, ['2026-01-12']);
});

test('a period that is not valid is refused; a statistics file that is wrong stops the start', async () => {
  const sim = await startWithStats();
  try {
    for (const q of ['?from=2026-11-05&to=2026-11-01', '?from=yesterday&to=2026-11-01', '?from=2024-01-01&to=2026-11-01', '?from=2026-13-40&to=2026-13-41']) {
      const res = await statsOf(sim.base, q);
      assert.equal(res.status, 400, q);
      assert.equal(res.body.code, 'BAD_PERIOD');
    }
    assert.equal((await fetch(`${sim.base}/admin/api/stats`)).status, 401);
  } finally {
    await sim.close();
  }
  for (const content of ['{', JSON.stringify({ format: 2, days: {} }), JSON.stringify({ format: 1, days: { yesterday: {} } }),
    JSON.stringify({ format: 1, days: { '2026-01-01': { alpha: { clients: { x: { tokens: -1 } } } } } })]) {
    const dataDir = tempDir();
    fs.writeFileSync(path.join(dataDir, STATS_FILE), content);
    assert.throws(() => createStats({ dataDir, providers, flushMs: 0 }), ConfigError);
  }
});

test('a provider that is not known, or a request with no provider, is not counted', () => {
  const dataDir = tempDir();
  const stats = createStats({ dataDir, providers, flushMs: 0 });
  stats.record({ provider: 'nobody', client: 'x', method: 'POST', segments: ['offers'], status: 200 });
  stats.record({ provider: undefined, client: 'admin:x', method: 'GET', segments: ['accounts'], status: 200 });
  stats.flush();
  assert.equal(fs.existsSync(path.join(dataDir, STATS_FILE)), false);
});
