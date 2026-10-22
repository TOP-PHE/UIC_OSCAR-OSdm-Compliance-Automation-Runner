// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #903: fare offers for a requested section, and their wrong variants.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HttpError } = require('../src/http');
const { buildOfferCollection } = require('../src/osdm/offers');
const { shapeAnswer } = require('../src/osdm/versionShapes');
const { loadAllProviders, checkConformance } = require('./helpers');

const providers = loadAllProviders();
const NOW = Date.parse('2026-11-02T09:00:00Z');
const station = (code) => ({ objectType: 'StopPlaceRef', stopPlaceRef: `urn:uic:stn:${code}` });
const ADULT = { externalRef: '00001', type: 'PERSON', dateOfBirth: '1990-01-15' };
const CHILD = { externalRef: '00002', type: 'PERSON', dateOfBirth: '2023-03-01' };

// A fare request on a trip specification, as the collection sends it.
function fareRequest({ start = '0000001', parts = ['FARE_ADMISSION'], passengers = [ADULT], sections } = {}) {
  return {
    tripSpecifications: [{
      isPartOfInternationalTrip: true,
      legs: [{
        timedLeg: {
          start: { stopPlaceRef: station('0000001'), serviceDeparture: { timetabledTime: '2026-11-20T08:00:00+01:00' } },
          end: { stopPlaceRef: station('0000002'), serviceArrival: { timetabledTime: '2026-11-20T11:00:00+01:00' } },
          service: { vehicleNumbers: ['1001'] },
        },
      }],
    }],
    requestedSections: sections ?? [{ startPlace: station(start), endPlace: station('0000002') }],
    offerSearchCriteria: parts ? { requestedOfferParts: parts } : undefined,
    anonymousPassengerSpecifications: passengers,
  };
}

const build = (request, provider = 'gamma') => buildOfferCollection(request, providers.get(provider), NOW).response;
const fareOffers = (response) => response.offers.filter((o) => Array.isArray(o.fares));

test('FARE_ADMISSION with a section: one fare offer per cluster, next to the product offers, in OSDM 3.8 shapes', () => {
  const response = build(fareRequest());
  const fares = fareOffers(response);
  assert.equal(fares.length, 3);
  assert.ok(response.offers.length > fares.length, 'the product offers stay');
  assert.deepEqual(fares.map((o) => o.fares[0].combinationConstraint[0].referenceCluster), ['FULL_FLEX', 'SEMI_FLEX', 'NON_FLEX']);
  for (const offer of fares) {
    assert.equal(offer.offerSummary, undefined, 'no offer summary for fares');
    assert.equal(offer.admissionOfferParts, undefined);
    const [fare] = offer.fares;
    assert.equal(fare.type, 'ADMISSION');
    assert.deepEqual(fare.passengerRefs, ['00001']);
    assert.deepEqual(fare.coveredSection.startPlace, station('0000001'));
    assert.deepEqual(fare.coveredSection.endPlace, station('0000002'));
    assert.ok(fare.regionalConstraint.regionalValidities[0].route.routeSummary);
    assert.equal(fare.regionalConstraint.entryConnectionPoint.stationSets[0].stations[0].stopPlaceRef, 'urn:uic:stn:0000001');
    assert.ok(fare.afterSalesCondition.conditions.length > 0);
    assert.equal(fare.travelValidityConstraint.validTravelDates.from.slice(0, 10), '2026-11-20');
    assert.deepEqual(fare.involvedTCOs, [providers.get('gamma').carrier.ref]);
  }
  const amounts = fares.map((o) => o.fares[0].prices[0].amount);
  assert.ok(amounts[0] > amounts[1] && amounts[1] > amounts[2], 'flexible fares cost more');
  assert.equal(response.problems, undefined, 'FARE_ADMISSION is not reported as ignored');
  checkConformance('POST', '/gamma/offers', 200, response);
});

test('allowed clusters are the reference cluster and the less flexible ones', () => {
  const allowed = fareOffers(build(fareRequest())).map((o) => o.fares[0].combinationConstraint[0].allowedClusters);
  assert.deepEqual(allowed, [['FULL_FLEX', 'SEMI_FLEX', 'NON_FLEX'], ['SEMI_FLEX', 'NON_FLEX'], ['NON_FLEX']]);
});

test('a child under the free age gets a fare priced 0; each passenger has a fare', () => {
  for (const offer of fareOffers(build(fareRequest({ passengers: [ADULT, CHILD] })))) {
    assert.deepEqual(offer.fares.map((f) => f.passengerRefs[0]), ['00001', '00002']);
    assert.ok(offer.fares[0].prices[0].amount > 0);
    assert.equal(offer.fares[1].prices[0].amount, 0);
  }
});

