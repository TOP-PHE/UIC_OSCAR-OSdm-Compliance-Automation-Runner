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

const PROVIDERS_DIR = path.join(__dirname, '..', 'providers');

// Two clients for alpha, one for beta, one for gamma, and one id, "same-id", that exists on
// both with different secrets: only the provider tells those two apart. The
// secrets only exist in the test.
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
};

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
  const providers = loadProviders(PROVIDERS_DIR);
  const allLimits = { bodyBytes: 64 * 1024, offersPerClient: 50, bookingsPerClient: 5, ttlSeconds: 3600, requestsPerMinute: 10000, ...limits };
  const store = givenStore || createStore({
    limits: { offer: allLimits.offersPerClient, trip: allLimits.offersPerClient, booking: allLimits.bookingsPerClient },
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
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    clock,
    logs,
    store,
    close: () => new Promise((resolve) => server.close(resolve)),
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

async function call(base, token, method, url, body) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json;version=3.8.0';
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
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

module.exports = { PROVIDERS_DIR, SECRETS, tempDir, writeClientsFile, startSimulator, basic, tokenFor, call, offerRequest, bookingRequest };
