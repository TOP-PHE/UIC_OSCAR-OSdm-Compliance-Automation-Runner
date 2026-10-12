// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-exchange-parts.test.js — #649: the booking read after an exchange holds
 * the parts sold first and the parts the exchange added. The first are checked
 * against the original offer, the others for their own status. A provider that
 * shows the pre-booked exchange in the booking (the form seen on a real
 * provider; the simulator shows it only once confirmed) failed 25 checks: the
 * new parts were compared with the original offer.
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
global.req = { getName: () => '13. GET Booking before Fulfillment' };

const { partIdsOf, splitExchangeBooking, checkAddedParts } = require('../../../Bruno_Collection/library-bruno/exchangeParts.js');
const exchanges = require('../../../Bruno_Collection/library-bruno/exchanges.js');
const rb = require('../../../Bruno_Collection/library-bruno/requestsBuilder.js');

const price = (amount) => ({ amount, currency: 'EUR', scale: 2 });
const now = new Date().toISOString();

// The original offer: one admission per passenger, on trip T1.
const OFFER = {
  offerId: 'O1',
  createdOn: now,
  offerSummary: { minimalPrice: price(200), overallFlexibility: 'FULL_FLEXIBLE', overallServiceClass: { type: 'STANDARD' } },
  admissionOfferParts: [
    { id: 'OP1', passengerRefs: ['PAX01'], price: price(120), refundable: 'YES', exchangeable: 'YES', createdOn: now, validFrom: now,
      appliedPassengerTypes: [{ type: 'ADULT', description: 'Adult', passengerRef: 'PAX01' }], tripCoverage: { coveredTripId: 'T1', coveredLegIds: ['L1'] } },
    { id: 'OP2', passengerRefs: ['PAX02'], price: price(80), refundable: 'YES', exchangeable: 'YES', createdOn: now, validFrom: now,
      appliedPassengerTypes: [{ type: 'YOUTH', description: 'Youth', passengerRef: 'PAX02' }], tripCoverage: { coveredTripId: 'T1', coveredLegIds: ['L1'] } },
  ],
};

// `ref` is the passengerRef of the applied passenger type. On the real
// provider, the original parts name the provider's passenger id there, and the
// exchange's parts name the externalRef of the exchange request (PAX01…), the
// same as the original offer: that is what made the old pairing take them.
const part = (id, pax, type, status, trip, ref = pax) => ({
  id, objectType: 'Admission', status, passengerIds: [pax], price: price(type === 'ADULT' ? 120 : 80),
  refundable: 'YES', exchangeable: 'YES', createdOn: now, validFrom: now,
  appliedPassengerTypes: [{ type, description: type[0] + type.slice(1).toLowerCase(), passengerRef: ref }],
  tripCoverage: { coveredTripId: trip, coveredLegIds: [trip === 'T1' ? 'L1' : 'L2'] },
});

// The booking before the exchange (step 07), and once the exchange is
// pre-booked: the original booked offer EXCHANGE_ONGOING, the new one
// PREBOOKED on another trip.
const BEFORE = { booking: { id: 'B1', confirmedPrice: price(200), bookedOffers: [
  { offerId: 'BO1', admissions: [part('A1', 'P1', 'ADULT', 'FULFILLED', 'T1'), part('A2', 'P2', 'YOUTH', 'FULFILLED', 'T1')] },
] } };
const prebooked = (newParts) => ({ booking: { id: 'B1', confirmedPrice: price(200), provisionalPrice: price(210), fulfillments: [], bookedOffers: [
  { offerId: 'BO1', admissions: [part('A1', 'P1', 'ADULT', 'EXCHANGE_ONGOING', 'T1'), part('A2', 'P2', 'YOUTH', 'EXCHANGE_ONGOING', 'T1')] },
  ...(newParts ? [{ offerId: 'BO2', admissions: [part('N1', 'P1', 'CHILD', 'PREBOOKED', 'T2', 'PAX01'), part('N2', 'P2', 'CHILD', 'PREBOOKED', 'T2', 'PAX02')] }] : []),
] } });

