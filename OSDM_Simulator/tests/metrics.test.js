// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1005: what the simulator and its host are doing, read by OSCAR through the
// administration API for its Prometheus.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { REAL_SECRETS, PROVIDERS_DIR, tempDir, writeClientsFile, basic } = require('./helpers');
const { loadProviders } = require('../src/config');
const { createAccounts } = require('../src/accounts');
const { createAdmin } = require('../src/admin');
const { createTokenService } = require('../src/tokens');
const { createStore } = require('../src/store');
const { createApp } = require('../src/app');
const { createMetrics, parseMeminfo, parseLoadavg, parseCpuSeconds, BUCKETS } = require('../src/metrics');

const MEMINFO = [
  'MemTotal:        8000000 kB',
  'MemFree:          100000 kB',
  'MemAvailable:    2000000 kB',
  'SwapTotal:       1000000 kB',
  'SwapFree:         750000 kB',
].join('\n');
const STAT = 'cpu  1000 50 300 9000 20 0 10 5 0 0\ncpu0 500 25 150 4500 10 0 5 2 0 0\n';

// A process and host that do not move, so a snapshot can be compared whole.
function fixedSources(overrides = {}) {
  const files = { '/proc/meminfo': MEMINFO, '/proc/loadavg': '0.50 0.75 1.00 2/300 4242\n', '/proc/stat': STAT };
  return {
    readFile: (file) => {
      if (!(file in files)) throw new Error('ENOENT');
      return files[file];
    },
    statfs: () => ({ blocks: 1000, bsize: 4096, bavail: 250 }),
    cpuUsage: () => ({ user: 2_500_000, system: 500_000 }),
    memoryUsage: () => ({ rss: 80_000_000, heapUsed: 20_000_000, heapTotal: 30_000_000 }),
    eventLoop: { percentile: () => 12_000_000, max: 40_000_000, reset() {}, enable() {} },
    ...overrides,
  };
}

test('/proc is read in bytes, seconds and loads', () => {
  assert.deepEqual(parseMeminfo(MEMINFO), { memoryTotal: 8000000 * 1024, memoryAvailable: 2000000 * 1024, swapTotal: 1000000 * 1024, swapFree: 750000 * 1024 });
  assert.equal(parseMeminfo('MemTotal: 1 kB'), null);
  assert.deepEqual(parseLoadavg('0.50 0.75 1.00 2/300 4242\n'), [0.5, 0.75, 1]);
  assert.equal(parseLoadavg('nonsense'), null);
  assert.deepEqual(parseCpuSeconds(STAT), { user: 10, nice: 0.5, system: 3, idle: 90, iowait: 0.2, irq: 0, softirq: 0.1, steal: 0.05 });
  assert.equal(parseCpuSeconds('intr 1 2 3'), null);
});

test('a snapshot counts requests by provider, method and status, and their durations', () => {
  let ms = Date.parse('2026-11-02T09:00:00Z');
  const store = { count: (kind) => ({ offer: 3, booking: 2 }[kind] ?? 0) };
  const m = createMetrics({ version: '0.57.0', store, dataDir: '/data', now: () => ms, ...fixedSources() });
  m.record({ provider: 'gamma', method: 'POST', status: 200, ms: 30 });
  m.record({ provider: 'gamma', method: 'POST', status: 200, ms: 700 });
  m.record({ provider: 'alpha', method: 'GET', status: 401, ms: 2 });
  m.record({ method: 'BREW', status: 404, ms: 1 });
  m.rateLimited(true);
  m.rateLimited(false);
  m.rateLimited(false);
  ms += 90_000;
  const s = m.snapshot();
  assert.equal(s.version, '0.57.0');
  assert.equal(s.uptimeSeconds, 90);
  assert.deepEqual(s.requests, [
    { provider: 'gamma', method: 'POST', status: 200, count: 2 },
    { provider: 'alpha', method: 'GET', status: 401, count: 1 },
    { provider: 'none', method: 'OTHER', status: 404, count: 1 },
  ]);
  assert.deepEqual(s.durations.buckets, BUCKETS);
  const gamma = s.durations.byProvider.gamma;
  assert.equal(gamma.count, 2);
  assert.ok(Math.abs(gamma.sum - 0.73) < 1e-9);
  // Cumulative, as Prometheus reads a histogram: 0.03 s from the 0.05 bucket, 0.7 s from 1.
  assert.deepEqual(gamma.counts, [0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2]);
  assert.deepEqual(s.rateLimited, { trusted: 1, others: 2 });
  assert.deepEqual(s.store, { offer: 3, trip: 0, booking: 2, fulfillment: 0, idempotency: 0 });
  assert.deepEqual(s.process, {
    residentBytes: 80_000_000, heapUsedBytes: 20_000_000, heapTotalBytes: 30_000_000,
    cpuUserSeconds: 2.5, cpuSystemSeconds: 0.5, eventLoop: { p99Seconds: 0.012, maxSeconds: 0.04 },
  });
  assert.equal(s.host.memoryAvailable, 2000000 * 1024);
  assert.deepEqual(s.host.load, [0.5, 0.75, 1]);
  assert.equal(s.host.cpuSeconds.idle, 90);
  assert.deepEqual(s.host.disk, { total: 4096000, free: 1024000 });
  // Nothing in it names an account or a token.
  assert.equal(/client|token|secret/i.test(JSON.stringify(s)), false);
});

