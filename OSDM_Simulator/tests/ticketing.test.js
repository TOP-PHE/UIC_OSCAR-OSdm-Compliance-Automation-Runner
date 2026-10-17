// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #697: tickets per passenger or per leg, from the trip's stop place.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkProvider } = require('../src/config');
const { buildOfferCollection } = require('../src/osdm/offers');
const { createBooking, confirmBooking } = require('../src/osdm/bookings');
const { createRefundOffers, confirmRefundOffer } = require('../src/osdm/refunds');
const { loadAllProviders, offerRequest, bookingRequest } = require('./helpers');

const providers = loadAllProviders();
const gamma = providers.get('gamma');
const plain = providers.get('plain');
const NOW = Date.parse('2026-10-11T08:00:00Z');
const TWO = [{ externalRef: '00001', type: 'PERSON' }, { externalRef: '00002', type: 'PERSON' }];
const parts = (booking) => booking.bookedOffers.flatMap((o) => o.admissions);

const searchFrom = (stopPlaceRef, passengers = TWO) => offerRequest({
  anonymousPassengerSpecifications: passengers,
  tripSearchCriteria: { ...offerRequest().tripSearchCriteria, origin: { objectType: 'StopPlaceRef', stopPlaceRef } },
});

const leg = (from, to, start, end, number) => ({
  timedLeg: {
    start: { stopPlaceRef: { objectType: 'StopPlaceRef', stopPlaceRef: from }, serviceDeparture: { timetabledTime: start } },
    end: { stopPlaceRef: { objectType: 'StopPlaceRef', stopPlaceRef: to }, serviceArrival: { timetabledTime: end } },
    service: { vehicleNumbers: [number] },
  },
});
function twoLegsFrom(stopPlaceRef, passengers) {
  const request = offerRequest({
    anonymousPassengerSpecifications: passengers,
    tripSpecifications: [{ legs: [
      leg(stopPlaceRef, 'urn:uic:stn:0000004', '2026-11-20T08:00:00+02:00', '2026-11-20T10:00:00+02:00', '101'),
      leg('urn:uic:stn:0000004', 'urn:uic:stn:0000002', '2026-11-20T10:20:00+02:00', '2026-11-20T11:20:00+02:00', '202'),
    ] }],
  });
  delete request.tripSearchCriteria;
  return request;
}

function booked(request, provider = gamma) {
  const { response, remembered } = buildOfferCollection(request, provider, NOW);
  const byId = new Map(remembered.map((e) => [e.offer.offerId, e]));
  const booking = createBooking(bookingRequest(response.offers[0]), (id) => byId.get(id), provider, NOW);
  confirmBooking(booking, provider, NOW + 1000);
  return { booking, offer: response.offers[0] };
}

test('every provider names the two stop places; plain has none', () => {
  for (const key of ['alpha', 'beta', 'gamma']) {
    assert.deepEqual(providers.get(key).ticketing, { perPassengerFrom: 'urn:uic:stn:0000096', perLegFrom: 'urn:uic:stn:0000095' }, key);
  }
  assert.equal(plain.ticketing, undefined);
});

test('per passenger: one ticket per passenger, and one passenger refunded alone', () => {
  const { booking } = booked(searchFrom(gamma.ticketing.perPassengerFrom));
  assert.equal(booking.fulfillments.length, 2);
  const passengerOf = (f) => parts(booking).find((p) => p.id === f.bookingParts[0].id).passengerIds[0];
  const [first, second] = booking.fulfillments;
  assert.notEqual(passengerOf(first), passengerOf(second));
  const [ro] = createRefundOffers(booking, {
    fulfillmentIds: [second.id], refundSpecifications: [{ fulfillmentId: second.id, passengerIds: [passengerOf(second)] }],
  }, gamma, NOW + 2000);
  confirmRefundOffer(booking, ro.id, { status: 'CONFIRMED' }, gamma, NOW + 3000);
  assert.deepEqual(booking.fulfillments.map((f) => f.status), ['FULFILLED', 'REFUNDED']);
  assert.deepEqual(parts(booking).map((p) => p.status), parts(booking).map((p) => (p.passengerIds[0] === passengerOf(second) ? 'REFUNDED' : 'FULFILLED')));
});

