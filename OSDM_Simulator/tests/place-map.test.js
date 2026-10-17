// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #766 PR 3: a named place or compartment chosen on the place map, with or
// without a selection fee.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadProviders, checkProvider } = require('../src/config');
const { buildOfferCollection } = require('../src/osdm/offers');
const { createBooking } = require('../src/osdm/bookings');
const { vehiclePlaceMap } = require('../src/osdm/placeMap');
const { PROVIDERS_DIR, SECRETS, startSimulator, tokenFor, call, offerRequest, bookingRequest } = require('./helpers');

const providers = loadProviders(PROVIDERS_DIR);
const gamma = providers.get('gamma');
const NOW = Date.parse('2026-10-11T08:00:00Z');
const FROM = 'urn:uic:stn:0000091';
const price = (amount) => ({ amount, currency: gamma.currency, scale: 2 });

function tripFrom(origin, passengers = 2) {
  const request = offerRequest({
    anonymousPassengerSpecifications: Array.from({ length: passengers }, (_, i) => ({ externalRef: `P${i + 1}`, type: 'PERSON' })),
    tripSpecifications: [{ legs: [{
      timedLeg: {
        start: { stopPlaceRef: { objectType: 'StopPlaceRef', stopPlaceRef: origin }, serviceDeparture: { timetabledTime: '2026-11-20T08:00:00+02:00' } },
        end: { stopPlaceRef: { objectType: 'StopPlaceRef', stopPlaceRef: 'urn:uic:stn:0000002' }, serviceArrival: { timetabledTime: '2026-11-20T10:00:00+02:00' } },
        service: { vehicleNumbers: ['521'], productCategory: { name: 'SC', shortName: 'SC' } },
      },
    }] }],
  });
  delete request.tripSearchCriteria;
  return request;
}
function offered(origin = FROM, passengers = 2) {
  const { response, remembered } = buildOfferCollection(tripFrom(origin, passengers), gamma, NOW);
  const byId = new Map(remembered.map((e) => [e.offer.offerId, e]));
  return { offer: response.offers[0], trip: response.trips[0], find: (id) => byId.get(id) };
}
const restriction = (offer) => ({ placeRestrictions: [{ reservationRef: { contextId: offer.offerId, contextType: 'OFFER', resourceId: offer.reservationOfferParts[0].id, resourceType: 'RESERVATION' } }] });
function booking(offer, trip, find, choice, lastName) {
  const request = bookingRequest(offer);
  request.offers[0].placeSelections = [{ reservationId: offer.reservationOfferParts[0].id, tripLegCoverage: { tripId: trip.id, legId: trip.legs[0].id }, ...choice }];
  if (lastName) request.passengerSpecifications[0].detail.lastName = lastName;
  return createBooking(request, find, gamma, NOW);
}
const seats = (...numbers) => ({ places: numbers.map((n, i) => ({ coachNumber: '7', placeNumber: n, passengerRef: `P${i + 1}` })) });
const reserved = (b) => b.bookedOffers[0].reservations[0];

test('profile: gamma has a place map from one stop place; a wrong one is refused', () => {
  assert.deepEqual(gamma.placeMap, { from: FROM, fee: 10 });
  const base = JSON.parse(JSON.stringify(require('../providers/gamma.json')));
  for (const wrong of [{}, { from: FROM }, { from: FROM, fee: 0 }, { from: FROM, fee: 1.5 }, { fee: 10 }]) {
    assert.throws(() => checkProvider('gamma', { ...base, placeMap: wrong }), /placeMap/, JSON.stringify(wrong));
  }
});

test('offer: a reservation from that stop place takes the nearby and the two manual flows; elsewhere as before', () => {
  assert.deepEqual(offered().offer.reservationOfferParts[0].supportedPlaceSelectionFlows,
    ['AUTOMATIC_PLACE_SELECTION', 'AUTOMATIC_PLACE_SELECTION_NEARBY', 'MANUAL_PLACE_SELECTION_WITHOUT_FEE', 'MANUAL_PLACE_SELECTION_WITH_FEE']);
  assert.deepEqual(offered('urn:uic:stn:0000001').offer.reservationOfferParts[0].supportedPlaceSelectionFlows, ['AUTOMATIC_PLACE_SELECTION']);
});

test('map: one coach, a saloon with two seats taken and four fee seats, a compartment booked as a whole', () => {
  const { offer, find } = offered();
  const { vehicle } = vehiclePlaceMap(restriction(offer), find, gamma, price);
  const [coach] = vehicle.coaches;
  assert.equal(coach.number, '7');
  const [saloon, compartment] = coach.decks[0].compartments;
  assert.equal(saloon.isSelectable, false);
  assert.deepEqual(saloon.places.filter((p) => p.status === 'ALLOCATED').map((p) => p.number), ['11', '12']);
  assert.deepEqual(saloon.places.filter((p) => p.selectionFee).map((p) => [p.number, p.selectionFee.price.amount]), ['21', '22', '23', '24'].map((n) => [n, 240]));
  assert.deepEqual([compartment.isSelectable, compartment.number, compartment.places.map((p) => p.number)], [true, 'C1', ['61', '62', '63', '64']]);
  assert.deepEqual(saloon.places[0].reservationRefs, [restriction(offer).placeRestrictions[0].reservationRef]);
});

