// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-confirmed-fulfillments.test.js — the fulfilments the confirmation gave
 * (#1045). A real provider answered POST /bookings/{id}/fulfillments with two
 * fulfilments, then gave the booking at 07 with `fulfillments: []`. The fare
 * refund took its ids from that booking and sent `{"fulfillmentIds": []}`,
 * which the provider refused (400) and OSCAR's own conformance check called an
 * OSCAR issue. Step 06 now keeps the confirmation's fulfilments; at 07 a
 * booking that lists none is a WARNING and the refund names the
 * confirmation's; with none from either, the scenario ends at 07.
 */

const fs = require('node:fs');
const path = require('node:path');
const { withBrunoExpect } = require('../helpers/bruno-chai.js');

const ROOT = path.join(__dirname, '..', '..', '..');
const LIB = path.join(ROOT, 'Bruno_Collection', 'library-bruno');

let env = {};
let mockRecorded = [];
let mockLogs = [];
let next = null;
let stopped = false;
global.bru = {
  getEnvVar: (k) => env[k],
  setEnvVar: (k, v) => { env[k] = v; },
  runner: { setNextRequest: (n) => { next = n; }, stopExecution: () => { stopped = true; } },
};
jest.mock('../../../Bruno_Collection/library-bruno/displays.js', () => ({
  validationLogger: (line) => { mockLogs.push(line); },
}));
jest.mock('../../../Bruno_Collection/library-bruno/testCapture.js', () => ({
  bruTest: (name, fn) => { try { fn(); mockRecorded.push(`${name}: ok`); } catch (e) { mockRecorded.push(`${name}: ${e.message}`); } },
  expectTypeOrNull: () => {},
  expectScale: () => {},
}));
global.validationLogger = (line) => { mockLogs.push(line); };
const realTest = test;

const C = require(path.join(LIB, 'confirmedFulfillments.js'));
const fareBooking = require(path.join(LIB, 'fareBooking.js'));
const bookings = require(path.join(LIB, 'bookings.js'));
const refunds = require(path.join(LIB, 'refunds.js'));
const { buildOfferCollection } = require('../../../OSDM_Simulator/src/osdm/offers');
const { createBooking, confirmBooking } = require('../../../OSDM_Simulator/src/osdm/bookings');
const { loadProviders } = require('../../../OSDM_Simulator/src/config');

// The provider's answers, as in its run: the confirmation's two fulfilments,
// the booking read after it listing none.
const CONFIRMATION = {
  fulfillments: [
    { id: '15900622583907', status: 'FULFILLED', bookingRef: 'B1', bookingParts: [{ id: 'fare-1', summary: null }], controlNumber: 'XXXXXXXXXXXX' },
    { id: '15900622583908', status: 'FULFILLED', bookingRef: 'B1', bookingParts: [{ id: 'fare-2', summary: null }] },
  ],
};

beforeEach(() => {
  env = {};
  mockRecorded = [];
  mockLogs = [];
  next = null;
  stopped = false;
  global.test = (name, fn) => { try { fn(); mockRecorded.push(`${name}: ok`); } catch (e) { mockRecorded.push(`${name}: ${e.message}`); } };
});
afterAll(() => { delete global.bru; delete global.validationLogger; global.test = realTest; });

describe('the rules', () => {
  realTest('what is kept of a fulfilment: its id, status and the parts it names', () => {
    expect(C.keptOf(CONFIRMATION.fulfillments)).toEqual([
      { id: '15900622583907', status: 'FULFILLED', bookingParts: [{ id: 'fare-1' }] },
      { id: '15900622583908', status: 'FULFILLED', bookingParts: [{ id: 'fare-2' }] },
    ]);
    expect(C.keptOf([{ status: 'FULFILLED' }, null, { id: '' }])).toEqual([]);
    expect(C.idsOf(undefined)).toEqual([]);
  });

  realTest('the booking against the confirmation: none given, all listed, none listed, some missing', () => {
    const given = C.keptOf(CONFIRMATION.fulfillments);
    expect(C.bookingListCheck([{ id: 'X' }], [])).toBeNull();
    expect(C.bookingListCheck(CONFIRMATION.fulfillments, given)).toEqual({ name: C.LIST_CHECK, ok: true });
    const none = C.bookingListCheck([], given);
    expect(none.ok).toBe(false);
    expect(none.message).toMatch(/^it lists no fulfilment, though the confirmation gave 15900622583907, 15900622583908\. OSCAR goes on/);
    expect(C.bookingListCheck([{ id: '15900622583907' }], given).message).toMatch(/^it does not list 15900622583908,/);
  });

  realTest('a refund or exchange names the booking\'s fulfilments when it lists some, else the confirmation\'s', () => {
    const given = C.keptOf(CONFIRMATION.fulfillments);
    expect(C.idsOf(C.fulfillmentsInUse([], given))).toEqual(['15900622583907', '15900622583908']);
    expect(C.idsOf(C.fulfillmentsInUse([{ id: 'NEW' }], given))).toEqual(['NEW']);
    expect(C.fulfillmentsInUse(undefined, [])).toEqual([]);
  });

  realTest('only a refund or an exchange with no id to name is stopped', () => {
    expect(C.nothingToNameCheck('SALE', [])).toBeNull();
    expect(C.nothingToNameCheck('REFUND', ['F1'])).toBeNull();
    expect(C.nothingToNameCheck('REFUND', []).name).toBe('A fulfilment to name in the refund offer request');
    expect(C.nothingToNameCheck('EXCHANGE', []).message).toMatch(/the exchange offer request needs at least one \(OSDM: fulfillmentIds, minItems 1\)/);
  });
});

describe('a fare refund on the provider\'s answers', () => {
  const gamma = loadProviders(path.join(ROOT, 'OSDM_Simulator', 'providers')).get('gamma');
  const NOW = Date.parse('2026-11-02T09:00:00Z');
  const station = (code) => ({ objectType: 'StopPlaceRef', stopPlaceRef: `urn:uic:stn:${code}` });
  const PASSENGERS = [{ externalRef: '00001', type: 'PERSON', dateOfBirth: '1990-01-15' }];

  // A fare sale on the simulator, its booking read after the confirmation emptied of fulfilments.
  function sale() {
    const request = {
      tripSpecifications: [{ isPartOfInternationalTrip: true, legs: [{ timedLeg: {
        start: { stopPlaceRef: station('0000001'), serviceDeparture: { timetabledTime: '2026-11-20T08:00:00+01:00' } },
        end: { stopPlaceRef: station('0000002'), serviceArrival: { timetabledTime: '2026-11-20T11:00:00+01:00' } },
        service: { vehicleNumbers: ['1001'] },
      } }] }],
      requestedSections: [{ startPlace: station('0000001'), endPlace: station('0000002') }],
      offerSearchCriteria: { requestedOfferParts: ['FARE_ADMISSION'] },
      anonymousPassengerSpecifications: PASSENGERS,
    };
    const { response, remembered } = buildOfferCollection(request, gamma, NOW);
    const offer = response.offers.find((o) => o.fares);
    const known = new Map(remembered.map((entry) => [entry.offer.offerId, entry]));
    const booking = createBooking({
      offers: [{ offerId: offer.offerId, passengerRefs: offer.passengerRefs }],
      passengerSpecifications: PASSENGERS.map((p) => ({ ...p, detail: { firstName: 'Ada', lastName: 'Example' } })),
    }, (id) => known.get(id), gamma, NOW);
    const fulfillments = structuredClone(confirmBooking(booking, gamma, NOW + 1000));
    const confirmed = structuredClone(booking);
    confirmed.fulfillments = [];
    return { offer, fulfillments, confirmed };
  }

  realTest('the booking lists none: a WARNING, F5 reads the confirmation\'s, the refund names its ids', () => {
    const s = sale();
    Object.assign(env, { __fareSale: 'true', offer: s.offer, scenarioType: 'REFUND' });
    C.keepConfirmation({ fulfillments: s.fulfillments });
    expect(fareBooking.checkFareConfirmedStep({ booking: s.confirmed })).toBe(true);
    expect(next).toBe('10. POST Refund Offers');
    const ids = s.fulfillments.map((f) => f.id);
    expect(env.fulfillmentIds).toEqual(ids);
    expect(JSON.parse(env.__bookingFulfillmentIds)).toEqual(ids);
    expect(JSON.parse(env.__fareRefundFulfillments).map((f) => f.fulfillmentId)).toEqual(ids);
    expect(mockRecorded.filter((r) => !r.endsWith(': ok'))).toEqual([]);
    expect(mockRecorded).toContain('[fares F5] Every booked fare is in a fulfilment (bookingParts): ok');
    expect(mockLogs.filter((l) => l.startsWith(`[WARNING] ${C.LIST_CHECK} — it lists no fulfilment`))).toHaveLength(1);
  });

  realTest('neither lists one: F5 fails, one failed check names the refund, and the request is not sent', () => {
    const s = sale();
    Object.assign(env, { __fareSale: 'true', offer: s.offer, scenarioType: 'REFUND' });
    C.keepConfirmation({ fulfillments: [] });
    expect(fareBooking.checkFareConfirmedStep({ booking: s.confirmed })).toBe(true);
    expect(next).not.toBe('10. POST Refund Offers');
    expect(stopped).toBe(true);
    expect(mockRecorded.filter((r) => !r.endsWith(': ok'))).toEqual([
      '[fares F5] Every booked fare is in a fulfilment (bookingParts): fares in no fulfilment: neither the booking nor the confirmation lists a fulfilment',
      expect.stringMatching(/^A fulfilment to name in the refund offer request: neither the confirmation/),
    ]);
  });

  realTest('a sale only: nothing is stopped, the scenario ends as before', () => {
    const s = sale();
    Object.assign(env, { __fareSale: 'true', offer: s.offer, scenarioType: 'SALE' });
    C.keepConfirmation({ fulfillments: s.fulfillments });
    expect(fareBooking.checkFareConfirmedStep({ booking: s.confirmed })).toBe(true);
    expect(stopped).toBe(true);
    expect(mockRecorded.filter((r) => !r.endsWith(': ok'))).toEqual([]);
  });
});

describe('a product sale\'s booking read after the confirmation', () => {
  const run = () => withBrunoExpect(() => bookings.validateFulfillments([], 0, ['FULFILLED', 'CONFIRMED'], true, undefined));

  realTest('the confirmation gave fulfilments: no failed check there (07 mockLogs the WARNING)', () => {
    C.keepConfirmation(CONFIRMATION);
    run();
    expect(mockRecorded).toEqual([]);
  });

  realTest('the confirmation gave none: the #250 check still fails', () => {
    C.keepConfirmation({});
    run();
    expect(mockRecorded).toEqual([expect.stringMatching(/^Booking embeds the generated fulfillments after fulfillment .*: GET \/bookings returned no fulfillments/)]);
  });
});

describe('step 14 on a booking read listing no fulfilment', () => {
  // The provider's form (simulator variant booking-without-fulfillments):
  // the confirmation gave F1 and F2, the booking lists none, F1 was refunded.
  const booking = { fulfillments: [], bookedOffers: [{ admissions: [{ id: 'A1', status: 'REFUNDED' }, { id: 'A2', status: 'FULFILLED' }] }] };
  const confirm = () => C.keepConfirmation({ fulfillments: [
    { id: 'F1', status: 'FULFILLED', bookingParts: [{ id: 'A1' }] },
    { id: 'F2', status: 'FULFILLED', bookingParts: [{ id: 'A2' }] },
  ] });

  realTest('the parts are checked through the confirmation, with one WARNING, and no fulfilment state is read', () => {
    confirm();
    env.__refundedFulfillmentIds = JSON.stringify(['F1']);
    withBrunoExpect(() => refunds.checkRefundScopeOnBooking(booking));
    expect(mockRecorded).toEqual([
      'Booked admission A1 is REFUNDED - status: REFUNDED: ok',
      'Booked admission A2 is not REFUNDED (left out of the refund) - status: FULFILLED: ok',
    ]);
    expect(mockLogs.filter((l) => l.startsWith('[WARNING] Refund scope: the booking read after the refund lists no fulfilment, so the REFUNDED state of F1, F2'))).toHaveLength(1);
    expect(refunds.isScopedRefundOnBooking(booking)).toBe(true);
  });

  realTest('a full refund is held to every fulfilment the confirmation gave', () => {
    confirm();
    env.__refundedFulfillmentIds = JSON.stringify(['F1']);
    refunds.checkFullRefundDone(booking);
    env.__refundedFulfillmentIds = JSON.stringify(['F1', 'F2']);
    refunds.checkFullRefundDone(booking);
    expect(mockRecorded).toEqual([
      'Full refund: every fulfillment of the booking is refunded (1/2): not refunded by any confirmed refund offer: [F2]',
      'Full refund: every fulfillment of the booking is refunded (2/2): ok',
    ]);
  });

  realTest('neither the booking nor the confirmation lists one: the part-level check is skipped, nothing fails', () => {
    C.keepConfirmation({});
    env.__refundedFulfillmentIds = JSON.stringify(['F1']);
    withBrunoExpect(() => refunds.checkRefundScopeOnBooking(booking));
    expect(mockRecorded).toEqual([]);
    expect(mockLogs).toContain('[INFO] Refund scope: neither the booking nor the confirmation lists a fulfilment — the part-level scope check is skipped.');
  });
});

describe('the wiring', () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

  realTest('06 keeps the confirmation\'s fulfilments before the fare and product checks', () => {
    const six = read('Bruno_Collection/02-Common Requests/06. POST Obtaining Fulfillments from Booking.yml');
    const at = six.indexOf('confirmedFulfillments.js").keepConfirmation(jsonData);');
    expect(at).toBeGreaterThan(six.indexOf('jsonData = res.getBody();'));
    expect(at).toBeLessThan(six.indexOf('checkFareFulfillmentStep(jsonData)'));
    expect(at).toBeLessThan(six.indexOf('validateFulfillments(jsonData.fulfillments'));
  });

  realTest('07 checks the list and may stop before it routes a product refund or exchange', () => {
    const seven = read('Bruno_Collection/02-Common Requests/07. GET Booking after Fulfillments.yml');
    const at = seven.indexOf('_confirmation.stopWithoutFulfillment(_ids)) return;');
    expect(at).toBeGreaterThan(seven.indexOf('postCreateBookingResponse('));
    expect(at).toBeLessThan(seven.indexOf('bru.runner.setNextRequest("10. POST Refund Offers");'));
  });

  realTest('the variable is cleared with the sale: both reset lists and each expiry sub-run', () => {
    for (const file of ['Bruno_Collection/opencollection.yml', 'Bruno_Collection/library-bruno/scenarioParser.js']) {
      expect([file, read(file).includes('"__bookingFulfillmentIds", "__confirmedFulfillments"')]).toEqual([file, true]);
    }
    expect(read('Bruno_Collection/library-bruno/expiredFlow.js')).toContain("'__bookingFulfillmentIds', '__confirmedFulfillments',");
  });
});
