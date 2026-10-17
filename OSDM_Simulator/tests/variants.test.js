// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #611: answers that differ from the happy path, chosen per booking.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildOfferCollection } = require('../src/osdm/offers');
const { createBooking, confirmBooking } = require('../src/osdm/bookings');
const { createRefundOffers, confirmRefundOffer } = require('../src/osdm/refunds');
const { createExchangeOffers } = require('../src/osdm/exchanges');
const { variantsOf } = require('../src/osdm/variants');
const { loadAllProviders, offerRequest, bookingRequest } = require('./helpers');

const providers = loadAllProviders();
const gamma = providers.get('gamma');
const plain = providers.get('plain');
const NOW = Date.parse('2026-10-11T08:00:00Z');
const TWO = [{ externalRef: '00001', type: 'PERSON' }, { externalRef: '00002', type: 'PERSON' }];
const parts = (booking) => booking.bookedOffers.flatMap((o) => o.admissions);

// A booking of two passengers, the first named for the variant; confirmed when asked.
function booked(provider, variant, { confirm = true, request = offerRequest({ anonymousPassengerSpecifications: TWO }) } = {}) {
  const { response, remembered } = buildOfferCollection(request, provider, NOW);
  const byId = new Map(remembered.map((e) => [e.offer.offerId, e]));
  const body = bookingRequest(response.offers[0]);
  if (variant) body.passengerSpecifications[0].detail.lastName = `Simvariant-${variant}`;
  const booking = createBooking(body, (id) => byId.get(id), provider, NOW);
  if (confirm) confirmBooking(booking, provider, NOW + 1000);
  return { booking, offer: response.offers[0] };
}

test('the variants named by last names, any case, on every provider; unknown names and a provider without variants give none', () => {
  const specs = (...names) => names.map((lastName) => ({ detail: { lastName } }));
  assert.deepEqual([...variantsOf(specs('SIMVARIANT-Reordered', 'simvariant-minimal', 'Example'), gamma)], ['reordered', 'minimal']);
  assert.deepEqual([...variantsOf(specs('Simvariant-unknown', 'Simvariant'), gamma)], []);
  for (const key of ['alpha', 'beta']) assert.deepEqual([...variantsOf(specs('Simvariant-Reordered'), providers.get(key))], ['reordered'], key);
  assert.deepEqual([...variantsOf(specs('Simvariant-Reordered'), plain)], []);
  assert.deepEqual([...variantsOf('x', gamma)], []);
});

test('no variant: one fulfillment for the journey, in offer order, with its optional members', () => {
  const { booking, offer } = booked(gamma, null);
  assert.equal(booking.fulfillments.length, 1);
  assert.deepEqual(parts(booking).map((p) => p.id), offer.admissionOfferParts.map((p) => p.id));
  assert.ok(booking.bookingCode);
  assert.equal(booking.provisionalPrice.amount, 0);
  assert.equal(booking.confirmedPrice.amount, parts(booking).reduce((t, p) => t + p.price.amount, 0));
});

test('per-passenger: one fulfillment per passenger, and a refund scoped by passenger or part within one', () => {
  const { booking } = booked(gamma, 'Per-Passenger');
  assert.equal(booking.fulfillments.length, 2);
  const [first, second] = booking.fulfillments;
  const passengerOf = (f) => parts(booking).find((p) => p.id === f.bookingParts[0].id).passengerIds[0];
  assert.notEqual(passengerOf(first), passengerOf(second));
  const [offer] = createRefundOffers(booking, {
    fulfillmentIds: [second.id], refundSpecifications: [{ fulfillmentId: second.id, passengerIds: [passengerOf(second)] }],
  }, gamma, NOW + 2000);
  assert.deepEqual(offer.refundOfferBreakdown.flatMap((b) => b.bookingParts.map((p) => p.id)), second.bookingParts.map((p) => p.id));
  confirmRefundOffer(booking, offer.id, { status: 'CONFIRMED' }, gamma, NOW + 3000);
  assert.deepEqual(booking.fulfillments.map((f) => f.status), ['FULFILLED', 'REFUNDED']);
  assert.throws(() => createRefundOffers(booking, {
    fulfillmentIds: [first.id], refundSpecifications: [{ fulfillmentId: first.id, passengerIds: [passengerOf(second)] }],
  }, gamma, NOW + 4000), (e) => e.status === 400 && /names no part/.test(e.detail));
});

