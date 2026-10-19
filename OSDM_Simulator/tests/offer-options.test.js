// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #780: what gamma does with the offer search criteria, and the stop place
// where it ignores them.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildOfferCollection } = require('../src/osdm/offers');
const { PROVIDERS_DIR, SECRETS, loadAllProviders, offerRequest, startSimulator, tokenFor, call } = require('./helpers');

const providers = loadAllProviders();
const gamma = providers.get('gamma');
const plain = providers.get('plain');
const NOW = Date.parse('2026-10-11T08:00:00Z');

function answer(criteria, { provider = gamma, from = 'urn:uic:stn:0000001' } = {}) {
  const request = offerRequest({ offerSearchCriteria: criteria });
  request.tripSearchCriteria.origin.stopPlaceRef = from;
  return buildOfferCollection(request, provider, NOW).response;
}
const classes = (response) => [...new Set(response.offers.map((o) => o.offerSummary.overallTravelClass))].sort();
const serviceClasses = (response) => [...new Set(response.offers.map((o) => o.offerSummary.overallServiceClass?.type))].sort();

test('service classes: HIGH is first class, STANDARD second, BEST and BASIC are not sold', () => {
  assert.deepEqual(classes(answer({ serviceClassTypes: ['HIGH'] })), ['FIRST']);
  assert.deepEqual(serviceClasses(answer({ serviceClassTypes: ['HIGH'] })), ['HIGH']);
  assert.deepEqual(classes(answer({ serviceClassTypes: ['STANDARD'] })), ['SECOND']);
  assert.deepEqual(classes(answer({ serviceClassTypes: ['HIGH', 'STANDARD'] })), ['FIRST', 'SECOND']);
  assert.equal(answer({ serviceClassTypes: ['BEST'] }).offers.length, 0);
  // With a travel class too, both must hold.
  assert.equal(answer({ serviceClassTypes: ['HIGH'], travelClasses: ['SECOND'] }).offers.length, 0);
  // Nothing asked: second class, as before.
  assert.deepEqual(classes(answer(undefined)), ['SECOND']);
  assert.deepEqual(classes(answer({ serviceClassTypes: ['ANY'] })), ['SECOND']);
});

test('offer parts without an admission: the usual offers, and a problem saying the member was ignored', () => {
  const reservationOnly = answer({ requestedOfferParts: ['RESERVATION'] });
  assert.ok(reservationOnly.offers.length > 0);
  assert.deepEqual(reservationOnly.problems, [{
    code: 'PARAMETER_NOT_SUPPORTED',
    title: "Parameter 'offerSearchCriteria.requestedOfferParts' was ignored.",
    detail: 'No offer without an admission is sold (asked: RESERVATION); offers with admissions are given.',
    pointers: [{ requestPointer: '/offerSearchCriteria/requestedOfferParts' }],
  }]);
  for (const parts of [['ADMISSION'], ['ADMISSION', 'RESERVATION'], ['ALL'], ['UNKNOWN']]) {
    assert.equal(answer({ requestedOfferParts: parts }).problems, undefined, parts.join());
  }
});

test('from the ignoring stop place, every provider answers as if no criteria were sent; elsewhere and on a provider without variants, it keeps to them', () => {
  const from = gamma.variants.ignoresOfferOptionsFrom;
  assert.equal(from, 'urn:uic:stn:0000090');
  for (const key of ['alpha', 'beta', 'gamma']) {
    assert.deepEqual(classes(answer({ travelClasses: ['FIRST'] }, { provider: providers.get(key), from })), ['SECOND'], key);
  }
  assert.equal(answer({ requestedOfferParts: ['RESERVATION'] }, { from }).problems, undefined);
  assert.deepEqual(classes(answer({ travelClasses: ['FIRST'] })), ['FIRST']);
  assert.deepEqual(classes(answer({ travelClasses: ['FIRST'] }, { provider: plain, from })), ['FIRST']);
});

test('the variant stop place is optional in a provider profile, and must be text when given', () => {
  const { checkProvider } = require('../src/config');
  const raw = JSON.parse(require('node:fs').readFileSync(require('node:path').join(PROVIDERS_DIR, 'gamma.json'), 'utf8'));
  const withVariants = (variants) => ({ ...raw, variants });
  assert.equal(checkProvider('gamma', withVariants({ wrongOffersFrom: 'x' })).variants.ignoresOfferOptionsFrom, undefined);
  assert.equal(checkProvider('gamma', withVariants({ wrongOffersFrom: 'x', ignoresOfferOptionsFrom: 'y' })).variants.ignoresOfferOptionsFrom, 'y');
  assert.throws(() => checkProvider('gamma', withVariants({ wrongOffersFrom: 'x', ignoresOfferOptionsFrom: 3 })), /variants/);
});

// #780 PR A: product tags and product selections.
const productsOf = (response) => response.offers.flatMap((o) => o.products);
const types = (response) => [...new Set(productsOf(response).map((p) => p.type))].sort();

test('product tags: offers holding a product of the tag, each product tagged; nothing tagged without the member', () => {
  const plainAnswer = answer(undefined);
  assert.ok(productsOf(plainAnswer).every((p) => p.productTags === undefined));
  const admissions = answer({ productTags: ['ADMISSION_POINT2POINT'] });
  assert.equal(admissions.offers.length, plainAnswer.offers.length);
  assert.equal(admissions.problems, undefined);
  for (const p of productsOf(admissions)) {
    if (p.type === 'ADMISSION') assert.deepEqual(p.productTags, ['ADMISSION_POINT2POINT']);
  }
  // No upgrade on this trip: no offer.
  assert.equal(answer({ productTags: ['UPGRADE_POINT2POINT'] }).offers.length, 0);
  // Only tags it does not sell: offers as without it, and the member ignored.
  const pass = answer({ productTags: ['ADMISSION_PASS'] });
  assert.equal(pass.offers.length, plainAnswer.offers.length);
  assert.deepEqual(pass.problems.map((p) => p.pointers[0].requestPointer), ['/offerSearchCriteria/productTags']);
  assert.deepEqual(types(pass), types(plainAnswer));
});