test('per leg: one admission per passenger and leg, priced to the trip\'s price, one ticket per leg', () => {
  const plain = buildOfferCollection(twoLegsFrom('urn:uic:stn:0000001', TWO), gamma, NOW).response.offers[0];
  const { booking, offer } = booked(twoLegsFrom(gamma.ticketing.perLegFrom, TWO));
  const legIds = booking.trips[0].legs.map((l) => l.id);
  assert.equal(plain.admissionOfferParts.length, 2);
  assert.equal(offer.admissionOfferParts.length, 4);
  for (const part of offer.admissionOfferParts) assert.equal(part.tripCoverage.coveredLegIds.length, 1);
  for (const ref of ['00001', '00002']) {
    const own = offer.admissionOfferParts.filter((p) => p.passengerRefs[0] === ref);
    assert.deepEqual(own.map((p) => p.tripCoverage.coveredLegIds[0]), legIds);
    assert.deepEqual(own.map((p) => p.products[0].legIds), legIds.map((id) => [id]));
  }
  assert.equal(booking.fulfillments.length, 2);
  const [, last] = booking.fulfillments;
  const lastLeg = new Set(parts(booking).filter((p) => p.tripCoverage.coveredLegIds[0] === legIds[1]).map((p) => p.id));
  assert.deepEqual(new Set(last.bookingParts.map((p) => p.id)), lastLeg);
  const [ro] = createRefundOffers(booking, {
    fulfillmentIds: [last.id], refundSpecifications: [{ fulfillmentId: last.id, bookingPartIds: [...lastLeg] }],
  }, gamma, NOW + 2000);
  confirmRefundOffer(booking, ro.id, { status: 'CONFIRMED' }, gamma, NOW + 3000);
  assert.deepEqual(booking.fulfillments.map((f) => f.status), ['FULFILLED', 'REFUNDED']);
});

test('a leg\'s share of the price follows its travel time (2 h of 3)', () => {
  const offer = buildOfferCollection(twoLegsFrom(gamma.ticketing.perLegFrom, [TWO[0]]), gamma, NOW).response.offers[0];
  const [a, b] = offer.admissionOfferParts.map((p) => p.price.amount);
  assert.equal(a, Math.round((a + b) * 2 / 3));
  assert.equal(offer.offerSummary.minimalPrice.amount, a + b);
});

test('elsewhere, and on a provider without ticketing, one ticket per direction and a scoped refund is refused', () => {
  for (const provider of [gamma, plain]) {
    const stop = provider === gamma ? 'urn:uic:stn:0000001' : 'urn:uic:stn:0000096';
    const { booking } = booked(searchFrom(stop), provider);
    assert.equal(booking.fulfillments.length, 1);
    const f = booking.fulfillments[0];
    assert.throws(() => createRefundOffers(booking, { fulfillmentIds: [f.id], refundSpecifications: [{ fulfillmentId: f.id, passengerIds: ['x'] }] }, provider, NOW + 2000),
      (e) => e.code === 'PARTIAL_REFUND_NOT_SUPPORTED');
  }
});

test('the profile check', () => {
  const base = JSON.parse(JSON.stringify(require('../providers/gamma.json')));
  const check = (ticketing) => checkProvider('gamma', { ...base, ticketing });
  assert.deepEqual(check({ perLegFrom: 'urn:uic:stn:1' }).ticketing, { perLegFrom: 'urn:uic:stn:1' });
  for (const wrong of [null, 'x', {}, { perLegFrom: '' }, { perPassengerFrom: 'a', perLegFrom: 'a' }, { perLegFrom: 5 }]) {
    assert.throws(() => check(wrong), /ticketing/);
  }
});
