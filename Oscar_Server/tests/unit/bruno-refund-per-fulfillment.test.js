// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-refund-per-fulfillment.test.js — #595: a refund given as one refund
 * offer per fulfillment.
 *
 * Before, the collection confirmed refundOffers[0] only, so on a provider that
 * answers one refund offer per fulfillment a "full" refund refunded one
 * direction of a return, and the run passed. Now every offer is confirmed in
 * turn and the booking checked after each; a partial refund can be the refund
 * of one whole fulfillment.
 */

const { withBrunoExpect } = require('../helpers/bruno-chai.js');

let envStore = {};
global.bru = {
  getEnvVar:    (k) => (Object.prototype.hasOwnProperty.call(envStore, k) ? envStore[k] : undefined),
  setEnvVar:    (k, v) => { envStore[k] = v; },
  deleteEnvVar: (k) => { delete envStore[k]; },
};

let mockResults = [];
let mockLogs = [];
jest.mock('../../../Bruno_Collection/library-bruno/displays.js', () => ({
  validationLogger: (line) => { mockLogs.push(line); },
}));
jest.mock('../../../Bruno_Collection/library-bruno/testCapture.js', () => ({
  bruTest: (name, fn) => {
    try { fn(); mockResults.push({ name, ok: true }); } catch (e) { mockResults.push({ name, ok: false, message: e.message }); }
  },
  expectTypeOrNull: () => {},
}));
global.validationLogger = (line) => { mockLogs.push(line); };

const refunds = require('../../../Bruno_Collection/library-bruno/refunds.js');
const { resolveFulfillmentRefundScope } = require('../../../Bruno_Collection/library-bruno/partialRefund.js');

function run(fn) {
  mockResults = [];
  mockLogs = [];
  withBrunoExpect(fn);
  return { results: mockResults, logs: mockLogs };
}
const failed = (r) => r.results.filter((x) => !x.ok).map((x) => x.name);

beforeEach(() => { envStore = {}; });

const price = (amount) => ({ amount, currency: 'CZK', scale: 2 });

// A confirmed return as a provider refunding per fulfillment gives it: one
// fulfillment per direction, the inbound trip listed first on purpose.
function returnBooking({ directions = true } = {}) {
  return {
    id: 'B1',
    trips: [
      { id: 'T-IN', ...(directions ? { direction: 'IN_BOUND' } : {}) },
      { id: 'T-OUT', ...(directions ? { direction: 'OUT_BOUND' } : {}) },
    ],
    bookedOffers: [{
      admissions: [
        { id: 'A-OUT', price: price(1000), tripCoverage: { coveredTripId: 'T-OUT' } },
        { id: 'A-IN', price: price(800), tripCoverage: { coveredTripId: 'T-IN' } },
      ],
      reservations: [{ id: 'R-IN', price: price(50), tripCoverage: { coveredTripId: 'T-IN' } }],
    }],
    fulfillments: [
      { id: 'F-OUT', bookingParts: [{ id: 'A-OUT' }] },
      { id: 'F-IN', bookingParts: [{ id: 'A-IN' }, { id: 'R-IN' }] },
    ],
  };
}

describe('resolveFulfillmentRefundScope', () => {
  test('first and last follow the order of the booking\'s fulfillments', () => {
    expect(resolveFulfillmentRefundScope(returnBooking(), 'first')).toMatchObject({ armed: true, fulfillmentId: 'F-OUT', expectedPartIds: ['A-OUT'] });
    expect(resolveFulfillmentRefundScope(returnBooking(), 'last')).toMatchObject({ armed: true, fulfillmentId: 'F-IN', expectedPartIds: ['A-IN', 'R-IN'] });
  });

  test('outbound and inbound follow the trips the parts cover, by direction', () => {
    const inbound = resolveFulfillmentRefundScope(returnBooking(), 'inbound');
    expect(inbound).toMatchObject({ fulfillmentId: 'F-IN', selection: 'inbound', expected: { amount: 850, currency: 'CZK', scale: 2 } });
    expect(resolveFulfillmentRefundScope(returnBooking(), 'outbound').fulfillmentId).toBe('F-OUT');
  });

  test('without directions on the trips, outbound is the first trip and inbound the last', () => {
    const b = returnBooking({ directions: false });
    expect(resolveFulfillmentRefundScope(b, 'outbound').fulfillmentId).toBe('F-IN');
    expect(resolveFulfillmentRefundScope(b, 'inbound').fulfillmentId).toBe('F-OUT');
  });

  test('an unknown selection is first', () => {
    expect(resolveFulfillmentRefundScope(returnBooking(), 'middle').fulfillmentId).toBe('F-OUT');
  });

  test('it degrades, saying why, when one fulfillment is the whole booking or no trip goes that way', () => {
    const one = { ...returnBooking(), fulfillments: [{ id: 'F', bookingParts: [{ id: 'A-OUT' }, { id: 'A-IN' }] }] };
    expect(resolveFulfillmentRefundScope(one, 'first')).toMatchObject({ degraded: true, reason: expect.stringMatching(/1 fulfillment/) });
    const oneWay = { ...returnBooking(), trips: [{ id: 'T-OUT' }] };
    expect(resolveFulfillmentRefundScope(oneWay, 'inbound')).toMatchObject({ degraded: true, reason: expect.stringMatching(/fewer than 2 trips/) });
    const uncovered = returnBooking();
    uncovered.bookedOffers[0].admissions.forEach((a) => { delete a.tripCoverage; });
    uncovered.bookedOffers[0].reservations = [];
    expect(resolveFulfillmentRefundScope(uncovered, 'outbound')).toMatchObject({ degraded: true, reason: expect.stringMatching(/no fulfillment holds/) });
    expect(resolveFulfillmentRefundScope(null, 'first').degraded).toBe(true);
  });
});