test('product selections: by product code, by tag, or ignored when neither is sold', () => {
  const plainAnswer = answer(undefined);
  const code = plainAnswer.offers[0].products[0].code;
  const byCode = answer({ productSelections: [{ productCode: code, numberOfItems: 1 }] });
  assert.ok(byCode.offers.length > 0 && byCode.offers.length < plainAnswer.offers.length);
  assert.ok(byCode.offers.every((o) => o.products.some((p) => p.code === code)));
  assert.equal(byCode.problems, undefined);
  assert.equal(answer({ productSelections: [{ productTag: 'ADMISSION_POINT2POINT' }] }).offers.length, plainAnswer.offers.length);
  const unknown = answer({ productSelections: [{ productCode: 'NOPE' }] });
  assert.equal(unknown.offers.length, plainAnswer.offers.length);
  assert.deepEqual(unknown.problems.map((p) => p.pointers[0].requestPointer), ['/offerSearchCriteria/productSelections']);
});

test('product tags and selections are read on every provider, and not from the ignoring stop place', () => {
  for (const key of ['alpha', 'beta', 'gamma', 'delta']) {
    assert.equal(answer({ productTags: ['UPGRADE_POINT2POINT'] }, { provider: providers.get(key) }).offers.length, 0, key);
  }
  const from = gamma.variants.ignoresOfferOptionsFrom;
  assert.ok(answer({ productTags: ['UPGRADE_POINT2POINT'] }, { from }).offers.length > 0);
});

test('an answer with tagged products conforms to each provider\'s OSDM version', async () => {
  const sim = await startSimulator();
  try {
    for (const key of ['alpha', 'beta', 'gamma', 'delta']) {
      const token = await tokenFor(sim.base, key, SECRETS[key][0]);
      const res = await call(sim.base, token, 'POST', `/${key}/offers`, offerRequest({ offerSearchCriteria: { productTags: ['ADMISSION_POINT2POINT'], productSelections: [{ productTag: 'RESERVATION' }] } }));
      assert.equal(res.status, 200, key);
      assert.ok(res.body.offers.flatMap((o) => o.products).some((p) => Array.isArray(p.productTags)), key);
    }
  } finally {
    await sim.close();
  }
});

// #780 PR B: a search through a via.
function viaAnswer(tripSearch) {
  const request = offerRequest({});
  Object.assign(request.tripSearchCriteria, tripSearch);
  return buildOfferCollection(request, gamma, NOW).response;
}

test('a via: two legs changing there after the dwell time; none, one direct leg as before', () => {
  const direct = viaAnswer({});
  assert.equal(direct.trips[0].legs.length, 1);
  const via = { objectType: 'StopPlaceRef', stopPlaceRef: 'urn:uic:stn:0000050' };
  const through = viaAnswer({ vias: [{ viaPlace: via, dwellTime: 'PT15M' }] });
  const [trip] = through.trips;
  assert.equal(trip.legs.length, 2);
  assert.equal(trip.transfers, 1);
  const [a, b] = trip.legs.map((l) => l.timedLeg);
  assert.equal(a.end.stopPlaceRef.stopPlaceRef, 'urn:uic:stn:0000050');
  assert.equal(b.start.stopPlaceRef.stopPlaceRef, 'urn:uic:stn:0000050');
  assert.equal(Date.parse(b.start.serviceDeparture.timetabledTime) - Date.parse(a.end.serviceArrival.timetabledTime), 15 * 60000);
  assert.equal(trip.startTime, direct.trips[0].startTime);
  assert.notEqual(a.service.vehicleNumbers[0], b.service.vehicleNumbers[0]);
  assert.ok(through.offers.length > 0);
  // No dwell time: 10 minutes. Arrival basis: it still arrives when asked.
  const tenMin = viaAnswer({ vias: [{ viaPlace: via }] }).trips[0].legs.map((l) => l.timedLeg);
  assert.equal(Date.parse(tenMin[1].start.serviceDeparture.timetabledTime) - Date.parse(tenMin[0].end.serviceArrival.timetabledTime), 10 * 60000);
  const byArrival = viaAnswer({ departureTime: undefined, arrivalTime: '2026-11-20T12:00:00', vias: [{ viaPlace: via }] }).trips[0];
  assert.equal(Date.parse(byArrival.endTime), Date.parse(viaAnswer({ departureTime: undefined, arrivalTime: '2026-11-20T12:00:00' }).trips[0].endTime));
});

test('an answer through a via conforms to each provider\'s OSDM version', async () => {
  const sim = await startSimulator();
  try {
    for (const key of ['alpha', 'beta', 'gamma', 'delta']) {
      const token = await tokenFor(sim.base, key, SECRETS[key][0]);
      const request = offerRequest({});
      request.tripSearchCriteria.vias = [{ viaPlace: { objectType: 'StopPlaceRef', stopPlaceRef: 'urn:uic:stn:0000050' } }];
      const res = await call(sim.base, token, 'POST', `/${key}/offers`, request);
      assert.equal(res.status, 200, key);
      assert.equal(res.body.trips[0].legs.length, 2, key);
    }
  } finally {
    await sim.close();
  }
});