test('no fare without FARE_* asked, or without a section; ALL asks for them', () => {
  assert.equal(fareOffers(build(fareRequest({ parts: ['ADMISSION'] }))).length, 0);
  assert.equal(fareOffers(build(fareRequest({ parts: null }))).length, 0);
  assert.equal(fareOffers(build(fareRequest({ sections: [] }))).length, 0);
  assert.equal(fareOffers(build(fareRequest({ parts: ['ALL'] }))).length, 3);
  // Without fares, FARE_ADMISSION alone is still reported as ignored.
  const none = build(fareRequest({ sections: [] }));
  assert.ok(none.problems.some((p) => p.code === 'PARAMETER_NOT_SUPPORTED'));
});

test('a provider without fares in its profile offers none', () => {
  assert.equal(fareOffers(build(fareRequest(), 'plain')).length, 0);
});

test('every provider answers fares in the shapes of its own OSDM version', () => {
  for (const key of ['alpha', 'beta', 'gamma', 'delta']) {
    const provider = providers.get(key);
    const response = shapeAnswer(build(fareRequest(), key), provider.osdmVersion);
    assert.equal(fareOffers(response).length, 3, key);
    checkConformance('POST', `/${key}/offers`, 200, response);
  }
});

test('a section or flag that is not valid is refused', () => {
  const refused = (request, pattern) => assert.throws(() => build(request), (e) => e instanceof HttpError && e.status === 400 && pattern.test(e.detail));
  refused(fareRequest({ sections: [{ startPlace: station('0000001') }] }), /requestedSections\[0\]\.endPlace/);
  refused(fareRequest({ sections: [{ startPlace: station('0000002'), endPlace: station('0000002') }] }), /starts where it ends/);
  const flag = fareRequest();
  flag.tripSpecifications[0].isPartOfInternationalTrip = 'yes';
  refused(flag, /isPartOfInternationalTrip/);
});

test('the wrong variants, chosen by the section start station, each break one rule', () => {
  const variant = (start, options = {}) => fareOffers(build(fareRequest({ start, ...options })));
  const two = { passengers: [ADULT, { ...ADULT, externalRef: '00002' }] };
  // A passenger without a fare.
  for (const offer of variant('0000080', two)) assert.deepEqual(offer.fares.map((f) => f.passengerRefs[0]), ['00001']);
  // A cluster outside the list.
  for (const offer of variant('0000081')) assert.equal(offer.fares[0].combinationConstraint[0].referenceCluster, 'GOLD');
  // Allowed clusters wider than the reference one.
  const wider = variant('0000082');
  assert.ok(wider.at(-1).fares[0].combinationConstraint[0].allowedClusters.includes('BUSINESS'));
  // A gap: the fare stops before the end of the section.
  for (const offer of variant('0000083')) assert.equal(offer.fares[0].coveredSection.endPlace.stopPlaceRef, 'urn:uic:stn:0000079');
  // An overlap: two fares for the passenger over the start of the section.
  for (const offer of variant('0000084')) assert.equal(offer.fares.length, 2);
  // Fares that were not asked.
  assert.equal(variant('0000085', { parts: ['ADMISSION'] }).length, 3);
  // Each variant answer is still OSDM-shaped.
  for (const start of ['0000080', '0000081', '0000082', '0000083', '0000084']) checkConformance('POST', '/gamma/offers', 200, build(fareRequest({ start })));
});

// #905: a request naming no section gets no fare, except on a trip from the
// `faresWithoutSection` station, where gamma prices the whole trip all the same.
test('without a section, fares only on a trip from the faresWithoutSection station, for the whole trip', () => {
  const fromVariant = ({ sections, parts } = {}) => {
    const req = fareRequest({ sections, parts });
    req.tripSpecifications[0].legs[0].timedLeg.start.stopPlaceRef = station('0000086');
    if (sections === undefined) delete req.requestedSections;
    return req;
  };
  for (const req of [fromVariant(), fromVariant({ sections: [] })]) {
    const offers = fareOffers(build(req));
    assert.equal(offers.length, 3);
    for (const offer of offers) {
      assert.deepEqual(offer.fares.map((f) => [f.coveredSection.startPlace.stopPlaceRef, f.coveredSection.endPlace.stopPlaceRef]),
        [['urn:uic:stn:0000086', 'urn:uic:stn:0000002']]);
    }
    checkConformance('POST', '/gamma/offers', 200, build(req));
  }
  // Not asked, no fare; and from any other station, no section gives none.
  assert.equal(fareOffers(build(fromVariant({ parts: ['ADMISSION'] }))).length, 0);
  const elsewhere = fareRequest();
  delete elsewhere.requestedSections;
  assert.equal(fareOffers(build(elsewhere)).length, 0);
  // A section from that station is priced as asked, as any other.
  assert.equal(fareOffers(build(fromVariant({ sections: [{ startPlace: station('0000086'), endPlace: station('0000002') }] }))).length, 3);
});

