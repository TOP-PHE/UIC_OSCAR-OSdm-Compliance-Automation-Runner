// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-refund-clock-tolerance.test.js — #1334: a refund offer's createdOn
 * is held to the run's clock with the clock tolerance of #644, as the
 * fulfilment's is. A simulator a few milliseconds ahead of the test machine
 * failed 18 refunds of one campaign.
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
jest.mock('../../../Bruno_Collection/library-bruno/requestedInformation.js', () => ({
  processRequestedInformation: () => {},
  summariseRequestedInformation: () => '',
}));
global.validationLogger = (line) => { mockLogs.push(line); };

const { CLOCK_TOLERANCE_MS } = require('../../../Bruno_Collection/library-bruno/clockTolerance.js');
const refunds = require('../../../Bruno_Collection/library-bruno/refunds.js');
const bookings = require('../../../Bruno_Collection/library-bruno/bookings.js');
global.validationLogger = (line) => { mockLogs.push(line); };

function run(fn) {
  mockResults = [];
  mockLogs = [];
  withBrunoExpect(fn);
  return mockResults;
}

const money = (amount) => ({ currency: 'EUR', amount, scale: 2 });
const refundOffer = (createdOn) => ({
  id: 'RO1', status: 'PROPOSED', createdOn,
  validFrom: new Date(Date.now() - 1000).toISOString(),
  validUntil: new Date(Date.now() + 15 * 60_000).toISOString(),
  refundableAmount: money(14000), refundFee: money(0), fulfillments: [],
});
const createdOnCheck = (createdOnMs) => {
  const results = run(() => refunds.validateRefundOfferResponse(
    refundOffer(new Date(createdOnMs).toISOString()), 0, 'PROPOSED', 'FULFILLED'));
  const found = results.filter((r) => r.name.includes('createdOn is valid and in the past'));
  expect(found).toHaveLength(1);
  return found[0];
};

beforeEach(() => { envStore = {}; });

describe('#1334 a refund offer created after the run\'s clock', () => {
  test('the tolerance is #644\'s two minutes', () => {
    expect(CLOCK_TOLERANCE_MS).toBe(120000);
  });

  test('a few milliseconds after now passes: the clocks of two machines differ', () => {
    // The campaign's failures were 1 to 14 ms after now.
    expect(createdOnCheck(Date.now() + 14).ok).toBe(true);
    expect(createdOnCheck(Date.now() + 1).ok).toBe(true);
  });

  test('before now passes, as it did', () => {
    expect(createdOnCheck(Date.now() - 60 * 60_000).ok).toBe(true);
    expect(createdOnCheck(Date.now()).ok).toBe(true);
  });

  test('just inside the tolerance passes; past it fails and names the tolerance', () => {
    expect(createdOnCheck(Date.now() + CLOCK_TOLERANCE_MS - 5000).ok).toBe(true);
    const late = createdOnCheck(Date.now() + CLOCK_TOLERANCE_MS + 60_000);
    expect(late.ok).toBe(false);
    expect(late.message).toContain('more than 120 s (the clock tolerance) after now');
  });

  test('the title is unchanged: the #735 keys and published comparisons read it', () => {
    const at = '2026-11-19T06:37:39.280Z';
    const results = run(() => refunds.validateRefundOfferResponse(refundOffer(at), 0, 'PROPOSED', 'FULFILLED'));
    expect(results.some((r) => r.name.startsWith(`Refund offer[0] createdOn is valid and in the past: ${at}`))).toBe(true);
  });

  test('the fulfilment\'s createdOn check keeps the same tolerance', () => {
    const source = require('node:fs').readFileSync(require.resolve('../../../Bruno_Collection/library-bruno/bookings.js'), 'utf8');
    expect(source).toContain("const { CLOCK_TOLERANCE_MS } = require('./clockTolerance.js');");
    expect(source).not.toMatch(/const CLOCK_TOLERANCE_MS = \d/);
    expect(typeof bookings.postCreateBookingResponse).toBe('function');
  });
});
