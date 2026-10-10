// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { SECRETS, startSimulator, basic, tokenFor, call, offerRequest, bookingRequest } = require('./helpers');

let sim;
before(async () => { sim = await startSimulator(); });
after(async () => { await sim.close(); });

const [alphaOne, alphaTwo, alphaSame] = SECRETS.alpha;
const [betaOne, betaSame] = SECRETS.beta;
const [gammaOne] = SECRETS.gamma;
const form = { 'Content-Type': 'application/x-www-form-urlencoded' };

async function tokenRequest(provider, { headers = {}, body = 'grant_type=client_credentials', method = 'POST' } = {}) {
  const res = await fetch(`${sim.base}/${provider}/oauth/token`, { method, headers: { ...form, ...headers }, body: method === 'POST' ? body : undefined });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

// ── token endpoint ──────────────────────────────────────────────────────────

test('token: client credentials in a Basic header (OSCAR profile oauth2_basic)', async () => {
  const res = await tokenRequest('alpha', { headers: { Authorization: basic(alphaOne) } });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ['access_token', 'expires_in', 'token_type']);
  assert.equal(res.body.token_type, 'Bearer');
  assert.equal(res.body.expires_in, 3600);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('pragma'), 'no-cache');
});

test('token: client credentials in the body (OSCAR profile oauth2_post), and as JSON', async () => {
  const body = new URLSearchParams({ grant_type: 'client_credentials', ...alphaOne }).toString();
  assert.equal((await tokenRequest('alpha', { body })).status, 200);
  const json = await tokenRequest('alpha', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', ...alphaOne }),
  });
  assert.equal(json.status, 200);
});

test('token: the lifetime is the provider\'s own', async () => {
  const res = await tokenRequest('beta', { headers: { Authorization: basic(betaOne) } });
  assert.equal(res.body.expires_in, 120);
});

test('token: a wrong secret, an unknown client or another provider\'s client gets none', async () => {
  const attempts = [
    ['alpha', { headers: { Authorization: basic({ ...alphaOne, client_secret: 'wrong' }) } }],
    ['alpha', { headers: { Authorization: basic({ client_id: 'nobody', client_secret: alphaOne.client_secret }) } }],
    ['beta', { headers: { Authorization: basic(alphaOne) } }],
    ['alpha', { headers: { Authorization: 'Basic !!!' } }],
    ['alpha', { headers: { Authorization: 'Basic ' + Buffer.from('no-colon').toString('base64') } }],
    ['alpha', {}],
    ['alpha', { body: new URLSearchParams({ grant_type: 'client_credentials', client_id: alphaOne.client_id, client_secret: 'wrong' }).toString() }],
  ];
  for (const [provider, options] of attempts) {
    const res = await tokenRequest(provider, options);
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'invalid_client');
    assert.equal(res.body.access_token, undefined);
  }
  const withBasic = await tokenRequest('alpha', { headers: { Authorization: basic({ ...alphaOne, client_secret: 'wrong' }) } });
  assert.match(withBasic.headers.get('www-authenticate'), /^Basic /);
});

test('token: a Basic header wins over credentials in the body', async () => {
  const body = new URLSearchParams({ grant_type: 'client_credentials', ...alphaOne }).toString();
  const res = await tokenRequest('alpha', { headers: { Authorization: basic({ ...alphaOne, client_secret: 'wrong' }) }, body });
  assert.equal(res.status, 401);
});

test('token: only the client_credentials grant, and only for an authenticated client', async () => {
  const res = await tokenRequest('alpha', { headers: { Authorization: basic(alphaOne) }, body: 'grant_type=password' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'unsupported_grant_type');
  const anonymous = await tokenRequest('alpha', { body: 'grant_type=password' });
  assert.equal(anonymous.status, 401);
});

test('token: GET is not allowed', async () => {
  const res = await tokenRequest('alpha', { method: 'GET' });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'POST');
});

// ── who may call what ───────────────────────────────────────────────────────

test('a token issued for one provider is refused on another', async () => {
  const token = await tokenFor(sim.base, 'alpha', alphaOne);
  assert.equal((await call(sim.base, token, 'GET', '/alpha/versions')).status, 200);
  const res = await call(sim.base, token, 'GET', '/beta/versions');
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('www-authenticate'), 'Bearer');
  assert.equal((await call(sim.base, token, 'GET', '/gamma/versions')).status, 401);
});

test('the same client id on two providers: each token works on its own provider only', async () => {
  assert.equal(alphaSame.client_id, betaSame.client_id);
  const alpha = await tokenFor(sim.base, 'alpha', alphaSame);
  const beta = await tokenFor(sim.base, 'beta', betaSame);
  assert.equal((await call(sim.base, alpha, 'GET', '/alpha/versions')).status, 200);
  assert.equal((await call(sim.base, beta, 'GET', '/beta/versions')).status, 200);
  assert.equal((await call(sim.base, alpha, 'GET', '/beta/versions')).status, 401);
  assert.equal((await call(sim.base, beta, 'GET', '/alpha/versions')).status, 401);
  // And each secret opens its own provider only.
  assert.equal((await tokenRequest('beta', { headers: { Authorization: basic(alphaSame) } })).status, 401);
});

test('no token, a made-up token or a token past its lifetime is refused', async (t) => {
  assert.equal((await call(sim.base, null, 'GET', '/alpha/versions')).status, 401);
  assert.equal((await call(sim.base, 'made.up', 'GET', '/alpha/versions')).status, 401);
  const res = await fetch(`${sim.base}/alpha/versions`, { headers: { Authorization: basic(alphaOne) } });
  assert.equal(res.status, 401);
  const token = await tokenFor(sim.base, 'beta', betaOne);
  const started = sim.clock.ms;
  t.after(() => { sim.clock.ms = started; });
  sim.clock.ms += 119000;
  assert.equal((await call(sim.base, token, 'GET', '/beta/versions')).status, 200);
  sim.clock.ms += 1000;
  assert.equal((await call(sim.base, token, 'GET', '/beta/versions')).status, 401);
});

test('an unknown provider is a 404, with or without a token', async () => {
  const token = await tokenFor(sim.base, 'alpha', alphaOne);
  for (const url of ['/delta/versions', '/delta/oauth/token', '/', '/alpha-/versions']) {
    assert.equal((await call(sim.base, token, 'GET', url)).status, 404, url);
  }
});

test('the health check answers without a token and says nothing else', async () => {
  const res = await call(sim.base, null, 'GET', '/healthz');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'ok' });
  assert.equal((await call(sim.base, null, 'POST', '/healthz', {})).status, 405);
});

// ── what the simulator provides, and what it does not ───────────────────────