// #904: the fares follow the section whichever way the trip is given.
test('fares by search criteria and by trip id, over HTTP', async (t) => {
  const { SECRETS, startSimulator, tokenFor, call, offerRequest } = require('./helpers');
  const sim = await startSimulator();
  t.after(() => sim.close());
  const token = await tokenFor(sim.base, 'gamma', SECRETS.gamma[0]);
  const section = { startPlace: station('0000001'), endPlace: station('0000002') };
  const asked = { requestedSections: [section], offerSearchCriteria: { requestedOfferParts: ['FARE_ADMISSION'] } };
  const bySearch = await call(sim.base, token, 'POST', '/gamma/offers', offerRequest(asked));
  assert.equal(bySearch.status, 200);
  assert.equal(fareOffers(bySearch.body).length, 3);
  for (const offer of fareOffers(bySearch.body)) assert.deepEqual(offer.fares[0].coveredSection, section);

  const { trips } = (await call(sim.base, token, 'POST', '/gamma/trips-collection', offerRequest().tripSearchCriteria)).body;
  const byId = offerRequest({ ...asked, tripIds: [trips[1].id] });
  delete byId.tripSearchCriteria;
  const res = await call(sim.base, token, 'POST', '/gamma/offers', byId);
  assert.equal(res.status, 200);
  assert.equal(fareOffers(res.body).length, 3);
  assert.equal(fareOffers(res.body)[0].fares[0].travelValidityConstraint.validTravelDates.from.slice(0, 10), trips[1].startTime.slice(0, 10));
});

// #906: a fare offer is booked like any other offer, and confirmed by a
// fulfilment of its own: no document, control number or issuer (OSDM
// processes, "Remarks on the Booking Process with Fares").
test('a fare offer is booked and confirmed, on every provider, in its version\'s shapes', async (t) => {
  const { SECRETS, startSimulator, tokenFor, call, offerRequest, bookingRequest } = require('./helpers');
  const sim = await startSimulator();
  t.after(() => sim.close());
  const section = { startPlace: station('0000001'), endPlace: station('0000002') };
  const asked = { requestedSections: [section], offerSearchCriteria: { requestedOfferParts: ['FARE_ADMISSION'] } };
  for (const provider of ['alpha', 'beta', 'gamma', 'delta']) {
    const token = await tokenFor(sim.base, provider, SECRETS[provider][0]);
    const offers = (await call(sim.base, token, 'POST', `/${provider}/offers`, offerRequest(asked))).body;
    const offer = fareOffers(offers)[0];
    const booked = await call(sim.base, token, 'POST', `/${provider}/bookings`, bookingRequest(offer));
    assert.equal(booked.status, 200, provider);
    const booking = booked.body.booking;
    const [bookedOffer] = booking.bookedOffers;
    assert.deepEqual(bookedOffer.fares.map((f) => f.id), offer.fares.map((f) => f.id), provider);
    assert.deepEqual(bookedOffer.fares.map((f) => f.status), ['PREBOOKED'], provider);
    assert.deepEqual(bookedOffer.fares[0].passengerRefs, [booking.passengers[0].id], provider);
    assert.deepEqual(bookedOffer.admissions, [], provider);
    assert.equal(booking.provisionalPrice.amount, offer.fares[0].prices[0].amount, provider);

    const confirmed = await call(sim.base, token, 'POST', `/${provider}/bookings/${booking.id}/fulfillments`, {});
    assert.equal(confirmed.status, 200, provider);
    const [fulfillment] = confirmed.body.fulfillments;
    assert.equal(confirmed.body.fulfillments.length, 1, provider);
    assert.deepEqual(Object.keys(fulfillment).sort(), ['bookingParts', 'bookingRef', 'createdOn', 'id', 'status'], provider);
    assert.deepEqual(fulfillment.bookingParts, [{ id: offer.fares[0].id }], provider);
    assert.equal(confirmed.body.fulfillmentDocuments, undefined, provider);
    const read = (await call(sim.base, token, 'GET', `/${provider}/bookings/${booking.id}`)).body.booking;
    assert.deepEqual(read.bookedOffers[0].fares.map((f) => f.status), ['FULFILLED'], provider);
    assert.equal(read.confirmedPrice.amount, offer.fares[0].prices[0].amount, provider);
    const one = await call(sim.base, token, 'GET', `/${provider}/fulfillments/${fulfillment.id}`);
    assert.equal(one.status, 200, provider);
  }
});

