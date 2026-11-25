// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1258: offers without a trip, valid between stop places or in zones; the
// stop places (GET/POST /places) and zones (GET /zones) they are asked for.
// #1266: the products sold without a trip, asked by tag or code, and the
// wrong variants.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { checkProvider } = require('../src/config');
const { buildOfferCollection } = require('../src/osdm/offers');
const { createBooking, confirmBooking } = require('../src/osdm/bookings');
const { shapeAnswer } = require('../src/osdm/versionShapes');
const { SECRETS, loadAllProviders, startSimulator, tokenFor, call, bookingRequest } = require('./helpers');

const providers = loadAllProviders();
const gamma = providers.get('gamma');
const plain = providers.get('plain');
const REAL = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
const NOW = Date.parse('2026-11-02T09:00:00Z');
const CENTRAL = 'urn:uic:stn:0000040';
const AIRPORT = 'urn:uic:stn:0000041';
const NORTH = 'urn:uic:stn:0000042';
const EAST = 'urn:uic:stn:0000043';
const WEST = 'urn:uic:stn:0000044';
const SOUTH = 'urn:uic:stn:0000045';
// #1437: where the offer request options apply without a trip.
const OPTIONVILLE = 'urn:uic:stn:0000046';
const ALL_PLACES = [CENTRAL, AIRPORT, NORTH, EAST, WEST, SOUTH, OPTIONVILLE];
const PAX = [{ externalRef: '00001', type: 'PERSON', dateOfBirth: '1990-01-15' }];

const stop = (stopPlaceRef) => ({ objectType: 'StopPlaceRef', stopPlaceRef });
const byPlaces = (refs, extra = {}) => ({
  nonTripSearchCriteria: { validFrom: '2026-11-20T00:00:00+01:00', places: refs.map(stop) },
  anonymousPassengerSpecifications: PAX,
  ...extra,
});
const byZones = (zones, extra = {}) => ({
  nonTripSearchCriteria: { validFrom: '2026-11-20T00:00:00+01:00', zones },
  anonymousPassengerSpecifications: PAX,
  ...extra,
});
const admissionsOf = (offers) => offers.flatMap((o) => o.admissionOfferParts);

let sim;
before(async () => { sim = await startSimulator(); });
after(async () => { await sim.close(); });

test('every provider sells without a trip, with the same stop places and zones; plain does not', () => {
  for (const key of REAL) assert.deepEqual(providers.get(key).nonTrip, gamma.nonTrip, key);
  assert.deepEqual(gamma.nonTrip.places.map((p) => p.id), ALL_PLACES);
  assert.equal(gamma.nonTrip.withoutValidityFrom, NORTH);
  assert.deepEqual(gamma.nonTrip.variants, { tripCoverage: EAST, otherPlaces: WEST, otherCarrier: SOUTH });
  assert.deepEqual(gamma.nonTrip.products.map((p) => [p.code, p.type, p.by.join('+')]), [
    ['SIM_SINGLE_RIDE', 'ADMISSION_POINT2POINT', 'PLACES+ZONES'],
    ['SIM_DAY_PASS', 'ADMISSION_PASS', 'ZONES'],
    ['SIM_TEN_RIDES', 'ADMISSION_MULTI_RIDE', 'PLACES+ZONES'],
  ]);
  assert.equal(plain.nonTrip, undefined);
});

test('a wrong nonTrip profile stops the start', () => {
  const base = { ...JSON.parse(JSON.stringify(gamma)), key: undefined };
  const raw = (nonTrip) => ({ ...base, carrier: gamma.carrier, nonTrip });
  const places = gamma.nonTrip.places;
  for (const wrong of [
    null,
    { places: places.slice(0, 1), zones: gamma.nonTrip.zones },
    { places: [...places, places[0]], zones: gamma.nonTrip.zones },
    { places: [{ id: 'not-a-urn', name: 'X' }, ...places], zones: gamma.nonTrip.zones },
    { places, zones: [] },
    { places, zones: [{ id: 'Z', name: 'Z', zoneId: 1, places: ['urn:uic:stn:9999999'] }] },
    { places, zones: gamma.nonTrip.zones, withoutValidityFrom: 'urn:uic:stn:9999999' },
  ]) {
    assert.throws(() => checkProvider('gamma', raw(wrong)), /nonTrip/, JSON.stringify(wrong));
  }
  // #1266: the products and the wrong variants.
  const ok = { places, zones: gamma.nonTrip.zones, products: gamma.nonTrip.products };
  const product = gamma.nonTrip.products[0];
  for (const wrong of [
    { ...ok, products: undefined },
    { ...ok, products: [] },
    { ...ok, products: [{ ...product, type: 'ADMISSION' }] },
    { ...ok, products: [{ ...product, by: [] }] },
    { ...ok, products: [{ ...product, by: ['PLACES', 'PLACES'] }] },
    { ...ok, products: [{ ...product, validityMinutes: 10 }] },
    { ...ok, products: [{ ...product, by: ['PLACES'] }] },
    { ...ok, products: [product, product] },
    { ...ok, variants: { tripCoverage: 'urn:uic:stn:9999999' } },
    { ...ok, variants: { elsewhere: EAST } },
    { ...ok, variants: { tripCoverage: EAST, otherPlaces: EAST } },
    { ...ok, withoutValidityFrom: NORTH, variants: { tripCoverage: NORTH } },
  ]) {
    assert.throws(() => checkProvider('gamma', raw(wrong)), /nonTrip/, JSON.stringify(wrong));
  }
});

