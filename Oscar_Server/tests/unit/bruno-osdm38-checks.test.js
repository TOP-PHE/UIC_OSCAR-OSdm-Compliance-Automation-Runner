// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-osdm38-checks.test.js — #613: checks of the collection that disagreed
 * with the OSDM specification (3.5 and 3.8, both in the repository:
 * Bruno_Collection/json_validator/openapi3_0.json and
 * Documentation/Test_Coverage/OSDM_reference/OSDM-online-api-v3.8.0.yml).
 *
 * Each block runs the real validator on an answer the specification allows
 * and records every check (name, pass/fail) and every log line, as
 * bruno-bookings-part-pairing.test.js does. The comment of each block names
 * what the old code did with the same answer.
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
jest.mock('../../../Bruno_Collection/library-bruno/requestedInformation.js', () => ({
  processRequestedInformation: () => {},
  summariseRequestedInformation: () => '',
}));
// offers.js logs through a global validationLogger as well.
global.validationLogger = (line) => { mockLogs.push(line); };

const { OSDM_PASSENGER_TYPES, classifyExtensibleCode } = require('../../../Bruno_Collection/library-bruno/osdmEnums.js');
const offers = require('../../../Bruno_Collection/library-bruno/offers.js');
const bookings = require('../../../Bruno_Collection/library-bruno/bookings.js');
const passengers = require('../../../Bruno_Collection/library-bruno/passengers.js');
const exchanges = require('../../../Bruno_Collection/library-bruno/exchanges.js');
const refunds = require('../../../Bruno_Collection/library-bruno/refunds.js');
const auth = require('../../../Bruno_Collection/library-bruno/auth.js');

function run(fn) {
  mockResults = [];
  mockLogs = [];
  withBrunoExpect(fn);
  return { results: mockResults, logs: mockLogs };
}
const failed = (r) => r.results.filter((x) => !x.ok);
const named = (r, part) => r.results.filter((x) => x.name.includes(part));
const warned = (r, part) => r.logs.some((l) => l.startsWith('[WARNING]') && l.includes(part));

beforeEach(() => { envStore = {}; });

// ─── F4 PassengerType: extensible list, both spellings ──────────────────────
describe('F4 PassengerType', () => {
  test('both spellings of the two renamed values are listed (3.5 and 3.8)', () => {
    for (const v of ['ACCOMP_DOG', 'COMPANION_DOG', 'MOTOCYCLE', 'MOTORCYCLE']) {
      expect(OSDM_PASSENGER_TYPES).toContain(v);
    }
  });

  test('classifyExtensibleCode: text required, listed or not', () => {
    expect(classifyExtensibleCode('ADULT', OSDM_PASSENGER_TYPES)).toEqual({ ok: true, known: true });
    expect(classifyExtensibleCode('A', OSDM_PASSENGER_TYPES)).toEqual({ ok: true, known: false });
    expect(classifyExtensibleCode('', OSDM_PASSENGER_TYPES)).toEqual({ ok: false, known: false });
    expect(classifyExtensibleCode(undefined, OSDM_PASSENGER_TYPES)).toEqual({ ok: false, known: false });
    expect(classifyExtensibleCode(3, OSDM_PASSENGER_TYPES)).toEqual({ ok: false, known: false });
  });

  // Old code: `oneOf([... 'COMPANION_DOG' ... 'MOTORCYCLE' ...])` → ACCOMP_DOG and 'A' failed.
  test('POST /offers passengers: the 3.8 value passes, a provider code passes with a WARNING, a missing type fails', () => {
    const r = run(() => offers.validatePassengers({
      anonymousPassengerSpecifications: [
        { externalRef: 'P1', type: 'ACCOMP_DOG' },
        { externalRef: 'P2', type: 'A' },
        { externalRef: 'P3' },
      ],
    }));
    const typeChecks = named(r, 'type is a non-empty PassengerType code');
    expect(typeChecks.map((x) => x.ok)).toEqual([true, true, false]);
    expect(warned(r, "Passenger 2 type 'A'")).toBe(true);
    expect(warned(r, "'ACCOMP_DOG'")).toBe(false);
  });

  // Old code: `appliedPassengerTypes[].type` oneOf the closed list → 'C' failed.
  test('appliedPassengerTypes: a provider code is a WARNING, not a failure', () => {
    envStore.admissionReservationAncillaryOfferPartsIds = '[]';
    const r = run(() => offers.validateAdmissions({
      offerSummary: { overallFlexibility: 'FULL_FLEXIBLE' },
      admissionOfferParts: [{
        id: 'adm-1', validFrom: '2030-01-01T08:00:00Z', price: { amount: 100, currency: 'EUR', scale: 2 },
        appliedPassengerTypes: [{ passengerRef: 'P1', type: 'C' }, { passengerRef: 'P2', type: 'MOTOCYCLE' }],
      }],
    }));
    const checks = named(r, 'appliedPassengerTypes[');
    expect(checks.length).toBe(2);
    expect(checks.every((x) => x.ok)).toBe(true);
    expect(warned(r, "appliedPassengerTypes[0].type 'C'")).toBe(true);
  });

  // Old code: `expect(OSDM_PASSENGER_TYPES).to.include(type)` → 'Y' failed.
  test('PATCH passenger answer: a provider code passes with a WARNING, a missing type is not checked', () => {
    envStore.offerPassengerNumber = '1';
    envStore.passengerAdditionalData = JSON.stringify([{ firstName: 'A', lastName: 'B' }]);
    const answer = (type) => ({ passenger: { id: 'p1', type, detail: { firstName: 'A', lastName: 'B' } } });
    const r = run(() => passengers.patchMultiPassengerResponse(answer('Y'), 0));
    const check = named(r, 'Passenger 0 - type is a non-empty PassengerType code');
    expect(check.length).toBe(1);
    expect(check[0].ok).toBe(true);
    expect(warned(r, "'Y'")).toBe(true);
    expect(named(run(() => passengers.patchMultiPassengerResponse(answer(undefined), 0)), 'PassengerType')).toEqual([]);
  });
});