test('map: refusals, and no coach for a trip without a map', () => {
  const { offer, find } = offered();
  const status = (body, f = find) => { try { vehiclePlaceMap(body, f, gamma, price); return 200; } catch (e) { return e.status; } };
  const ref = restriction(offer).placeRestrictions[0].reservationRef;
  assert.equal(status({}), 400);
  assert.equal(status({ placeRestrictions: [{ reservationRef: { ...ref, contextType: 'BOOKING' } }] }, () => null), 404, 'BOOKING context: no such booking');
  assert.equal(status({ placeRestrictions: [{ reservationRef: { ...ref, contextType: 'TRIP' } }] }), 400);
  assert.equal(status({ placeRestrictions: [{ reservationRef: { ...ref, resourceType: 'FARE' } }] }), 400);
  assert.equal(status(restriction(offer), () => undefined), 404);
  assert.equal(status({ placeRestrictions: [{ reservationRef: { ...ref, resourceId: 'nope' } }] }), 404);
  const other = offered('urn:uic:stn:0000001');
  assert.deepEqual(vehiclePlaceMap(restriction(other.offer), other.find, gamma, price).vehicle.coaches, []);
});

test('booking: free seats without fee are given as named, at the offer price', () => {
  const { offer, trip, find } = offered();
  const r = reserved(booking(offer, trip, find, seats('15', '16')));
  assert.deepEqual([r.placeAllocation.reservedPlaces[0].coachNumber, r.placeAllocation.reservedPlaces[0].placeNumbers], ['7', ['15', '16']]);
  assert.equal(r.price.amount, offer.reservationOfferParts[0].price.amount);
});

test('booking: a fee seat adds its fee to the reservation price', () => {
  const { offer, trip, find } = offered();
  const r = reserved(booking(offer, trip, find, seats('21', '15')));
  assert.equal(r.price.amount, offer.reservationOfferParts[0].price.amount + 240);
});

test('booking: the compartment is given as a whole', () => {
  const { offer, trip, find } = offered();
  const r = reserved(booking(offer, trip, find, { compartments: [{ coachNumber: '7', compartmentNumber: 'C1', passengerRefs: ['P1', 'P2'] }] }));
  assert.deepEqual([r.placeAllocation.accommodationSubType, r.placeAllocation.reservedPlaces[0].compartmentNumber, r.placeAllocation.reservedPlaces[0].placeNumbers], ['COMPARTMENT', 'C1', ['61', '62', '63', '64']]);
});

test('booking: a taken, unknown, repeated or compartment seat is refused (409); a malformed choice 400', () => {
  const { offer, trip, find } = offered();
  const status = (choice) => { try { booking(offer, trip, find, choice); return 200; } catch (e) { return e.status; } };
  assert.equal(status(seats('11', '15')), 409);
  assert.equal(status(seats('99', '15')), 409);
  assert.equal(status(seats('15', '15')), 409);
  assert.equal(status(seats('61', '15')), 409);
  assert.equal(status({ compartments: [{ coachNumber: '7', compartmentNumber: 'C9', passengerRefs: ['P1'] }] }), 409);
  assert.equal(status(seats('15')), 400, 'one place for two passengers');
  assert.equal(status({ places: [{ coachNumber: '7', placeNumber: '15' }, { coachNumber: '7', placeNumber: '16' }] }), 400);
  assert.equal(status({ ...seats('15', '16'), compartments: [{ coachNumber: '7', compartmentNumber: 'C1', passengerRefs: ['P1'] }] }), 400);
});

test('booking: the gives-other-place variant moves each named seat', () => {
  const { offer, trip, find } = offered();
  const r = reserved(booking(offer, trip, find, seats('15', '16'), 'Simvariant-Gives-Other-Place'));
  assert.deepEqual(r.placeAllocation.reservedPlaces[0].placeNumbers, ['16', '17']);
});

test('booking: named places on a trip without a map are ignored, as before', () => {
  const { offer, trip, find } = offered('urn:uic:stn:0000001');
  const r = reserved(booking(offer, trip, find, seats('99', '98')));
  assert.notDeepEqual(r.placeAllocation.reservedPlaces[0].placeNumbers, ['99', '98']);
});

test('route: POST /availabilities/vehicle-place-map on every provider, 501 on one without a map, POST only', async (t) => {
  const sim = await startSimulator();
  t.after(() => sim.close());
  let offers;
  for (const key of ['alpha', 'beta', 'gamma']) {
    const token = await tokenFor(sim.base, key, SECRETS[key][0]);
    ({ offers } = (await call(sim.base, token, 'POST', `/${key}/offers`, tripFrom(FROM))).body);
    const res = await call(sim.base, token, 'POST', `/${key}/availabilities/vehicle-place-map`, restriction(offers[0]));
    assert.equal(res.status, 200, key);
    assert.equal(res.body.vehicle.coaches[0].number, '7');
    assert.equal((await call(sim.base, token, 'GET', `/${key}/availabilities/vehicle-place-map`)).status, 405);
  }
  const plainToken = await tokenFor(sim.base, 'plain', SECRETS.plain[0]);
  assert.equal((await call(sim.base, plainToken, 'POST', '/plain/availabilities/vehicle-place-map', restriction(offers[0]))).status, 501);
});