const productOfPart = (offer, part) => offer.products.find((p) => p.id === part.products[0].productId);
const UNTIL = { SIM_SINGLE_RIDE: '2026-11-20T02:00:00+01:00', SIM_DAY_PASS: '2026-11-21T00:00:00+01:00', SIM_TEN_RIDES: '2026-12-20T00:00:00+01:00' };
const FOR = { SIM_SINGLE_RIDE: 'Single ride, valid between Simtown Central, Simtown Airport, for 2 hours', SIM_TEN_RIDES: 'Ten-ride card, valid between Simtown Central, Simtown Airport, for 30 days' };

test('places: every offer has no trip, and each admission is valid between the stop places asked', () => {
  const { response, remembered, trips } = buildOfferCollection(byPlaces([CENTRAL, AIRPORT]), gamma, NOW);
  assert.equal(response.trips, undefined);
  assert.deepEqual(trips, []);
  assert.ok(response.offers.length > 0);
  for (const offer of response.offers) assert.equal(offer.tripCoverage, undefined);
  for (const offer of response.offers) for (const part of offer.admissionOfferParts) {
    const { code } = productOfPart(offer, part);
    assert.equal(part.tripCoverage, undefined);
    assert.equal(part.validFrom, '2026-11-20T00:00:00+01:00');
    assert.equal(part.validUntil, UNTIL[code], code);
    assert.deepEqual(part.regionalValiditySummary, { description: FOR[code], shortDescription: 'Simtown Central - Simtown Airport' });
    assert.equal(part.regionalValidities.length, 1);
    const { route } = part.regionalValidities[0];
    assert.deepEqual(route.routeItemList.map((item) => item.station.id), [CENTRAL, AIRPORT]);
    assert.deepEqual(route.routeItem.routeItemIndices, [0, 1]);
  }
  assert.ok(remembered.every((entry) => entry.trips.length === 0));
});

test('places: the same stop places, the same prices; others, other prices', () => {
  const prices = (refs) => buildOfferCollection(byPlaces(refs), gamma, NOW).response.offers.map((o) => o.offerSummary.minimalPrice.amount);
  assert.deepEqual(prices([CENTRAL, AIRPORT]), prices([CENTRAL, AIRPORT]));
  assert.notDeepEqual(prices([CENTRAL, AIRPORT]), prices([CENTRAL, NORTH]));
});

test('zones: each admission is valid in a Zone of the provider\'s carrier', () => {
  const { response } = buildOfferCollection(byZones([{ id: 'SIM-CITY', carrier: gamma.carrier.ref }]), gamma, NOW);
  assert.ok(response.offers.length > 0);
  for (const part of admissionsOf(response.offers)) {
    assert.equal(part.tripCoverage, undefined);
    assert.deepEqual(part.regionalValidities, [{ seqNb: 1, zone: { carrier: gamma.carrier.ref, name: 'Simtown city', zoneIds: [100] } }]);
    assert.equal(part.regionalValiditySummary.shortDescription, 'Simtown city');
  }
});

test('the wrong variant: from its stop place, or in its zone, the admissions say nothing of where they are valid', () => {
  for (const request of [byPlaces([NORTH, CENTRAL]), byZones([{ id: 'SIM-NORTH', carrier: gamma.carrier.ref }])]) {
    const { response } = buildOfferCollection(request, gamma, NOW);
    for (const part of admissionsOf(response.offers)) {
      assert.equal(part.regionalValidities, undefined);
      assert.equal(part.regionalValiditySummary, undefined);
    }
  }
});