test('the version check reports the provider\'s OSDM version', async () => {
  const alpha = await call(sim.base, await tokenFor(sim.base, 'alpha', alphaOne), 'GET', '/alpha/versions');
  assert.deepEqual(alpha.body, [{ version: '3.6.0' }]);
  assert.equal(alpha.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(alpha.headers.get('x-content-type-options'), 'nosniff');
});

test('OSDM resources the simulator does not provide answer 501 with a Problem', async () => {
  const token = await tokenFor(sim.base, 'alpha', alphaOne);
  for (const url of ['/alpha/places', '/alpha/products', '/alpha/products/abc', '/alpha/coach-deck-layouts', '/alpha/coach-layouts', '/alpha/trips-collection',
    '/alpha/bookings/any/reimbursements', '/alpha/bookings/any/exchange-operations/x', '/alpha/bookings/any/booked-offers/x/reservations']) {
    const res = await call(sim.base, token, 'GET', url);
    assert.equal(res.status, 501, url);
    assert.equal(res.body.code, 'NOT_IMPLEMENTED');
    assert.equal(res.body.status, 501);
    assert.equal(res.headers.get('content-type'), 'application/problem+json; charset=utf-8');
  }
});

test('reduction cards: gamma lists its cards, a provider without cards answers 501 (#597)', async () => {
  const token = await tokenFor(sim.base, 'gamma', gammaOne);
  const res = await call(sim.base, token, 'GET', '/gamma/reduction-cards');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.reductionCardTypes.map((c) => c.code), ['SIM_CARD_25', 'SIM_CARD_50', 'SIM_STUDENT']);
  for (const type of res.body.reductionCardTypes) {
    assert.equal(type.issuer, 'urn:x_osdm_simulator:carrier:gamma');
    assert.ok(type.name.id && type.name.text && type.reductionsGranted[0].description);
  }
  const alpha = await call(sim.base, await tokenFor(sim.base, 'alpha', alphaOne), 'GET', '/alpha/reduction-cards');
  assert.equal(alpha.status, 501);
});

test('products: gamma lists its named products in both classes and gives one by id (#598)', async () => {
  const token = await tokenFor(sim.base, 'gamma', gammaOne);
  const list = await call(sim.base, token, 'GET', '/gamma/products');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.products.map((p) => p.id), [
    // Each tariff in both classes, then (#600) its upgrade from second to first class.
    'GAMMA-PRD-SIM_FLEXI_BASIC-SECOND', 'GAMMA-PRD-SIM_FLEXI_BASIC-FIRST', 'GAMMA-PRD-UPG-SIM_FLEXI_BASIC',
    'GAMMA-PRD-SIM_ALL_DAY-SECOND', 'GAMMA-PRD-SIM_ALL_DAY-FIRST', 'GAMMA-PRD-UPG-SIM_ALL_DAY',
    'GAMMA-PRD-SIM_FLEXI_SAVER-SECOND', 'GAMMA-PRD-SIM_FLEXI_SAVER-FIRST', 'GAMMA-PRD-UPG-SIM_FLEXI_SAVER',
    'GAMMA-PRD-SIM_TRAIN_BOUND-SECOND', 'GAMMA-PRD-SIM_TRAIN_BOUND-FIRST', 'GAMMA-PRD-UPG-SIM_TRAIN_BOUND',
    // #599: the weekend group in both classes, the group in second class only.
    'GAMMA-PRD-SIM_WEEKEND_GROUP-SECOND', 'GAMMA-PRD-SIM_WEEKEND_GROUP-FIRST', 'GAMMA-PRD-SIM_GROUP-SECOND',
  ]);
  for (const p of list.body.products) for (const field of ['id', 'code', 'owner', 'flexibility']) assert.ok(p[field], `${p.id} ${field}`);
  const one = await call(sim.base, token, 'GET', '/gamma/products/GAMMA-PRD-SIM_TRAIN_BOUND-FIRST');
  assert.deepEqual(one.body.product, list.body.products.find((p) => p.id === 'GAMMA-PRD-SIM_TRAIN_BOUND-FIRST'));
  assert.equal((await call(sim.base, token, 'GET', '/gamma/products/nope')).status, 404);
  assert.equal((await call(sim.base, token, 'GET', '/gamma/products/a/b')).status, 501, 'deeper product paths are not provided');
});

test('reduction cards: the booking keeps the card on the passenger and on the admission (#597)', async () => {
  const token = await tokenFor(sim.base, 'gamma', gammaOne);
  const cards = [{ type: 'REDUCTION_CARD', code: 'SIM_STUDENT' }];
  const offers = (await call(sim.base, token, 'POST', '/gamma/offers', offerRequest({ anonymousPassengerSpecifications: [{ externalRef: 'P1', type: 'PERSON', cards }] }))).body.offers;
  const request = bookingRequest(offers[0]);
  request.passengerSpecifications[0].cards = cards;
  const booking = (await call(sim.base, token, 'POST', '/gamma/bookings', request)).body.booking;
  assert.deepEqual(booking.passengers[0].cards, cards);
  assert.deepEqual(booking.bookedOffers[0].admissions[0].appliedPassengerTypes, offers[0].admissionOfferParts[0].appliedPassengerTypes);
  assert.equal(booking.bookedOffers[0].admissions[0].appliedPassengerTypes[0].appliedReductionCardTypes[0].code, 'SIM_STUDENT');
});

test('a path that is no OSDM resource is a 404, a wrong method a 405', async () => {
  const token = await tokenFor(sim.base, 'alpha', alphaOne);
  for (const url of ['/alpha', '/alpha/nothing', '/alpha/versions/extra', '/alpha/offers/extra', '/alpha/oauth', '/alpha/bookings/x/y/z/w',
    '/alpha/bookings/x/passengers', '/alpha/bookings/x/unknown']) {
    assert.equal((await call(sim.base, token, 'GET', url)).status, 404, url);
  }
  const wrong = [['POST', '/alpha/versions', ['GET']], ['GET', '/alpha/offers', ['POST']], ['GET', '/alpha/bookings', ['POST']],
    ['DELETE', '/alpha/bookings/x', ['GET']], ['GET', '/alpha/bookings/x/fulfillments', ['POST']]];
  for (const [method, url, allowed] of wrong) {
    const res = await call(sim.base, token, method, url, method === 'POST' ? {} : undefined);
    assert.equal(res.status, 405, `${method} ${url}`);
    assert.equal(res.headers.get('allow'), allowed.join(', '));
  }
});

test('a path that cannot be decoded, or is too long, is a 400', async () => {
  assert.equal((await call(sim.base, null, 'GET', '/alpha/%E0%A4%A')).status, 400);
  assert.equal((await call(sim.base, null, 'GET', '/alpha/' + 'a'.repeat(600))).status, 400);
});

// ── the sale flow ───────────────────────────────────────────────────────────

