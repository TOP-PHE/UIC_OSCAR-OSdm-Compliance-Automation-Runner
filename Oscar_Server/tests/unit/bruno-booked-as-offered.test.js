// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-booked-as-offered.test.js — a booked part against the offer part it
 * was booked from, member by member (#1300). The parts were paired by
 * content (#550), but only some members were compared: the price over all
 * parts together, the validity for its presence only, the product, the
 * flexibility, the classes, the trip coverage and the passengers not at all;
 * and OFFER_PART_PRICE_CHANGE, which OSDM asks with a price changed at
 * pre-booking, was never read. Each difference is a WARNING line, never a
 * test.
 */

const fs = require('node:fs');
const path = require('node:path');
const { withBrunoExpect } = require('../helpers/bruno-chai.js');

const ROOT = path.join(__dirname, '..', '..', '..');
const LIB = path.join(ROOT, 'Bruno_Collection', 'library-bruno');

let env = {};
global.bru = {
  getEnvVar: (k) => (Object.prototype.hasOwnProperty.call(env, k) ? env[k] : undefined),
  setEnvVar: (k, v) => { env[k] = v; },
  deleteEnvVar: (k) => { delete env[k]; },
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
  processRequestedInformation: () => ({ provided: [], additional: [] }),
  summariseRequestedInformation: () => ({ parseOk: false, leaves: [] }),
}));

const A = require(path.join(LIB, 'bookedAsOffered.js'));
const bookings = require(path.join(LIB, 'bookings.js'));
const { buildOfferCollection } = require('../../../OSDM_Simulator/src/osdm/offers');
const { createBooking } = require('../../../OSDM_Simulator/src/osdm/bookings');
const variants = require('../../../OSDM_Simulator/src/osdm/variants');
const { loadProviders } = require('../../../OSDM_Simulator/src/config');

beforeEach(() => { env = {}; mockResults = []; mockLogs = []; delete global.req; });
afterAll(() => { delete global.bru; delete global.req; });

const OFFER_PART = {
  id: 'O-A1', price: { amount: 5000, currency: 'EUR', scale: 2 },
  validFrom: '2026-11-20T08:00:00+01:00', validUntil: '2026-11-20T23:59:00+01:00',
  summaryProductId: 'P1', products: [{ productId: 'P1', legIds: ['L1'] }],
  tripCoverage: { coveredTripId: 'T1', coveredLegIds: ['L1'] },
  passengerRefs: ['00001'],
};
const BOOKED = (over = {}) => ({ ...structuredClone(OFFER_PART), id: 'B-A1', passengerIds: ['PAX-1'], ...over });
const CTX = (over = {}) => ({
  offerProducts: [{ id: 'P1', code: 'STANDARD', flexibility: 'FULL_FLEXIBLE', travelClass: 'SECOND', serviceClass: { type: 'STANDARD', name: 'Std' } }],
  bookedProducts: [{ id: 'P1', code: 'STANDARD', flexibility: 'FULL_FLEXIBLE', travelClass: 'SECOND', serviceClass: { type: 'STANDARD', name: 'Std' } }],
  passengerRefs: { 'PAX-1': '00001' },
  ...over,
});