function run(fn) {
  mockResults = [];
  mockLogs = [];
  withBrunoExpect(fn);
  return mockResults;
}
const failed = (results) => results.filter((r) => !r.ok).map((r) => r.name);
const statusOrTypeFailures = (results) => failed(results).filter((n) => /^Status is|appliedPassengerTypes|^New /.test(n));

beforeEach(() => {
  envStore = { offer: OFFER, admissionReservationAncillaryBookingPartsIds: '[]' };
});

describe('exchangeParts (pure)', () => {
  test('partIdsOf lists every booked part, with or without the booking wrapper', () => {
    expect(partIdsOf(BEFORE)).toEqual(['A1', 'A2']);
    expect(partIdsOf(BEFORE.booking)).toEqual(['A1', 'A2']);
    expect(partIdsOf(null)).toEqual([]);
  });

  test('splitExchangeBooking keeps the parts held before and lists the others', () => {
    const { original, added } = splitExchangeBooking(prebooked(true), ['A1', 'A2']);
    expect(original.booking.bookedOffers).toHaveLength(1);
    expect(original.booking.bookedOffers[0].admissions.map((p) => p.id)).toEqual(['A1', 'A2']);
    expect(added.map((a) => `${a.list}:${a.part.id}`)).toEqual(['admissions:N1', 'admissions:N2']);
    expect(original.booking.confirmedPrice).toEqual(price(200));
  });

  test('checkAddedParts: before the confirmation, no new part is information only', () => {
    const checks = checkAddedParts([], ['PREBOOKED'], { confirmed: false });
    expect(checks).toHaveLength(1);
    expect(checks[0].level).toBe('info');
  });

  test('checkAddedParts: after the confirmation, the new admissions must be there', () => {
    expect(checkAddedParts([], ['FULFILLED'], { confirmed: true })).toEqual([
      expect.objectContaining({ ok: false, name: 'The booking holds the admissions the exchange sold' }),
    ]);
    const added = [{ list: 'admissions', part: { id: 'N1', status: 'PREBOOKED' } }];
    expect(checkAddedParts(added, ['FULFILLED', 'CONFIRMED'], { confirmed: true }).filter((c) => !c.ok)).toHaveLength(1);
  });
});

describe('checkBookingAroundExchange (step 13)', () => {
  test('a provider showing the pre-booked exchange: no status or passenger-type failure', () => {
    envStore.__partIdsBeforeExchange = JSON.stringify(partIdsOf(BEFORE));
    const results = run(() => exchanges.checkBookingAroundExchange(prebooked(true), 'prebooked'));
    expect(statusOrTypeFailures(results)).toEqual([]);
    expect(results.filter((r) => r.name.startsWith('Status is EXCHANGE_ONGOING')).length).toBe(2);
    expect(results.filter((r) => r.name.startsWith('New admission')).map((r) => r.ok)).toEqual([true, true]);
  });

  test('a provider not showing it yet: information, no failure', () => {
    envStore.__partIdsBeforeExchange = JSON.stringify(partIdsOf(BEFORE));
    const results = run(() => exchanges.checkBookingAroundExchange(prebooked(false), 'prebooked'));
    expect(statusOrTypeFailures(results)).toEqual([]);
    expect(mockLogs.some((l) => l.startsWith('[INFO] The pre-booked exchange is shown in the booking'))).toBe(true);
  });

  test('without the ids kept at 07, the whole booking is checked, as before #649', () => {
    const results = run(() => exchanges.checkBookingAroundExchange(prebooked(true), 'prebooked'));
    expect(mockLogs.some((l) => l.includes('were not kept'))).toBe(true);
    // The bug the split fixes: the new parts compared with the original offer.
    expect(statusOrTypeFailures(results).length).toBeGreaterThan(0);
  });
});

