// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1266: the replacement of a lost ticket or card (TICKET_LOST, CARD_LOST),
// asked as a non-trip offer, booked for a holder or card the provider knows.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { checkProvider } = require('../src/config');
const { buildOfferCollection, productsOf } = require('../src/osdm/offers');
const { createBooking, confirmBooking } = require('../src/osdm/bookings');
const { SECRETS, loadAllProviders, startSimulator, tokenFor, call, bookingRequest } = require('./helpers');

const providers = loadAllProviders();
const gamma = providers.get('gamma');
const REAL = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
const NOW = Date.parse('2026-11-02T09:00:00Z');
const CITY = { id: 'SIM-CITY', carrier: gamma.carrier.ref };
const PAX = [{ externalRef: '00001', type: 'PERSON', dateOfBirth: '1990-01-15' }];
const FEE = 500 * gamma.priceFactor;

const asking = (criteria, zone = CITY) => ({
  nonTripSearchCriteria: { validFrom: '2026-11-20T00:00:00+01:00', zones: [zone] },
  anonymousPassengerSpecifications: PAX,
  offerSearchCriteria: criteria,
});
const offersFor = (criteria) => buildOfferCollection(asking(criteria), gamma, NOW);
const finder = (remembered) => { const byId = new Map(remembered.map((e) => [e.offer.offerId, e])); return (id) => byId.get(id); };
const withCard = (request, number) => ({
  ...request,
  passengerSpecifications: request.passengerSpecifications.map((s) => ({ ...s, cards: [{ type: 'REDUCTION_CARD', code: 'SIM_CARD_25', number }] })),
});
const problemOf = (fn) => {
  try { fn(); } catch (e) { return { status: e.status, code: e.code }; }
  return null;
};

let sim;
before(async () => { sim = await startSimulator(); });
after(async () => { await sim.close(); });

test('every provider replaces the same lost ticket and card; a wrong profile stops the start', () => {
  for (const key of REAL) assert.deepEqual(providers.get(key).nonTrip.replacements, gamma.nonTrip.replacements, key);
  assert.equal(gamma.nonTrip.replacements.fee, 500);
  assert.deepEqual(gamma.nonTrip.replacements.ticket.holders, [{ lastName: 'Example', dateOfBirth: '1990-01-15' }]);
  assert.deepEqual(gamma.nonTrip.replacements.card.cards, [{ code: 'SIM_CARD_25', number: 'SIM-CARD-0001' }]);
  const base = { ...JSON.parse(JSON.stringify(gamma)), key: undefined };
  const r = gamma.nonTrip.replacements;
  for (const wrong of [
    null,
    { ...r, fee: 0 },
    { ...r, ticket: { ...r.ticket, type: 'RESERVATION' } },
    { ...r, ticket: { ...r.ticket, holders: [] } },
    { ...r, ticket: { ...r.ticket, holders: [{ lastName: 'Example', dateOfBirth: '15/01/1990' }] } },
    { ...r, card: { ...r.card, cards: [{ code: 'SIM_CARD_25' }] } },
    { ...r, card: { ...r.card, code: r.ticket.code } },
  ]) {
    const raw = { ...base, carrier: gamma.carrier, nonTrip: { ...base.nonTrip, replacements: wrong } };
    assert.throws(() => checkProvider('gamma', raw), /nonTrip/, JSON.stringify(wrong));
  }
});

test('TICKET_LOST: the replacement only, an admission priced 0 that asks for the holder, and the fee', () => {
  const { response } = offersFor({ productTags: ['TICKET_LOST'] });
  assert.equal(response.problems, undefined);
  assert.equal(response.offers.length, 1);
  const [offer] = response.offers;
  assert.deepEqual(offer.products.map((p) => [p.code, p.type, p.productTags]), [['SIM_LOST_TICKET', 'ADMISSION_MULTI_RIDE', ['TICKET_LOST']]]);
  const [part] = offer.admissionOfferParts;
  assert.equal(part.price.amount, 0);
  assert.equal(part.requestedInformation, 'passengerSpecifications[ANY].detail.lastName AND passengerSpecifications[ANY].dateOfBirth');
  assert.ok(part.regionalValidities.length > 0);
  assert.equal(part.tripCoverage, undefined);
  assert.deepEqual(offer.fees.map((f) => f.price), [{ amount: FEE, currency: gamma.currency, scale: 2 }]);
  assert.deepEqual(offer.offerSummary.minimalPrice, offer.fees[0].price);
});

test('CARD_LOST: a reduction card replacing the lost one, asking for its number; asked by product selection too', () => {
  for (const criteria of [{ productTags: ['CARD_LOST'] }, { productSelections: [{ productTag: 'CARD_LOST' }] }]) {
    const { response } = offersFor(criteria);
    assert.equal(response.problems, undefined, JSON.stringify(criteria));
    const [offer] = response.offers;
    assert.deepEqual(offer.products.map((p) => [p.code, p.type, p.productTags]), [['SIM_LOST_CARD', 'REDUCTION_CARD', ['CARD_LOST']]]);
    assert.equal(offer.admissionOfferParts[0].requestedInformation, 'passengerSpecifications[ANY].cards.number');
    assert.equal(offer.fees.length, 1);
  }
  // Both asked: one replacement each.
  const both = offersFor({ productTags: ['TICKET_LOST', 'CARD_LOST'] }).response.offers;
  assert.deepEqual(both.map((o) => o.products[0].productTags[0]), ['TICKET_LOST', 'CARD_LOST']);
});