describe('the rules', () => {
  test('OFFER_PART_PRICE_CHANGE, in problems or in the deprecated warnings, as a code or a URN', () => {
    expect(A.priceChangeSaid({ problems: [{ code: 'OFFER_PART_PRICE_CHANGE' }] })).toBe(true);
    expect(A.priceChangeSaid({ problems: [{ code: 'urn:uic:problem:OFFER_PART_PRICE_CHANGE' }] })).toBe(true);
    expect(A.priceChangeSaid({ warnings: { warnings: [{ code: 'OFFER_PART_PRICE_CHANGE' }] } })).toBe(true);
    expect(A.priceChangeSaid({ warnings: [{ code: 'OFFER_PART_PRICE_CHANGE' }] })).toBe(true);
    expect(A.priceChangeSaid({ problems: [{ code: 'PARAMETER_NOT_SUPPORTED', title: 'OFFER_PART_PRICE_CHANGE' }] })).toBe(false);
    expect(A.priceChangeSaid({ problems: [{ code: 'X_OFFER_PART_PRICE_CHANGE' }] })).toBe(false);
    expect(A.priceChangeSaid(undefined)).toBe(false);
  });

  test('a part booked as offered: nothing to say', () => {
    expect(A.pairFindings(OFFER_PART, BOOKED(), CTX())).toEqual({ warn: [], info: [] });
  });

  test('the price: another amount, said or not; the same value at another scale; a named place fee', () => {
    const dearer = BOOKED({ price: { amount: 5100, currency: 'EUR', scale: 2 } });
    expect(A.pairFindings(OFFER_PART, dearer, CTX()).warn).toEqual([
      'the price changed: the offer said 5000 EUR (scale 2), the booking says 5100 EUR (scale 2) (the booking answer did not say OFFER_PART_PRICE_CHANGE, which OSDM asks for a price changed at pre-booking)',
    ]);
    expect(A.pairFindings(OFFER_PART, dearer, CTX({ priceChangeSaid: true })).warn[0]).toMatch(/\(the provider said OFFER_PART_PRICE_CHANGE when booking, as OSDM asks\)$/);
    expect(A.pairFindings(OFFER_PART, BOOKED({ price: { amount: 50000, currency: 'EUR', scale: 3 } }), CTX()).warn).toEqual([]);
    expect(A.pairFindings(OFFER_PART, BOOKED({ price: { amount: 5000, currency: 'CHF', scale: 2 } }), CTX()).warn[0]).toMatch(/^the price changed: the offer said 5000 EUR \(scale 2\), the booking says 5000 CHF/);
    expect(A.pairFindings(OFFER_PART, dearer, CTX({ fees: { 'O-A1': 100 } })).warn).toEqual([]);
  });

  test('the validity: another instant, never another offset of the same one', () => {
    expect(A.pairFindings(OFFER_PART, BOOKED({ validFrom: '2026-11-20T07:00:00Z' }), CTX()).warn).toEqual([]);
    expect(A.pairFindings(OFFER_PART, BOOKED({ validUntil: '2026-11-21T23:59:00+01:00' }), CTX()).warn).toEqual([
      'validUntil is 2026-11-21T23:59:00+01:00, the offer said 2026-11-20T23:59:00+01:00',
    ]);
  });

  test('the product, its flexibility and classes, read through the products of the offer and the booking', () => {
    const other = CTX({ bookedProducts: [{ id: 'P1', code: 'SAVER', flexibility: 'NON_FLEXIBLE', travelClass: 'FIRST', serviceClass: { type: 'HIGH', name: 'High' } }] });
    expect(A.pairFindings(OFFER_PART, BOOKED(), other).warn).toEqual([
      'another product: SAVER, the offer sold STANDARD',
      'flexibility NON_FLEXIBLE, the offer sold FULL_FLEXIBLE',
      'travel class FIRST, the offer sold SECOND',
      'service class "HIGH", the offer sold "STANDARD"',
    ]);
    // Another id for the same product (OSDM: booked ids may differ).
    const renamed = CTX({ bookedProducts: [{ ...CTX().bookedProducts[0], id: 'BP1' }] });
    expect(A.pairFindings(OFFER_PART, BOOKED({ summaryProductId: 'BP1', products: [{ productId: 'BP1' }] }), renamed)).toEqual({ warn: [], info: [] });
    // Another id the booking gives no product for: said at INFO only.
    expect(A.pairFindings(OFFER_PART, BOOKED({ summaryProductId: 'BP9' }), CTX())).toEqual({ warn: [], info: [
      'the product ids differ (offer P1, booking BP9) and the booked offer gives no product BP9 to compare them by',
    ] });
    // The same id, no product given by the booking: nothing to compare, nothing said.
    expect(A.pairFindings(OFFER_PART, BOOKED(), CTX({ bookedProducts: [] }))).toEqual({ warn: [], info: [] });
    // A product on one side only.
    expect(A.pairFindings(OFFER_PART, BOOKED({ summaryProductId: undefined, products: [] }), CTX()).warn).toEqual([
      'the product is named in the offer (P1) but not in the booking',
    ]);
    expect(A.productIdOf({ products: [{}, { productId: 'P2' }] })).toBe('P2');
  });

  test('the trip coverage: one side only, or other legs of the same trip; another trip id is #1299\'s', () => {
    expect(A.pairFindings(OFFER_PART, BOOKED({ tripCoverage: undefined }), CTX()).warn).toEqual(['a trip coverage is in the offer but not in the booking']);
    // A booking that names no trip at all is said once, by #1299's check.
    expect(A.pairFindings(OFFER_PART, BOOKED({ tripCoverage: undefined }), CTX({ namesTrip: false })).warn).toEqual([]);
    expect(A.pairFindings({ ...OFFER_PART, tripCoverage: undefined }, BOOKED(), CTX({ namesTrip: false })).warn).toEqual(['a trip coverage is in the booking but not in the offer']);
    expect(A.pairFindings(OFFER_PART, BOOKED({ tripCoverage: { coveredTripId: 'T1', coveredLegIds: ['L2'] } }), CTX()).warn).toEqual(['it covers legs L2 of trip T1, the offer part L1']);
    // The same legs in another order are the same; a leg given twice instead of another is not.
    const two = { ...OFFER_PART, tripCoverage: { coveredTripId: 'T1', coveredLegIds: ['L2', 'L1'] } };
    expect(A.pairFindings(two, BOOKED({ tripCoverage: { coveredTripId: 'T1', coveredLegIds: ['L1', 'L2'] } }), CTX()).warn).toEqual([]);
    expect(A.pairFindings(two, BOOKED({ tripCoverage: { coveredTripId: 'T1', coveredLegIds: ['L1', 'L1'] } }), CTX()).warn).toEqual(['it covers legs L1, L1 of trip T1, the offer part L1, L2']);
    expect(A.pairFindings(OFFER_PART, BOOKED({ tripCoverage: { coveredTripId: 'BT1', coveredLegIds: ['BL1'] } }), CTX()).warn).toEqual([]);
    expect(A.pairFindings(OFFER_PART, BOOKED({ tripCoverage: { coveredTripId: 'T1' } }), CTX()).warn).toEqual([]);
  });

  test('the passengers, by externalRef; not compared when a booked passenger has none', () => {
    expect(A.pairFindings(OFFER_PART, BOOKED({ passengerIds: ['PAX-2'] }), CTX({ passengerRefs: { 'PAX-1': '00001', 'PAX-2': '00002' } })).warn).toEqual([
      'it is for passengers 00002 (by externalRef), the offer part for 00001',
    ]);
    expect(A.pairFindings(OFFER_PART, BOOKED({ passengerIds: ['PAX-2'] }), CTX()).warn).toEqual([]);
  });

  test('the context of a booking', () => {
    const ctx = A.contextOf({ products: [{ id: 'P1' }] }, { passengers: [{ id: 'X', externalRef: '00001' }, { id: 'Y' }], bookedOffers: [{ products: [{ id: 'B1' }] }, {}] }, { priceChangeSaid: true });
    expect(ctx).toEqual({ offerProducts: [{ id: 'P1' }], bookedProducts: [{ id: 'B1' }], passengerRefs: { X: '00001' }, namesTrip: false, priceChangeSaid: true });
    expect(A.contextOf({}, { trips: [{ id: 'T' }] }).namesTrip).toBe(true);
    expect(A.contextOf({}, { bookedOffers: [{ admissions: [{ tripCoverage: { coveredTripId: 'T' } }] }] }).namesTrip).toBe(true);
    expect(A.contextOf({}, { bookedOffers: [{ inboundTripCoverage: { coveredTripId: 'R' } }] }).namesTrip).toBe(true);
  });
});