describe('requestExchangeOffersBody: no age unless the scenario gives one', () => {
  test('a date of birth only', () => {
    envStore = {
      fulfillmentIds: '["F1"]',
      offerPassengerSpecifications: '[{"externalRef":"PAX01","type":"PERSON","dateOfBirth":"1973-07-11"},{"externalRef":"PAX02","type":"PERSON","dateOfBirth":"2003-12-28","age":22}]',
      offerTripSearchCriteria: '{}',
      offerSearchCriteria: '{}',
    };
    rb.requestExchangeOffersBody();
    const specs = JSON.parse(envStore.requestExchangeOffersBodyData).anonymousPassengerSpecifications;
    expect(specs[0]).not.toHaveProperty('age');
    expect(specs[1].age).toBe(22);
  });

  test('the fallback passenger has no age either', () => {
    envStore = { fulfillmentIds: '["F1"]', offerPassengerSpecifications: '[]', offerTripSearchCriteria: '{}', offerSearchCriteria: '{}' };
    rb.requestExchangeOffersBody();
    expect(JSON.parse(envStore.requestExchangeOffersBodyData).anonymousPassengerSpecifications[0]).not.toHaveProperty('age');
  });
});

// #671: once the exchange is confirmed, a fulfillment that holds the parts it
// made failed "bookingParts.id exist …": 10 failures on a real provider, whose
// new parts even change id between the pre-booked exchange and its
// confirmation.
describe('#671: the fulfillments of the parts an exchange made', () => {
  const ff = (id, status, ...parts) => ({ id, status, bookingRef: 'B1', createdOn: now, controlNumber: 'C', bookingParts: parts.map((p) => ({ id: p })) });
  const confirmed = { booking: { id: 'B1', confirmedPrice: price(210), bookedOffers: [
    { offerId: 'BO1', admissions: [part('A1', 'P1', 'ADULT', 'EXCHANGED', 'T1'), part('A2', 'P2', 'YOUTH', 'EXCHANGED', 'T1')] },
    { offerId: 'BO2', admissions: [part('N7', 'P1', 'CHILD', 'FULFILLED', 'T2', 'PAX01'), part('N8', 'P2', 'CHILD', 'FULFILLED', 'T2', 'PAX02')] },
  ], fulfillments: [ff('F1', 'EXCHANGED', 'A1', 'A2'), ff('F2', 'FULFILLED', 'N7', 'N8')] } };
  const partChecks = (results) => results.filter((r) => r.name.includes('bookingParts.id exist'));

  test('step 15: the booking\'s new parts are known, every fulfillment passes', () => {
    envStore.__partIdsBeforeExchange = JSON.stringify(['A1', 'A2']);
    envStore.bookingId = 'B1';
    const results = run(() => exchanges.checkBookingAroundExchange(confirmed, 'confirmed'));
    expect(partChecks(results).map((r) => r.ok)).toEqual([true, true]);
  });

  test('step 14: a part not seen before is said, not failed; a known one is still checked', () => {
    const { validateFulfillments } = require('../../../Bruno_Collection/library-bruno/bookings.js');
    envStore.admissionReservationAncillaryBookingPartsIds = JSON.stringify(['A1', 'A2']);
    envStore.bookingId = 'B1';
    const deferred = run(() => validateFulfillments([ff('F2', 'FULFILLED', 'N7', 'N8')], 0, ['FULFILLED'], false, undefined, { deferUnknownParts: true }));
    expect(partChecks(deferred).map((r) => r.ok)).toEqual([true]);
    expect(mockLogs.some((l) => l.startsWith('[INFO] Fulfillment[0] holds part(s) not seen before (N7, N8)'))).toBe(true);
    const strict = run(() => validateFulfillments([ff('F2', 'FULFILLED', 'N7', 'N8')], 0, ['FULFILLED'], false));
    expect(partChecks(strict).map((r) => r.ok)).toEqual([false]);
  });

  test('step 14 of an exchange asks for it', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    expect(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'Bruno_Collection', '04-Exchange', '14. POST Obtaining Fulfillments from Booking.yml'), 'utf8'))
      .toMatch(/jsonData\.fulfillmentDocuments, \{ deferUnknownParts: true \}\);/);
  });
});
