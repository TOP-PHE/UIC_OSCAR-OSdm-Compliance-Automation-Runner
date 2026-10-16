// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-real-provider-786.test.js — #786: four checks that failed a real
 * provider's (OSDM 3.0.5) correct answers. Shapes are the provider's,
 * anonymised.
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

const bookings = require('../../../Bruno_Collection/library-bruno/bookings.js');
const refunds = require('../../../Bruno_Collection/library-bruno/refunds.js');
const offers = require('../../../Bruno_Collection/library-bruno/offers.js');
global.validationLogger = (line) => { mockLogs.push(line); };

function run(fn) {
  mockResults = [];
  mockLogs = [];
  withBrunoExpect(fn);
  return { results: mockResults, logs: mockLogs };
}
const named = (r, text) => r.results.filter((x) => x.name.includes(text));

beforeEach(() => { envStore = {}; });

describe('#786 the booking is created at or after the offer', () => {
  test('the same second passes; a booking before its offer still fails', () => {
    const same = run(() => bookings.checkBookingAfterOffer({ createdOn: '2026-10-16T14:31:40Z' }, { createdOn: '2026-10-16T14:31:40Z' }));
    expect(named(same, 'booking.createdOn')).toEqual([expect.objectContaining({ ok: true })]);
    const later = run(() => bookings.checkBookingAfterOffer({ createdOn: '2026-10-16T14:31:41Z' }, { createdOn: '2026-10-16T14:31:40Z' }));
    expect(named(later, 'booking.createdOn')[0].ok).toBe(true);
    const before = run(() => bookings.checkBookingAfterOffer({ createdOn: '2026-10-16T14:31:39Z' }, { createdOn: '2026-10-16T14:31:40Z' }));
    expect(named(before, 'booking.createdOn')[0]).toEqual(expect.objectContaining({ ok: false }));
    expect(named(before, 'booking.createdOn')[0].message).toContain('the booking is created before the offer it books');
  });
});

describe('#786 a refund offer\'s deadline is checked while it is PROPOSED', () => {
  const money = (amount) => ({ currency: 'EUR', amount, scale: 2 });
  const refundOffer = (status, validUntil) => ({
    id: 'RO1', status, createdOn: '2026-10-16T14:00:00Z', validFrom: '2026-10-16T14:00:00Z', validUntil,
    refundableAmount: money(140000), refundFee: money(0), fulfillments: [],
  });
  const past = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 15 * 60_000).toISOString();
  const deadline = (r) => named(r, 'validUntil is valid and in the future');

  test('CONFIRMED with a past validUntil: not checked, said at INFO', () => {
    const r = run(() => refunds.validateRefundOfferResponse(refundOffer('CONFIRMED', past), 0, 'CONFIRMED', 'REFUNDED'));
    expect(deadline(r)).toHaveLength(0);
    expect(r.logs.some((l) => l.startsWith('[INFO]') && l.includes('is CONFIRMED: validUntil'))).toBe(true);
    // Its presence is still required.
    const absent = run(() => refunds.validateRefundOfferResponse(refundOffer('CONFIRMED', undefined), 0, 'CONFIRMED', 'REFUNDED'));
    expect(named(absent, 'validUntil is present')[0]).toEqual(expect.objectContaining({ ok: false }));
  });

  test('PROPOSED, or no status: a past validUntil fails, a future one passes', () => {
    for (const status of ['PROPOSED', undefined]) {
      expect(deadline(run(() => refunds.validateRefundOfferResponse(refundOffer(status, past), 0, 'PROPOSED', 'FULFILLED')))[0].ok).toBe(false);
      expect(deadline(run(() => refunds.validateRefundOfferResponse(refundOffer(status, future), 0, 'PROPOSED', 'FULFILLED')))[0].ok).toBe(true);
    }
  });
});

describe('#786 the after-sale flags of a refunded part are not compared with the offer', () => {
  const offerPart = { id: 'o1', refundable: 'YES', exchangeable: 'YES', passengerRefs: ['P1'], price: { amount: 105000, currency: 'EUR', scale: 2 } };
  const booked = (status, flag) => ({ ...offerPart, id: 'b1', status, refundable: flag, exchangeable: flag });
  const flagChecks = (r) => r.results.filter((x) => / (refundable|exchangeable) values have at least one member in common/.test(x.name));

  test('REFUNDED parts saying NO: no check, one INFO line', () => {
    envStore.admissionReservationAncillaryBookingPartsIds = '[]';
    const r = run(() => bookings.validateBookedOfferParts([offerPart], [booked('REFUNDED', 'NO')], 'admission', 'REFUNDED'));
    expect(flagChecks(r)).toHaveLength(0);
    expect(r.logs.some((l) => l.startsWith('[INFO]') && l.includes('already refunded or exchanged'))).toBe(true);
  });

  test('a part not yet refunded is still compared, and NO against YES still fails', () => {
    envStore.admissionReservationAncillaryBookingPartsIds = '[]';
    const r = run(() => bookings.validateBookedOfferParts([offerPart], [booked('CONFIRMED', 'NO')], 'admission', 'CONFIRMED'));
    expect(flagChecks(r)).toHaveLength(2);
    expect(flagChecks(r).every((x) => !x.ok)).toBe(true);
  });
});

describe('#786 an answer without offers says "no offer" and quotes the provider', () => {
  const answer = {
    anonymousPassengerSpecifications: [{ externalRef: '00001', type: 'PERSON' }],
    warnings: { warnings: [{ code: '2103', detail: 'Could not validate (part of) the routes' }] },
  };

  test('the provider\'s reasons, at most three', () => {
    expect(offers.providerReasons(answer)).toBe('The provider says: 2103: Could not validate (part of) the routes.');
    expect(offers.providerReasons({})).toBe('The provider gives no warning or problem saying why.');
    const many = { problems: [1, 2, 3, 4].map((n) => ({ code: `C${n}`, title: `t${n}` })) };
    expect(offers.providerReasons(many)).toBe('The provider says: C1: t1; C2: t2; C3: t3; ….');
  });

  test('no offers member: "no offer", with the reason; a non-array still reads malformed', () => {
    expect(() => run(() => offers.postOfferResponse(answer))).toThrow(
      "POST /offers returned no offer: the response has no 'offers' property. The provider says: 2103: Could not validate (part of) the routes.");
    expect(() => run(() => offers.postOfferResponse({ offers: 'x' }))).toThrow(/malformed OfferCollectionResponse envelope\. The provider gives no warning/);
  });
});
