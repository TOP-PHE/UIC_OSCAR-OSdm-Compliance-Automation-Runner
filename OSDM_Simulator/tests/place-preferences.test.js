// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #766: place preferences, offered on the trips from one stop place,
// honoured at booking, and their availability asked by GET
// /availabilities/preferences.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkProvider } = require('../src/config');
const { buildOfferCollection } = require('../src/osdm/offers');
const { createBooking, addOfferParts } = require('../src/osdm/bookings');
const { preferenceAvailability } = require('../src/osdm/reservations');
const { SECRETS, loadAllProviders, startSimulator, tokenFor, call, offerRequest, bookingRequest } = require('./helpers');

const providers = loadAllProviders();
const gamma = providers.get('gamma');
const NOW = Date.parse('2026-10-11T08:00:00Z');
const FROM = 'urn:uic:stn:0000092';

const leg = (from, to, start, end, number, shortName) => ({
  timedLeg: {
    start: { stopPlaceRef: { objectType: 'StopPlaceRef', stopPlaceRef: from }, serviceDeparture: { timetabledTime: start } },
    end: { stopPlaceRef: { objectType: 'StopPlaceRef', stopPlaceRef: to }, serviceArrival: { timetabledTime: end } },
    service: { vehicleNumbers: [number], productCategory: { name: shortName, shortName } },
  },
});
function tripFrom(origin, shortName = 'SC') {
  const request = offerRequest({
    anonymousPassengerSpecifications: [{ externalRef: 'P1', type: 'PERSON' }, { externalRef: 'P2', type: 'PERSON' }],
    tripSpecifications: [{ legs: [leg(origin, 'urn:uic:stn:0000002', '2026-11-20T08:00:00+02:00', '2026-11-20T10:00:00+02:00', '501', shortName)] }],
  });
  delete request.tripSearchCriteria;
  return request;
}
function offered(origin, shortName) {
  const { response, remembered } = buildOfferCollection(tripFrom(origin, shortName), gamma, NOW);
  const byId = new Map(remembered.map((e) => [e.offer.offerId, e]));
  return { offer: response.offers[0], trip: response.trips[0], find: (id) => byId.get(id) };
}
function placing(offer, trip, placeProperties, lastName) {
  const request = bookingRequest(offer);
  const part = offer.reservationOfferParts[0];
  request.offers[0].placeSelections = [{
    reservationId: part.id,
    tripLegCoverage: { tripId: trip.id, legId: trip.legs[0].id },
    accommodations: [{ passengerRefs: offer.passengerRefs, accommodationType: 'SEAT', accommodationSubType: 'ANY_SEAT', placeProperties }],
  }];
  if (lastName) request.passengerSpecifications[0].detail.lastName = lastName;
  return request;
}
const placesOf = (booking) => booking.bookedOffers[0].reservations[0].placeAllocation.reservedPlaces[0];

test('profile: every provider offers place preferences from one stop place, one of them sold out; plain none', () => {
  for (const key of ['alpha', 'beta', 'gamma']) {
    const provider = providers.get(key);
    assert.equal(provider.placePreferences.from, FROM, key);
    assert.deepEqual(provider.placePreferences.groups.flatMap((g) => g.preferences), ['WINDOW', 'AISLE', 'TABLE', 'POWER']);
    assert.deepEqual(provider.placePreferences.soldOut, ['TABLE']);
  }
  assert.equal(providers.get('plain').placePreferences, undefined);
});

test('profile: a wrong placePreferences is refused', () => {
  const base = JSON.parse(JSON.stringify(require('../providers/gamma.json')));
  for (const wrong of [
    {}, { from: FROM }, { from: FROM, groups: [] },
    { from: FROM, groups: [{ preferenceGroup: 'x', preferences: ['WINDOW'] }] },
    { from: FROM, groups: [{ preferenceGroup: 'G', preferences: [] }] },
    { from: FROM, groups: [{ preferenceGroup: 'G', preferences: ['WINDOW', 'WINDOW'] }] },
    { from: FROM, groups: [{ preferenceGroup: 'G', preferences: ['WINDOW'] }], soldOut: ['AISLE'] },
  ]) {
    assert.throws(() => checkProvider('gamma', { ...base, placePreferences: wrong }), /placePreferences/, JSON.stringify(wrong));
  }
});

test('offer: a reservation from that stop place lists the preferences, the PREFERENCES flow and its places', () => {
  const { offer } = offered(FROM);
  const [part] = offer.reservationOfferParts;
  assert.deepEqual(part.supportedPlaceSelectionFlows, ['AUTOMATIC_PLACE_SELECTION', 'AUTOMATIC_PLACE_SELECTION_PREFERENCES']);
  assert.deepEqual(part.availablePlacePreferences, [{ preferenceGroups: gamma.placePreferences.groups }]);
  assert.deepEqual(part.availablePlaces.map((p) => [p.accommodationType, p.accommodationSubType, p.placeProperties]),
    [['SEAT', 'ANY_SEAT', ['WINDOW', 'AISLE', 'TABLE', 'POWER']]]);
  assert.deepEqual(part.availablePlaces[0].tripLegCoverage, { tripId: part.tripCoverage.coveredTripId, legId: part.tripCoverage.coveredLegIds[0] });
});

