// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { loadProviders, loadClients } = require('../src/config');
const { createTokenService } = require('../src/tokens');
const { createStore } = require('../src/store');
const { createApp } = require('../src/app');
const { responseIssues } = require('./osdm-conformance');

const PROVIDERS_DIR = path.join(__dirname, '..', 'providers');
// A provider with none of the optional functions, for the tests of a provider
// without them (#824): alpha, beta, gamma and delta all have every function.
const PLAIN_DIR = path.join(__dirname, 'fixtures', 'providers');

// Two clients for alpha, one each for beta, gamma and delta, one for the test-only
// plain, and one id, "same-id", that exists on alpha and beta with different
// secrets: only the provider tells those two apart. The secrets only exist in
// the test.
const SECRETS = {
  alpha: [
    { client_id: 'alpha-one', client_secret: 'a1'.repeat(24) },
    { client_id: 'alpha-two', client_secret: 'a2'.repeat(24) },
    { client_id: 'same-id', client_secret: 'a3'.repeat(24) },
  ],
  beta: [
    { client_id: 'beta-one', client_secret: 'b1'.repeat(24) },
    { client_id: 'same-id', client_secret: 'b3'.repeat(24) },
  ],
  gamma: [
    { client_id: 'gamma-one', client_secret: 'g1'.repeat(24) },
  ],
  delta: [
    { client_id: 'delta-one', client_secret: 'd1'.repeat(24) },
  ],
  plain: [
    { client_id: 'plain-one', client_secret: 'p1'.repeat(24) },
  ],
};

// The clients of the shipped providers only, for a test that loads
// providers/ alone (as the server does) and not the test-only plain.
const REAL_SECRETS = Object.fromEntries(Object.entries(SECRETS).filter(([key]) => key !== 'plain'));

// The shipped providers and the test-only plain, as the test simulator has them.
function loadAllProviders() {
  return new Map([...loadProviders(PROVIDERS_DIR), ...loadProviders(PLAIN_DIR)]);
}

// Every temporary folder of a test process lives under one root, which is
// removed when the process ends. Each test file runs in a process of its own,
// and nothing in these folders is held open, so this works on every system
// (#583: before, each call left a folder behind for good).
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'osdm-sim-'));
process.on('exit', () => {
  try { fs.rmSync(TEMP_ROOT, { recursive: true, force: true }); } catch { /* best effort: it is the temporary folder */ }
});

function tempDir() {
  return fs.mkdtempSync(path.join(TEMP_ROOT, 't-'));
}

function writeClientsFile(content = SECRETS) {
  const file = path.join(tempDir(), 'clients.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

/**
 * A simulator on a free local port, with a clock the test moves by hand.
 * Returns { base, clock, logs, store, close }.
 */
async function startSimulator({ limits = {}, store: givenStore } = {}) {
  const clock = { ms: Date.parse('2026-11-02T09:00:00Z') };
  const now = () => clock.ms;
  const providers = loadAllProviders();
  const allLimits = { bodyBytes: 64 * 1024, offersPerClient: 50, bookingsPerClient: 5, ttlSeconds: 3600, requestsPerMinute: 10000, ...limits };
  const store = givenStore || createStore({
    limits: { offer: allLimits.offersPerClient, trip: allLimits.offersPerClient, booking: allLimits.bookingsPerClient, fulfillment: allLimits.offersPerClient, idempotency: allLimits.offersPerClient },
    ttlMs: allLimits.ttlSeconds * 1000,
    now,
  });
  const logs = [];
  const app = createApp({
    providers,
    clients: loadClients(writeClientsFile(), providers),
    tokens: createTokenService({ now }),
    store,
    limits: allLimits,
    now,
    log: (entry) => logs.push(entry),
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  // A test that fails before closing its simulator must not hold the test
  // file open for ever (#833): the server and its connections do not keep
  // the process alive.
  server.unref();
  server.on('connection', (socket) => socket.unref());
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    clock,
    logs,
    store,
    // Open keep-alive connections would hold the close (and the test file)
    // for ever after a failed test (#833).
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
  };
}

const basic = (client) => 'Basic ' + Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64');

async function tokenFor(base, provider, client) {
  const res = await fetch(`${base}/${provider}/oauth/token`, {
    method: 'POST',
    headers: { Authorization: basic(client), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  return (await res.json()).access_token;
}

// #833: every answer a test receives is checked against the OSDM response
// schema of the provider's version, so each test of a flow is also a test
// that the simulator answers in that version's shapes. The version is the
// provider's own (the first segment of the path).
const VERSION_OF = new Map([...loadAllProviders()].map(([key, p]) => [key, p.osdmVersion]));

function checkConformance(method, url, status, body) {
  if (body === undefined) return;
  const provider = String(url).split('/').filter(Boolean)[0];
  const version = VERSION_OF.get(provider);
  if (!version) return;
  const issues = responseIssues(version, method, url, status, body);
  if (issues?.length) {
    throw new Error(`${method} ${url} → ${status}: not an OSDM ${version} answer:\n  ${issues.slice(0, 15).join('\n  ')}`);
  }
}

async function call(base, token, method, url, body) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json;version=3.8.0';
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : undefined;
  checkConformance(method, url, res.status, parsed);
  return { status: res.status, headers: res.headers, body: parsed };
}

const offerRequest = (overrides = {}) => ({
  tripSearchCriteria: {
    departureTime: '2026-11-20T08:00:00',
    origin: { objectType: 'StopPlaceRef', stopPlaceRef: 'urn:uic:stn:0000001' },
    destination: { objectType: 'StopPlaceRef', stopPlaceRef: 'urn:uic:stn:0000002' },
  },
  anonymousPassengerSpecifications: [{ externalRef: '00001', type: 'PERSON', dateOfBirth: '1990-01-15' }],
  ...overrides,
});

const bookingRequest = (offer) => ({
  offers: [{ offerId: offer.offerId, passengerRefs: offer.passengerRefs }],
  passengerSpecifications: offer.passengerRefs.map((externalRef) => ({
    externalRef,
    type: 'PERSON',
    dateOfBirth: '1990-01-15',
    detail: { firstName: 'Alex', lastName: 'Example', contact: { email: 'alex.example@example.org', phoneNumber: '+33199000001' } },
  })),
  purchaser: { detail: { firstName: 'Paula', lastName: 'Purchaser', contact: { email: 'paula.purchaser@example.org', phoneNumber: '+33199000010' } } },
});

module.exports = { checkConformance, PROVIDERS_DIR, PLAIN_DIR, SECRETS, REAL_SECRETS, loadAllProviders, tempDir, writeClientsFile, startSimulator, basic, tokenFor, call, offerRequest, bookingRequest };
