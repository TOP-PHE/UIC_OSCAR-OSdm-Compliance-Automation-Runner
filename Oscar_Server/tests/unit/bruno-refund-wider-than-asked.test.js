// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-refund-wider-than-asked.test.js — #688: a provider was asked to refund
 * one fulfillment (one passenger of five), answered with a refund offer naming
 * all five (one twice), and after the confirmation refunded another
 * passenger's. That is one failure at step 10, and step 14 expects the asked
 * fulfillment REFUNDED and the others unchanged, so it names the swap.
 * Shapes are the provider's, anonymised.
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
const money = (amount) => ({ currency: 'CZK', amount, scale: 2 });

const ALL = ['F2', 'F5', 'F3', 'F1', 'F4'];
const offer = (status, ids) => ({
  id: 'RO1', status, refundableAmount: money(0), refundFee: money(0),
  fulfillments: ids.map((id) => ({ id, status: 'FULFILLED', bookingRef: 'B1' })),
});
const bookingAfter = (refundedId) => ({
  id: 'B1',
  fulfillments: ALL.map((id) => ({ id, status: id === refundedId ? 'REFUNDED' : 'FULFILLED', bookingParts: [{ id: `P-${id}` }] })),
});
const asked = (ids) => JSON.stringify({ fulfillmentIds: ids, refundSpecifications: [{ fulfillmentId: ids[0], passengerIds: ['PAX2'] }] });

beforeEach(() => {
  envStore = { __bookingFulfillmentIds: JSON.stringify(ALL), partialRefundByPax: 'true' };
});

describe('#688 a refund offer wider than the request', () => {
  test('is one failure at step 10, naming what was asked and what was added; a duplicate is a warning', () => {
    envStore.requestRefundOffersBodyData = asked(['F2']);
    const r = run(() => refunds.recordRefundOfferStates([offer('PROPOSED', ['F1', 'F2', 'F3', 'F4', 'F5', 'F2'])]));
    const bad = failed(r);
    expect(bad).toHaveLength(1);
    expect(bad[0].name).toContain('covers only the fulfillments asked for');
    expect(bad[0].message).toBe('asked for [F2]; the offer also names [F1, F3, F4, F5]');
    expect(r.logs.some((l) => l.startsWith('[WARNING]') && l.includes('more than once: [F2]'))).toBe(true);
  });

  test('a re-read of the same offer (step 11) does not say it again', () => {
    envStore.requestRefundOffersBodyData = asked(['F2']);
    run(() => refunds.recordRefundOfferStates([offer('PROPOSED', ALL)]));
    const again = run(() => refunds.recordRefundOfferStates([offer('PROPOSED', ALL)]));
    expect(failed(again)).toHaveLength(0);
    expect(again.logs.filter((l) => l.startsWith('[WARNING]') || l.startsWith('[INFO]'))).toHaveLength(0);
  });

  test('step 14 expects the asked fulfillment REFUNDED and names the one refunded in its place', () => {
    envStore.requestRefundOffersBodyData = asked(['F2']);
    run(() => refunds.recordRefundOfferStates([offer('PROPOSED', ALL)]));
    run(() => refunds.recordRefundOfferStates([offer('CONFIRMED', ALL)]));
    expect(JSON.parse(envStore.__refundedFulfillmentIds)).toEqual(['F2']);
    const booking = bookingAfter('F1');
    expect(refunds.isScopedRefundOnBooking(booking)).toBe(true);
    const bad = failed(run(() => refunds.checkRefundScopeOnBooking(booking)));
    expect(bad.map((x) => x.name).sort()).toEqual([
      'Fulfillment F1 is not REFUNDED (left out of the refund) - status: REFUNDED',
      'Fulfillment F2 is REFUNDED (held by the confirmed refund offer) - status: FULFILLED',
    ]);
  });

  test('a provider that refunds what was asked passes', () => {
    envStore.requestRefundOffersBodyData = asked(['F2']);
    run(() => refunds.recordRefundOfferStates([offer('PROPOSED', ALL)]));
    run(() => refunds.recordRefundOfferStates([offer('CONFIRMED', ALL)]));
    expect(failed(run(() => refunds.checkRefundScopeOnBooking(bookingAfter('F2'))))).toHaveLength(0);
  });

  test('an offer that covers exactly what was asked is unchanged', () => {
    envStore.requestRefundOffersBodyData = asked(['F2']);
    const r = run(() => refunds.recordRefundOfferStates([offer('PROPOSED', ['F2'])]));
    expect(failed(r)).toHaveLength(0);
    expect(JSON.parse(envStore.__refundProposed).RO1).toEqual({ refundable: 0, fee: 0, fulfillmentIds: ['F2'] });
  });

  test('a full refund asks for every fulfillment and is unchanged', () => {
    delete envStore.partialRefundByPax;
    envStore.requestRefundOffersBodyData = JSON.stringify({ fulfillmentIds: ALL });
    expect(failed(run(() => refunds.recordRefundOfferStates([offer('PROPOSED', ALL)])))).toHaveLength(0);
    run(() => refunds.recordRefundOfferStates([offer('CONFIRMED', ALL)]));
    expect(JSON.parse(envStore.__refundedFulfillmentIds).sort()).toEqual([...ALL].sort());
  });

  test('without a recorded request, the offer\'s own list is the scope, as before', () => {
    const r = run(() => refunds.recordRefundOfferStates([offer('PROPOSED', ALL)]));
    expect(failed(r)).toHaveLength(0);
    expect(JSON.parse(envStore.__refundProposed).RO1.fulfillmentIds).toEqual(ALL);
  });

  test('an offer naming none of what was asked still expects the asked one', () => {
    envStore.requestRefundOffersBodyData = asked(['F2']);
    run(() => refunds.recordRefundOfferStates([offer('PROPOSED', ['F1'])]));
    expect(JSON.parse(envStore.__refundProposed).RO1.fulfillmentIds).toEqual(['F2']);
  });
});