test('the two wrong fare fulfilments: a fare left out of bookingParts, a PDF ticket attached (#906)', async (t) => {
  const { SECRETS, startSimulator, tokenFor, call, offerRequest, bookingRequest } = require('./helpers');
  const sim = await startSimulator();
  t.after(() => sim.close());
  const token = await tokenFor(sim.base, 'gamma', SECRETS.gamma[0]);
  const two = [{ externalRef: '00001', type: 'PERSON', dateOfBirth: '1990-01-15' }, { externalRef: '00002', type: 'PERSON', dateOfBirth: '1985-06-01' }];
  const asked = { requestedSections: [{ startPlace: station('0000001'), endPlace: station('0000002') }], offerSearchCriteria: { requestedOfferParts: ['FARE_ADMISSION'] }, anonymousPassengerSpecifications: two };
  const confirmWith = async (variant) => {
    const offer = fareOffers((await call(sim.base, token, 'POST', '/gamma/offers', offerRequest(asked))).body)[0];
    const request = bookingRequest(offer);
    request.passengerSpecifications[1].detail.lastName = `Simvariant-${variant}`;
    const booking = (await call(sim.base, token, 'POST', '/gamma/bookings', request)).body.booking;
    return { offer, booking, answer: (await call(sim.base, token, 'POST', `/gamma/bookings/${booking.id}/fulfillments`, {})).body };
  };
  const left = await confirmWith('fare-not-in-fulfillment');
  assert.equal(left.offer.fares.length, 2);
  assert.deepEqual(left.answer.fulfillments[0].bookingParts, [{ id: left.offer.fares[0].id }]);
  const ticket = await confirmWith('fare-fulfillment-document');
  assert.equal(ticket.answer.fulfillments[0].fulfillmentDocumentRefs.length, 1);
  assert.equal(ticket.answer.fulfillmentDocuments[0].id, ticket.answer.fulfillments[0].fulfillmentDocumentRefs[0]);
});

// #907: the refund of a booked fare. The simulator of the tests runs on a
// fixed clock (helpers.js), before the trip's day, so the date windows of the
// COMBINING fares give the same fee whenever the tests run.

async function fareSale(sim, token, provider, { start = '0000001', cluster = 0, lastName } = {}) {
  const { call, offerRequest, bookingRequest } = require('./helpers');
  const asked = offerRequest({
    requestedSections: [{ startPlace: station(start), endPlace: station('0000002') }],
    offerSearchCriteria: { requestedOfferParts: ['FARE_ADMISSION'] },
  });
  const offer = fareOffers((await call(sim.base, token, 'POST', `/${provider}/offers`, asked)).body)[cluster];
  const request = bookingRequest(offer);
  if (lastName) request.passengerSpecifications[0].detail.lastName = lastName;
  const booking = (await call(sim.base, token, 'POST', `/${provider}/bookings`, request)).body.booking;
  const [fulfillment] = (await call(sim.base, token, 'POST', `/${provider}/bookings/${booking.id}/fulfillments`, {})).body.fulfillments;
  return { offer, fare: offer.fares[0], booking, fulfillment };
}

test('a fare is refunded by its own after-sales conditions, then REFUNDED with its fulfilment, on every provider (#907)', async (t) => {
  const { SECRETS, startSimulator, tokenFor, call } = require('./helpers');
  const sim = await startSimulator();
  t.after(() => sim.close());
  for (const provider of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) {
    const token = await tokenFor(sim.base, provider, SECRETS[provider][0]);
    // The semi-flexible fare: a quarter of its price kept.
    const { fare, booking, fulfillment } = await fareSale(sim, token, provider, { cluster: 1 });
    assert.equal(fare.combinationConstraint[0].referenceCluster, 'SEMI_FLEX', provider);
    const price = fare.prices[0].amount;
    const asked = await call(sim.base, token, 'POST', `/${provider}/bookings/${booking.id}/refund-offers`, { fulfillmentIds: [fulfillment.id] });
    assert.equal(asked.status, 200, provider);
    const [refundOffer] = asked.body.refundOffers;
    assert.equal(asked.body.refundOffers.length, 1, provider);
    assert.equal(refundOffer.refundFee.amount, Math.round(price * 0.25), provider);
    assert.equal(refundOffer.refundableAmount.amount + refundOffer.refundFee.amount, price, provider);
    assert.deepEqual(refundOffer.refundOfferBreakdown.map((b) => b.bookingParts.map((p) => p.id)), [[fare.id]], provider);
    const confirmed = await call(sim.base, token, 'PATCH', `/${provider}/bookings/${booking.id}/refund-offers/${refundOffer.id}`, { status: 'CONFIRMED' });
    assert.equal(confirmed.status, 200, provider);
    const read = (await call(sim.base, token, 'GET', `/${provider}/bookings/${booking.id}`)).body.booking;
    assert.deepEqual(read.bookedOffers[0].fares.map((f) => f.status), ['REFUNDED'], provider);
    assert.deepEqual(read.fulfillments.map((f) => f.status), ['REFUNDED'], provider);
    assert.equal(read.confirmedPrice.amount, refundOffer.refundFee.amount, provider);
  }
});