describe('in the booking checks', () => {
  const offer = { admissionOfferParts: [OFFER_PART] };
  const run = (booked, ctx) => withBrunoExpect(() => bookings.validateBookedOfferParts(offer.admissionOfferParts, [booked], 'admission', ['PREBOOKED'], ctx));

  test('one WARNING line per difference, naming the part; never a test', () => {
    run(BOOKED({ status: 'PREBOOKED', refundable: 'YES', exchangeable: 'YES', validUntil: '2026-11-21T23:59:00+01:00' }), CTX());
    const lines = mockLogs.filter((l) => l.includes('is not booked as offered'));
    expect(lines).toEqual(['[WARNING] admission[0] (id=O-A1) is not booked as offered: validUntil is 2026-11-21T23:59:00+01:00, the offer said 2026-11-20T23:59:00+01:00.']);
    const without = mockResults.length;
    mockResults = [];
    run(BOOKED({ status: 'PREBOOKED', refundable: 'YES', exchangeable: 'YES' }), null);
    expect(mockResults).toHaveLength(without);
  });

  test('a changed price: the price check fails as before, unless the provider said OFFER_PART_PRICE_CHANGE', () => {
    const dearer = BOOKED({ status: 'PREBOOKED', refundable: 'YES', exchangeable: 'YES', price: { amount: 5100, currency: 'EUR', scale: 2 } });
    run(dearer, CTX());
    const price = () => mockResults.find((r) => r.name === 'admission prices have at least one member in common between offer and booking');
    expect(price()).toEqual(expect.objectContaining({ ok: false }));
    mockResults = [];
    run(dearer, CTX({ priceChangeSaid: true }));
    expect(price()).toEqual(expect.objectContaining({ ok: true }));
    // Another currency still fails: OSDM speaks of a different price, not another currency.
    mockResults = [];
    run(BOOKED({ status: 'PREBOOKED', refundable: 'YES', exchangeable: 'YES', price: { amount: 5100, currency: 'CHF', scale: 2 } }), CTX({ priceChangeSaid: true }));
    expect(price()).toEqual(expect.objectContaining({ ok: false }));
  });

  test('provisionalPrice below the offer\'s minimal price: a failure, a WARNING when the change was said', () => {
    const name = /^provisionalPrice is not below the offer's minimalPrice/;
    const booking = { bookedOffers: [] };
    withBrunoExpect(() => bookings.checkProvisionalPrice({ amount: 4900, currency: 'EUR' }, { amount: 5000, currency: 'EUR' }, booking));
    expect(mockResults.find((r) => name.test(r.name)).ok).toBe(false);
    mockResults = [];
    withBrunoExpect(() => bookings.checkProvisionalPrice({ amount: 4900, currency: 'EUR' }, { amount: 5000, currency: 'EUR' }, booking, true));
    expect(mockResults.find((r) => name.test(r.name)).ok).toBe(true);
    expect(mockLogs).toContain('[WARNING] provisionalPrice 4900 is below the offer\'s minimalPrice 5000: the provider said OFFER_PART_PRICE_CHANGE, which OSDM allows at pre-booking (#1300).');
  });
});