// ─── F3 fulfillment statuses ────────────────────────────────────────────────
describe('F3 fulfillment statuses', () => {
  // Old code: allowed list UNISSUED/ISSUED/… → every 3.8 value failed.
  test.each(['PENDING', 'CREATED', 'COMPLETE'])('booking.fulfillmentStatus %s passes without WARNING', (v) => {
    const r = run(() => bookings.checkFulfillmentSummaryStatus({ fulfillmentStatus: v }));
    expect(failed(r)).toEqual([]);
    expect(r.logs.some((l) => l.startsWith('[WARNING]'))).toBe(false);
  });

  test('booking.fulfillmentStatus outside the list is a WARNING, not a failure', () => {
    const r = run(() => bookings.checkFulfillmentSummaryStatus({ fulfillmentStatus: 'ISSUED' }));
    expect(failed(r)).toEqual([]);
    expect(warned(r, "'ISSUED'")).toBe(true);
  });

  function fulfillment(status, extra = {}) {
    return { id: 'F1', status, createdOn: '2026-01-01T10:00:00Z', bookingParts: [{ id: 'bp-1' }], ...extra };
  }
  const statusCheck = (r) => named(r, 'is a valid OSDM FulfillmentStatus')[0];

  // Old code: CHECKEDIN missing from the list → failed.
  test('CHECKEDIN is a valid FulfillmentStatus', () => {
    envStore.admissionReservationAncillaryBookingPartsIds = JSON.stringify(['bp-1']);
    const r = run(() => bookings.validateFulfillments([fulfillment('CHECKEDIN')], 0, ['CHECKEDIN']));
    expect(statusCheck(r).ok).toBe(true);
  });

  // Old code: USED, PARTIALLY_USED and RESERVED were accepted.
  test.each(['USED', 'PARTIALLY_USED', 'RESERVED'])('%s is not an OSDM FulfillmentStatus', (v) => {
    envStore.admissionReservationAncillaryBookingPartsIds = JSON.stringify(['bp-1']);
    const r = run(() => bookings.validateFulfillments([fulfillment(v)], 0, [v]));
    expect(statusCheck(r).ok).toBe(false);
  });

  // ─── F8 bookingParts optional in the schema ───────────────────────────────
  // Old code: the check title called fulfillment.bookingParts.map(...) → TypeError, step aborted.
  test('F8: a fulfillment without bookingParts fails one check instead of aborting', () => {
    envStore.admissionReservationAncillaryBookingPartsIds = JSON.stringify(['bp-1']);
    let r;
    expect(() => { r = run(() => bookings.validateFulfillments([fulfillment('FULFILLED', { bookingParts: undefined })], 0, ['FULFILLED'])); }).not.toThrow();
    const check = named(r, 'bookingParts.id exist')[0];
    expect(check.ok).toBe(false);
    expect(check.name).toContain('(no bookingParts)');
  });
});