test('without /proc the host part is null, and the process part is still there', () => {
  const m = createMetrics({
    version: 'x',
    ...fixedSources({ readFile: () => { throw new Error('ENOENT'); }, statfs: () => { throw new Error('ENOSYS'); } }),
  });
  const s = m.snapshot();
  assert.equal(s.host, null);
  assert.equal(s.process.residentBytes, 80_000_000);
});

test('the real process and host can be read', () => {
  const m = createMetrics({ version: 'x', dataDir: tempDir() });
  const s = m.snapshot();
  assert.ok(s.process.residentBytes > 0);
  assert.ok(s.process.cpuUserSeconds >= 0);
  if (process.platform === 'linux') {
    assert.ok(s.host.memoryTotal > 0);
    assert.ok(s.host.disk.total > 0);
  }
});

// Through the app: provider requests are counted, the administration API is
// not (OSCAR's scrapes would fill it), and a 429 is counted as refused.
test('GET /admin/api/metrics answers the snapshot to the key only, and counts provider requests', async (t) => {
  const providers = loadProviders(PROVIDERS_DIR);
  const key = 'k'.repeat(20) + crypto.randomBytes(16).toString('hex');
  const keySha256 = crypto.createHash('sha256').update(key).digest('hex');
  const accounts = createAccounts({ dataDir: tempDir(), providers, clientsFile: writeClientsFile(REAL_SECRETS) });
  const metrics = createMetrics({ version: 'test', ...fixedSources() });
  const app = createApp({
    providers,
    clients: accounts.clients,
    accounts,
    admin: createAdmin({ keySha256, accounts, metrics }),
    metrics,
    tokens: createTokenService(),
    store: createStore({ limits: { offer: 5, trip: 5, booking: 5, fulfillment: 5, idempotency: 5 }, ttlMs: 60000 }),
    limits: { bodyBytes: 64 * 1024, requestsPerMinute: 4 },
  });
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const admin = (headers) => fetch(`${base}/admin/api/metrics`, { headers });

  const alpha = REAL_SECRETS.alpha[0];
  const token = await fetch(`${base}/alpha/oauth/token`, {
    method: 'POST',
    headers: { Authorization: basic(alpha), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  assert.equal(token.status, 200);
  assert.equal((await fetch(`${base}/alpha/versions`)).status, 401);

  assert.equal((await admin({})).status, 401);
  const ok = await admin({ Authorization: `Bearer ${key}`, 'X-Admin-Actor': 'prometheus' });
  assert.equal(ok.status, 200);
  const snap = await ok.json();
  assert.deepEqual(snap.requests.map((r) => `${r.provider} ${r.method} ${r.status}`).sort(), ['alpha GET 401', 'alpha POST 200']);
  assert.deepEqual(snap.rateLimited, { trusted: 0, others: 0 });
  // The fifth request of the minute is refused, and counted as refused.
  assert.equal((await fetch(`${base}/alpha/versions`)).status, 429);
  // Read in the process: the administration API shares the address's limit.
  const after = metrics.snapshot();
  assert.deepEqual(after.rateLimited, { trusted: 0, others: 1 });
  assert.equal(after.requests.some((r) => r.provider === 'none' && r.status === 429), true);
});