async function sale(provider, client, request = offerRequest()) {
  const token = await tokenFor(sim.base, provider, client);
  const offers = await call(sim.base, token, 'POST', `/${provider}/offers`, request);
  assert.equal(offers.status, 200);
  const offer = offers.body.offers[0];
  const created = await call(sim.base, token, 'POST', `/${provider}/bookings`, bookingRequest(offer));
  assert.equal(created.status, 200);
  return { token, offers: offers.body, offer, booking: created.body.booking };
}

test('offer, booking, tickets: the booking goes from PREBOOKED to FULFILLED', async () => {
  const { token, offer, booking } = await sale('alpha', alphaOne);
  assert.equal(booking.bookedOffers[0].offerId, offer.offerId);
  assert.deepEqual(booking.bookedOffers[0].admissions.map((a) => a.status), ['PREBOOKED']);
  assert.deepEqual(booking.provisionalPrice, offer.offerSummary.minimalPrice);
  assert.equal(booking.confirmedPrice, undefined);
  assert.deepEqual(booking.fulfillments, []);
  assert.equal(booking.passengers[0].externalRef, '00001');
  assert.equal(booking.passengers[0].detail.contact.email, 'alex.example@example.org');
  assert.equal(booking.purchaser.detail.lastName, 'Purchaser');
  assert.deepEqual(booking.bookedOffers[0].admissions[0].passengerIds, [booking.passengers[0].id]);

  const read = await call(sim.base, token, 'GET', `/alpha/bookings/${booking.id}`);
  assert.deepEqual(read.body.booking, booking);

  const issued = await call(sim.base, token, 'POST', `/alpha/bookings/${booking.id}/fulfillments`, {});
  assert.equal(issued.status, 200);
  const [fulfillment] = issued.body.fulfillments;
  assert.equal(fulfillment.status, 'FULFILLED');
  assert.equal(fulfillment.bookingRef, booking.id);
  assert.match(fulfillment.controlNumber, /^\d{10}$/);
  assert.deepEqual(fulfillment.bookingParts.map((p) => p.id), booking.bookedOffers[0].admissions.map((a) => a.id));

  const after = (await call(sim.base, token, 'GET', `/alpha/bookings/${booking.id}`)).body.booking;
  assert.deepEqual(after.bookedOffers[0].admissions.map((a) => a.status), ['FULFILLED']);
  assert.deepEqual(after.confirmedPrice, offer.offerSummary.minimalPrice);
  assert.equal(after.provisionalPrice.amount, 0);
  assert.equal(after.fulfillments[0].id, fulfillment.id);

  // Asked again, the same fulfilment: a booking is not confirmed twice.
  const again = await call(sim.base, token, 'POST', `/alpha/bookings/${booking.id}/fulfillments`);
  assert.equal(again.body.fulfillments[0].id, fulfillment.id);
});

// ── return journeys (#594) ──────────────────────────────────────────────────

const inboundRequest = (returnSearchParameters) => offerRequest({
  tripSearchCriteria: {
    departureTime: '2026-11-22T17:00:00',
    origin: { objectType: 'StopPlaceRef', stopPlaceRef: 'urn:uic:stn:0000002' },
    destination: { objectType: 'StopPlaceRef', stopPlaceRef: 'urn:uic:stn:0000001' },
    returnSearchParameters,
  },
});

test('return, both directions: offers cover the outbound and the inbound trip; two tickets', async () => {
  const token = await tokenFor(sim.base, 'alpha', alphaOne);
  const outbound = (await call(sim.base, token, 'POST', '/alpha/offers', offerRequest())).body;
  const outboundTrip = outbound.trips[0];
  const res = await call(sim.base, token, 'POST', '/alpha/offers', inboundRequest({ outboundTripIds: [outboundTrip.id] }));
  assert.equal(res.status, 200);
  const { trips, offers } = res.body;
  assert.deepEqual(trips.map((t) => t.direction), ['OUT_BOUND', 'IN_BOUND']);
  assert.equal(trips[0].id, outboundTrip.id);
  assert.equal(trips[1].origin.stopPlaceRef, outboundTrip.destination.stopPlaceRef);
  for (const offer of offers) {
    assert.equal(offer.tripCoverage.coveredTripId, outboundTrip.id);
    assert.equal(offer.inboundTripCoverage.coveredTripId, trips[1].id);
    assert.deepEqual(offer.admissionOfferParts.map((p) => p.tripCoverage.coveredTripId), [outboundTrip.id, trips[1].id]);
    const parts = offer.admissionOfferParts.reduce((total, p) => total + p.price.amount, 0);
    assert.equal(offer.offerSummary.minimalPrice.amount, parts);
  }
  // A return price: less than the two single journeys bought apart.
  const single = (list, flex) => list.offers.find((o) => o.offerSummary.overallFlexibility === flex).offerSummary.minimalPrice.amount;
  const inboundAlone = (await call(sim.base, token, 'POST', '/alpha/offers', inboundRequest(undefined))).body;
  assert.ok(single(res.body, 'FULL_FLEXIBLE') < single(outbound, 'FULL_FLEXIBLE') + single(inboundAlone, 'FULL_FLEXIBLE'));

  const offer = offers[0];
  const created = (await call(sim.base, token, 'POST', '/alpha/bookings', bookingRequest(offer))).body.booking;
  assert.deepEqual(created.trips.map((t) => t.id), trips.map((t) => t.id));
  assert.equal(created.bookedOffers[0].inboundTripCoverage.coveredTripId, trips[1].id);
  const issued = (await call(sim.base, token, 'POST', `/alpha/bookings/${created.id}/fulfillments`, {})).body.fulfillments;
  assert.equal(issued.length, 2, 'one ticket per direction');
  const admissions = created.bookedOffers[0].admissions;
  assert.deepEqual(issued.map((f) => f.bookingParts.map((p) => p.id)), [[admissions[0].id], [admissions[1].id]]);
});