// ─── F10 warnings as a WarningCollection ────────────────────────────────────
describe('F10 envelope warnings', () => {
  const w = { code: 'urn:uic:problem:X', title: 'Something to know' };

  test('a WarningCollection object is read', () => {
    expect(offers.envelopeWarnings({ warnings: { warnings: [w] } })).toEqual([w]);
  });

  test('a bare array is still read, with a WARNING on its shape', () => {
    const logs = [];
    expect(offers.envelopeWarnings({ warnings: [w] }, (l) => logs.push(l))).toEqual([w]);
    expect(logs.some((l) => l.startsWith('[WARNING]') && l.includes('WarningCollection'))).toBe(true);
  });

  test('absent, null or malformed: no warning', () => {
    expect(offers.envelopeWarnings({})).toEqual([]);
    expect(offers.envelopeWarnings({ warnings: null })).toEqual([]);
    expect(offers.envelopeWarnings({ warnings: {} })).toEqual([]);
  });

  // Old code: Array.isArray(jsonData.warnings) → the conformant object was never logged.
  test('checkWarningsAndProblems logs the warnings of a WarningCollection', () => {
    const r = run(() => offers.checkWarningsAndProblems({ warnings: { warnings: [w] } }));
    expect(r.logs.some((l) => l.includes('Response envelope warning 1/1') && l.includes('Something to know'))).toBe(true);
  });
});

// ─── F11 optional members ───────────────────────────────────────────────────
describe('F11 optional members', () => {
  // Old code: 'Price fields exist (currency, scale)' failed without scale.
  test('minimalPrice without scale passes, with an INFO line', () => {
    const r = run(() => offers.validateOfferSummary({
      offerSummary: { minimalPrice: { amount: 1000, currency: 'EUR' }, overallFlexibility: 'FULL_FLEXIBLE', overallTravelClass: 'SECOND' },
    }));
    expect(named(r, 'Price fields exist')[0].ok).toBe(true);
    expect(r.logs.some((l) => l.startsWith('[INFO]') && l.includes('scale'))).toBe(true);
  });

  test('minimalPrice without currency still fails', () => {
    const r = run(() => offers.validateOfferSummary({
      offerSummary: { minimalPrice: { amount: 1000 }, overallFlexibility: 'FULL_FLEXIBLE' },
    }));
    expect(named(r, 'Price fields exist')[0].ok).toBe(false);
  });

  // Old code: 'direction is a known value' failed when absent.
  test('a trip without direction is not checked; a wrong direction still fails', () => {
    const trip = (direction) => ({ id: 'T1', startTime: '2030-01-01T08:00:00Z', endTime: '2030-01-01T10:00:00Z', direction, legs: [] });
    const absent = run(() => offers.validateTripsAndLegs({ trips: [trip(undefined)] }));
    expect(named(absent, 'direction')).toEqual([]);
    const wrong = run(() => offers.validateTripsAndLegs({ trips: [trip('SIDEWAYS')] }));
    expect(named(wrong, 'direction')[0].ok).toBe(false);
  });

  // Old code: minimalPrice >= sum of admissions + reservations + referenced ancillaries.
  test('an optional reservation priced above minimalPrice no longer fails the offer', () => {
    const r = run(() => offers.validateOfferParts({
      offerSummary: { minimalPrice: { amount: 5000, currency: 'EUR', scale: 2 } },
      admissionOfferParts: [{ id: 'adm-1', price: { amount: 5000, currency: 'EUR', scale: 2 } }],
      reservationOfferParts: [{ id: 'res-1', price: { amount: 1000, currency: 'EUR', scale: 2 } }],
    }));
    const check = named(r, 'minimalPrice >= sum of admission parts')[0];
    expect(check.ok).toBe(true);
    expect(r.logs.some((l) => l.startsWith('[INFO]') && l.includes('optional'))).toBe(true);
  });

  test('a minimalPrice below the admissions still fails', () => {
    const r = run(() => offers.validateOfferParts({
      offerSummary: { minimalPrice: { amount: 4000, currency: 'EUR', scale: 2 } },
      admissionOfferParts: [{ id: 'adm-1', price: { amount: 5000, currency: 'EUR', scale: 2 } }],
    }));
    expect(named(r, 'minimalPrice >= sum of admission parts')[0].ok).toBe(false);
  });

  // Old code: 'validUntil is in the future' ran on new Date(undefined) and failed.
  test('an admission without validUntil is not checked; a past one still fails', () => {
    envStore.admissionReservationAncillaryOfferPartsIds = '[]';
    const part = (validUntil) => ({
      offerSummary: { overallFlexibility: 'FULL_FLEXIBLE' },
      admissionOfferParts: [{ id: 'adm-1', validFrom: '2026-01-01T08:00:00Z', validUntil, price: { amount: 1, currency: 'EUR', scale: 2 } }],
    });
    expect(named(run(() => offers.validateAdmissions(part(undefined))), 'validUntil is in the future')).toEqual([]);
    expect(named(run(() => offers.validateAdmissions(part('2001-01-01T00:00:00Z'))), 'validUntil is in the future')[0].ok).toBe(false);
  });
});