test('refused: a trip besides, one place, another kind of place, a place twice, unknown or foreign zones, unknown NUTS codes, two kinds or none', () => {
  const refused = (body, pattern) => assert.throws(() => buildOfferCollection(body, gamma, NOW), (e) => e.status === 400 && pattern.test(e.detail), JSON.stringify(body));
  refused(byPlaces([CENTRAL, AIRPORT], { tripSearchCriteria: {} }), /cannot go with tripSearchCriteria/);
  refused(byPlaces([CENTRAL]), /2 to 10 stop places/);
  refused({ ...byPlaces([CENTRAL]), nonTripSearchCriteria: { places: [stop(CENTRAL), { objectType: 'GeoPositionRef', latitude: 1, longitude: 2 }] } }, /only a StopPlaceRef/);
  refused(byPlaces([CENTRAL, CENTRAL]), /twice/);
  refused(byZones([{ id: 'NOWHERE', carrier: gamma.carrier.ref }]), /not a zone of this provider/);
  refused(byZones([{ id: 'SIM-CITY', carrier: 'urn:x_other:carrier' }]), /is defined by/);
  refused({ nonTripSearchCriteria: { nutsCodes: ['CZ010'] }, anonymousPassengerSpecifications: PAX }, /no NUTS code of this provider/);
  refused({ nonTripSearchCriteria: { nutsCodes: ['XS111', 'XS111'] }, anonymousPassengerSpecifications: PAX }, /twice/);
  refused({ nonTripSearchCriteria: { nutsCodes: [] }, anonymousPassengerSpecifications: PAX }, /1 to 10 codes/);
  refused({ nonTripSearchCriteria: { nutsCodes: ['XS111'], zones: [{ id: 'SIM-CITY', carrier: gamma.carrier.ref }] }, anonymousPassengerSpecifications: PAX }, /either places, zones or nutsCodes/);
  refused({ nonTripSearchCriteria: { places: [stop(CENTRAL), stop(AIRPORT)], zones: [{ id: 'SIM-CITY', carrier: gamma.carrier.ref }] }, anonymousPassengerSpecifications: PAX }, /either places, zones or nutsCodes/);
  refused({ nonTripSearchCriteria: {}, anonymousPassengerSpecifications: PAX }, /either places, zones or nutsCodes/);
  assert.throws(() => buildOfferCollection(byPlaces([CENTRAL, AIRPORT]), plain, NOW), (e) => /trips only/.test(e.detail));
});

test('booked and fulfilled: the admissions keep their validity, no trip anywhere', () => {
  const { response, remembered } = buildOfferCollection(byPlaces([CENTRAL, AIRPORT]), gamma, NOW);
  const byId = new Map(remembered.map((e) => [e.offer.offerId, e]));
  const offer = response.offers[0];
  const booking = createBooking(bookingRequest(offer), (id) => byId.get(id), gamma, NOW);
  assert.deepEqual(booking.trips, []);
  const [admission] = booking.bookedOffers[0].admissions;
  assert.equal(admission.tripCoverage, undefined);
  assert.deepEqual(admission.regionalValidities, offer.admissionOfferParts[0].regionalValidities);
  const fulfillments = confirmBooking(booking, gamma, NOW + 1000);
  assert.equal(fulfillments.length, 1);
  assert.equal(fulfillments[0].tripCoverage, undefined);
});

test('below 3.7 an admission holds the one regionalValidity; from 3.7 the list', () => {
  const { response } = buildOfferCollection(byPlaces([CENTRAL, AIRPORT]), gamma, NOW);
  const old = shapeAnswer(response, '3.6.0');
  for (const part of admissionsOf(old.offers)) {
    assert.equal(part.regionalValidities, undefined);
    assert.ok(part.regionalValidity.route);
  }
  assert.ok(admissionsOf(shapeAnswer(response, '3.7.0').offers).every((p) => Array.isArray(p.regionalValidities)));
});