// ── #766 PR 4: a place near a reference place ───────────────────────────────

const { nearbyAvailability, seatsNear } = require('../src/osdm/placeMap');
const nearQuery = (offer, o = {}) => new URLSearchParams({ contextId: offer.offerId, contextType: 'OFFER', resourceId: offer.reservationOfferParts[0].id, resourceType: 'RESERVATION', coachNumber: '7', placeNumber: '15', ...o });

test('nearby: the free seats around a saloon seat; refusals; no map, nothing', () => {
  const { offer, find } = offered();
  const answer = nearbyAvailability(nearQuery(offer), find(offer.offerId), gamma);
  assert.deepEqual(answer.availablePlaces.map((p) => [p.accommodationType, p.accommodationSubType, p.numericAvailability]), [['SEAT', 'ANY_SEAT', 17]]);
  const status = (q, found = find(offer.offerId)) => { try { nearbyAvailability(q, found, gamma); return 200; } catch (e) { return e.status; } };
  assert.equal(status(nearQuery(offer, { placeNumber: '99' })), 404);
  assert.equal(status(nearQuery(offer, { coachNumber: '8' })), 404);
  assert.equal(status(nearQuery(offer, { contextType: 'BOOKING' }), null), 404);
  assert.equal(status(nearQuery(offer, { contextType: 'TRIP' })), 400);
  assert.equal(status(nearQuery(offer, { resourceType: 'FARE' })), 400);
  assert.equal(status(new URLSearchParams({ contextId: offer.offerId })), 400);
  assert.equal(status(nearQuery(offer), null), 404);
  const other = offered('urn:uic:stn:0000001');
  assert.deepEqual(nearbyAvailability(nearQuery(other.offer), other.find(other.offer.offerId), gamma).availablePlaces, []);
});

test('nearby: seats after the reference, taken ones skipped, going round at the end', () => {
  assert.deepEqual(seatsNear('15', 2), ['16', '17']);
  assert.deepEqual(seatsNear('11', 2), ['13', '14'], 'from a taken seat too');
  assert.deepEqual(seatsNear('29', 3), ['30', '13', '14']);
});

test('booking: a reference place gives the seats after it, in its coach; the variant another coach', () => {
  const { offer, trip, find } = offered();
  const ref = { referencePlace: { coachNumber: '7', placeNumber: '15' } };
  const near = reserved(booking(offer, trip, find, ref)).placeAllocation.reservedPlaces[0];
  assert.deepEqual([near.coachNumber, near.placeNumbers], ['7', ['16', '17']]);
  const other = reserved(booking(offer, trip, find, ref, 'Simvariant-Ignores-Reference-Place')).placeAllocation.reservedPlaces[0];
  // The same seats in the next coach, so the warning a replay records names the same place every run.
  assert.deepEqual([other.coachNumber, other.placeNumbers], ['8', ['16', '17']]);
  const status = (choice) => { try { booking(offer, trip, find, choice); return 200; } catch (e) { return e.status; } };
  assert.equal(status({ referencePlace: { coachNumber: '7', placeNumber: '61' } }), 409);
  assert.equal(status({ referencePlace: { coachNumber: '7' } }), 400);
});

test('route: GET /availabilities/nearby on gamma, GET only', async (t) => {
  const sim = await startSimulator();
  t.after(() => sim.close());
  const token = await tokenFor(sim.base, 'gamma', SECRETS.gamma[0]);
  const { offers } = (await call(sim.base, token, 'POST', '/gamma/offers', tripFrom(FROM))).body;
  const url = `/gamma/availabilities/nearby?${nearQuery(offers[0])}`;
  const res = await call(sim.base, token, 'GET', url);
  assert.equal(res.status, 200);
  assert.equal(res.body.availablePlaces[0].numericAvailability, 17);
  assert.equal((await call(sim.base, token, 'POST', url, {})).status, 405);
});

test('variant refuses-bare-place-selection: a placeSelection asking nothing is a 400, a choice or none passes (#793)', () => {
  const variant = 'Simvariant-Refuses-Bare-Place-Selection';
  // A fresh offer each time: a booking takes its seats.
  const status = (choice, lastName) => {
    const { offer, trip, find } = offered();
    try { booking(offer, trip, find, choice, lastName); return 200; } catch (e) { return e.status; }
  };
  assert.equal(status({}, variant), 400);
  assert.equal(status({}), 200, 'without the variant a bare placeSelection passes');
  assert.equal(status(seats('15', '16'), variant), 200);
  assert.equal(status({ referencePlace: { coachNumber: '7', placeNumber: '15' } }, variant), 200);
  // No placeSelection at all passes.
  const { offer, find } = offered();
  const request = bookingRequest(offer);
  request.passengerSpecifications[0].detail.lastName = variant;
  assert.ok(createBooking(request, find, gamma, NOW).id);
});
