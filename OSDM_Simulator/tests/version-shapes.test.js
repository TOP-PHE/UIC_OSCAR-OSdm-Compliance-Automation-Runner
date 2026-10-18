// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #833: each provider answers in the shapes of its own OSDM version. Every
// answer the tests receive is also checked against the response schema of
// the provider's version (helpers.js, osdm-conformance.js).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { shapeAnswer } = require('../src/osdm/versionShapes');
const { responseIssues } = require('./osdm-conformance');
const { SECRETS, startSimulator, tokenFor, call, offerRequest, bookingRequest } = require('./helpers');

const confirmed38 = () => ({
  booking: {
    id: 'B1',
    fulfillmentStatus: 'FULFILLED',
    bookedOffers: [{ offerId: 'O1', inboundTripCoverage: { coveredTripId: 'T2' }, admissions: [] }],
    fulfillments: [
      { id: 'F1', status: 'FULFILLED', bookingRef: 'B1', createdOn: 't', fulfillmentDocumentRefs: ['D1', 'D2'], inboundTripCoverage: { coveredTripId: 'T2' } },
      { id: 'F2', status: 'FULFILLED', bookingRef: 'B1', createdOn: 't', fulfillmentDocumentRefs: ['D1'] },
    ],
    fulfillmentDocuments: [
      { id: 'D1', medium: 'PDF_A4', type: 'TICKET', format: 'application/pdf', content: 'x' },
      { id: 'D2', medium: 'IMAGE', type: 'TICKET', format: 'image/png', content: 'y', controlNumber: '123' },
    ],
  },
});

test('3.8 and later: the answer is the one built, untouched', () => {
  const body = confirmed38();
  assert.equal(shapeAnswer(body, '3.8.0'), body);
  assert.equal(shapeAnswer(body, '3.9.0'), body);
});

test('3.7: each fulfilment holds its documents, without the 3.8 members; the booking list goes', () => {
  const body = confirmed38();
  const out = shapeAnswer(body, '3.7.0');
  assert.notEqual(out, body, 'a copy: the stored booking is not changed');
  assert.ok(body.booking.fulfillmentDocuments, 'the original keeps its list');
  assert.equal(out.booking.fulfillmentDocuments, undefined);
  assert.deepEqual(out.booking.fulfillments[0].fulfillmentDocuments, [
    { medium: 'PDF_A4', type: 'TICKET', format: 'application/pdf', content: 'x' },
    { medium: 'IMAGE', type: 'TICKET', format: 'image/png', content: 'y' },
  ]);
  assert.equal(out.booking.fulfillments[1].fulfillmentDocuments.length, 1, 'a merged document is held by every fulfilment it covers');
  assert.equal(out.booking.fulfillments[0].fulfillmentDocumentRefs, undefined);
  assert.ok(out.booking.fulfillments[0].inboundTripCoverage, '3.7 has inboundTripCoverage');
  assert.equal(out.booking.fulfillmentStatus, 'FULFILLED', '3.7 has fulfillmentStatus');
});

test('3.6: no inboundTripCoverage, isIncluded, compartmentNumber or fulfillmentStatus', () => {
  const body = confirmed38();
  body.booking.bookedOffers[0].reservations = [{ placeAllocation: { reservedPlaces: [{ placeNumber: '15', compartmentNumber: '3' }] } }];
  body.booking.bookedOffers[0].admissions = [{ reservations: [{ reservationGroup: 'G', minGroupItemsToBeBooked: 1, isIncluded: true }] }];
  const out = shapeAnswer(body, '3.6.0');
  assert.equal(out.booking.fulfillmentStatus, undefined);
  assert.equal(out.booking.bookedOffers[0].inboundTripCoverage, undefined);
  assert.equal(out.booking.fulfillments[0].inboundTripCoverage, undefined);
  assert.deepEqual(out.booking.bookedOffers[0].reservations[0].placeAllocation.reservedPlaces[0], { placeNumber: '15' });
  assert.deepEqual(out.booking.bookedOffers[0].admissions[0].reservations[0], { reservationGroup: 'G', minGroupItemsToBeBooked: 1 });
});