// ─── F12 exchange offer required members ────────────────────────────────────
describe('F12 exchange offer', () => {
  const price = { amount: 100, currency: 'EUR', scale: 2 };
  const offer = (extra = {}) => ({
    offerId: 'X1', createdOn: '2026-01-01T10:00:00Z', preBookableUntil: '2099-01-01T10:00:00Z',
    passengerRefs: ['P1'], fulfillments: [{ id: 'F1' }], admissionOfferParts: [{ id: 'a' }],
    exchangeFee: price, exchangePrice: price, ...extra,
  });
  const requiredCheck = (r) => named(r, 'has required properties')[0];

  // Old code: offerSummary (optional) was required → this offer failed.
  test('an exchange offer without offerSummary passes the required-members check', () => {
    const r = run(() => exchanges.validateExchangeOfferResponse(offer(), 0, ['FULFILLED']));
    expect(requiredCheck(r).ok).toBe(true);
  });

  // Old code: createdOn, passengerRefs and fulfillments were not checked → passed.
  test.each(['createdOn', 'passengerRefs', 'fulfillments'])('an exchange offer without %s fails', (member) => {
    const r = run(() => exchanges.validateExchangeOfferResponse(offer({ [member]: undefined }), 0, ['FULFILLED']));
    expect(requiredCheck(r).ok).toBe(false);
  });

  // Old code: an absent preBookableUntil was skipped.
  test('an exchange offer without preBookableUntil fails', () => {
    const r = run(() => exchanges.validateExchangeOfferResponse(offer({ preBookableUntil: undefined }), 0, ['FULFILLED']));
    expect(named(r, 'preBookableUntil')[0].ok).toBe(false);
  });
});