test('over HTTP, in each provider\'s version: places, zones, a non-trip sale', async () => {
  for (const key of REAL) {
    const token = await tokenFor(sim.base, key, SECRETS[key][0]);
    const all = await call(sim.base, token, 'GET', `/${key}/places`);
    assert.equal(all.status, 200, key);
    assert.deepEqual(all.body.places.map((p) => p.id), ALL_PLACES);
    assert.ok(all.body.places.every((p) => p.objectType === 'StopPlace' && p.name));

    const found = await call(sim.base, token, 'POST', `/${key}/places`, { placeInput: { name: 'simtown' }, restrictions: { type: 'STOP', numberOfResults: 2 } });
    assert.equal(found.status, 200, key);
    assert.deepEqual(found.body.places.map((p) => p.id), [CENTRAL, AIRPORT]);
    const airport = await call(sim.base, token, 'POST', `/${key}/places`, { placeInput: { name: 'Airport' } });
    assert.deepEqual(airport.body.places.map((p) => p.id), [AIRPORT]);
    const one = await call(sim.base, token, 'GET', `/${key}/places/${encodeURIComponent(AIRPORT)}`);
    assert.equal(one.body.places[0].name, 'Simtown Airport');
    assert.equal((await call(sim.base, token, 'GET', `/${key}/places/urn:uic:stn:1`)).status, 404);
    assert.equal((await call(sim.base, token, 'POST', `/${key}/places`, { restrictions: { numberOfResults: 0 } })).status, 400);

    const zones = await call(sim.base, token, 'GET', `/${key}/zones`);
    assert.equal(zones.status, 200, key);
    const zone = zones.body.zones[0];
    assert.equal(zone.id, 'SIM-CITY');
    assert.equal(zone.carrier, providers.get(key).carrier.ref);

    for (const body of [byPlaces([CENTRAL, AIRPORT]), byZones([{ id: zone.id, carrier: zone.carrier }])]) {
      const offers = await call(sim.base, token, 'POST', `/${key}/offers`, body);
      assert.equal(offers.status, 200, `${key} ${JSON.stringify(offers.body).slice(0, 300)}`);
      assert.equal(offers.body.trips, undefined);
      const offer = offers.body.offers[0];
      const booked = await call(sim.base, token, 'POST', `/${key}/bookings`, bookingRequest(offer));
      assert.equal(booked.status, 200, `${key} ${JSON.stringify(booked.body).slice(0, 300)}`);
      const bookingId = booked.body.booking.id;
      const confirmed = await call(sim.base, token, 'POST', `/${key}/bookings/${bookingId}/fulfillments`, {});
      assert.equal(confirmed.status, 200, `${key} ${JSON.stringify(confirmed.body).slice(0, 300)}`);
      const read = await call(sim.base, token, 'GET', `/${key}/bookings/${bookingId}`);
      const admission = read.body.booking.bookedOffers[0].admissions[0];
      assert.equal(admission.tripCoverage, undefined);
      assert.ok(admission.regionalValidities || admission.regionalValidity, key);
    }
  }
});

// ── #1266: the products sold without a trip ─────────────────────────────────

const codesOf = (offers) => offers.map((o) => `${o.products[0].code}/${o.products[0].travelClass}`);
const CITY = { id: 'SIM-CITY', carrier: gamma.carrier.ref };

test('the products: a single ride and a ten-ride card between stop places; a day pass too in zones; in each class asked', () => {
  const places = buildOfferCollection(byPlaces([CENTRAL, AIRPORT]), gamma, NOW).response.offers;
  assert.deepEqual(codesOf(places), ['SIM_SINGLE_RIDE/SECOND', 'SIM_TEN_RIDES/SECOND']);
  const both = buildOfferCollection(byPlaces([CENTRAL, AIRPORT], { offerSearchCriteria: { travelClasses: ['FIRST', 'SECOND'] } }), gamma, NOW).response.offers;
  assert.deepEqual(codesOf(both).sort(), ['SIM_SINGLE_RIDE/FIRST', 'SIM_SINGLE_RIDE/SECOND', 'SIM_TEN_RIDES/FIRST', 'SIM_TEN_RIDES/SECOND']);
  const zones = buildOfferCollection(byZones([CITY]), gamma, NOW).response.offers;
  assert.deepEqual(codesOf(zones), ['SIM_SINGLE_RIDE/SECOND', 'SIM_DAY_PASS/SECOND', 'SIM_TEN_RIDES/SECOND']);
  for (const offer of zones) {
    const [product] = offer.products;
    assert.equal(product.isTrainBound, false);
    assert.equal(offer.offerSummary.overallFlexibility, product.flexibility);
    assert.equal(product.productTags, undefined, 'tags only in an answer to a product request');
    assert.equal(offer.admissionOfferParts[0].summaryProductId, product.id);
  }
  const pass = zones.find((o) => o.products[0].code === 'SIM_DAY_PASS');
  assert.equal(pass.products[0].type, 'ADMISSION_PASS');
  assert.equal(pass.admissionOfferParts[0].validUntil, '2026-11-21T00:00:00+01:00');
  assert.equal(pass.admissionOfferParts[0].refundable, 'WITH_CONDITION');
});

test('a flexibility asked keeps the products of that flexibility', () => {
  const asked = (flexibilities) => codesOf(buildOfferCollection(byZones([CITY], { offerSearchCriteria: { flexibilities } }), gamma, NOW).response.offers);
  assert.deepEqual(asked(['NON_FLEXIBLE']), ['SIM_SINGLE_RIDE/SECOND']);
  assert.deepEqual(asked(['SEMI_FLEXIBLE', 'FULL_FLEXIBLE']), ['SIM_DAY_PASS/SECOND', 'SIM_TEN_RIDES/SECOND']);
});