test('return, separate directions: inbound offers for an outbound offer; booked together, two tickets', async () => {
  const token = await tokenFor(sim.base, 'alpha', alphaOne);
  const outbound = (await call(sim.base, token, 'POST', '/alpha/offers', offerRequest())).body;
  const res = await call(sim.base, token, 'POST', '/alpha/offers', inboundRequest({ outwardOfferIds: [outbound.offers[0].offerId] }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.trips.map((t) => t.direction), ['IN_BOUND']);
  assert.equal(res.body.offers[0].inboundTripCoverage, undefined);
  const inbound = res.body.offers[0];
  const request = bookingRequest(outbound.offers[0]);
  request.offers.push({ offerId: inbound.offerId, passengerRefs: inbound.passengerRefs });
  const created = (await call(sim.base, token, 'POST', '/alpha/bookings', request)).body.booking;
  assert.equal(created.trips.length, 2);
  const issued = (await call(sim.base, token, 'POST', `/alpha/bookings/${created.id}/fulfillments`, {})).body.fulfillments;
  assert.equal(issued.length, 2);
});

test('return: an id this client was not given, both kinds of id, or a malformed list are refused', async () => {
  const token = await tokenFor(sim.base, 'alpha', alphaOne);
  const other = await tokenFor(sim.base, 'alpha', alphaTwo);
  const outbound = (await call(sim.base, token, 'POST', '/alpha/offers', offerRequest())).body;
  const tripId = outbound.trips[0].id;
  const offerId = outbound.offers[0].offerId;
  const cases = [
    [token, { outboundTripIds: ['ALPHA-TRIP-000000000000'] }, /outboundTripIds.*not one this client was given/],
    [other, { outboundTripIds: [tripId] }, /outboundTripIds.*not one this client was given/],
    [token, { outwardOfferIds: ['ALPHA-OFR-0'] }, /outwardOfferIds.*not one this client was given/],
    [token, { outboundTripIds: [tripId], outwardOfferIds: [offerId] }, /not both/],
    [token, { outboundTripIds: [] }, /1 to 4 ids/],
    [token, { outboundTripIds: 'x' }, /1 to 4 ids/],
    [token, [], /returnSearchParameters is not valid/],
  ];
  for (const [who, params, pattern] of cases) {
    const res = await call(sim.base, who, 'POST', '/alpha/offers', inboundRequest(params));
    assert.equal(res.status, 400, JSON.stringify(params));
    assert.equal(res.body.code, 'VALIDATION_ERROR');
    assert.match(res.body.detail, pattern);
  }
});

test('the date of a later inbound journey, on the first call, changes nothing', async () => {
  const token = await tokenFor(sim.base, 'alpha', alphaOne);
  const plain = (await call(sim.base, token, 'POST', '/alpha/offers', offerRequest())).body;
  const withDates = offerRequest({ offerSearchCriteria: { inboundDate: '2026-11-22T17:00:00' } });
  withDates.tripSearchCriteria.returnSearchParameters = { inwardReturnDate: '2026-11-22T17:00:00' };
  const res = await call(sim.base, token, 'POST', '/alpha/offers', withDates);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.trips, plain.trips);
});

// ── refunds, one offer per fulfillment (#595) ─────────────────────────────

// A confirmed return: two fulfillments, one per direction.
async function confirmedReturn(flexibility = 'FULL_FLEXIBLE', provider = 'alpha') {
  const token = await tokenFor(sim.base, provider, provider === 'gamma' ? gammaOne : alphaOne);
  const outbound = (await call(sim.base, token, 'POST', `/${provider}/offers`, offerRequest())).body;
  const pick = (list) => list.offers.find((o) => o.offerSummary.overallFlexibility === flexibility);
  const both = (await call(sim.base, token, 'POST', `/${provider}/offers`, inboundRequest({ outboundTripIds: [outbound.trips[0].id] }))).body;
  const booking = (await call(sim.base, token, 'POST', `/${provider}/bookings`, bookingRequest(pick(both)))).body.booking;
  const fulfillments = (await call(sim.base, token, 'POST', `/${provider}/bookings/${booking.id}/fulfillments`, {})).body.fulfillments;
  return { token, booking, fulfillments, base: `/${provider}/bookings/${booking.id}` };
}

test('refund: one refund offer per fulfillment named, holding all its parts', async () => {
  const { token, fulfillments, base } = await confirmedReturn();
  const res = await call(sim.base, token, 'POST', `${base}/refund-offers`, { fulfillmentIds: fulfillments.map((f) => f.id) });
  assert.equal(res.status, 200);
  const offers = res.body.refundOffers;
  assert.equal(offers.length, 2);
  offers.forEach((offer, i) => {
    assert.equal(offer.status, 'PROPOSED');
    assert.deepEqual(offer.fulfillments.map((f) => f.id), [fulfillments[i].id]);
    assert.deepEqual(offer.refundOfferBreakdown.flatMap((b) => b.bookingParts.map((p) => p.id)), fulfillments[i].bookingParts.map((p) => p.id));
    assert.equal(offer.refundFee.amount, 0, 'a flexible part is refunded in full');
    assert.ok(offer.refundableAmount.amount > 0);
    for (const field of ['id', 'createdOn', 'validFrom', 'validUntil']) assert.ok(offer[field], field);
  });
  assert.deepEqual((await call(sim.base, token, 'GET', `${base}/refund-offers/${offers[0].id}`)).body.refundOffer, offers[0]);
  assert.equal((await call(sim.base, token, 'GET', `${base}/refund-offers`)).body.refundOffers.length, 2);
});

test('refund: confirming one offer refunds that direction only; the other keeps its status', async () => {
  const { token, fulfillments, base } = await confirmedReturn();
  const [first, second] = (await call(sim.base, token, 'POST', `${base}/refund-offers`, { fulfillmentIds: fulfillments.map((f) => f.id) })).body.refundOffers;
  const before = (await call(sim.base, token, 'GET', base)).body.booking;
  const done = await call(sim.base, token, 'PATCH', `${base}/refund-offers/${first.id}`, { status: 'CONFIRMED' });
  assert.equal(done.status, 200);
  assert.equal(done.body.refundOffer.status, 'CONFIRMED');
  assert.ok(done.body.refundOffer.confirmedOn);
  let booking = (await call(sim.base, token, 'GET', base)).body.booking;
  assert.deepEqual(booking.fulfillments.map((f) => f.status), ['REFUNDED', 'FULFILLED']);
  assert.deepEqual(booking.bookedOffers[0].admissions.map((a) => a.status), ['REFUNDED', 'FULFILLED']);
  assert.equal(booking.confirmedPrice.amount, before.confirmedPrice.amount - first.refundableAmount.amount);
  // Asked again: the same confirmed offer, nothing refunded twice.
  assert.equal((await call(sim.base, token, 'PATCH', `${base}/refund-offers/${first.id}`, { status: 'CONFIRMED' })).body.refundOffer.confirmedOn, done.body.refundOffer.confirmedOn);
  await call(sim.base, token, 'PATCH', `${base}/refund-offers/${second.id}`, { status: 'CONFIRMED' });
  booking = (await call(sim.base, token, 'GET', base)).body.booking;
  assert.deepEqual(booking.fulfillments.map((f) => f.status), ['REFUNDED', 'REFUNDED']);
  assert.equal(booking.confirmedPrice.amount, 0);
});

test('refund: the fee follows the flexibility of the parts', async () => {
  for (const [flexibility, check] of [
    ['SEMI_FLEXIBLE', (o) => o.refundFee.amount > 0 && o.refundableAmount.amount > o.refundFee.amount],
    ['NON_FLEXIBLE', (o) => o.refundableAmount.amount === 0 && o.refundFee.amount > 0],
  ]) {
    const { token, fulfillments, base } = await confirmedReturn(flexibility);
    const [offer] = (await call(sim.base, token, 'POST', `${base}/refund-offers`, { fulfillmentIds: [fulfillments[0].id] })).body.refundOffers;
    assert.ok(check(offer), `${flexibility}: ${JSON.stringify([offer.refundFee, offer.refundableAmount])}`);
  }
});