describe('every refund offer of the answer', () => {
  const offer = (id, ffIds) => ({ id, fulfillments: ffIds.map((f) => ({ id: f })) });

  test('each names fulfillments of the booking, none twice', () => {
    envStore.__bookingFulfillmentIds = JSON.stringify(['F-OUT', 'F-IN']);
    expect(failed(run(() => refunds.checkRefundOfferFulfillments([offer('R1', ['F-OUT']), offer('R2', ['F-IN'])])))).toEqual([]);
    const bad = run(() => refunds.checkRefundOfferFulfillments([offer('R1', ['F-OUT', 'F-X']), offer('R2', ['F-OUT']), offer('R3', [])]));
    expect(failed(bad)).toEqual([
      'Refund offer 1 (R1) names fulfillments of this booking',
      'Refund offer 3 (R3) names fulfillments of this booking',
      'No fulfillment is in two of the 3 refund offers',
    ]);
  });

  test('they are confirmed in turn: the next one becomes the current offer, then none is left', () => {
    run(() => refunds.rememberRefundOffersToConfirm([offer('R1', ['F-OUT']), offer('R2', ['F-IN']), offer('R3', ['F-3'])]));
    envStore.refundOffersOfferId = 'R1';
    expect(refunds.nextRefundOfferToConfirm()).toEqual({ id: 'R2', position: 2, total: 3 });
    expect(envStore.refundOffersOfferId).toBe('R2');
    expect(refunds.nextRefundOfferToConfirm()).toEqual({ id: 'R3', position: 3, total: 3 });
    expect(refunds.nextRefundOfferToConfirm()).toBeNull();
    expect(envStore.refundOffersOfferId).toBe('R3');
  });

  test('one refund offer: nothing to loop over', () => {
    run(() => refunds.rememberRefundOffersToConfirm([offer('R1', ['F-OUT', 'F-IN'])]));
    expect(refunds.nextRefundOfferToConfirm()).toBeNull();
  });
});

describe('a full refund ends with every fulfillment refunded', () => {
  const booking = { fulfillments: [{ id: 'F-OUT' }, { id: 'F-IN' }] };

  test('one confirmed of two fails; both pass', () => {
    envStore.__refundedFulfillmentIds = JSON.stringify(['F-OUT']);
    const half = run(() => refunds.checkFullRefundDone(booking));
    expect(failed(half)).toEqual(['Full refund: every fulfillment of the booking is refunded (1/2)']);
    envStore.__refundedFulfillmentIds = JSON.stringify(['F-OUT', 'F-IN']);
    expect(failed(run(() => refunds.checkFullRefundDone(booking)))).toEqual([]);
  });

  test('a partial refund is not held to it, unless it degraded to full', () => {
    envStore.__refundedFulfillmentIds = JSON.stringify(['F-IN']);
    envStore.partialRefundByFulfillment = 'true';
    expect(run(() => refunds.checkFullRefundDone(booking)).results).toEqual([]);
    envStore.__partialRefundDegradedToFull = 'true';
    expect(failed(run(() => refunds.checkFullRefundDone(booking)))).toHaveLength(1);
  });
});

describe('an overrule on a refund given per fulfillment', () => {
  const ro = (fee, refundable, ffIds) => ({ id: 'R1', refundFee: price(fee), refundableAmount: price(refundable), fulfillments: ffIds.map((id) => ({ id })) });

  test('one offer of several: the fee is waived; the whole booking value is not expected of it', () => {
    envStore.__bookingFulfillmentIds = JSON.stringify(['F-OUT', 'F-IN']);
    const r = run(() => refunds.validateRefundableAmount(ro(0, 1000, ['F-OUT']), 'STRIKE', 1850));
    expect(failed(r)).toEqual([]);
    expect(r.results.some((x) => x.name.includes('one refund offer of several'))).toBe(true);
    expect(failed(run(() => refunds.validateRefundableAmount(ro(100, 900, ['F-OUT']), 'STRIKE', 1850)))).toHaveLength(1);
  });

  test('one offer for the whole booking keeps the full-restitution identity', () => {
    envStore.__bookingFulfillmentIds = JSON.stringify(['F-OUT', 'F-IN']);
    const r = run(() => refunds.validateRefundableAmount(ro(0, 1000, ['F-OUT', 'F-IN']), 'STRIKE', 1850));
    expect(failed(r).some((n) => n.includes('== confirmedPrice'))).toBe(true);
  });

  test('a partial refund by fulfillment counts as partial', () => {
    envStore.__bookingFulfillmentIds = JSON.stringify(['F-OUT', 'F-IN']);
    envStore.partialRefundByFulfillment = 'true';
    const r = run(() => refunds.validateRefundableAmount(ro(0, 850, ['F-IN']), 'STRIKE', 1850));
    expect(r.results.some((x) => x.name.startsWith('Partial refund WITH overrule'))).toBe(true);
    expect(failed(r)).toEqual([]);
  });
});
