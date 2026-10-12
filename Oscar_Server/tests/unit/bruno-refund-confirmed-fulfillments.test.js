// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-refund-confirmed-fulfillments.test.js — #674: a provider answered the
 * confirmation of a refund offer with other fulfillments (new ids, CANCELLED,
 * another bookingRef) while the booking's own were refunded. That is one
 * failure at step 13, and step 14 checks the fulfillments the offer named when
 * PROPOSED instead of failing every one of them as "left out of the refund".
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
  expectScale: () => {},
}));
global.validationLogger = (line) => { mockLogs.push(line); };

const refunds = require('../../../Bruno_Collection/library-bruno/refunds.js');

function run(fn) {
  mockResults = [];
  mockLogs = [];
  withBrunoExpect(fn);
  return { results: mockResults, logs: mockLogs };
}
const failed = (r) => r.results.filter((x) => !x.ok);
const money = (amount) => ({ currency: 'EUR', amount, scale: 2 });

const offer = (status, fulfillments) => ({
  id: 'RO1', status, refundableAmount: money(60990), refundFee: money(0), fulfillments,
});
const own = [{ id: 'F1', status: 'FULFILLED', bookingRef: 'B1' }];
const foreign = [{ id: 'X9', status: 'CANCELLED', bookingRef: 'B-OTHER' }];
const booking = { id: 'B1', fulfillments: [{ id: 'F1', status: 'REFUNDED', bookingParts: [{ id: 'P1' }] }] };

beforeEach(() => {
  envStore = { __bookingFulfillmentIds: JSON.stringify(['F1']) };
});

describe('#674 a confirmed refund offer naming other fulfillments', () => {
  test('is one failure at the confirmation, naming the ids and their bookingRef', () => {
    run(() => refunds.recordRefundOfferStates([offer('PROPOSED', own)]));
    const r = run(() => refunds.recordRefundOfferStates([offer('CONFIRMED', foreign)]));
    const bad = failed(r);
    expect(bad).toHaveLength(1);
    expect(bad[0].name).toContain('names fulfillments of this booking');
    expect(bad[0].message).toContain('X9 (status CANCELLED, bookingRef B-OTHER)');
    expect(bad[0].message).toContain('[F1]');
  });

  test('step 14 then checks the fulfillments the offer named when PROPOSED, with no false failure', () => {
    run(() => refunds.recordRefundOfferStates([offer('PROPOSED', own)]));
    run(() => refunds.recordRefundOfferStates([offer('CONFIRMED', foreign)]));
    expect(JSON.parse(envStore.__refundedFulfillmentIds)).toEqual(['F1']);
    const r = run(() => {
      refunds.checkRefundScopeOnBooking(booking);
      refunds.checkFullRefundDone(booking);
    });
    expect(failed(r)).toEqual([]);
  });

  test('without a PROPOSED record, the ids of the booking it does name are kept', () => {
    const mixed = [...foreign, { id: 'F1', status: 'REFUNDED', bookingRef: 'B1' }];
    const r = run(() => refunds.recordRefundOfferStates([offer('CONFIRMED', mixed)]));
    expect(failed(r)).toHaveLength(1);
    expect(JSON.parse(envStore.__refundedFulfillmentIds)).toEqual(['F1']);
  });

  test('a confirmed offer naming the booking\'s own fulfillments is unchanged: no new check, same set', () => {
    run(() => refunds.recordRefundOfferStates([offer('PROPOSED', own)]));
    const r = run(() => refunds.recordRefundOfferStates([offer('CONFIRMED', own)]));
    expect(failed(r)).toEqual([]);
    expect(r.results.some((x) => x.name.includes('names fulfillments of this booking'))).toBe(false);
    expect(JSON.parse(envStore.__refundedFulfillmentIds)).toEqual(['F1']);
  });

  test('when the booking\'s fulfillments are not known, the confirmed offer is taken as it is', () => {
    envStore = {};
    const r = run(() => refunds.recordRefundOfferStates([offer('CONFIRMED', foreign)]));
    expect(failed(r)).toEqual([]);
    expect(JSON.parse(envStore.__refundedFulfillmentIds)).toEqual(['X9']);
  });
});