test('refund: an overrule code waives the fee and is named in the offer', async () => {
  const { token, fulfillments, base } = await confirmedReturn('NON_FLEXIBLE');
  const [offer] = (await call(sim.base, token, 'POST', `${base}/refund-offers`, { fulfillmentIds: [fulfillments[0].id], overruleCode: 'STRIKE' })).body.refundOffers;
  assert.equal(offer.refundFee.amount, 0);
  assert.ok(offer.refundableAmount.amount > 0);
  assert.equal(offer.appliedOverruleCode, 'STRIKE');
  assert.equal((await call(sim.base, token, 'POST', `${base}/refund-offers`, { fulfillmentIds: [fulfillments[1].id], overruleCode: 7 })).status, 400);
});

test('refund: gamma takes its four overrule codes, each a full refund with no fee (#596)', async () => {
  for (const code of ['CONNECTION_BROKEN', 'PAYMENT_FAILURE', 'SALES_STAFF_ERROR', 'TECHNICAL_FAILURE']) {
    const { token, fulfillments, base } = await confirmedReturn('SEMI_FLEXIBLE', 'gamma');
    const booking = (await call(sim.base, token, 'GET', base)).body.booking;
    const offers = (await call(sim.base, token, 'POST', `${base}/refund-offers`, { fulfillmentIds: fulfillments.map((f) => f.id), overruleCode: code })).body.refundOffers;
    assert.deepEqual(offers.map((o) => o.refundFee.amount), [0, 0], code);
    assert.deepEqual(offers.map((o) => o.appliedOverruleCode), [code, code]);
    assert.equal(offers.reduce((sum, o) => sum + o.refundableAmount.amount, 0), booking.confirmedPrice.amount, code);
  }
});

test('refund: without a code, the same product keeps its fee on gamma (#596)', async () => {
  const { token, fulfillments, base } = await confirmedReturn('SEMI_FLEXIBLE', 'gamma');
  const booking = (await call(sim.base, token, 'GET', base)).body.booking;
  const offers = (await call(sim.base, token, 'POST', `${base}/refund-offers`, { fulfillmentIds: fulfillments.map((f) => f.id) })).body.refundOffers;
  assert.ok(offers.every((o) => o.refundFee.amount > 0 && o.appliedOverruleCode === undefined));
  assert.ok(offers.reduce((sum, o) => sum + o.refundableAmount.amount, 0) < booking.confirmedPrice.amount);
});

test('refund: gamma refuses another overrule code with a Problem naming it; alpha takes any (#596)', async () => {
  const { token, fulfillments, base } = await confirmedReturn('SEMI_FLEXIBLE', 'gamma');
  const refused = await call(sim.base, token, 'POST', `${base}/refund-offers`, { fulfillmentIds: [fulfillments[0].id], overruleCode: 'STRIKE' });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, 'OVERRULE_CODE_NOT_SUPPORTED');
  assert.match(refused.body.detail, /overruleCode "STRIKE" is not accepted/);
  // Nothing was proposed by the refused request.
  assert.equal((await call(sim.base, token, 'GET', `${base}/refund-offers`)).body.refundOffers.length, 0);
  const alpha = await confirmedReturn('SEMI_FLEXIBLE');
  const [offer] = (await call(sim.base, alpha.token, 'POST', `${alpha.base}/refund-offers`, { fulfillmentIds: [alpha.fulfillments[0].id], overruleCode: 'STRIKE' })).body.refundOffers;
  assert.equal(offer.appliedOverruleCode, 'STRIKE');
});