test('a CLUSTERING fare takes the refund fee the client states; a wrong one is refused, the variant ignores it (#907)', async (t) => {
  const { SECRETS, startSimulator, tokenFor, call } = require('./helpers');
  const sim = await startSimulator();
  t.after(() => sim.close());
  const token = await tokenFor(sim.base, 'gamma', SECRETS.gamma[0]);
  const ask = (sale, refundFee) => call(sim.base, token, 'POST', `/gamma/bookings/${sale.booking.id}/refund-offers`, {
    fulfillmentIds: [sale.fulfillment.id], refundSpecifications: [{ fulfillmentId: sale.fulfillment.id, refundFee }],
  });
  // The fully flexible fare keeps nothing of its own.
  const sale = await fareSale(sim, token, 'gamma', { cluster: 0 });
  assert.equal(sale.fare.afterSalesCondition.isProviderFee, true);
  const price = sale.fare.prices[0].amount;
  const stated = await ask(sale, { currency: 'CZK', amount: 250, scale: 2 });
  assert.equal(stated.status, 200);
  assert.equal(stated.body.refundOffers[0].refundFee.amount, 250);
  assert.equal(stated.body.refundOffers[0].refundableAmount.amount, price - 250);
  assert.equal((await ask(sale, { currency: 'EUR', amount: 250 })).status, 400);
  assert.equal((await ask(sale, { currency: 'CZK', amount: -1 })).status, 400);
  // The fee is never more than the fare's price.
  assert.equal((await ask(sale, { currency: 'CZK', amount: price + 1000 })).body.refundOffers[0].refundableAmount.amount, 0);
  const ignored = await ask(await fareSale(sim, token, 'gamma', { cluster: 0, lastName: 'Simvariant-Fare-Ignores-Refund-Fee' }), { currency: 'CZK', amount: 250 });
  assert.equal(ignored.status, 200);
  assert.equal(ignored.body.refundOffers[0].refundFee.amount, 0);
});

test('COMBINING fares: the fee of the REFUND window valid at the time; the wrong variant takes the other (#907)', async (t) => {
  const { SECRETS, startSimulator, tokenFor, call } = require('./helpers');
  const sim = await startSimulator();
  t.after(() => sim.close());
  const token = await tokenFor(sim.base, 'gamma', SECRETS.gamma[0]);
  const sale = await fareSale(sim, token, 'gamma', { start: '0000087' });
  assert.deepEqual(sale.fare.combinationConstraint, [{ model: 'COMBINING' }]);
  const windows = sale.fare.afterSalesCondition.conditions.filter((c) => c.condition === 'REFUND');
  const price = sale.fare.prices[0].amount;
  assert.deepEqual(windows.map((c) => c.afterSaleFee.amount), [Math.round(price / 10), Math.round(price / 2)]);
  assert.ok(windows[0].validUntil < windows[1].validFrom);
  const refundOf = async (s, body = {}) => (await call(sim.base, token, 'POST', `/gamma/bookings/${s.booking.id}/refund-offers`, { fulfillmentIds: [s.fulfillment.id], ...body })).body.refundOffers[0];
  assert.equal((await refundOf(sale)).refundFee.amount, Math.round(price / 10));
  // A fee stated for COMBINING fares is not taken: the fares give theirs.
  const stated = await refundOf(sale, { refundSpecifications: [{ fulfillmentId: sale.fulfillment.id, refundFee: { currency: 'CZK', amount: 1 } }] });
  assert.equal(stated.refundFee.amount, Math.round(price / 10));
  const wrong = await fareSale(sim, token, 'gamma', { start: '0000087', lastName: 'Simvariant-Fare-Wrong-Combining-Fee' });
  assert.equal((await refundOf(wrong)).refundFee.amount, Math.round(wrong.fare.prices[0].amount / 2));
});