test('offer: a reservation from another stop place is as before', () => {
  const { offer } = offered('urn:uic:stn:0000001');
  const [part] = offer.reservationOfferParts;
  assert.deepEqual(part.supportedPlaceSelectionFlows, ['AUTOMATIC_PLACE_SELECTION']);
  assert.equal(part.availablePlacePreferences, undefined);
  assert.equal(part.availablePlaces, undefined);
});

test('booking: the preferences asked and left are given; sold out and unknown ones are not', () => {
  const { offer, trip, find } = offered(FROM);
  const booking = createBooking(placing(offer, trip, ['WINDOW', 'TABLE', 'UPPER_DECK']), find, gamma, NOW);
  assert.deepEqual(placesOf(booking).placeProperties, ['WINDOW']);
});

test('booking: none asked, none shown; the ignores-place-preferences variant gives none', () => {
  const { offer, trip, find } = offered(FROM);
  assert.equal(placesOf(createBooking(bookingRequest(offer), find, gamma, NOW)).placeProperties, undefined);
  const ignored = createBooking(placing(offer, trip, ['WINDOW'], 'Simvariant-Ignores-Place-Preferences'), find, gamma, NOW);
  assert.equal(placesOf(ignored).placeProperties, undefined);
});

test('booking: a trip from another stop place gives no preference', () => {
  const { offer, trip, find } = offered('urn:uic:stn:0000001');
  assert.equal(placesOf(createBooking(placing(offer, trip, ['WINDOW']), find, gamma, NOW)).placeProperties, undefined);
});

test('booking: an accommodation without its type, sub-type or passengers is refused', () => {
  const { offer, trip, find } = offered(FROM);
  for (const change of [
    (a) => { delete a.accommodationType; },
    (a) => { delete a.accommodationSubType; },
    (a) => { a.passengerRefs = []; },
    (a) => { a.placeProperties = 'WINDOW'; },
    (a) => { a.placeProperties = [1]; },
  ]) {
    const request = placing(offer, trip, ['WINDOW']);
    change(request.offers[0].placeSelections[0].accommodations[0]);
    assert.throws(() => createBooking(request, find, gamma, NOW), (e) => e.status === 400);
  }
});

test('add later: the preferences asked are given on the added reservation', () => {
  const { offer, trip, find } = offered(FROM, 'EC');
  const booking = createBooking(bookingRequest(offer), find, gamma, NOW);
  assert.equal(booking.bookedOffers[0].reservations.length, 0, 'an optional reservation is not booked unasked');
  const body = placing(offer, trip, ['AISLE']).offers[0];
  addOfferParts(booking, offer.offerId, body, find, gamma);
  assert.deepEqual(placesOf(booking).placeProperties, ['AISLE']);
});

test('availability: GET /availabilities/preferences leaves out what is sold out', () => {
  const { offer, find } = offered(FROM);
  const part = offer.reservationOfferParts[0];
  const query = (o) => new URLSearchParams({ contextId: offer.offerId, contextType: 'OFFER', resourceId: part.id, resourceType: 'RESERVATION', ...o });
  const answer = preferenceAvailability(query(), find(offer.offerId), gamma);
  assert.deepEqual(answer.availablePlaces.map((p) => p.placeProperties), [['WINDOW', 'AISLE', 'POWER']]);
  assert.equal(answer.availablePlaces[0].numericAvailability, 40);
  const status = (q, found = find(offer.offerId)) => { try { preferenceAvailability(q, found, gamma); return 200; } catch (e) { return e.status; } };
  assert.equal(status(query({ contextType: 'BOOKING' }), null), 404);
  assert.equal(status(query({ contextType: 'TRIP' })), 400);
  assert.equal(status(query({ resourceType: 'FARE' })), 400);
  assert.equal(status(new URLSearchParams({ contextId: offer.offerId })), 400);
  assert.equal(status(query(), null), 404);
  assert.equal(status(query({ resourceId: 'nope' })), 404);
  const other = offered('urn:uic:stn:0000001');
  const plain = preferenceAvailability(query({ contextId: other.offer.offerId, resourceId: other.offer.reservationOfferParts[0].id }), other.find(other.offer.offerId), gamma);
  assert.deepEqual(plain.availablePlaces, []);
});

test('route: GET /availabilities/preferences answers on every provider, 501 on one without preferences, and only to GET', async (t) => {
  const sim = await startSimulator();
  t.after(() => sim.close());
  for (const key of ['alpha', 'beta', 'gamma']) {
    const token = await tokenFor(sim.base, key, SECRETS[key][0]);
    const { offers } = (await call(sim.base, token, 'POST', `/${key}/offers`, tripFrom(FROM))).body;
    const part = offers[0].reservationOfferParts[0];
    const url = `/${key}/availabilities/preferences?contextId=${offers[0].offerId}&contextType=OFFER&resourceId=${part.id}&resourceType=RESERVATION`;
    const res = await call(sim.base, token, 'GET', url);
    assert.equal(res.status, 200, key);
    assert.deepEqual(res.body.availablePlaces[0].placeProperties, ['WINDOW', 'AISLE', 'POWER']);
    assert.equal((await call(sim.base, token, 'POST', url, {})).status, 405);
    assert.equal((await call(sim.base, token, 'GET', `/${key}/availabilities/on-demand-services`)).status, 501);
  }
  const plainToken = await tokenFor(sim.base, 'plain', SECRETS.plain[0]);
  assert.equal((await call(sim.base, plainToken, 'GET', '/plain/availabilities/preferences?contextId=x')).status, 501);
});
