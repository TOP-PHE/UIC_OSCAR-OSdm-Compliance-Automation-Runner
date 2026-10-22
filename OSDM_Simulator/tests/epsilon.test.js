// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #920: epsilon answers in OSDM 3.10, the version in development (branch
// patches-osdm-v3.10 at the commit of osdm-dev.json). Every answer below is
// checked against the 3.10 response schemas by call() (#833), so a full sale
// on epsilon is also the proof that the simulator answers in 3.10's shapes.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SECRETS, startSimulator, tokenFor, call, offerRequest, bookingRequest } = require('./helpers');
const { loadProviders } = require('../src/config');

const DEV = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'Documentation', 'Test_Coverage', 'OSDM_reference', 'osdm-dev.json'), 'utf8'));
const [epsilonOne] = SECRETS.epsilon;
const [deltaOne] = SECRETS.delta;

let sim;
before(async () => { sim = await startSimulator(); });
after(async () => { await sim.close(); });

test('epsilon answers to the OSDM version in development OSCAR holds: same version, branch and commit', () => {
  const epsilon = loadProviders(path.join(__dirname, '..', 'providers')).get('epsilon');
  assert.equal(epsilon.osdmVersion, DEV.version);
  assert.deepEqual(epsilon.osdmDevelopment, { branch: DEV.branch, commit: DEV.commit });
  assert.equal(epsilon.currency, 'SEK');
  assert.deepEqual(Object.keys(epsilon.otherCurrencies || {}), ['EUR']);
  // The released providers name no development branch.
  for (const [key, p] of loadProviders(path.join(__dirname, '..', 'providers'))) {
    if (key !== 'epsilon') assert.equal(p.osdmDevelopment, undefined, key);
  }
});

test('a profile with a development branch but no commit is refused', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'sim-dev-'));
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'providers', 'epsilon.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'epsilon.json'), JSON.stringify({ ...raw, osdmDevelopment: { branch: 'x', commit: 'main' } }));
  assert.throws(() => loadProviders(dir), /osdmDevelopment/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('epsilon reports 3.10.0', async () => {
  const token = await tokenFor(sim.base, 'epsilon', epsilonOne);
  assert.deepEqual((await call(sim.base, token, 'GET', '/epsilon/versions')).body, [{ version: '3.10.0' }]);
});

test('POST /trips-collections (OSDM#1487) on 3.10, the singular still answered; not on 3.9', async () => {
  const token = await tokenFor(sim.base, 'epsilon', epsilonOne);
  const search = offerRequest().tripSearchCriteria;
  const plural = await call(sim.base, token, 'POST', '/epsilon/trips-collections', search);
  assert.equal(plural.status, 200);
  assert.match(plural.body.id, /^EPSILON-TRIPS-/);
  assert.equal(plural.body.trips.length, 4);
  const singular = await call(sim.base, token, 'POST', '/epsilon/trips-collection', search);
  assert.equal(singular.status, 200);
  assert.deepEqual(singular.body.trips.map((t) => t.startTime), plural.body.trips.map((t) => t.startTime));
  // A trip of the plural answer can be asked for by id, like one of the singular.
  const request = offerRequest({ tripIds: [plural.body.trips[2].id] });
  delete request.tripSearchCriteria;
  const offers = await call(sim.base, token, 'POST', '/epsilon/offers', request);
  assert.equal(offers.status, 200);
  assert.equal(offers.body.trips[0].id, plural.body.trips[2].id);
  // Below 3.10 the plural is not OSDM: delta (3.9) answers 501, as before.
  const delta = await call(sim.base, await tokenFor(sim.base, 'delta', deltaOne), 'POST', '/delta/trips-collections', search);
  assert.equal(delta.status, 501);
  assert.equal((await call(sim.base, token, 'GET', '/epsilon/trips-collections')).status, 405);
});

test('a sale on epsilon, in SEK, then its refund: every answer is an OSDM 3.10 one', async () => {
  const token = await tokenFor(sim.base, 'epsilon', epsilonOne);
  const offers = (await call(sim.base, token, 'POST', '/epsilon/offers', offerRequest())).body.offers;
  assert.ok(offers.length >= 3);
  assert.ok(offers.every((o) => o.offerSummary.minimalPrice.currency === 'SEK'));
  const flexible = offers.find((o) => o.offerSummary.overallFlexibility === 'FULL_FLEXIBLE');
  const booking = (await call(sim.base, token, 'POST', '/epsilon/bookings', bookingRequest(flexible))).body.booking;
  assert.match(booking.id, /^EPSILON-/);
  const base = `/epsilon/bookings/${booking.id}`;
  const fulfillments = (await call(sim.base, token, 'POST', `${base}/fulfillments`, {})).body.fulfillments;
  assert.ok(fulfillments.length > 0);
  const read = (await call(sim.base, token, 'GET', base)).body.booking;
  assert.equal(read.confirmedPrice.currency, 'SEK');
  const refund = (await call(sim.base, token, 'POST', `${base}/refund-offers`, { fulfillmentIds: fulfillments.map((f) => f.id) })).body.refundOffers;
  for (const offer of refund) {
    const done = await call(sim.base, token, 'PATCH', `${base}/refund-offers/${offer.id}`, { status: 'CONFIRMED' });
    assert.equal(done.status, 200);
  }
  const after = (await call(sim.base, token, 'GET', base)).body.booking;
  assert.ok(after.fulfillments.every((f) => f.status === 'REFUNDED'));
});

test('a sale on epsilon in EUR, its second currency', async () => {
  const token = await tokenFor(sim.base, 'epsilon', epsilonOne);
  const request = offerRequest({ offerSearchCriteria: { currency: 'EUR' } });
  const offers = (await call(sim.base, token, 'POST', '/epsilon/offers', request)).body.offers;
  assert.ok(offers.every((o) => o.offerSummary.minimalPrice.currency === 'EUR'));
});