describe('on the simulator\'s own answers', () => {
  const gamma = loadProviders(path.join(ROOT, 'OSDM_Simulator', 'providers')).get('gamma');
  const NOW = Date.parse('2026-11-02T09:00:00Z');
  const stop = (code) => ({ objectType: 'StopPlaceRef', stopPlaceRef: `urn:uic:stn:${code}` });
  const PASSENGERS = [{ externalRef: '00001', type: 'PERSON', dateOfBirth: '1990-01-15' }];

  function sale(lastName) {
    const request = {
      tripSearchCriteria: { origin: stop('0000001'), destination: stop('0000002'), departureTime: '2026-11-20T08:00:00' },
      anonymousPassengerSpecifications: PASSENGERS,
    };
    const { response, remembered } = buildOfferCollection(request, gamma, NOW);
    const offer = response.offers[0];
    const known = new Map(remembered.map((entry) => [entry.offer.offerId, entry]));
    const booking = createBooking({
      offers: [{ offerId: offer.offerId, passengerRefs: offer.passengerRefs }],
      passengerSpecifications: PASSENGERS.map((p) => ({ ...p, detail: { firstName: 'Ada', lastName } })),
    }, (id) => known.get(id), gamma, NOW);
    return { offer: structuredClone(offer), answer: structuredClone({ booking: variants.bookingAsAnswered(booking), ...variants.bookingProblems(booking) }) };
  }

  const atCreation = (s) => {
    global.req = { getName: () => '02. POST Create Booking' };
    Object.assign(env, { passengerCount: '1', bookingPassengerReferences: JSON.stringify(['00001']) });
    withBrunoExpect(() => bookings.postCreateBookingResponse(s.offer, s.answer, ['PREBOOKED'], ['ON_HOLD', 'AVAILABLE']));
  };
  const asOffered = () => mockLogs.filter((l) => l.includes('is not booked as offered'));
  const priceCheck = () => mockResults.find((r) => r.name === 'admission prices have at least one member in common between offer and booking');

  test('a booking as the simulator gives it: every member as offered', () => {
    const s = sale('Example');
    expect(A.priceChangeSaid(s.answer)).toBe(false);
    atCreation(s);
    expect(asOffered()).toEqual([]);
    expect(priceCheck().ok).toBe(true);
    expect(env.__bookingPriceChangeSaid).toBe('false');
  });

  test('variant booking-price-change: one WARNING for the admission, the change said, no price check failed', () => {
    const s = sale('Simvariant-Booking-Price-Change');
    expect(s.answer.problems).toEqual([{ code: 'urn:uic:problem:OFFER_PART_PRICE_CHANGE', title: 'Price change', detail: 'The price of 1 booked offer part(s) changed at pre-booking.' }]);
    const offered = s.offer.admissionOfferParts[0].price.amount;
    expect(s.answer.booking.bookedOffers[0].admissions[0].price.amount).toBe(offered + 100);
    expect(s.answer.booking.provisionalPrice.amount).toBe(offered + 100);
    atCreation(s);
    expect(env.__bookingPriceChangeSaid).toBe('true');
    const lines = asOffered();
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith('[WARNING] admission[0] (id=')).toBe(true);
    expect(lines[0].endsWith(` is not booked as offered: the price changed: the offer said ${offered} CZK (scale 2), the booking says ${offered + 100} CZK (scale 2) (the provider said OFFER_PART_PRICE_CHANGE when booking, as OSDM asks).`)).toBe(true);
    expect(priceCheck().ok).toBe(true);
    expect(mockResults.filter((r) => /provisionalPrice/.test(r.name)).every((r) => r.ok)).toBe(true);
  });

  test('the same change not said: the price check fails as before, and the WARNING says it was not said', () => {
    const s = sale('Simvariant-Booking-Price-Change');
    delete s.answer.problems;
    atCreation(s);
    expect(priceCheck().ok).toBe(false);
    expect(asOffered()[0]).toMatch(/\(the booking answer did not say OFFER_PART_PRICE_CHANGE, which OSDM asks for a price changed at pre-booking\)\.$/);
  });
});

describe('the wiring', () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

  test('the variable is cleared with each scenario and each expiry sub-run', () => {
    for (const file of ['Bruno_Collection/opencollection.yml', 'Bruno_Collection/library-bruno/scenarioParser.js']) {
      expect([file, read(file).includes('"__offerTrips", "__bookingPriceChangeSaid"')]).toEqual([file, true]);
    }
    expect(read('Bruno_Collection/library-bruno/expiredFlow.js')).toContain("'__fulfillmentIdsSeen', '__bookingPriceChangeSaid',");
  });
});
