// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { ConfigError, loadProviders, loadClients } = require('../src/config');
const { createApp, createRateLimiter } = require('../src/app');
const { createTokenService } = require('../src/tokens');
const { start, logLine } = require('../server');
const makeClients = require('../scripts/make-clients');
const { PROVIDERS_DIR, SECRETS, tempDir, writeClientsFile, basic } = require('./helpers');

const baseDir = path.join(__dirname, '..');
const listening = (server) => new Promise((resolve) => server.once('listening', resolve));
const closed = (server) => new Promise((resolve) => server.close(resolve));

test('the simulator does not start without a clients file: no default credentials', () => {
  const env = { SIM_PORT: '0', SIM_CLIENTS_FILE: path.join(tempDir(), 'clients.json') };
  assert.throws(() => start(env, baseDir), ConfigError);
});

test('run as a program without a clients file, it ends with status 1 and one line', () => {
  const env = { ...process.env, SIM_PORT: '0', SIM_CLIENTS_FILE: path.join(tempDir(), 'clients.json') };
  const result = spawnSync(process.execPath, [path.join(baseDir, 'server.js')], { env, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^OSDM simulator not started: the clients file cannot be read/);
  assert.equal(result.stderr.trim().split('\n').length, 1);
});

test('started with a clients file, it listens where told and serves a token', async (t) => {
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  const server = start({ SIM_PORT: '0', SIM_CLIENTS_FILE: writeClientsFile() }, baseDir);
  await listening(server);
  t.after(() => closed(server));
  const { address, port } = server.address();
  assert.equal(address, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  const res = await fetch(`${base}/alpha/oauth/token`, {
    method: 'POST',
    headers: { Authorization: basic(SECRETS.alpha[0]), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  assert.equal(res.status, 200);
  assert.match(lines[0], /listening on 127\.0\.0\.1:\d+, providers: alpha, beta, gamma$/);
  const tokenLine = lines.find((line) => line.includes('/alpha/oauth/token'));
  assert.match(tokenLine, /POST \/alpha\/oauth\/token 200 \d+ms provider=alpha client=alpha-one$/);
});

test('a log line stays one line of printable text, whatever the request held', (t) => {
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  const lineSeparator = String.fromCharCode(0x2028);
  const bell = String.fromCharCode(7);
  logLine({
    method: 'GET',
    path: '/alpha/x\r\n2026-01-01T00:00:00.000Z GET /forged 200',
    status: 404,
    ms: 3,
    provider: 'alpha',
    client: `id\nwith${lineSeparator}breaks${bell}`,
  });
  assert.equal(lines.length, 1);
  assert.ok(lines[0].endsWith(' GET /alpha/x 2026-01-01T00:00:00.000Z GET /forged 200 404 3ms provider=alpha client=id with?breaks?'), lines[0]);
  assert.equal(/[^\x20-\x7E]/.test(lines[0]), false);
});

test('an error that is a bug answers 500 with no detail, and is logged', async (t) => {
  const providers = loadProviders(PROVIDERS_DIR);
  const logs = [];
  const tokens = createTokenService();
  const app = createApp({
    providers,
    clients: loadClients(writeClientsFile(), providers),
    tokens,
    store: { get() { throw new Error('store is broken: internal detail'); }, put() {} },
    limits: { bodyBytes: 1024, requestsPerMinute: 1000 },
    log: (entry) => logs.push(entry),
  });
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await listening(server);
  t.after(() => closed(server));
  const token = tokens.issue('alpha', SECRETS.alpha[0].client_id, 60);
  const res = await fetch(`http://127.0.0.1:${server.address().port}/alpha/bookings/any`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { code: 'INTERNAL_ERROR', title: 'Internal error', status: 500 });
  assert.equal(logs[0].status, 500);
  assert.match(logs[0].error.message, /store is broken/);
});

test('the request limit is per caller and per minute', () => {
  const clock = { ms: 0 };
  const allow = createRateLimiter({ perMinute: 3, now: () => clock.ms });
  assert.deepEqual([1, 2, 3, 4].map(() => allow('10.0.0.1')), [true, true, true, false]);
  assert.equal(allow('10.0.0.2'), true);
  clock.ms = 60000;
  assert.equal(allow('10.0.0.1'), true);
});

test('over the limit a caller gets 429; behind a proxy the caller is the forwarded address', async (t) => {
  const providers = loadProviders(PROVIDERS_DIR);
  const app = createApp({
    providers,
    clients: loadClients(writeClientsFile(), providers),
    tokens: createTokenService(),
    store: { get() {}, put() {} },
    limits: { bodyBytes: 1024, requestsPerMinute: 2 },
    trustProxy: true,
  });
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await listening(server);
  t.after(() => closed(server));
  const url = `http://127.0.0.1:${server.address().port}/alpha/versions`;
  const from = (forwarded) => fetch(url, { headers: forwarded ? { 'X-Forwarded-For': forwarded } : {} }).then((res) => res.status);
  assert.deepEqual([await from('198.51.100.7'), await from('198.51.100.7'), await from('198.51.100.7')], [401, 401, 429]);
  // Only the last address counts: it is the one the proxy itself added.
  assert.equal(await from('203.0.113.9, 198.51.100.7'), 429);
  assert.equal(await from('198.51.100.7, 203.0.113.9'), 401);
  assert.equal(await from(undefined), 401);
  const limited = await fetch(url, { headers: { 'X-Forwarded-For': '198.51.100.7' } });
  assert.equal(limited.headers.get('retry-after'), '60');
});

test('not behind a proxy, a forwarded address is ignored: it cannot be used to dodge the limit', async (t) => {
  const providers = loadProviders(PROVIDERS_DIR);
  const app = createApp({
    providers,
    clients: loadClients(writeClientsFile(), providers),
    tokens: createTokenService(),
    store: { get() {}, put() {} },
    limits: { bodyBytes: 1024, requestsPerMinute: 2 },
  });
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await listening(server);
  t.after(() => closed(server));
  const url = `http://127.0.0.1:${server.address().port}/alpha/versions`;
  const from = (forwarded) => fetch(url, { headers: { 'X-Forwarded-For': forwarded } }).then((res) => res.status);
  assert.deepEqual([await from('198.51.100.1'), await from('198.51.100.2'), await from('198.51.100.3')], [401, 401, 429]);
});

test('a clients file is written with random secrets the simulator accepts, and is never replaced', () => {
  const providers = loadProviders(PROVIDERS_DIR);
  const file = path.join(tempDir(), 'clients.json');
  makeClients.writeClientsFile(file, providers, 2);
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(written), ['alpha', 'beta', 'gamma']);
  const secrets = Object.values(written).flat().map((c) => c.client_secret);
  assert.equal(secrets.length, 6);
  assert.equal(new Set(secrets).size, 6);
  for (const secret of secrets) assert.match(secret, /^[0-9a-f]{64}$/);
  assert.ok(loadClients(file, providers).get('alpha').has('alpha-client-1'));
  assert.throws(() => makeClients.writeClientsFile(file, providers, 2), { code: 'EEXIST' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), written);
});

test('make-clients writes to one of two fixed places, both ignored by git, and prints no secret', (t) => {
  assert.equal(makeClients.LOCAL_FILE, path.join(baseDir, 'clients.json'));
  assert.equal(makeClients.DEPLOY_FILE, path.join(baseDir, 'deploy', 'clients.json'));
  const ignore = fs.readFileSync(path.join(baseDir, '..', '.gitignore'), 'utf8');
  assert.ok(ignore.split(/\r?\n/).includes('OSDM_Simulator/**/clients.json'), 'both places must be ignored by git');

  const writes = [];
  const printed = [];
  t.mock.method(fs, 'writeFileSync', (file, content, options) => { writes.push({ file, content, options }); });
  t.mock.method(console, 'log', (line) => printed.push(line));
  t.mock.method(console, 'error', (line) => printed.push(line));

  assert.equal(makeClients.main([]), 0);
  assert.equal(makeClients.main(['deploy', '1']), 0);
  assert.deepEqual(writes.map((w) => w.file), [makeClients.LOCAL_FILE, makeClients.DEPLOY_FILE]);
  assert.deepEqual(writes.map((w) => w.options), new Array(2).fill({ flag: 'wx', mode: 0o600 }));
  assert.deepEqual(writes.map((w) => JSON.parse(w.content).alpha.length), [2, 1]);
  for (const { content } of writes) {
    for (const client of Object.values(JSON.parse(content)).flat()) {
      assert.equal(printed.join('\n').includes(client.client_secret), false, 'a secret must not be printed');
    }
  }
});

test('make-clients refuses any other destination, a bad count, and a file that is already there', (t) => {
  const writes = [];
  const printed = [];
  t.mock.method(fs, 'writeFileSync', (file) => { writes.push(file); });
  t.mock.method(console, 'error', (line) => printed.push(line));
  const elsewhere = path.join(tempDir(), 'clients.json');
  for (const args of [[elsewhere], ['../clients.json'], ['deploy/clients.json'], ['DEPLOY'], ['local', '0'], ['deploy', '51'], ['local', 'two']]) {
    assert.equal(makeClients.main(args), 1, args.join(' '));
  }
  assert.deepEqual(writes, [], 'nothing may be written for a refused request');
  assert.equal(fs.existsSync(elsewhere), false);
  assert.match(printed[0], /^Usage: /);

  fs.writeFileSync.mock.mockImplementation(() => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }); });
  assert.equal(makeClients.main(['local']), 1);
  assert.match(printed.at(-1), /already exists and was left as it is/);
  fs.writeFileSync.mock.mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
  assert.equal(makeClients.main(['local']), 1);
  assert.match(printed.at(-1), /Could not write .*: EACCES$/);
});

test('run as a program, make-clients ends with status 1 for a destination it does not know', () => {
  const script = path.join(baseDir, 'scripts', 'make-clients.js');
  const result = spawnSync(process.execPath, [script, path.join(tempDir(), 'clients.json')], { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Usage: /);
});