// ─── F2 / F5 / F6 refund path ───────────────────────────────────────────────
describe('F2, F5, F6 refund path', () => {
  const price = (amount) => ({ amount, currency: 'EUR', scale: 2 });
  const refundOffer = (status, ids, refundable = 900, fee = 100, extra = {}) => ({
    id: 'RO1', status, createdOn: '2026-01-01T10:00:00Z', validFrom: '2026-01-01T10:00:00Z', validUntil: '2099-01-01T10:00:00Z',
    refundableAmount: price(refundable), refundFee: price(fee),
    fulfillments: ids.map((id) => ({ id, status: status === 'CONFIRMED' ? 'REFUNDED' : 'FULFILLED', bookingParts: [{ id: `bp-${id}` }] })),
    ...extra,
  });

  // Old code: the PROPOSED amounts were stored only when the *fulfillment*
  // status contained PROPOSED, which never happens — no comparison existed.
  test('F5: a refund offer confirmed at its proposed amounts passes; a changed amount fails', () => {
    run(() => refunds.postPatchRefundOfferResponse({ refundOffers: [refundOffer('PROPOSED', ['F1'])] }, ['PROPOSED'], ['FULFILLED']));
    const same = run(() => refunds.postPatchRefundOfferResponse({ refundOffer: refundOffer('CONFIRMED', ['F1']) }, ['CONFIRMED'], ['REFUNDED']));
    expect(named(same, 'confirmed with the amounts it was proposed at')[0].ok).toBe(true);

    envStore = {};
    run(() => refunds.postPatchRefundOfferResponse({ refundOffers: [refundOffer('PROPOSED', ['F1'])] }, ['PROPOSED'], ['FULFILLED']));
    const changed = run(() => refunds.postPatchRefundOfferResponse({ refundOffer: refundOffer('CONFIRMED', ['F1'], 800, 200) }, ['CONFIRMED'], ['REFUNDED']));
    expect(named(changed, 'confirmed with the amounts it was proposed at')[0].ok).toBe(false);
  });

  // Old code: isRefundConfirmed was set only by a function no request calls.
  test('F6: a confirmed refund offer sets isRefundConfirmed and records its fulfillments', () => {
    run(() => refunds.postPatchRefundOfferResponse({ refundOffer: refundOffer('CONFIRMED', ['F2']) }, ['CONFIRMED'], ['REFUNDED']));
    expect(envStore.isRefundConfirmed).toBe('true');
    expect(JSON.parse(envStore.__refundedFulfillmentIds)).toEqual(['F2']);
  });

  // Old code: the breakdown was read as refundOfferBreakDown and required a
  // fulfillmentId, which RefundOfferBreakdownItem does not have.
  test('F5: the spec member refundOfferBreakdown is checked, without fulfillmentId', () => {
    const ro = refundOffer('PROPOSED', ['F1'], 900, 100, {
      refundOfferBreakdown: [{ refundFee: price(100), refundableAmount: price(900), bookingParts: [{ id: 'bp-F1' }] }],
    });
    const r = run(() => refunds.validateRefundOfferResponse(ro, 0, ['PROPOSED'], ['FULFILLED']));
    const check = named(r, 'breakdown[0] is valid');
    expect(check.length).toBe(1);
    expect(check[0].ok).toBe(true);
  });

  test('F5: the misspelt member is still read, with a WARNING', () => {
    const ro = refundOffer('PROPOSED', ['F1'], 900, 100, {
      refundOfferBreakDown: [{ refundFee: price(100), refundableAmount: price(900), bookingParts: [{ id: 'bp-F1' }] }],
    });
    const r = run(() => refunds.validateRefundOfferResponse(ro, 0, ['PROPOSED'], ['FULFILLED']));
    expect(named(r, 'breakdown[0] is valid')[0].ok).toBe(true);
    expect(warned(r, "'refundOfferBreakDown'")).toBe(true);
  });

  test('F2: refundScope — one fulfillment of two is scoped, all of them is not', () => {
    envStore.__bookingFulfillmentIds = JSON.stringify(['F1', 'F2']);
    expect(refunds.refundScope(refundOffer('PROPOSED', ['F1'])).scoped).toBe(true);
    expect(refunds.refundScope(refundOffer('PROPOSED', ['F1', 'F2'])).scoped).toBe(false);
  });

  // Old code: step 14 expected every fulfillment and every part REFUNDED.
  const booking = (s1, s2, p1, p2) => ({
    fulfillments: [
      { id: 'F1', status: s1, bookingParts: [{ id: 'bp-1' }] },
      { id: 'F2', status: s2, bookingParts: [{ id: 'bp-2' }] },
    ],
    bookedOffers: [{ admissions: [{ id: 'bp-1', status: p1 }, { id: 'bp-2', status: p2 }] }],
  });

  test('F2: after refunding F1 only, F1 and its part are REFUNDED and F2 is untouched', () => {
    envStore.__refundedFulfillmentIds = JSON.stringify(['F1']);
    const b = booking('REFUNDED', 'FULFILLED', 'REFUNDED', 'FULFILLED');
    expect(refunds.isScopedRefundOnBooking(b)).toBe(true);
    const r = run(() => refunds.checkRefundScopeOnBooking(b));
    expect(r.results.length).toBe(4);
    expect(failed(r)).toEqual([]);
  });

  test('F2: a fulfillment or part refunded although left out fails', () => {
    envStore.__refundedFulfillmentIds = JSON.stringify(['F1']);
    const r = run(() => refunds.checkRefundScopeOnBooking(booking('REFUNDED', 'REFUNDED', 'REFUNDED', 'REFUNDED')));
    expect(failed(r).map((x) => x.name)).toEqual([
      expect.stringContaining('Fulfillment F2 is not REFUNDED'),
      expect.stringContaining('Booked admission bp-2 is not REFUNDED'),
    ]);
  });

  test('F2: the refunded fulfillment still FULFILLED fails', () => {
    envStore.__refundedFulfillmentIds = JSON.stringify(['F1']);
    const r = run(() => refunds.checkRefundScopeOnBooking(booking('FULFILLED', 'FULFILLED', 'FULFILLED', 'FULFILLED')));
    expect(failed(r).length).toBe(2);
  });

  test('F2: a full refund is not scoped', () => {
    envStore.__refundedFulfillmentIds = JSON.stringify(['F1', 'F2']);
    expect(refunds.isScopedRefundOnBooking(booking('REFUNDED', 'REFUNDED', 'REFUNDED', 'REFUNDED'))).toBe(false);
  });
});

