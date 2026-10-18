// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #833 PR B: errors injected on demand, by header or by token scope.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../src/osdm/faults');
const { SECRETS, startSimulator, basic, tokenFor, call, offerRequest, bookingRequest } = require('./helpers');

let sim;
before(async () => { sim = await startSimulator(); });
after(async () => { await sim.close(); });

const client = SECRETS.gamma[0];

// A request with faults: the answer as it came, JSON or not (no conformance check: it is faulty on purpose).
async function faulty(token, method, url, body, codes) {
  const headers = { Authorization: `Bearer ${token}` };
  if (codes !== undefined) headers['X-Simulator-Faults'] = codes;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(sim.base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, type: res.headers.get('content-type'), text, body: json };
}

async function sale(passengers = 1) {
  const token = await tokenFor(sim.base, 'gamma', client);
  const request = offerRequest({ anonymousPassengerSpecifications: Array.from({ length: passengers }, (_, i) => ({ externalRef: `p${i}`, type: 'PERSON', dateOfBirth: '1990-01-15' })) });
  const offer = (await call(sim.base, token, 'POST', '/gamma/offers', request)).body.offers[0];
  return { token, offer, request };
}

test('the catalogue: each fault says what it does and what OSCAR must report', () => {
  const list = F.catalogue();
  assert.ok(list.length >= 10);
  assert.equal(new Set(list.map((f) => f.code)).size, list.length);
  for (const f of list) {
    assert.match(f.code, /^[a-z]+\.[a-z0-9-]+$/);
    assert.ok(f.title && f.detail && f.feature, f.code);
    assert.ok(f.expect.length > 0 && f.expect.every((e) => e.step && e.check && ['FAIL', 'WARNING'].includes(e.level)), f.code);
  }
});

test('an unknown fault is refused, in the header and in the scope', async () => {
  const { token } = await sale();
  const res = await faulty(token, 'POST', '/gamma/offers', offerRequest(), 'offer.price-below-parts, no.such-fault');
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'UNKNOWN_FAULT');
  assert.ok(res.body.detail.includes('no.such-fault'));
  const tokenRes = await fetch(`${sim.base}/gamma/oauth/token`, {
    method: 'POST', headers: { Authorization: basic(client), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=sim-faults:nope.nope',
  });
  assert.equal(tokenRes.status, 400);
  assert.equal((await tokenRes.json()).error, 'invalid_scope');
  assert.throws(() => F.requestedFaults(Array.from({ length: 21 }, () => 'x.y').map((c, i) => `${c}${i}`).join(',')), F.FaultRefusal);
});

test('offer faults: a price below the admissions, a trip the answer does not have', async () => {
  const { token, request } = await sale();
  const priced = (await faulty(token, 'POST', '/gamma/offers', request, 'offer.price-below-parts')).body.offers[0];
  const parts = priced.admissionOfferParts.reduce((t, p) => t + p.price.amount, 0);
  assert.equal(priced.offerSummary.minimalPrice.amount, parts - 1);
  const tripless = (await faulty(token, 'POST', '/gamma/offers', request, 'offer.trip-unknown')).body;
  assert.ok(tripless.offers.every((o) => !tripless.trips.some((t) => t.id === o.tripCoverage.coveredTripId)));
});

test('booking faults change what the caller is told, never the booking stored', async () => {
  const { token, offer } = await sale(2);
  const res = await faulty(token, 'POST', '/gamma/bookings', bookingRequest(offer), 'booking.currency-changed booking.passenger-dropped booking.not-prebooked');
  assert.equal(res.status, 200);
  const { booking } = res.body;
  assert.notEqual(booking.provisionalPrice.currency, offer.offerSummary.minimalPrice.currency);
  assert.equal(booking.passengers.length, 1);
  assert.ok(booking.bookedOffers[0].admissions.every((a) => a.status === 'CONFIRMED'));
  const stored = (await call(sim.base, token, 'GET', `/gamma/bookings/${booking.id}`)).body.booking;
  assert.equal(stored.passengers.length, 2);
  assert.equal(stored.provisionalPrice.currency, offer.offerSummary.minimalPrice.currency);
  assert.ok(stored.bookedOffers[0].admissions.every((a) => a.status === 'PREBOOKED'));
});