test('by product tag: the offers of that tag, tagged; a tag not sold for the request gets the usual offers and the problem', () => {
  const pass = buildOfferCollection(byZones([CITY], { offerSearchCriteria: { productTags: ['ADMISSION_PASS'] } }), gamma, NOW).response;
  assert.deepEqual(codesOf(pass.offers), ['SIM_DAY_PASS/SECOND']);
  assert.ok(pass.offers.every((o) => o.products[0].productTags[0] === 'ADMISSION_PASS'));
  assert.equal(pass.problems, undefined);

  const rides = buildOfferCollection(byPlaces([CENTRAL, AIRPORT], { offerSearchCriteria: { productTags: ['ADMISSION_MULTI_RIDE'] } }), gamma, NOW).response;
  assert.deepEqual(codesOf(rides.offers), ['SIM_TEN_RIDES/SECOND']);

  // A pass is sold in zones only: between stop places, the usual offers and PARAMETER_NOT_SUPPORTED.
  const none = buildOfferCollection(byPlaces([CENTRAL, AIRPORT], { offerSearchCriteria: { productTags: ['ADMISSION_PASS'] } }), gamma, NOW).response;
  assert.equal(none.offers.length, 2);
  assert.deepEqual(none.problems.map((p) => [p.code, p.pointers[0].requestPointer]), [['PARAMETER_NOT_SUPPORTED', '/offerSearchCriteria/productTags']]);
});

test('by product selection: a code, or a tag', () => {
  const byCode = buildOfferCollection(byZones([CITY], { offerSearchCriteria: { productSelections: [{ productCode: 'SIM_DAY_PASS', numberOfItems: 1 }] } }), gamma, NOW).response;
  assert.deepEqual(codesOf(byCode.offers), ['SIM_DAY_PASS/SECOND']);
  const byTag = buildOfferCollection(byZones([CITY], { offerSearchCriteria: { productSelections: [{ productTag: 'ADMISSION_POINT2POINT' }] } }), gamma, NOW).response;
  assert.deepEqual(codesOf(byTag.offers), ['SIM_SINGLE_RIDE/SECOND']);
  const unknown = buildOfferCollection(byZones([CITY], { offerSearchCriteria: { productSelections: [{ productCode: 'SIM_NOTHING' }] } }), gamma, NOW).response;
  assert.equal(unknown.offers.length, 3);
  assert.equal(unknown.problems[0].code, 'PARAMETER_NOT_SUPPORTED');
});

test('a trip request still knows only its own tags: a pass asked for a trip is ignored, as before', () => {
  const { selectProducts } = require('../src/osdm/productSelection');
  const tripOffers = [{ products: [{ code: 'X', type: 'ADMISSION' }] }];
  const answer = selectProducts({ productTags: ['ADMISSION_PASS'] }, tripOffers);
  assert.equal(answer.offers.length, 1);
  assert.equal(answer.problems[0].code, 'PARAMETER_NOT_SUPPORTED');
});

test('wrong variant tripCoverage: from its stop place, the admissions, and the booked ones, cover a trip', () => {
  const { response, remembered } = buildOfferCollection(byPlaces([EAST, CENTRAL]), gamma, NOW);
  for (const part of admissionsOf(response.offers)) assert.deepEqual(part.tripCoverage, { coveredTripId: 'GAMMA-TRIP-NONTRIP' });
  const byId = new Map(remembered.map((e) => [e.offer.offerId, e]));
  const booking = createBooking(bookingRequest(response.offers[0]), (id) => byId.get(id), gamma, NOW);
  assert.deepEqual(booking.bookedOffers[0].admissions[0].tripCoverage, { coveredTripId: 'GAMMA-TRIP-NONTRIP' });
});

test('wrong variant otherPlaces: from its stop place, a route through other stop places', () => {
  const { response } = buildOfferCollection(byPlaces([WEST, CENTRAL]), gamma, NOW);
  for (const part of admissionsOf(response.offers)) {
    const stations = part.regionalValidities[0].route.routeItemList.map((item) => item.station.id);
    assert.deepEqual(stations, [AIRPORT, NORTH]);
    assert.equal(part.tripCoverage, undefined);
  }
});

test('wrong variant otherCarrier: in its zone, zones of another carrier; between stop places, nothing changes', () => {
  const south = buildOfferCollection(byZones([{ id: 'SIM-SOUTH', carrier: gamma.carrier.ref }]), gamma, NOW).response;
  for (const part of admissionsOf(south.offers)) {
    assert.deepEqual(part.regionalValidities, [{ seqNb: 1, zone: { carrier: 'urn:x_osdm_simulator:carrier:other', name: 'Simtown south', zoneIds: [102] } }]);
  }
  const places = buildOfferCollection(byPlaces([SOUTH, CENTRAL]), gamma, NOW).response;
  for (const part of admissionsOf(places.offers)) assert.ok(part.regionalValidities[0].route);
});