test('without a lost tag nothing changes: no replacement, no fee', () => {
  const { response } = offersFor(undefined);
  assert.ok(response.offers.length > 0);
  assert.ok(response.offers.every((o) => o.fees === undefined && !o.products.some((p) => p.productTags)));
  assert.ok(response.offers.every((o) => o.admissionOfferParts.every((p) => p.requestedInformation === undefined)));
});

test('TICKET_LOST booked for the holder known: the fee is booked, then confirmed; another holder is refused', () => {
  const { response, remembered } = offersFor({ productTags: ['TICKET_LOST'] });
  const [offer] = response.offers;
  const booking = createBooking(bookingRequest(offer), finder(remembered), gamma, NOW);
  const [fee] = booking.bookedOffers[0].fees;
  assert.equal(fee.status, 'PREBOOKED');
  assert.equal(booking.provisionalPrice.amount, FEE);
  confirmBooking(booking, gamma, NOW + 1000);
  assert.equal(fee.status, 'CONFIRMED');
  assert.equal(booking.confirmedPrice.amount, FEE);

  const other = bookingRequest(offer);
  other.passengerSpecifications[0].detail.lastName = 'Stranger';
  assert.deepEqual(problemOf(() => createBooking(other, finder(remembered), gamma, NOW)), { status: 400, code: 'LOST_TICKET_NOT_FOUND' });
  const noBirth = bookingRequest(offer);
  delete noBirth.passengerSpecifications[0].dateOfBirth;
  assert.deepEqual(problemOf(() => createBooking(noBirth, finder(remembered), gamma, NOW)), { status: 400, code: 'REQUESTED_INFORMATION_MISSING' });
});

test('CARD_LOST booked for the card known; no card, or an unknown number, is refused', () => {
  const { response, remembered } = offersFor({ productTags: ['CARD_LOST'] });
  const [offer] = response.offers;
  const booking = createBooking(withCard(bookingRequest(offer), 'SIM-CARD-0001'), finder(remembered), gamma, NOW);
  assert.deepEqual(booking.passengers[0].cards, [{ type: 'REDUCTION_CARD', code: 'SIM_CARD_25', number: 'SIM-CARD-0001' }]);
  assert.equal(booking.bookedOffers[0].fees.length, 1);
  assert.deepEqual(problemOf(() => createBooking(bookingRequest(offer), finder(remembered), gamma, NOW)), { status: 400, code: 'REQUESTED_INFORMATION_MISSING' });
  assert.deepEqual(problemOf(() => createBooking(withCard(bookingRequest(offer), 'SIM-CARD-9999'), finder(remembered), gamma, NOW)),
    { status: 400, code: 'LOST_CARD_NOT_FOUND' });
});

test('a sale without a trip is not checked for a lost item', () => {
  const { response, remembered } = offersFor(undefined);
  const request = bookingRequest(response.offers[0]);
  request.passengerSpecifications[0].detail.lastName = 'Stranger';
  assert.ok(createBooking(request, finder(remembered), gamma, NOW).id);
});

test('GET /products lists both replacements, tagged', () => {
  const lost = productsOf(gamma).filter((p) => p.productTags);
  assert.deepEqual(lost.map((p) => [p.code, p.type, p.productTags[0]]), [
    ['SIM_LOST_TICKET', 'ADMISSION_MULTI_RIDE', 'TICKET_LOST'],
    ['SIM_LOST_CARD', 'REDUCTION_CARD', 'CARD_LOST'],
  ]);
});

test('over HTTP, in each provider\'s version: both replacements offered, booked and confirmed; an unknown card refused', async () => {
  for (const key of REAL) {
    const token = await tokenFor(sim.base, key, SECRETS[key][0]);
    const zone = { id: 'SIM-CITY', carrier: providers.get(key).carrier.ref };
    for (const kind of ['TICKET_LOST', 'CARD_LOST']) {
      const offers = await call(sim.base, token, 'POST', `/${key}/offers`, asking({ productTags: [kind] }, zone));
      assert.equal(offers.status, 200, `${key} ${JSON.stringify(offers.body).slice(0, 300)}`);
      const [offer] = offers.body.offers;
      assert.equal(offer.fees.length, 1, key);
      const request = kind === 'CARD_LOST' ? withCard(bookingRequest(offer), 'SIM-CARD-0001') : bookingRequest(offer);
      if (kind === 'CARD_LOST') {
        const unknown = await call(sim.base, token, 'POST', `/${key}/bookings`, withCard(bookingRequest(offer), 'SIM-CARD-9999'));
        assert.equal(unknown.status, 400, key);
        assert.equal(unknown.body.code, 'LOST_CARD_NOT_FOUND');
      }
      const booked = await call(sim.base, token, 'POST', `/${key}/bookings`, request);
      assert.equal(booked.status, 200, `${key} ${JSON.stringify(booked.body).slice(0, 300)}`);
      const bookingId = booked.body.booking.id;
      const confirmed = await call(sim.base, token, 'POST', `/${key}/bookings/${bookingId}/fulfillments`, {});
      assert.equal(confirmed.status, 200, `${key} ${JSON.stringify(confirmed.body).slice(0, 300)}`);
      const read = await call(sim.base, token, 'GET', `/${key}/bookings/${bookingId}`);
      assert.equal(read.body.booking.bookedOffers[0].fees[0].status, 'CONFIRMED', key);
    }
  }
});