test('a passenger update answered with another last name; fulfilments in a wrong status', async () => {
  const { token, offer } = await sale();
  const booking = (await call(sim.base, token, 'POST', '/gamma/bookings', bookingRequest(offer))).body.booking;
  const base = `/gamma/bookings/${booking.id}`;
  const patched = await faulty(token, 'PATCH', `${base}/passengers/${booking.passengers[0].id}`, { detail: { lastName: 'Sample' } }, 'passenger.name-altered');
  assert.equal(patched.body.passenger.detail.lastName, 'Sample-X');
  const issued = await faulty(token, 'POST', `${base}/fulfillments`, {}, 'fulfillment.wrong-status');
  assert.ok(issued.body.fulfillments.every((f) => f.status === 'REFUNDED'));
});

test('refund faults: more given back than paid, and a refunded booking read as still valid', async () => {
  const { token, offer } = await sale();
  const booking = (await call(sim.base, token, 'POST', '/gamma/bookings', bookingRequest(offer))).body.booking;
  const base = `/gamma/bookings/${booking.id}`;
  const fulfillments = (await call(sim.base, token, 'POST', `${base}/fulfillments`, {})).body.fulfillments;
  const ask = { fulfillmentIds: fulfillments.map((f) => f.id) };
  const inflated = (await faulty(token, 'POST', `${base}/refund-offers`, ask, 'refund.amount-above-paid')).body.refundOffers;
  assert.ok(inflated.every((o) => o.refundableAmount.amount > booking.provisionalPrice.amount));
  const offers = (await call(sim.base, token, 'POST', `${base}/refund-offers`, ask)).body.refundOffers;
  for (const o of offers) await call(sim.base, token, 'PATCH', `${base}/refund-offers/${o.id}`, { status: 'CONFIRMED' });
  const read = (await faulty(token, 'GET', base, undefined, 'refund.not-refunded')).body.booking;
  assert.ok(read.fulfillments.every((f) => f.status === 'FULFILLED'));
  assert.ok((await call(sim.base, token, 'GET', base)).body.booking.fulfillments.every((f) => f.status === 'REFUNDED'));
});

test('an HTML page instead of the booking', async () => {
  const { token, offer } = await sale();
  const booking = (await call(sim.base, token, 'POST', '/gamma/bookings', bookingRequest(offer))).body.booking;
  const res = await faulty(token, 'GET', `/gamma/bookings/${booking.id}`, undefined, 'answer.html');
  assert.equal(res.status, 200);
  assert.ok(res.type.startsWith('text/html'));
  assert.ok(res.text.includes('Request Rejected'));
});

test('error faults: a refusal without its problem code, or as a server error; success answers keep theirs', async () => {
  const { token } = await sale();
  const unknown = '/gamma/bookings/NO-SUCH-BOOKING';
  const plain = await faulty(token, 'GET', unknown);
  assert.equal(plain.status, 404);
  assert.ok(plain.body.code);
  const codeless = await faulty(token, 'GET', unknown, undefined, 'error.problem-without-code');
  assert.equal(codeless.status, 404);
  assert.equal(codeless.body.code, undefined);
  assert.ok(codeless.body.title);
  const server = await faulty(token, 'GET', unknown, undefined, 'error.server-error-for-refusal');
  assert.equal(server.status, 500);
  assert.equal(server.body.status, 500);
  assert.equal((await faulty(token, 'POST', '/gamma/offers', offerRequest(), 'error.server-error-for-refusal')).status, 200);
});

test('a token asked with a fault scope makes every request faulty, without a header', async () => {
  const res = await fetch(`${sim.base}/gamma/oauth/token`, {
    method: 'POST', headers: { Authorization: basic(client), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=openid%20sim-faults:offer.price-below-parts',
  });
  assert.equal(res.status, 200);
  const token = (await res.json()).access_token;
  const offer = (await faulty(token, 'POST', '/gamma/offers', offerRequest())).body.offers[0];
  const parts = offer.admissionOfferParts.reduce((t, p) => t + p.price.amount, 0);
  assert.equal(offer.offerSummary.minimalPrice.amount, parts - 1);
});
