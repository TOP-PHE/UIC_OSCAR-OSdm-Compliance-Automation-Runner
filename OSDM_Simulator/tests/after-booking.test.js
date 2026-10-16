// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #766 PR 5: the place choices made after the booking. The availability
// resources answer in a BOOKING context, and a reservation added later
// (offer-parts) gets the places, preferences or reference place it names.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SECRETS, startSimulator, tokenFor, call, offerRequest, bookingRequest } = require('./helpers');

const MAP_FROM = 'urn:uic:stn:0000091';
const PREFS_FROM = 'urn:uic:stn:0000092';

// An EuroCity (optional reservation) from a stop place, for two passengers.
function ecTrip(origin) {
  const request = offerRequest({
    anonymousPassengerSpecifications: [{ externalRef: 'P1', type: 'PERSON' }, { externalRef: 'P2', type: 'PERSON' }],
    tripSpecifications: [{ legs: [{
      timedLeg: {
        start: { stopPlaceRef: { objectType: 'StopPlaceRef', stopPlaceRef: origin }, serviceDeparture: { timetabledTime: '2026-11-20T08:00:00+02:00' } },
        end: { stopPlaceRef: { objectType: 'StopPlaceRef', stopPlaceRef: 'urn:uic:stn:0000002' }, serviceArrival: { timetabledTime: '2026-11-20T10:00:00+02:00' } },
        service: { vehicleNumbers: ['171'], productCategory: { name: 'EC', shortName: 'EC' } },
      },
    }] }],
  });
  delete request.tripSearchCriteria;
  return request;
}

async function bookedWithoutReservation(origin) {
  const sim = await startSimulator();
  const token = await tokenFor(sim.base, 'gamma', SECRETS.gamma[0]);
  const { offers, trips } = (await call(sim.base, token, 'POST', '/gamma/offers', ecTrip(origin))).body;
  const offer = offers[0];
  const booking = (await call(sim.base, token, 'POST', '/gamma/bookings', bookingRequest(offer))).body.booking;
  const part = offer.reservationOfferParts[0];
  const trip = trips[0];
  const selection = { reservationId: part.id, tripLegCoverage: { tripId: trip.id, legId: trip.legs[0].id } };
  const addLater = (choice) => call(sim.base, token, 'POST', `/gamma/bookings/${booking.id}/booked-offers/${offer.offerId}/offer-parts`,
    { offerId: offer.offerId, passengerRefs: ['P1', 'P2'], placeSelections: [{ ...selection, ...choice }] });
  return { sim, token, offer, booking, part, addLater };
}

const reservedPlaces = (res, id) => res.body.bookedOffers[0].reservations.find((r) => r.id === id).placeAllocation.reservedPlaces[0];

test('after the booking: the place map in a BOOKING context, and the places named added later', async (t) => {
  const { sim, token, offer, booking, part, addLater } = await bookedWithoutReservation(MAP_FROM);
  t.after(() => sim.close());
  assert.equal(booking.bookedOffers[0].reservations.length, 0, 'the optional reservation is not booked');
  const ref = { contextId: booking.id, contextType: 'BOOKING', resourceId: part.id, resourceType: 'RESERVATION' };
  const map = await call(sim.base, token, 'POST', '/gamma/availabilities/vehicle-place-map', { placeRestrictions: [{ reservationRef: ref }] });
  assert.equal(map.status, 200);
  const saloon = map.body.vehicle.coaches[0].decks[0].compartments[0];
  assert.deepEqual(saloon.places[0].reservationRefs, [ref]);
  const unknown = { placeRestrictions: [{ reservationRef: { ...ref, contextId: 'nope' } }] };
  const refused = await call(sim.base, token, 'POST', '/gamma/availabilities/vehicle-place-map', unknown);
  assert.deepEqual([refused.status, refused.body.code], [404, 'BOOKING_NOT_FOUND']);
  assert.equal((await call(sim.base, token, 'POST', '/gamma/availabilities/vehicle-place-map', { placeRestrictions: [{ reservationRef: { ...ref, resourceId: 'nope' } }] })).status, 404);
  const added = await addLater({ places: [{ coachNumber: '7', placeNumber: '15', passengerRef: 'P1' }, { coachNumber: '7', placeNumber: '16', passengerRef: 'P2' }] });
  assert.equal(added.status, 200);
  assert.deepEqual(reservedPlaces(added, part.id).placeNumbers, ['15', '16']);
  assert.ok(offer.reservationOfferParts[0].supportedPlaceSelectionFlows.includes('MANUAL_PLACE_SELECTION_WITHOUT_FEE'));
});

test('after the booking: nearby in a BOOKING context, and a reference place added later', async (t) => {
  const { sim, token, booking, part, addLater } = await bookedWithoutReservation(MAP_FROM);
  t.after(() => sim.close());
  const query = new URLSearchParams({ contextId: booking.id, contextType: 'BOOKING', resourceId: part.id, resourceType: 'RESERVATION', coachNumber: '7', placeNumber: '15' });
  const near = await call(sim.base, token, 'GET', `/gamma/availabilities/nearby?${query}`);
  assert.equal(near.status, 200);
  assert.equal(near.body.availablePlaces[0].numericAvailability, 17);
  query.set('contextId', 'nope');
  assert.equal((await call(sim.base, token, 'GET', `/gamma/availabilities/nearby?${query}`)).status, 404);
  const added = await addLater({ referencePlace: { coachNumber: '7', placeNumber: '15' } });
  assert.equal(added.status, 200);
  assert.deepEqual([reservedPlaces(added, part.id).coachNumber, reservedPlaces(added, part.id).placeNumbers], ['7', ['16', '17']]);
});

test('after the booking: preferences in a BOOKING context, and given to the reservation added later', async (t) => {
  const { sim, token, booking, part, addLater } = await bookedWithoutReservation(PREFS_FROM);
  t.after(() => sim.close());
  const query = new URLSearchParams({ contextId: booking.id, contextType: 'BOOKING', resourceId: part.id, resourceType: 'RESERVATION' });
  const prefs = await call(sim.base, token, 'GET', `/gamma/availabilities/preferences?${query}`);
  assert.equal(prefs.status, 200);
  assert.deepEqual(prefs.body.availablePlaces.map((p) => p.placeProperties), [['WINDOW', 'AISLE', 'POWER']]);
  const added = await addLater({ accommodations: [{ accommodationType: 'SEAT', accommodationSubType: 'ANY_SEAT', placeProperties: ['WINDOW'], passengerRefs: ['P1', 'P2'] }] });
  assert.equal(added.status, 200);
  assert.deepEqual(reservedPlaces(added, part.id).placeProperties, ['WINDOW']);
});