test('over HTTP, in each provider\'s version: a pass asked by tag, and the wrong variants answer as OSDM allows', async () => {
  for (const key of REAL) {
    const token = await tokenFor(sim.base, key, SECRETS[key][0]);
    const carrier = providers.get(key).carrier.ref;
    for (const body of [
      byZones([{ id: 'SIM-CITY', carrier }], { offerSearchCriteria: { productTags: ['ADMISSION_PASS'] } }),
      byPlaces([EAST, CENTRAL]),
      byPlaces([WEST, CENTRAL]),
      byZones([{ id: 'SIM-SOUTH', carrier }]),
    ]) {
      const offers = await call(sim.base, token, 'POST', `/${key}/offers`, body);
      assert.equal(offers.status, 200, `${key} ${JSON.stringify(offers.body).slice(0, 300)}`);
      assert.ok(offers.body.offers.length > 0, key);
    }
  }
});

// ── #1266: NUTS codes ────────────────────────────────────────────────────────

const byNuts = (codes, extra = {}) => ({
  nonTripSearchCriteria: { validFrom: '2026-11-20T00:00:00+01:00', nutsCodes: codes },
  anonymousPassengerSpecifications: PAX,
  ...extra,
});

test('NUTS: the zones name made-up NUTS codes, each in one zone; a wrong one stops the start', () => {
  assert.deepEqual(gamma.nonTrip.zones.map((z) => [z.id, z.nutsCodes]), [['SIM-CITY', ['XS111']], ['SIM-NORTH', ['XS112']], ['SIM-SOUTH', undefined], ['SIM-OPTIONS', undefined]]);
  const base = { ...JSON.parse(JSON.stringify(gamma)), key: undefined };
  const withZones = (zones) => ({ ...base, carrier: gamma.carrier, nonTrip: { ...base.nonTrip, zones } });
  const [city, north] = gamma.nonTrip.zones;
  for (const wrong of [
    [{ ...city, nutsCodes: ['xs111'] }, north],
    [{ ...city, nutsCodes: ['X1'] }, north],
    [{ ...city, nutsCodes: [] }, north],
    [{ ...city, nutsCodes: ['XS111'] }, { ...north, nutsCodes: ['XS111'] }],
  ]) {
    assert.throws(() => checkProvider('gamma', withZones(wrong)), /nonTrip/, JSON.stringify(wrong));
  }
});

test('NUTS: a region asked by its code is sold what its zone is; each admission is valid in a Zone naming the code', () => {
  const { response } = buildOfferCollection(byNuts(['XS111']), gamma, NOW);
  assert.equal(response.trips, undefined);
  assert.deepEqual(codesOf(response.offers), ['SIM_SINGLE_RIDE/SECOND', 'SIM_DAY_PASS/SECOND', 'SIM_TEN_RIDES/SECOND']);
  for (const part of admissionsOf(response.offers)) {
    assert.deepEqual(part.regionalValidities, [{ seqNb: 1, zone: { carrier: gamma.carrier.ref, name: 'Simtown city', zoneIds: [100], nutsCode: 'XS111' } }]);
    assert.ok(part.regionalValiditySummary.description.includes('in Simtown city (XS111)'), part.regionalValiditySummary.description);
  }
  // Two codes: a Zone each.
  const two = admissionsOf(buildOfferCollection(byNuts(['XS111', 'XS112']), gamma, NOW).response.offers)[0];
  assert.deepEqual(two.regionalValidities.map((v) => v.zone.nutsCode), ['XS111', 'XS112']);
});

test('NUTS: the region by code and the zone sell the same products', () => {
  const nuts = buildOfferCollection(byNuts(['XS111']), gamma, NOW).response.offers;
  const zone = buildOfferCollection(byZones([CITY]), gamma, NOW).response.offers;
  assert.deepEqual(codesOf(nuts), codesOf(zone));
});