test('without the variant, a scoped refund is still refused', () => {
  const { booking } = booked(gamma, null);
  const f = booking.fulfillments[0];
  assert.throws(() => createRefundOffers(booking, { fulfillmentIds: [f.id], refundSpecifications: [{ fulfillmentId: f.id, passengerIds: ['x'] }] }, gamma, NOW),
    (e) => e.code === 'PARTIAL_REFUND_NOT_SUPPORTED');
});

test('reordered and minimal', () => {
  const plain = booked(gamma, null, { confirm: false });
  const reordered = booked(gamma, 'Reordered', { confirm: false });
  assert.deepEqual(parts(reordered.booking).map((p) => p.id), reordered.offer.admissionOfferParts.map((p) => p.id).reverse());
  assert.deepEqual(reordered.booking.passengers.map((p) => p.externalRef), ['00002', '00001']);
  assert.deepEqual(plain.booking.passengers.map((p) => p.externalRef), ['00001', '00002']);
  const { booking } = booked(gamma, 'Minimal', { confirm: false });
  assert.equal(booking.bookingCode, undefined);
  assert.ok(parts(booking).every((p) => p.summary === undefined));
  assert.ok(booking.bookedOffers.every((o) => o.summary === undefined));
});

test('the deliberately wrong answers are one cent off, or the wrong status', () => {
  const price = booked(gamma, 'Wrong-Booking-Price', { confirm: false }).booking;
  assert.equal(price.provisionalPrice.amount, parts(price).reduce((t, p) => t + p.price.amount, 0) + 1);
  const status = booked(gamma, 'Wrong-Fulfillment-Status').booking;
  assert.deepEqual(status.fulfillments.map((f) => f.status), ['AVAILABLE']);
  const refund = booked(gamma, 'Wrong-Refund-Amount').booking;
  const [ro] = createRefundOffers(refund, { fulfillmentIds: [refund.fulfillments[0].id] }, gamma, NOW + 2000);
  assert.equal(ro.refundableAmount.amount, ro.refundOfferBreakdown.reduce((t, b) => t + b.refundableAmount.amount, 0) + 1);
  const exchange = booked(gamma, 'Wrong-Exchange-Amount').booking;
  const [eo] = createExchangeOffers(exchange, { ...offerRequest({ anonymousPassengerSpecifications: TWO }), fulfillmentIds: [exchange.fulfillments[0].id] }, gamma, NOW + 2000, {});
  const given = parts(exchange).reduce((t, p) => t + p.price.amount, 0);
  const balance = eo.exchangePrice.amount + eo.exchangeFee.amount - given + 1;
  assert.equal(eo.amountToBePaid?.amount ?? -eo.refundableAmount.amount, balance);
});

test('offers from the wrong-offers stop place have minimalPrice one cent off; elsewhere, and on a provider without variants, the sum', () => {
  const sumOf = (offer) => [...offer.admissionOfferParts, ...(offer.reservationOfferParts || [])].reduce((t, p) => t + p.price.amount, 0);
  const at = (stopPlaceRef, provider) => buildOfferCollection(offerRequest({
    tripSearchCriteria: { ...offerRequest().tripSearchCriteria, origin: { objectType: 'StopPlaceRef', stopPlaceRef } },
  }), provider, NOW).response.offers;
  for (const offer of at(gamma.variants.wrongOffersFrom, gamma)) assert.equal(offer.offerSummary.minimalPrice.amount, sumOf(offer) + 1);
  for (const offer of at('urn:uic:stn:0000001', gamma)) assert.equal(offer.offerSummary.minimalPrice.amount, sumOf(offer));
  for (const offer of at(gamma.variants.wrongOffersFrom, plain)) assert.equal(offer.offerSummary.minimalPrice.amount, sumOf(offer));
});