test('refund: a proposed offer can be withdrawn, a confirmed one cannot', async () => {
  const { token, fulfillments, base } = await confirmedReturn();
  const [first, second] = (await call(sim.base, token, 'POST', `${base}/refund-offers`, { fulfillmentIds: fulfillments.map((f) => f.id) })).body.refundOffers;
  const removed = await fetch(`${sim.base}${base}/refund-offers/${first.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  assert.equal(removed.status, 204);
  assert.equal(await removed.text(), '');
  assert.equal((await call(sim.base, token, 'GET', `${base}/refund-offers/${first.id}`)).status, 404);
  await call(sim.base, token, 'PATCH', `${base}/refund-offers/${second.id}`, { status: 'CONFIRMED' });
  const kept = await call(sim.base, token, 'DELETE', `${base}/refund-offers/${second.id}`);
  assert.equal(kept.status, 409);
});

test('refund: what is refused, as the provider it follows refuses it', async () => {
  const { token, booking, fulfillments, base } = await confirmedReturn();
  const cases = [
    [{}, 400, 'VALIDATION_ERROR'],
    [{ fulfillmentIds: [] }, 400, 'VALIDATION_ERROR'],
    [{ fulfillmentIds: ['nope'] }, 400, 'VALIDATION_ERROR'],
    [{ fulfillmentIds: [fulfillments[0].id, fulfillments[0].id] }, 400, 'VALIDATION_ERROR'],
    [{ fulfillmentIds: [fulfillments[0].id], refundSpecifications: [{ fulfillmentId: fulfillments[0].id, bookingPartIds: [booking.bookedOffers[0].admissions[0].id] }] }, 400, 'PARTIAL_REFUND_NOT_SUPPORTED'],
    [{ fulfillmentIds: [fulfillments[0].id], refundSpecifications: [{ fulfillmentId: fulfillments[0].id, passengerIds: [booking.passengers[0].id] }] }, 400, 'PARTIAL_REFUND_NOT_SUPPORTED'],
  ];
  for (const [body, status, code] of cases) {
    const res = await call(sim.base, token, 'POST', `${base}/refund-offers`, body);
    assert.equal(res.status, status, JSON.stringify(body));
    assert.equal(res.body.code, code);
  }
  // A whole-fulfillment specification is a plain refund.
  const plain = await call(sim.base, token, 'POST', `${base}/refund-offers`, { fulfillmentIds: [fulfillments[0].id], refundSpecifications: [{ fulfillmentId: fulfillments[0].id }] });
  assert.equal(plain.status, 200);
  const offer = plain.body.refundOffers[0];
  for (const [body, status] of [[{ status: 'PROPOSED' }, 400], [{ status: 'OTHER' }, 400]]) {
    assert.equal((await call(sim.base, token, 'PATCH', `${base}/refund-offers/${offer.id}`, body)).status, status);
  }
  const missing = await call(sim.base, token, 'PATCH', `${base}/refund-offers/nope`, { status: 'CONFIRMED' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'RESOURCE_NOT_FOUND');
  await call(sim.base, token, 'PATCH', `${base}/refund-offers/${offer.id}`, { status: 'CONFIRMED' });
  assert.equal((await call(sim.base, token, 'POST', `${base}/refund-offers`, { fulfillmentIds: [fulfillments[0].id] })).status, 409, 'already refunded');
  // Another client sees no booking, so no refund offer either.
  const other = await tokenFor(sim.base, 'alpha', alphaTwo);
  assert.equal((await call(sim.base, other, 'GET', `${base}/refund-offers/${offer.id}`)).status, 404);
});

test('refund: a booking not confirmed has nothing to refund; an offer past its time cannot be confirmed', async () => {
  const token = await tokenFor(sim.base, 'alpha', alphaOne);
  const offer = (await call(sim.base, token, 'POST', '/alpha/offers', offerRequest())).body.offers[0];
  const booking = (await call(sim.base, token, 'POST', '/alpha/bookings', bookingRequest(offer))).body.booking;
  assert.equal((await call(sim.base, token, 'POST', `/alpha/bookings/${booking.id}/refund-offers`, { fulfillmentIds: ['x'] })).status, 409);
  const { fulfillments, base } = await confirmedReturn();
  const [refundOffer] = (await call(sim.base, token, 'POST', `${base}/refund-offers`, { fulfillmentIds: [fulfillments[0].id] })).body.refundOffers;
  sim.clock.ms += 31 * 60 * 1000;
  try {
    assert.equal((await call(sim.base, token, 'PATCH', `${base}/refund-offers/${refundOffer.id}`, { status: 'CONFIRMED' })).status, 409);
  } finally {
    sim.clock.ms -= 31 * 60 * 1000;
  }
});

test('passenger and purchaser can be read and changed; id, reference and type cannot', async () => {
  const { token, booking } = await sale('alpha', alphaOne);
  const url = `/alpha/bookings/${booking.id}/passengers/${booking.passengers[0].id}`;
  assert.deepEqual((await call(sim.base, token, 'GET', url)).body.passenger, booking.passengers[0]);
  const patched = await call(sim.base, token, 'PATCH', url, {
    id: 'forged', externalRef: 'forged', type: 'DOG', dateOfBirth: '1990-01-16', gender: 'X',
    detail: { firstName: 'Alexis', lastName: 'Sample', contact: { email: 'alexis.sample@example.org', phoneNumber: '+33199000002' } },
  });
  assert.equal(patched.status, 200);
  const passenger = patched.body.passenger;
  assert.equal(passenger.id, booking.passengers[0].id);
  assert.equal(passenger.externalRef, '00001');
  assert.equal(passenger.type, 'PERSON');
  assert.equal(passenger.dateOfBirth, '1990-01-16');
  assert.equal(passenger.detail.firstName, 'Alexis');
  assert.equal(passenger.detail.contact.phoneNumber, '+33199000002');
  assert.deepEqual((await call(sim.base, token, 'GET', url)).body.passenger, passenger);
  assert.equal((await call(sim.base, token, 'GET', `/alpha/bookings/${booking.id}/passengers/unknown`)).status, 404);
  assert.equal((await call(sim.base, token, 'DELETE', url)).status, 405);

  const purchaserUrl = `/alpha/bookings/${booking.id}/purchaser`;
  assert.equal((await call(sim.base, token, 'GET', purchaserUrl)).body.purchaser.detail.firstName, 'Paula');
  for (const [method, firstName] of [['PATCH', 'Pauline'], ['POST', 'Paulette']]) {
    const res = await call(sim.base, token, method, purchaserUrl, { detail: { firstName } });
    assert.equal(res.body.purchaser.detail.firstName, firstName);
    assert.equal(res.body.purchaser.detail.lastName, 'Purchaser');
  }
  assert.equal((await call(sim.base, token, 'DELETE', purchaserUrl)).status, 405);
});

test('text from a request comes back as JSON text, and over-long text is left out', async () => {
  const token = await tokenFor(sim.base, 'alpha', alphaOne);
  const offer = (await call(sim.base, token, 'POST', '/alpha/offers', offerRequest())).body.offers[0];
  const request = bookingRequest(offer);
  const markup = '<img src=x onerror=alert(1)>"{{access_token}}';
  request.passengerSpecifications[0].detail = { firstName: markup, lastName: 'x'.repeat(201), unknownField: 'dropped' };
  const res = await fetch(`${sim.base}/alpha/bookings`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(request),
  });
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  const detail = (await res.json()).booking.passengers[0].detail;
  assert.deepEqual(detail, { firstName: markup });
});

// ── isolation ───────────────────────────────────────────────────────────────

test('a booking is visible only to the client that made it', async () => {
  const { booking } = await sale('alpha', alphaOne);
  const other = await tokenFor(sim.base, 'alpha', alphaTwo);
  for (const [method, url, body] of [
    ['GET', `/alpha/bookings/${booking.id}`],
    ['POST', `/alpha/bookings/${booking.id}/fulfillments`, {}],
    ['GET', `/alpha/bookings/${booking.id}/purchaser`],
    ['PATCH', `/alpha/bookings/${booking.id}/purchaser`, { detail: { firstName: 'Intruder' } }],
    ['GET', `/alpha/bookings/${booking.id}/passengers/${booking.passengers[0].id}`],
    ['PATCH', `/alpha/bookings/${booking.id}/passengers/${booking.passengers[0].id}`, { detail: { firstName: 'Intruder' } }],
  ]) {
    const res = await call(sim.base, other, method, url, body);
    assert.equal(res.status, 404, `${method} ${url}`);
    assert.equal(res.body.code, 'BOOKING_NOT_FOUND');
  }
  // The same answer as for a booking that never existed.
  const missing = await call(sim.base, other, 'GET', '/alpha/bookings/ALPHA-BKG-0000000000000000');
  assert.deepEqual(missing.body, (await call(sim.base, other, 'GET', `/alpha/bookings/${booking.id}`)).body);
});

test('the same client id on two providers does not share offers or bookings', async () => {
  const { offer, booking } = await sale('alpha', alphaSame);
  const beta = await tokenFor(sim.base, 'beta', betaSame);
  assert.equal((await call(sim.base, beta, 'GET', `/beta/bookings/${booking.id}`)).status, 404);
  assert.equal((await call(sim.base, beta, 'POST', `/beta/bookings/${booking.id}/fulfillments`, {})).status, 404);
  assert.equal((await call(sim.base, beta, 'POST', '/beta/bookings', bookingRequest(offer))).status, 404);
  const alpha = await tokenFor(sim.base, 'alpha', alphaSame);
  assert.equal((await call(sim.base, alpha, 'GET', `/alpha/bookings/${booking.id}`)).status, 200);
});

test('an offer can only be booked by the client it was made for', async () => {
  const mine = await tokenFor(sim.base, 'alpha', alphaOne);
  const offer = (await call(sim.base, mine, 'POST', '/alpha/offers', offerRequest())).body.offers[0];
  const other = await tokenFor(sim.base, 'alpha', alphaTwo);
  const stolen = await call(sim.base, other, 'POST', '/alpha/bookings', bookingRequest(offer));
  assert.equal(stolen.status, 404);
  assert.equal(stolen.body.code, 'OFFER_NOT_FOUND');
  const beta = await tokenFor(sim.base, 'beta', betaOne);
  assert.equal((await call(sim.base, beta, 'POST', '/beta/bookings', bookingRequest(offer))).status, 404);
  assert.equal((await call(sim.base, mine, 'POST', '/alpha/bookings', bookingRequest(offer))).status, 200);
});

test('the same request gives another carrier, currency, price and ids on another provider', async () => {
  const alpha = await sale('alpha', alphaOne);
  const beta = await sale('beta', betaOne);
  const carrier = (s) => s.offers.trips[0].legs[0].timedLeg.service.carriers[0];
  assert.notEqual(carrier(alpha).ref, carrier(beta).ref);
  assert.equal(alpha.offer.offerSummary.minimalPrice.currency, 'EUR');
  assert.equal(beta.offer.offerSummary.minimalPrice.currency, 'CHF');
  assert.notEqual(alpha.offer.offerSummary.minimalPrice.amount, beta.offer.offerSummary.minimalPrice.amount);
  for (const [s, prefix] of [[alpha, 'ALPHA-'], [beta, 'BETA-']]) {
    const ids = [s.offers.trips[0].id, s.offer.offerId, s.offer.admissionOfferParts[0].id, s.booking.id, s.booking.passengers[0].id];
    for (const id of ids) assert.ok(id.startsWith(prefix), `${id} should start with ${prefix}`);
    assert.ok(s.booking.bookingCode.startsWith(prefix.slice(0, -1)));
  }
});

// ── refusals and limits ─────────────────────────────────────────────────────

test('a booking request the simulator cannot serve is refused with a Problem', async () => {
  const token = await tokenFor(sim.base, 'alpha', alphaOne);
  const offer = (await call(sim.base, token, 'POST', '/alpha/offers', offerRequest())).body.offers[0];
  const cases = [
    [{}, 400],
    [{ offers: [] }, 400],
    [{ offers: new Array(5).fill({ offerId: offer.offerId }) }, 400],
    [{ offers: [{ offerId: offer.offerId }], passengerSpecifications: new Array(20).fill({ externalRef: 'x' }) }, 400],
    [{ offers: [{ offerId: 'ALPHA-OFR-unknown' }] }, 404],
    [{ offers: [{ offerId: 42 }] }, 404],
    [{ offers: [null] }, 404],
  ];
  for (const [body, status] of cases) {
    const res = await call(sim.base, token, 'POST', '/alpha/bookings', body);
    assert.equal(res.status, status, JSON.stringify(body).slice(0, 60));
    assert.equal(res.body.status, status);
  }
});

test('an offer past its time, and a booking past its confirmation time, are refused', async (t) => {
  const started = sim.clock.ms;
  t.after(() => { sim.clock.ms = started; });
  const token = await tokenFor(sim.base, 'alpha', alphaOne);
  const offer = (await call(sim.base, token, 'POST', '/alpha/offers', offerRequest())).body.offers[0];
  const booking = (await call(sim.base, token, 'POST', '/alpha/bookings', bookingRequest(offer))).body.booking;
  sim.clock.ms += 30 * 60 * 1000;
  const late = await call(sim.base, await tokenFor(sim.base, 'alpha', alphaOne), 'POST', '/alpha/bookings', bookingRequest(offer));
  assert.equal(late.status, 409);
  assert.equal(late.body.code, 'OFFER_EXPIRED');
  const confirm = await call(sim.base, await tokenFor(sim.base, 'alpha', alphaOne), 'POST', `/alpha/bookings/${booking.id}/fulfillments`, {});
  assert.equal(confirm.status, 409);
  assert.equal(confirm.body.code, 'BOOKING_EXPIRED');
});

test('a body that is not a JSON object is a 400', async () => {
  const token = await tokenFor(sim.base, 'alpha', alphaOne);
  for (const body of ['{ not json', '[]', 'null', '"text"']) {
    const res = await fetch(`${sim.base}/alpha/offers`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body });
    assert.equal(res.status, 400, body);
  }
});

test('a body over the limit is refused, whether or not it declares its size', async () => {
  const token = await tokenFor(sim.base, 'alpha', alphaOne);
  const headers = { Authorization: `Bearer ${token}` };
  const stream = (kilobytes) => (async function* () { for (let i = 0; i < kilobytes; i++) yield Buffer.alloc(1024, 120); })();
  const request = JSON.stringify(offerRequest());
  const atLimit = await fetch(`${sim.base}/alpha/offers`, { method: 'POST', headers, body: request.padEnd(64 * 1024) });
  assert.equal(atLimit.status, 200, 'a body of exactly the limit is read and served');
  const oneOver = await fetch(`${sim.base}/alpha/offers`, { method: 'POST', headers, body: request.padEnd(64 * 1024 + 1) });
  assert.equal(oneOver.status, 413);
  const declared = await fetch(`${sim.base}/alpha/offers`, { method: 'POST', headers, body: JSON.stringify({ filler: 'x'.repeat(70 * 1024) }) });
  assert.equal(declared.status, 413);
  assert.equal((await declared.json()).code, 'PAYLOAD_TOO_LARGE');
  const streamed = await fetch(`${sim.base}/alpha/offers`, { method: 'POST', headers, body: stream(70), duplex: 'half' });
  assert.equal(streamed.status, 413);
  // Far over the limit the simulator stops reading: the caller gets a 413 or a
  // closed connection long before it has sent everything.
  const total = 2000;
  let sent = 0;
  const endless = (async function* () { for (; sent < total; sent++) yield Buffer.alloc(16 * 1024, 120); })();
  const huge = await fetch(`${sim.base}/alpha/offers`, { method: 'POST', headers, body: endless, duplex: 'half' })
    .then((res) => res.status, () => 'connection closed');
  assert.ok(huge === 413 || huge === 'connection closed', String(huge));
  assert.ok(sent < total, `the simulator read all ${total} chunks of a body far over its limit`);
  assert.equal((await call(sim.base, token, 'GET', '/alpha/versions')).status, 200);
});

test('each client keeps a bounded number of bookings; the oldest goes first', async () => {
  const token = await tokenFor(sim.base, 'beta', betaOne);
  const ids = [];
  for (let i = 0; i < 6; i++) {
    const offer = (await call(sim.base, token, 'POST', '/beta/offers', offerRequest())).body.offers[0];
    ids.push((await call(sim.base, token, 'POST', '/beta/bookings', bookingRequest(offer))).body.booking.id);
  }
  assert.equal((await call(sim.base, token, 'GET', `/beta/bookings/${ids[0]}`)).status, 404);
  assert.equal((await call(sim.base, token, 'GET', `/beta/bookings/${ids[5]}`)).status, 200);
});

test('a booking is gone after the time to live', async (t) => {
  const started = sim.clock.ms;
  t.after(() => { sim.clock.ms = started; });
  const { booking } = await sale('alpha', alphaTwo);
  sim.clock.ms += 3600 * 1000 + 1;
  const token = await tokenFor(sim.base, 'alpha', alphaTwo);
  assert.equal((await call(sim.base, token, 'GET', `/alpha/bookings/${booking.id}`)).status, 404);
});

// ── the log ─────────────────────────────────────────────────────────────────

test('the log names the provider and the client, also for a refusal, and never a header or a body', async () => {
  const token = await tokenFor(sim.base, 'alpha', alphaOne);
  sim.logs.length = 0;
  await call(sim.base, token, 'POST', '/alpha/offers?secret=in-the-query', offerRequest());
  await call(sim.base, token, 'GET', '/alpha/places');
  await call(sim.base, 'made.up', 'GET', '/alpha/versions');
  await tokenRequest('alpha', { headers: { Authorization: basic({ ...alphaOne, client_secret: 'wrong' }) } });
  assert.deepEqual(sim.logs.map((l) => [l.method, l.path, l.status, l.provider, l.client]), [
    ['POST', '/alpha/offers', 200, 'alpha', 'alpha-one'],
    ['GET', '/alpha/places', 501, 'alpha', 'alpha-one'],
    ['GET', '/alpha/versions', 401, 'alpha', undefined],
    ['POST', '/alpha/oauth/token', 401, 'alpha', undefined],
  ]);
  const written = JSON.stringify(sim.logs);
  for (const secret of [token, alphaOne.client_secret, 'in-the-query', 'urn:uic:stn']) {
    assert.equal(written.includes(secret), false, `the log must not contain ${secret.slice(0, 12)}`);
  }
});

// ── group products (#599) ─────────────────────────────────────────────────

test('weekend group, both directions: one COLLECTIVE admission per direction, one ticket for the whole booking', async () => {
  const token = await tokenFor(sim.base, 'gamma', gammaOne);
  const passengers = [
    { externalRef: 'P1', type: 'PERSON', dateOfBirth: '1980-05-05' },
    { externalRef: 'P2', type: 'PERSON', dateOfBirth: '2016-05-05' },
  ];
  const collective = { offerMode: 'COLLECTIVE' };
  const outboundRequest = offerRequest({ anonymousPassengerSpecifications: passengers, offerSearchCriteria: collective });
  outboundRequest.tripSearchCriteria.departureTime = '2026-11-21T08:00:00';
  const outbound = (await call(sim.base, token, 'POST', '/gamma/offers', outboundRequest)).body;
  const request = inboundRequest({ outboundTripIds: [outbound.trips[0].id] });
  request.anonymousPassengerSpecifications = passengers;
  request.offerSearchCriteria = collective;
  const both = (await call(sim.base, token, 'POST', '/gamma/offers', request)).body;
  const weekend = both.offers.find((o) => o.products[0].code === 'SIM_WEEKEND_GROUP');
  assert.deepEqual(weekend.admissionOfferParts.map((p) => [p.offerMode, p.passengerRefs.length]), [['COLLECTIVE', 2], ['COLLECTIVE', 2]]);
  const booking = (await call(sim.base, token, 'POST', '/gamma/bookings', bookingRequest(weekend))).body.booking;
  assert.deepEqual(booking.bookedOffers[0].admissions.map((a) => [a.offerMode, a.passengerIds.length]), [['COLLECTIVE', 2], ['COLLECTIVE', 2]]);
  const fulfillments = (await call(sim.base, token, 'POST', `/gamma/bookings/${booking.id}/fulfillments`, {})).body.fulfillments;
  assert.equal(fulfillments.length, 1);
  assert.deepEqual(fulfillments[0].bookingParts.map((p) => p.id), booking.bookedOffers[0].admissions.map((a) => a.id));
  // The group ticket, not sold on one ticket, keeps one per direction.
  const group = both.offers.find((o) => o.products[0].code === 'SIM_GROUP');
  const other = (await call(sim.base, token, 'POST', '/gamma/bookings', bookingRequest(group))).body.booking;
  assert.equal((await call(sim.base, token, 'POST', `/gamma/bookings/${other.id}/fulfillments`, {})).body.fulfillments.length, 2);
});

// ── travel class per leg (#600) ─────────────────────────────────────────────

test('class per leg: the booking keeps the upgrade part, and the ticket covers both parts', async () => {
  const token = await tokenFor(sim.base, 'gamma', gammaOne);
  const leg = (from, to, start, end, number, shortName) => ({
    timedLeg: {
      start: { stopPlaceRef: { objectType: 'StopPlaceRef', stopPlaceRef: from }, serviceDeparture: { timetabledTime: start } },
      end: { stopPlaceRef: { objectType: 'StopPlaceRef', stopPlaceRef: to }, serviceArrival: { timetabledTime: end } },
      service: { vehicleNumbers: [number], productCategory: { name: shortName, shortName } },
    },
  });
  const request = offerRequest({
    tripSpecifications: [{ legs: [
      leg('urn:uic:stn:0000001', 'urn:uic:stn:0000004', '2026-11-20T08:00:00+02:00', '2026-11-20T10:00:00+02:00', '101', 'IC'),
      leg('urn:uic:stn:0000004', 'urn:uic:stn:0000002', '2026-11-20T10:20:00+02:00', '2026-11-20T11:20:00+02:00', '202', 'R'),
    ] }],
    offerSearchCriteria: { travelClasses: ['FIRST'] },
  });
  delete request.tripSearchCriteria;
  const offer = (await call(sim.base, token, 'POST', '/gamma/offers', request)).body.offers[0];
  const booking = (await call(sim.base, token, 'POST', '/gamma/bookings', bookingRequest(offer))).body.booking;
  assert.deepEqual(booking.bookedOffers[0].admissions.map((a) => a.summaryProductId), offer.admissionOfferParts.map((p) => p.summaryProductId));
  assert.deepEqual(booking.bookedOffers[0].products.map((p) => p.type), ['ADMISSION', 'UPGRADE_POINT2POINT']);
  const fulfillments = (await call(sim.base, token, 'POST', `/gamma/bookings/${booking.id}/fulfillments`, {})).body.fulfillments;
  assert.equal(fulfillments.length, 1);
  assert.equal(fulfillments[0].bookingParts.length, 2);
});