test("over HTTP, in each provider's version: GET /zones names the NUTS codes; a sale by NUTS code; an unknown code refused", async () => {
  for (const key of REAL) {
    const token = await tokenFor(sim.base, key, SECRETS[key][0]);
    const zones = await call(sim.base, token, 'GET', `/${key}/zones`);
    assert.deepEqual(zones.body.zones.map((z) => z.nutsCodes), [['XS111'], ['XS112'], undefined, undefined], key);
    const offers = await call(sim.base, token, 'POST', `/${key}/offers`, byNuts(['XS111']));
    assert.equal(offers.status, 200, `${key} ${JSON.stringify(offers.body).slice(0, 300)}`);
    const offer = offers.body.offers[0];
    const booked = await call(sim.base, token, 'POST', `/${key}/bookings`, bookingRequest(offer));
    assert.equal(booked.status, 200, `${key} ${JSON.stringify(booked.body).slice(0, 300)}`);
    const confirmed = await call(sim.base, token, 'POST', `/${key}/bookings/${booked.body.booking.id}/fulfillments`, {});
    assert.equal(confirmed.status, 200, key);
    const read = await call(sim.base, token, 'GET', `/${key}/bookings/${booked.body.booking.id}`);
    const admission = read.body.booking.bookedOffers[0].admissions[0];
    const validity = admission.regionalValidities ? admission.regionalValidities[0] : admission.regionalValidity;
    assert.equal(validity.zone.nutsCode, 'XS111', key);
    const unknown = await call(sim.base, token, 'POST', `/${key}/offers`, byNuts(['XS999']));
    assert.equal(unknown.status, 400, key);
    // The Problem points at the code refused.
    assert.deepEqual(unknown.body.pointers, [{ requestPointer: '/nonTripSearchCriteria/nutsCodes/0' }], key);
  }
});

// ── #1444, #1449: fares without a trip ──────────────────────────────────────

const faresOf = (offers) => offers.flatMap((o) => o.fares || []);
const fareAsking = (body, criteria) => ({ ...body, offerSearchCriteria: { requestedOfferParts: ['FARE_ADMISSION'], ...criteria } });

test('#1449: every provider lists two fares sold without a trip, by zone (and NUTS region) and between stop places', () => {
  assert.deepEqual(gamma.nonTrip.fares.map((f) => [f.code, f.tag, f.by.join('+')]), [
    ['SIM_FARE_ZONE', 'FARE_ZONE', 'ZONES'],
    ['SIM_FARE_POINT2POINT', 'FARE_POINT2POINT', 'PLACES'],
  ]);
  const base = { ...JSON.parse(JSON.stringify(gamma)), key: undefined };
  const raw = (fares) => ({ ...base, carrier: gamma.carrier, nonTrip: { ...base.nonTrip, fares } });
  const fare = gamma.nonTrip.fares[0];
  for (const wrong of [[], [{ ...fare, tag: 'ADMISSION_PASS' }], [fare, { ...fare, tag: 'FARE_POINT2POINT' }], [fare, { ...fare, code: 'SIM_OTHER' }],
    [{ ...fare, by: ['NUTS'] }], [{ ...fare, factor: 0 }], [{ ...fare, flexibility: 'SOMETIMES' }]]) {
    assert.throws(() => checkProvider('gamma', raw(wrong)), /nonTrip\.fares/, JSON.stringify(wrong));
  }
  assert.equal(checkProvider('gamma', raw(undefined)).nonTrip.fares, undefined, 'absent: no fare without a trip');
});

test("#1449: without a trip, fares are sold in every provider's version: in a zone, a NUTS region, between stop places; booked and confirmed", async () => {
  for (const key of REAL) {
    const token = await tokenFor(sim.base, key, SECRETS[key][0]);
    const carrier = providers.get(key).carrier.ref;
    const asks = [
      ['zone', byZones([{ id: 'SIM-CITY', carrier }]), (v) => v.zone?.name === 'Simtown city' && v.zone.nutsCode === undefined],
      ['NUTS', { ...byZones([]), nonTripSearchCriteria: { validFrom: '2026-11-20T00:00:00+01:00', nutsCodes: ['XS111'] } }, (v) => v.zone?.nutsCode === 'XS111'],
      ['places', byPlaces([CENTRAL, AIRPORT]), (v) => v.route?.routeItemList?.length === 2],
    ];
    for (const [what, body, validityOk] of asks) {
      const res = await call(sim.base, token, 'POST', `/${key}/offers`, fareAsking(body, { travelClasses: ['SECOND', 'FIRST'] }));
      assert.equal(res.status, 200, `${key} ${what} ${JSON.stringify(res.body).slice(0, 300)}`);
      assert.equal(res.body.trips, undefined, key);
      const offers = res.body.offers;
      assert.deepEqual(offers.map((o) => o.fares[0].travelClass), ['SECOND', 'FIRST'], `${key} ${what}: one offer per class asked`);
      for (const offer of offers) {
        assert.equal(offer.tripCoverage, undefined, key);
        assert.equal(offer.products, undefined, `${key} ${what}: fare parts only asked, no product`);
        assert.equal(offer.fares.length, PAX.length, key);
      }
      for (const fare of faresOf(offers)) {
        assert.equal(fare.type, 'ADMISSION');
        assert.equal(fare.coveredSection, undefined, `${key} ${what}: no section of a trip`);
        assert.deepEqual(fare.combinationConstraint, [{ model: 'SEPARATE_TICKET' }]);
        assert.ok(fare.regionalConstraint.regionalValidities.every(validityOk), `${key} ${what} ${JSON.stringify(fare.regionalConstraint)}`);
        assert.equal(fare.name.text, what === 'places' ? 'Fare between stop places' : 'Zone fare', key);
      }
      // The fare offer is booked like any other, and confirmed with a fulfilment of fares.
      const booked = await call(sim.base, token, 'POST', `/${key}/bookings`, bookingRequest(offers[0]));
      assert.equal(booked.status, 200, `${key} ${what} ${JSON.stringify(booked.body).slice(0, 300)}`);
      const bookedOffer = booked.body.booking.bookedOffers[0];
      assert.equal(bookedOffer.tripCoverage, undefined, key);
      assert.deepEqual(bookedOffer.fares.map((f) => f.status), ['PREBOOKED'], key);
      const confirmed = await call(sim.base, token, 'POST', `/${key}/bookings/${booked.body.booking.id}/fulfillments`, {});
      assert.equal(confirmed.status, 200, `${key} ${what} ${JSON.stringify(confirmed.body).slice(0, 300)}`);
      assert.equal(confirmed.body.fulfillments.length, 1, key);
      const read = await call(sim.base, token, 'GET', `/${key}/bookings/${booked.body.booking.id}`);
      assert.deepEqual(read.body.booking.bookedOffers[0].fares.map((f) => f.status), ['FULFILLED'], key);
    }
  }
});

