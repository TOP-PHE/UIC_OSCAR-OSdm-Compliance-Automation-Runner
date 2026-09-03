// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-bookings-stage-price.test.js — unit tests for the lifecycle-stage
 * predicate that decides which Booking price member OSCAR asserts
 * (Bruno_Collection/library-bruno/bookings.js#isPostConfirmationStage,
 * issues #375 / #496).
 *
 * OSDM Booking (openapi3_0.json):
 *   provisionalPrice — "Price of all unconfirmed pre-booked parts in the booking"
 *   confirmedPrice   — "Sum of all prices of confirmed parts in the booking minus
 *                       the sum of all confirmed refund amounts."
 *
 * #496 (OTST review, Farruggia/SBB): `14. GET Booking after Patch Refund`
 * passes stage REFUNDED and was still asserting provisionalPrice — the
 * original #375 pattern only matched FULFILLED|CONFIRMED.
 *
 * Harness mirrors the other library-bruno tests: minimal `bru` + mocked
 * displays/testCapture/requestedInformation so requiring bookings.js has no
 * side effects. Only the pure predicate is exercised here — the full
 * postCreateBookingResponse() needs Bruno's chai `expect` and a complete
 * offer+booking fixture, which is out of scope for a unit test.
 */

let envStore = {};
global.bru = {
  getEnvVar:    (k) => (Object.prototype.hasOwnProperty.call(envStore, k) ? envStore[k] : undefined),
  setEnvVar:    (k, v) => { envStore[k] = v; },
  deleteEnvVar: (k) => { delete envStore[k]; },
};

jest.mock('../../../Bruno_Collection/library-bruno/displays.js', () => ({
  validationLogger: () => {},
}));
jest.mock('../../../Bruno_Collection/library-bruno/testCapture.js', () => ({
  bruTest: () => {},
}));
jest.mock('../../../Bruno_Collection/library-bruno/requestedInformation.js', () => ({
  processRequestedInformation: () => {},
  summariseRequestedInformation: () => '',
}));

const { isPostConfirmationStage } = require('../../../Bruno_Collection/library-bruno/bookings.js');

beforeEach(() => { envStore = {}; });

describe('bookings.isPostConfirmationStage — which price member a stage must carry', () => {
  // ── Pre-confirmation → provisionalPrice ───────────────────────────────────
  test.each([
    [['PREBOOKED']],
    [['ON_HOLD']],
    [['PREBOOKED', 'ON_HOLD']],
  ])('%j → false (pre-confirmation: provisionalPrice)', (status) => {
    expect(isPostConfirmationStage(status)).toBe(false);
  });

  test('no expected status at all → false (defaults to the pre-confirmation member)', () => {
    expect(isPostConfirmationStage(undefined)).toBe(false);
    expect(isPostConfirmationStage(null)).toBe(false);
    expect(isPostConfirmationStage('')).toBe(false);
    expect(isPostConfirmationStage([])).toBe(false);
  });

  // ── Confirmed onwards → confirmedPrice ────────────────────────────────────
  test.each([
    [['CONFIRMED']],
    [['FULFILLED']],
    [['FULFILLED', 'CONFIRMED']],
    [['REFUNDED']],                              // #496 — the SBB case
    [['EXCHANGED']],
    [['EXCHANGED', 'FULFILLED', 'CONFIRMED']],
    [['FULFILLED', 'CONFIRMED', 'REFUNDED']],
  ])('%j → true (confirmed stage: confirmedPrice)', (status) => {
    expect(isPostConfirmationStage(status)).toBe(true);
  });

  test('accepts a bare string and is case-insensitive', () => {
    expect(isPostConfirmationStage('REFUNDED')).toBe(true);
    expect(isPostConfirmationStage('refunded')).toBe(true);
    expect(isPostConfirmationStage('PREBOOKED')).toBe(false);
  });

  // ── Exchange in progress stays on the provisional side ───────────────────
  test('EXCHANGE_ONGOING → false (exchange creates new pre-booked parts → provisionalPrice) and does not leak-match EXCHANGED', () => {
    expect(isPostConfirmationStage(['EXCHANGE_ONGOING'])).toBe(false);
  });

  // ── The collection's real call sites (expectedBookedOffersStatus argument) ─
  // Documentation-as-test: every GET-Booking step and the member it now asserts.
  test.each([
    ['02. POST Create Booking',                        ['PREBOOKED'],                'provisionalPrice'],
    ['05. GET Booking before Fulfillments',            ['PREBOOKED'],                'provisionalPrice'],
    ['07. GET Booking after Fulfillments',             ['FULFILLED', 'CONFIRMED'],   'confirmedPrice'],
    ['03-Refund/12. GET Booking before Patch Refund',  ['FULFILLED', 'CONFIRMED'],   'confirmedPrice'],
    ['03-Refund/14. GET Booking after Patch Refund',   ['REFUNDED'],                 'confirmedPrice'],
    ['03-Refund/16. GET Booking after Delete Refund',  ['FULFILLED', 'CONFIRMED'],   'confirmedPrice'],
    ['04-Exchange/13. GET Booking before Fulfillment', ['EXCHANGE_ONGOING'],         'provisionalPrice'],
    ['04-Exchange/15. GET Booking after Fulfillment',  ['EXCHANGED'],                'confirmedPrice'],
    ['04-Exchange/17. GET Booking after Fulfillment',  ['FULFILLED', 'CONFIRMED'],   'confirmedPrice'],
  ])('%s passes %j → asserts %s', (_step, status, member) => {
    expect(isPostConfirmationStage(status) ? 'confirmedPrice' : 'provisionalPrice').toBe(member);
  });
});