test('a fulfilment answer: the documents of the answer go into the fulfilment', () => {
  const out = shapeAnswer({
    fulfillment: { id: 'F1', status: 'FULFILLED', bookingRef: 'B1', createdOn: 't', fulfillmentDocumentRefs: ['D1'] },
    fulfillmentDocuments: [{ id: 'D1', medium: 'PDF_A4', type: 'TICKET', format: 'application/pdf' }],
  }, '3.6.0');
  assert.deepEqual(out, { fulfillment: { id: 'F1', status: 'FULFILLED', bookingRef: 'B1', createdOn: 't',
    fulfillmentDocuments: [{ medium: 'PDF_A4', type: 'TICKET', format: 'application/pdf' }] } });
});

test('an answer that is not an object is sent as it is', () => {
  assert.equal(shapeAnswer(null, '3.6.0'), null);
  assert.deepEqual(shapeAnswer([1], '3.6.0'), [1]);
});

let sim;
before(async () => { sim = await startSimulator(); });
after(async () => { await sim.close(); });

const clientOf = { alpha: SECRETS.alpha[0], beta: SECRETS.beta[0], gamma: SECRETS.gamma[0] };

async function confirmedBooking(provider) {
  const token = await tokenFor(sim.base, provider, clientOf[provider]);
  const offers = (await call(sim.base, token, 'POST', `/${provider}/offers`, offerRequest())).body.offers;
  const booking = (await call(sim.base, token, 'POST', `/${provider}/bookings`, bookingRequest(offers[0]))).body.booking;
  const issued = await call(sim.base, token, 'POST', `/${provider}/bookings/${booking.id}/fulfillments`, {});
  const read = await call(sim.base, token, 'GET', `/${provider}/bookings/${booking.id}`);
  return { issued: issued.body, booking: read.body.booking };
}

test('alpha (3.6) and beta (3.7) give the documents in each fulfilment, gamma (3.8) names them', async () => {
  for (const provider of ['alpha', 'beta']) {
    const { issued, booking } = await confirmedBooking(provider);
    assert.equal(issued.fulfillmentDocuments, undefined, provider);
    assert.ok(issued.fulfillments.every((f) => f.fulfillmentDocuments?.length > 0 && !f.fulfillmentDocumentRefs), provider);
    assert.ok(issued.fulfillments.every((f) => f.fulfillmentDocuments.every((d) => d.id === undefined)), provider);
    assert.equal(booking.fulfillmentDocuments, undefined, provider);
    assert.ok(booking.fulfillments.every((f) => f.fulfillmentDocuments?.length > 0), provider);
  }
  const { issued, booking } = await confirmedBooking('gamma');
  assert.ok(issued.fulfillmentDocuments.length > 0);
  assert.ok(issued.fulfillments.every((f) => f.fulfillmentDocumentRefs?.length > 0 && !f.fulfillmentDocuments));
  assert.ok(booking.fulfillmentDocuments.length > 0);
});

test('the checker itself: an answer of another version is refused, naming the member', () => {
  const offers38 = { offers: [{ offerId: 'O', createdOn: 't', preBookableUntil: 't', passengerRefs: ['p'],
    offerSummary: { minimalPrice: { amount: 1, currency: 'EUR', scale: 2 }, overallServiceClass: { type: 'STANDARD', name: 'S' }, overallFlexibility: 'FULL_FLEXIBLE' },
    inboundTripCoverage: { coveredTripId: 'T2' } }] };
  assert.deepEqual(responseIssues('3.8.0', 'POST', '/gamma/offers', 200, offers38), []);
  assert.deepEqual(responseIssues('3.6.0', 'POST', '/alpha/offers', 200, offers38), ['offers[0].inboundTripCoverage: not a member of Offer']);
  assert.equal(responseIssues('3.8.0', 'POST', '/gamma/oauth/token', 200, {}), null, 'not an OSDM operation: nothing to check');
});