test('#1449: products and fares asked together are both sold; a fare reservation alone is not, with a warning', async () => {
  const token = await tokenFor(sim.base, 'gamma', SECRETS.gamma[0]);
  const zone = byZones([{ id: 'SIM-CITY', carrier: gamma.carrier.ref }]);
  const both = await call(sim.base, token, 'POST', '/gamma/offers', fareAsking(zone, { requestedOfferParts: ['ADMISSION', 'FARE_ADMISSION'] }));
  assert.equal(both.status, 200);
  assert.ok(both.body.offers.some((o) => o.admissionOfferParts?.length > 0), 'product offers');
  assert.ok(both.body.offers.some((o) => o.fares?.length > 0), 'fare offers');
  const reservation = await call(sim.base, token, 'POST', '/gamma/offers', fareAsking(zone, { requestedOfferParts: ['FARE_RESERVATION'] }));
  assert.equal(reservation.status, 200);
  assert.deepEqual(reservation.body.offers, []);
  assert.deepEqual(reservation.body.problems.map((p) => p.code), ['OFFER_NO_RESULTS']);
});

test('#1449: a fare tag asked chooses the fare and is not reported ignored; a tag of the other form gives no fare', () => {
  const zone = byZones([{ id: 'SIM-CITY', carrier: gamma.carrier.ref }]);
  const { response } = buildOfferCollection(fareAsking(zone, { productTags: ['FARE_ZONE'] }), gamma, NOW);
  assert.deepEqual(faresOf(response.offers).map((f) => f.name.text), ['Zone fare']);
  assert.equal(response.problems, undefined);
  const other = buildOfferCollection(fareAsking(zone, { productTags: ['FARE_POINT2POINT'] }), gamma, NOW).response;
  assert.deepEqual(other.offers, []);
  assert.deepEqual(other.problems.map((p) => p.code), ['OFFER_NO_RESULTS']);
  // A flexibility the fares are not sold in gives none either.
  const flexible = buildOfferCollection(fareAsking(zone, { flexibilities: ['FULL_FLEXIBLE'] }), gamma, NOW).response;
  assert.deepEqual(flexible.offers, []);
});

test('#1444: a provider whose profile lists no fare without a trip refuses fare parts: 400 pointing at them; without them, as before', () => {
  const raw = { ...JSON.parse(JSON.stringify(gamma)), key: undefined, carrier: gamma.carrier };
  delete raw.nonTrip.fares;
  const without = checkProvider('gamma', raw);
  for (const parts of [['FARE_ADMISSION'], ['ADMISSION', 'FARE_ADMISSION'], ['FARE_RESERVATION']]) {
    for (const body of [byPlaces([CENTRAL, AIRPORT]), byZones([{ id: 'SIM-CITY', carrier: gamma.carrier.ref }])]) {
      assert.throws(() => buildOfferCollection({ ...body, offerSearchCriteria: { requestedOfferParts: parts } }, without, NOW),
        (err) => err.status === 400 && err.code === 'FARE_WITHOUT_TRIP_NOT_SUPPORTED', String(parts));
    }
  }
  const zone = byZones([{ id: 'SIM-CITY', carrier: gamma.carrier.ref }]);
  const products = buildOfferCollection({ ...zone, offerSearchCriteria: { requestedOfferParts: ['ADMISSION'] } }, without, NOW);
  assert.ok(products.response.offers.length > 0);
});
