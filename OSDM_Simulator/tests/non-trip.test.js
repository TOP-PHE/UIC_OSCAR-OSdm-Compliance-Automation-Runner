// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1258: offers without a trip, valid between stop places or in zones; the
// stop places (GET/POST /places) and zones (GET /zones) they are asked for.

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
  assert.equal(gamma.nonTrip.places.length, 3);
  assert.equal(gamma.nonTrip.withoutValidityFrom, NORTH);
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
});

test('places: every offer has no trip, and each admission is valid between the stop places asked', () => {
  const { response, remembered, trips } = buildOfferCollection(byPlaces([CENTRAL, AIRPORT]), gamma, NOW);
  assert.equal(response.trips, undefined);
  assert.deepEqual(trips, []);
  assert.ok(response.offers.length > 0);
  for (const offer of response.offers) assert.equal(offer.tripCoverage, undefined);
  for (const part of admissionsOf(response.offers)) {
    assert.equal(part.tripCoverage, undefined);
    assert.equal(part.validFrom, '2026-11-20T00:00:00+01:00');
    assert.equal(part.validUntil, '2026-11-21T00:00:00+01:00');
    assert.deepEqual(part.regionalValiditySummary, { description: 'Valid between Simtown Central, Simtown Airport, for one day', shortDescription: 'Simtown Central - Simtown Airport' });
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

test('refused: a trip besides, one place, another kind of place, a place twice, unknown or foreign zones, NUTS codes, both or neither', () => {
  const refused = (body, pattern) => assert.throws(() => buildOfferCollection(body, gamma, NOW), (e) => e.status === 400 && pattern.test(e.detail), JSON.stringify(body));
  refused(byPlaces([CENTRAL, AIRPORT], { tripSearchCriteria: {} }), /cannot go with tripSearchCriteria/);
  refused(byPlaces([CENTRAL]), /2 to 10 stop places/);
  refused({ ...byPlaces([CENTRAL]), nonTripSearchCriteria: { places: [stop(CENTRAL), { objectType: 'GeoPositionRef', latitude: 1, longitude: 2 }] } }, /only a StopPlaceRef/);
  refused(byPlaces([CENTRAL, CENTRAL]), /twice/);
  refused(byZones([{ id: 'NOWHERE', carrier: gamma.carrier.ref }]), /not a zone of this provider/);
  refused(byZones([{ id: 'SIM-CITY', carrier: 'urn:x_other:carrier' }]), /is defined by/);
  refused({ nonTripSearchCriteria: { nutsCodes: ['CZ010'] }, anonymousPassengerSpecifications: PAX }, /NUTS/);
  refused({ nonTripSearchCriteria: { places: [stop(CENTRAL), stop(AIRPORT)], zones: [{ id: 'SIM-CITY', carrier: gamma.carrier.ref }] }, anonymousPassengerSpecifications: PAX }, /either places or zones/);
  refused({ nonTripSearchCriteria: {}, anonymousPassengerSpecifications: PAX }, /either places or zones/);
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
    assert.deepEqual(all.body.places.map((p) => p.id), [CENTRAL, AIRPORT, NORTH]);
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