// ─── F7 provisionalPrice ────────────────────────────────────────────────────
describe('F7 provisionalPrice', () => {
  const price = (amount, extra = {}) => ({ amount, currency: 'EUR', scale: 2, ...extra });
  const booking = (...amounts) => ({ bookedOffers: [{ admissions: amounts.map((a, i) => ({ id: `b${i}`, status: 'PREBOOKED', price: price(a) })) }] });
  const check = (r) => named(r, "provisionalPrice is not below the offer's minimalPrice")[0];

  // Old code: provisionalPrice had to EQUAL minimalPrice → an added reservation failed.
  test('a booking with an added reservation (above minimalPrice) passes', () => {
    const r = run(() => bookings.checkProvisionalPrice(price(6000), price(5000), booking(5000, 1000)));
    expect(check(r).ok).toBe(true);
    expect(r.logs.some((l) => l.startsWith('[WARNING]'))).toBe(false);
  });

  test('below minimalPrice, or in another currency, fails', () => {
    expect(check(run(() => bookings.checkProvisionalPrice(price(4000), price(5000), booking(4000)))).ok).toBe(false);
    expect(check(run(() => bookings.checkProvisionalPrice({ amount: 5000, currency: 'CHF', scale: 2 }, price(5000), booking(5000)))).ok).toBe(false);
  });

  test('a provisionalPrice that differs from the pre-booked parts is a WARNING', () => {
    const r = run(() => bookings.checkProvisionalPrice(price(5500), price(5000), booking(5000)));
    expect(check(r).ok).toBe(true);
    expect(warned(r, 'sum of the pre-booked parts')).toBe(true);
  });

  // Old code: `${prov.amount}` in the title and `selectedOffer.offerSummary.minimalPrice`
  // threw a TypeError outside any check.
  test('missing provisionalPrice or minimalPrice never throws', () => {
    expect(() => run(() => bookings.checkProvisionalPrice(undefined, price(5000), booking(5000)))).not.toThrow();
    expect(check(run(() => bookings.checkProvisionalPrice(undefined, price(5000), booking(5000)))).ok).toBe(false);
    expect(check(run(() => bookings.checkProvisionalPrice(price(5000), undefined, booking(5000)))).ok).toBe(true);
  });
});

// ─── F9 a 403 on an optional read-only request ─────────────────────────────
describe('F9 auth guard', () => {
  let stopped;
  beforeEach(() => {
    stopped = false;
    global.bru.runner = { stopExecution: () => { stopped = true; } };
    envStore.stepFailurePolicy = 'HARD_STOP';
  });
  const res = (status) => ({ getStatus: () => status });

  // Old code: only /versions was exempt → a 403 on /zones stopped the run.
  test('a 403 on a reference-data GET does not stop the run', () => {
    let stoppedRun;
    const r = run(() => { stoppedRun = auth.checkAuthRejection(res(403), '07. GET Zones', 'https://x/zones'); });
    expect(stoppedRun).toBe(false);
    expect(stopped).toBe(false);
    expect(failed(r)).toEqual([]);
  });

  test('a 401 on the same GET still stops the run', () => {
    run(() => auth.checkAuthRejection(res(401), '07. GET Zones', 'https://x/zones'));
    expect(stopped).toBe(true);
  });

  test('a 403 on a business request still stops the run', () => {
    run(() => auth.checkAuthRejection(res(403), '02. POST Create Booking', 'https://x/bookings'));
    expect(stopped).toBe(true);
  });

  test('the optional requests are named exactly', () => {
    expect(auth.isOptionalReadProbe('04. GET Passenger')).toBe(true);
    expect(auth.isOptionalReadProbe('11. GET Refund Offer')).toBe(true);
    expect(auth.isOptionalReadProbe('02. POST Create Booking')).toBe(false);
    expect(auth.isOptionalReadProbe('07. GET Booking after Fulfillments')).toBe(false);
  });
});
