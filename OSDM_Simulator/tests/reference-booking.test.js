// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #776: the reference place of the NEARBY flow from a first booking. A place
// the simulator chooses on a train with a place map is a seat of that map
// (so that it can be named as a reference place), and a booking not
// confirmed may be deleted.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SECRETS, startSimulator, tokenFor, call, offerRequest, bookingRequest } = require('./helpers');

const MAP_FROM = 'urn:uic:stn:0000091';

// The SuperCity from the place map's station (mandatory reservation), for the passengers named.
function scTrip(refs) {
  const request = offerRequest({
    anonymousPassengerSpecifications: refs.map((externalRef) => ({ externalRef, type: 'PERSON' })),
    tripSpecifications: [{ legs: [{
      timedLeg: {
        start: { stopPlaceRef: { objectType: 'StopPlaceRef', stopPlaceRef: MAP_FROM }, serviceDeparture: { timetabledTime: '2026-11-20T08:00:00+02:00' } },
        end: { stopPlaceRef: { objectType: 'StopPlaceRef', stopPlaceRef: 'urn:uic:stn:0000002' }, serviceArrival: { timetabledTime: '2026-11-20T10:00:00+02:00' } },
        service: { vehicleNumbers: ['521'], productCategory: { name: 'SC', shortName: 'SC' } },
      },
    }] }],
  });
  delete request.tripSearchCriteria;
  return request;
}

async function bookWith(sim, token, refs, choice = {}) {
  const { offers, trips } = (await call(sim.base, token, 'POST', '/gamma/offers', scTrip(refs))).body;
  const offer = offers[0];
  const part = offer.reservationOfferParts[0];
  const body = bookingRequest(offer);
  body.offers[0].placeSelections = [{ reservationId: part.id, tripLegCoverage: { tripId: trips[0].id, legId: trips[0].legs[0].id }, ...choice }];
  return call(sim.base, token, 'POST', '/gamma/bookings', body);
}

const placesOf = (res) => res.body.booking.bookedOffers[0].reservations[0].placeAllocation.reservedPlaces[0];

test('a place chosen by the simulator on a map train is a saloon seat of coach 7, usable as a reference place', async (t) => {
  const sim = await startSimulator();
  t.after(() => sim.close());
  const token = await tokenFor(sim.base, 'gamma', SECRETS.gamma[0]);
  const first = await bookWith(sim, token, ['P1']);
  assert.equal(first.status, 200);
  const ref = placesOf(first);
  assert.equal(ref.coachNumber, '7');
  const near = await bookWith(sim, token, ['P1', 'P2'], { referencePlace: { coachNumber: ref.coachNumber, placeNumber: ref.placeNumbers[0] } });
  assert.equal(near.status, 200);
  const given = placesOf(near);
  assert.equal(given.coachNumber, '7');
  assert.equal(given.placeNumbers.length, 2);
  assert.ok(!given.placeNumbers.includes(ref.placeNumbers[0]), `given ${given.placeNumbers} holds the reference ${ref.placeNumbers[0]}`);
});

test('DELETE /bookings/{id}: a booking not confirmed is deleted (204, then 404); a confirmed one is refused (409)', async (t) => {
  const sim = await startSimulator();
  t.after(() => sim.close());
  const token = await tokenFor(sim.base, 'gamma', SECRETS.gamma[0]);
  const booking = (await bookWith(sim, token, ['P1'])).body.booking;
  assert.equal((await call(sim.base, token, 'DELETE', `/gamma/bookings/${booking.id}`)).status, 204);
  assert.equal((await call(sim.base, token, 'GET', `/gamma/bookings/${booking.id}`)).status, 404);
  assert.equal((await call(sim.base, token, 'DELETE', `/gamma/bookings/${booking.id}`)).status, 404);

  const kept = (await bookWith(sim, token, ['P1'])).body.booking;
  assert.equal((await call(sim.base, token, 'POST', `/gamma/bookings/${kept.id}/fulfillments`, {})).status, 200);
  const refused = await call(sim.base, token, 'DELETE', `/gamma/bookings/${kept.id}`);
  assert.deepEqual([refused.status, refused.body.code], [409, 'BOOKING_CONFIRMED']);
  assert.equal((await call(sim.base, token, 'GET', `/gamma/bookings/${kept.id}`)).status, 200);
});
