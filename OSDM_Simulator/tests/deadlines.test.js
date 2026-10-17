// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #611: the short-deadline stop place, for the collection's expired-X probes.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildOfferCollection, OFFER_LIFETIME_MS } = require('../src/osdm/offers');
const { createBooking, confirmBooking, releaseIfExpired } = require('../src/osdm/bookings');
const { createRefundOffers } = require('../src/osdm/refunds');
const { createExchangeOffers, createExchangeOperation } = require('../src/osdm/exchanges');
const { PROVIDERS_DIR, loadAllProviders, offerRequest, bookingRequest } = require('./helpers');

const providers = loadAllProviders();
const gamma = providers.get('gamma');
const NOW = Date.parse('2026-10-11T08:00:00Z');
const SHORT_MS = gamma.shortDeadlines.seconds * 1000;
const from = (stopPlaceRef) => offerRequest({
  tripSearchCriteria: { ...offerRequest().tripSearchCriteria, origin: { objectType: 'StopPlaceRef', stopPlaceRef } },
});
const iso = (ms) => new Date(ms).toISOString();

// Offers, a booking of the first, and that booking confirmed when asked.
function sale(provider, stopPlaceRef, { confirm = false } = {}) {
  const { response, remembered } = buildOfferCollection(from(stopPlaceRef), provider, NOW);
  const byId = new Map(remembered.map((entry) => [entry.offer.offerId, entry]));
  const booking = createBooking(bookingRequest(response.offers[0]), (id) => byId.get(id), provider, NOW);
  if (confirm) confirmBooking(booking, provider, NOW + 1000);
  return { offers: response.offers, booking };
}

test('the profile: every provider has the short-deadline stop place, plain does not', () => {
  for (const key of ['alpha', 'beta', 'gamma']) {
    assert.deepEqual(providers.get(key).shortDeadlines, { stopPlaceRef: 'urn:uic:stn:0000099', seconds: 60 }, key);
  }
  assert.equal(providers.get('plain').shortDeadlines, undefined);
});

test('a trip from that stop place: offers, booking, refund and exchange offers all expire after 60 s', () => {
  const { offers, booking } = sale(gamma, gamma.shortDeadlines.stopPlaceRef);
  for (const offer of offers) assert.equal(offer.preBookableUntil, iso(NOW + SHORT_MS));
  assert.equal(booking.confirmationTimeLimit, iso(NOW + SHORT_MS));
  confirmBooking(booking, gamma, NOW + 1000);
  const [refundOffer] = createRefundOffers(booking, { fulfillmentIds: [booking.fulfillments[0].id] }, gamma, NOW + 2000);
  assert.equal(refundOffer.validUntil, iso(NOW + 2000 + SHORT_MS));
  const exchange = createExchangeOffers(booking, { ...from(gamma.shortDeadlines.stopPlaceRef), fulfillmentIds: [booking.fulfillments[0].id] }, gamma, NOW + 3000, {});
  assert.equal(exchange[0].preBookableUntil, iso(NOW + 3000 + SHORT_MS));
  assert.throws(() => createExchangeOperation(booking, { exchangeOffers: [{ offerId: exchange[0].offerId }] }, gamma, NOW + 3000 + SHORT_MS),
    (error) => error.status === 409 && error.code === 'OFFER_EXPIRED');
});

test('any other trip, and the same stop place on a provider without short deadlines, keep the 30 minutes', () => {
  for (const [provider, stop] of [[gamma, 'urn:uic:stn:0000001'], [providers.get('plain'), gamma.shortDeadlines.stopPlaceRef]]) {
    const { offers, booking } = sale(provider, stop);
    assert.equal(offers[0].preBookableUntil, iso(NOW + OFFER_LIFETIME_MS));
    assert.equal(booking.confirmationTimeLimit, iso(NOW + 30 * 60 * 1000));
  }
});

test('a booking past its time limit is released, and its confirmation refused', () => {
  const { booking } = sale(gamma, gamma.shortDeadlines.stopPlaceRef);
  assert.equal(releaseIfExpired(booking, NOW + SHORT_MS - 1), false);
  assert.ok(booking.bookedOffers[0].admissions.every((p) => p.status === 'PREBOOKED'));
  assert.throws(() => confirmBooking(booking, gamma, NOW + SHORT_MS), (error) => error.status === 409 && error.code === 'BOOKING_EXPIRED');
  assert.ok(booking.bookedOffers[0].admissions.every((p) => p.status === 'RELEASED'));
  const confirmed = sale(gamma, gamma.shortDeadlines.stopPlaceRef, { confirm: true }).booking;
  assert.equal(releaseIfExpired(confirmed, NOW + 10 * SHORT_MS), false, 'a confirmed booking is never released');
  assert.ok(confirmed.bookedOffers[0].admissions.every((p) => p.status === 'FULFILLED'));
});

test('the profile field is checked', () => {
  const { loadProviders: load } = require('../src/config');
  const fs = require('node:fs');
  const path = require('node:path');
  const { tempDir } = require('./helpers');
  const raw = JSON.parse(fs.readFileSync(path.join(PROVIDERS_DIR, 'gamma.json'), 'utf8'));
  for (const bad of [{ stopPlaceRef: 'x', seconds: 5 }, { stopPlaceRef: 'x', seconds: 601 }, { stopPlaceRef: '', seconds: 60 }, { seconds: 60 }, 'x', { stopPlaceRef: 'x', seconds: 60.5 }]) {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'gamma.json'), JSON.stringify({ ...raw, shortDeadlines: bad }));
    assert.throws(() => load(dir), /"shortDeadlines"/, JSON.stringify(bad));
  }
  for (const bad of ['yes', 1]) {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'gamma.json'), JSON.stringify({ ...raw, exchange: bad }));
    assert.throws(() => load(dir), /"exchange"/, JSON.stringify(bad));
  }
});
