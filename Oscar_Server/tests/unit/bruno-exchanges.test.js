// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-exchanges.test.js — library-bruno/exchanges.js, the checks of the
 * EXCHANGE flow (steps 10 to 17 of 04-Exchange), run outside Bruno as
 * bruno-osdm38-checks.test.js does: the real validator, every check and log
 * line recorded. The coverage of library-bruno is measured since #754; this
 * file takes exchanges.js from 55% of its lines.
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
let mockBookingCalls = [];
jest.mock('../../../Bruno_Collection/library-bruno/displays.js', () => ({
  validationLogger: (line) => { mockLogs.push(line); },
}));
jest.mock('../../../Bruno_Collection/library-bruno/testCapture.js', () => ({
  bruTest: (name, fn) => {
    try { fn(); mockResults.push({ name, ok: true }); } catch (e) { mockResults.push({ name, ok: false, message: e.message }); }
  },
}));
// The booking checks have their own tests; here, what they are given.
jest.mock('../../../Bruno_Collection/library-bruno/bookings.js', () => ({
  postCreateBookingResponse: (...args) => { mockBookingCalls.push(args); },
}));
global.validationLogger = (line) => { mockLogs.push(line); };

const exchanges = require('../../../Bruno_Collection/library-bruno/exchanges.js');

function run(fn) {
  mockResults = [];
  mockLogs = [];
  mockBookingCalls = [];
  withBrunoExpect(fn);
  return { results: mockResults, logs: mockLogs };
}
const named = (r, part) => r.results.filter((x) => x.name.includes(part));
const failed = (r) => r.results.filter((x) => !x.ok);
const logged = (r, level, part) => r.logs.some((l) => l.startsWith(`[${level}]`) && l.includes(part));

const price = (amount, currency = 'EUR') => ({ amount, currency, scale: 2 });
const offer = (extra = {}) => ({
  offerId: 'X1', createdOn: '2026-01-01T10:00:00Z', preBookableUntil: '2099-01-01T10:00:00Z',
  passengerRefs: ['P1'], fulfillments: [{ id: 'F1' }], admissionOfferParts: [{ id: 'a1' }],
  exchangeFee: price(0), exchangePrice: price(100), ...extra,
});

beforeEach(() => {
  envStore = {};
  delete global.req;
  delete global.checkWarningsAndProblems;
  delete global.validateFulfillments;
});

describe('postPatchExchangeOffersResponse (step 10)', () => {
  test('no exchange offer stops the step', () => {
    for (const body of [{}, { exchangeOffers: [] }, { exchangeOffers: 'x' }]) {
      expect(() => run(() => exchanges.postPatchExchangeOffersResponse(body, ['FULFILLED']))).toThrow('No exchangeOffers found');
    }
  });

  test('every offer is checked; the first one\'s id and deadline are kept', () => {
    const r = run(() => exchanges.postPatchExchangeOffersResponse({ exchangeOffers: [offer(), offer({ offerId: 'X2' })] }, ['FULFILLED']));
    expect(named(r, "'exchangeOffers' array exists with 2")[0].ok).toBe(true);
    expect(named(r, 'has a valid Offer Id')).toHaveLength(2);
    expect(envStore.exchangeOffersOfferId).toBe('X1');
    expect(envStore.exchangeOfferPreBookableUntil).toBe('2099-01-01T10:00:00Z');
    expect(envStore.exchangeOfferPreBookableUntilSource).toBe('exchangeOffers[0].preBookableUntil');
  });

  test('without a deadline on the first offer, none is kept', () => {
    run(() => exchanges.postPatchExchangeOffersResponse({ exchangeOffers: [offer({ preBookableUntil: undefined })] }, ['FULFILLED']));
    expect(envStore).not.toHaveProperty('exchangeOfferPreBookableUntil');
  });
});

describe('postPatchExchangeOperationsResponse (step 11)', () => {
  const operation = (extra = {}) => ({ exchangeOperation: { id: 'OP1', status: 'PREBOOKED', exchangeOffers: [offer()], ...extra } });

  test('no exchange operation stops the step', () => {
    for (const body of [{}, { exchangeOperation: null }, { exchangeOperation: 'x' }]) {
      expect(() => run(() => exchanges.postPatchExchangeOperationsResponse(body, ['PREBOOKED'], ['FULFILLED']))).toThrow('No exchangeOperation found');
    }
  });

  test('a pre-booked operation passes, its offers are checked and its id kept; warnings are read first', () => {
    const seen = [];
    global.checkWarningsAndProblems = (body) => seen.push(body);
    const body = operation();
    const r = run(() => exchanges.postPatchExchangeOperationsResponse(body, ['PREBOOKED'], ['FULFILLED']));
    expect(seen).toEqual([body]);
    expect(failed(r).map((x) => x.name)).toEqual([]);
    expect(named(r, 'has a valid Id OP1')[0].ok).toBe(true);
    expect(named(r, 'contains exchangeOffers')[0].ok).toBe(true);
    expect(envStore.exchangeOperationId).toBe('OP1');
  });

  test('a status that was not expected, or an id that is not text, fails', () => {
    const r = run(() => exchanges.postPatchExchangeOperationsResponse(operation({ id: 7, status: 'CONFIRMED' }), ['PREBOOKED'], ['FULFILLED']));
    expect(named(r, 'has valid status, expected : PREBOOKED, actual : CONFIRMED')[0].ok).toBe(false);
    expect(named(r, 'has a valid Id 7')[0].ok).toBe(false);
  });
});

describe('validateExchangeOfferResponse', () => {
  test('a past or unreadable preBookableUntil fails', () => {
    for (const when of ['2001-01-01T10:00:00Z', 'not a date']) {
      const r = run(() => exchanges.validateExchangeOfferResponse(offer({ preBookableUntil: when }), 0, null));
      expect(named(r, 'preBookableUntil')[0].ok).toBe(false);
    }
  });

  test('an offer without admissions fails', () => {
    const r = run(() => exchanges.validateExchangeOfferResponse(offer({ admissionOfferParts: [] }), 0, null));
    expect(named(r, 'admissionOfferParts is a non-empty array')[0].ok).toBe(false);
  });

  test('offerSummary, when given, needs its flexibility and a numeric minimal price', () => {
    const good = run(() => exchanges.validateExchangeOfferResponse(offer({ offerSummary: { overallFlexibility: 'FULL', minimalPrice: { amount: 100 } } }), 0, null));
    expect(named(good, 'overallFlexibility')[0].ok).toBe(true);
    const bad = run(() => exchanges.validateExchangeOfferResponse(offer({ offerSummary: { minimalPrice: { amount: '100' } } }), 0, null));
    expect(named(bad, 'overallFlexibility')[0].ok).toBe(false);
    const none = run(() => exchanges.validateExchangeOfferResponse(offer(), 0, null));
    expect(named(none, 'overallFlexibility')).toEqual([]);
    expect(none.logs.some((l) => l.includes('offerSummary absent'))).toBe(true);
  });

  describe('amountToBePaid = exchangePrice + exchangeFee - confirmedPrice', () => {
    test('holds, in whole units of the scale', () => {
      envStore.confirmedPriceAmount = '80.1';
      const r = run(() => exchanges.validateExchangeOfferResponse(offer({ exchangePrice: price(100.2), exchangeFee: price(5), amountToBePaid: price(25.1) }), 0, null));
      expect(named(r, 'OSDM financial identity')[0].ok).toBe(true);
      expect(named(r, 'has amount to be paid: 25.1')[0].ok).toBe(true);
    });

    test('a wrong amount fails, naming the four amounts', () => {
      envStore.confirmedPriceAmount = '80';
      const r = run(() => exchanges.validateExchangeOfferResponse(offer({ exchangeFee: price(5), amountToBePaid: price(30) }), 0, null));
      const check = named(r, 'OSDM financial identity')[0];
      expect(check.ok).toBe(false);
      expect(check.message).toBe('amountToBePaid(3000) ≠ exchangePrice(10000) + exchangeFee(500) - confirmedPrice(8000)');
    });

    test('absent: a warning, no check', () => {
      const r = run(() => exchanges.validateExchangeOfferResponse(offer(), 0, null));
      expect(named(r, 'financial identity')).toEqual([]);
      expect(logged(r, 'WARN', 'amountToBePaid is missing')).toBe(true);
    });
  });

  test('a refundable amount, when given, is a number', () => {
    const r = run(() => exchanges.validateExchangeOfferResponse(offer({ refundableAmount: price('3') }), 0, null));
    expect(named(r, 'has refundable amount defined')[0].ok).toBe(false);
    const none = run(() => exchanges.validateExchangeOfferResponse(offer({ refundableAmount: { amount: null } }), 0, null));
    expect(named(none, 'refundable amount')).toEqual([]);
  });

  test('an applied overrule code is the one sent; none sent expects none', () => {
    envStore.overruleCode = 'STRIKE';
    const same = run(() => exchanges.validateExchangeOfferResponse(offer({ appliedOverruleCode: 'STRIKE' }), 0, null));
    expect(named(same, 'AppliedOverruleCode is valid, (expected: STRIKE, actual: STRIKE)')[0].ok).toBe(true);
    envStore = {};
    const unsent = run(() => exchanges.validateExchangeOfferResponse(offer({ appliedOverruleCode: 'STRIKE' }), 0, null));
    expect(named(unsent, 'AppliedOverruleCode is null as expected')[0].ok).toBe(false);
  });

  test('at 12. GET Exchange Offer the offer\'s part ids join the booking\'s, from a list or from text', () => {
    global.req = { getName: () => '12. GET Exchange Offer' };
    const parts = { admissionOfferParts: [{ id: 'a1' }], reservationOfferParts: [{ id: 'r1' }, {}], ancillaryOfferParts: [{ id: 'c1' }] };
    envStore.admissionReservationAncillaryBookingPartsIds = ['b1'];
    run(() => exchanges.validateExchangeOfferResponse(offer(parts), 0, null));
    expect(envStore.admissionReservationAncillaryBookingPartsIds).toEqual(['b1', 'a1', 'r1', 'c1']);
    envStore.admissionReservationAncillaryBookingPartsIds = '["b2"]';
    run(() => exchanges.validateExchangeOfferResponse(offer(parts), 0, null));
    expect(envStore.admissionReservationAncillaryBookingPartsIds).toEqual(['b2', 'a1', 'r1', 'c1']);
  });

  test('at another request the part ids are not collected', () => {
    global.req = { getName: () => '10. POST Exchange Offers' };
    run(() => exchanges.validateExchangeOfferResponse(offer(), 0, null));
    expect(envStore).not.toHaveProperty('admissionReservationAncillaryBookingPartsIds');
  });

  test('fulfillments go to validateFulfillments with the offer\'s documents, when a status is expected', () => {
    const calls = [];
    global.validateFulfillments = (...args) => calls.push(args);
    const docs = [{ id: 'D1' }];
    run(() => exchanges.validateExchangeOfferResponse(offer({ fulfillmentDocuments: docs }), 3, ['FULFILLED']));
    expect(calls).toEqual([[[{ id: 'F1' }], 3, ['FULFILLED'], false, docs]]);
    run(() => exchanges.validateExchangeOfferResponse(offer(), 3, null));
    expect(calls).toHaveLength(1);
  });
});

describe('validateExchangeFeesConsistentWithAfterSalesConditions (#396, #950)', () => {
  const window = (fee, currency = 'EUR') => ({
    condition: 'EXCHANGE', afterSaleFee: price(fee, currency), validFrom: '2000-01-01T00:00:00Z', validUntil: '2099-01-01T00:00:00Z',
  });
  const part = (amount, conditions) => ({ id: 'a1', price: price(amount), afterSalesConditions: conditions });
  const check = (r) => named(r, 'Exchange fee matches the active EXCHANGE schedule')[0];
  // #950: the schedule is that of the parts sold (the selected offer), never the new offer's.
  const sold = (admissionOfferParts, reservationOfferParts = []) => {
    envStore.offer = JSON.stringify({ offerId: 'O1', admissionOfferParts, reservationOfferParts });
  };
  const validate = (o) => run(() => exchanges.validateExchangeFeesConsistentWithAfterSalesConditions(o));

  test('a fee equal to the active windows\' fees of the parts sold passes', () => {
    sold([part(100, [window(10)])], [part(20, [window(5)])]);
    const r = validate(offer({ exchangeFee: price(15) }));
    expect(check(r).ok).toBe(true);
    expect(logged(r, 'INFO', 'schedule decode OK')).toBe(true);
  });

  test('another fee fails, naming both', () => {
    sold([part(100, [window(10)])]);
    const r = validate(offer({ exchangeFee: price(12) }));
    expect(check(r).ok).toBe(false);
    expect(check(r).message).toContain('charges 10 right now');
    expect(check(r).message).toContain("exchangeFee is 12");
  });

  test('the new offer\'s conditions are not the fee\'s: a flexible sale exchanged for a product sold under conditions owes nothing', () => {
    sold([part(100, [window(0)])]);
    const r = validate(offer({ exchangeFee: price(0), admissionOfferParts: [part(200, [window(50)])] }));
    expect(check(r).ok).toBe(true);
    expect(check(r).name).toContain('= active-window fee 0');
  });

  test('nothing is checked: no numeric fee, an overrule code sent, no parts sold known, a part of the booking only, no decodable schedule, another currency', () => {
    sold([part(100, [window(10)])]);
    const cases = [
      [offer({ exchangeFee: undefined }), 'no numeric exchangeFee'],
      [offer({ exchangeFee: price(10, 'CHF') }), 'differs from the schedule currency'],
    ];
    for (const [o, text] of cases) {
      const r = validate(o);
      expect(check(r)).toBeUndefined();
      expect(r.logs.some((l) => l.includes(text))).toBe(true);
    }
    sold([part(100, [])]);
    expect(validate(offer({ exchangeFee: price(12) })).logs.some((l) => l.includes('not schedule-decodable'))).toBe(true);
    delete envStore.offer;
    let r = validate(offer({ exchangeFee: price(12) }));
    expect(check(r)).toBeUndefined();
    expect(logged(r, 'INFO', 'no selected offer with parts')).toBe(true);
    sold([part(100, [window(10)])]);
    envStore.__bookingFulfillmentIds = '["F1","F2"]';
    envStore.requestExchangeOffersBodyData = { fulfillmentIds: ['F2'] };
    r = validate(offer({ exchangeFee: price(12) }));
    expect(check(r)).toBeUndefined();
    expect(logged(r, 'INFO', 'gives up fulfillments [F2] of [F1, F2]')).toBe(true);
    envStore.requestExchangeOffersBodyData = JSON.stringify({ fulfillmentIds: ['F2', 'F1'] });
    expect(check(validate(offer({ exchangeFee: price(10) }))).ok).toBe(true);
    envStore.overruleCode = 'STRIKE';
    r = validate(offer({ exchangeFee: price(12) }));
    expect(check(r)).toBeUndefined();
    expect(logged(r, 'INFO', 'an overruleCode (STRIKE) was sent')).toBe(true);
  });

  test('"null" sent as the overrule code counts as none', () => {
    envStore.overruleCode = 'null';
    sold([part(100, [window(10)])]);
    expect(check(validate(offer({ exchangeFee: price(10) }))).ok).toBe(true);
  });
});

describe('checkBookingAroundExchange (#649)', () => {
  const booking = (parts) => ({ booking: { id: 'B1', bookedOffers: [{ offerId: 'O1', admissions: parts }] } });
  const old = { id: 'old1', status: 'EXCHANGE_ONGOING' };

  test('without the ids kept at step 07, the whole booking is checked against the original offer', () => {
    envStore.offer = '{"offerId":"O1"}';
    const body = booking([old]);
    const r = run(() => exchanges.checkBookingAroundExchange(body, 'prebooked'));
    expect(mockBookingCalls).toEqual([['{"offerId":"O1"}', body, ['EXCHANGE_ONGOING'], ['FULFILLED', 'CONFIRMED', 'ON_HOLD']]]);
    expect(logged(r, 'INFO', 'were not kept')).toBe(true);
    envStore.__partIdsBeforeExchange = 'not json';
    run(() => exchanges.checkBookingAroundExchange(body, 'prebooked'));
    expect(mockBookingCalls).toHaveLength(1);
  });

  test('pre-booked: the parts held before go to the booking check, the new ones are checked and remembered', () => {
    envStore.__partIdsBeforeExchange = '["old1"]';
    envStore.admissionReservationAncillaryBookingPartsIds = '["old1"]';
    const r = run(() => exchanges.checkBookingAroundExchange(booking([old, { id: 'new1', status: 'PREBOOKED' }]), 'prebooked'));
    expect(mockBookingCalls[0][1].booking.bookedOffers[0].admissions).toEqual([old]);
    expect(named(r, 'New admission new1 from the exchange is PREBOOKED')[0].ok).toBe(true);
    expect(envStore.admissionReservationAncillaryBookingPartsIds).toEqual(['old1', 'new1']);
  });

  test('pre-booked without the new offer in the booking: told at INFO, not failed', () => {
    envStore.__partIdsBeforeExchange = ['old1'];
    envStore.admissionReservationAncillaryBookingPartsIds = 'not json';
    const r = run(() => exchanges.checkBookingAroundExchange(booking([old]), 'prebooked'));
    expect(failed(r)).toEqual([]);
    expect(logged(r, 'INFO', 'The pre-booked exchange is shown in the booking')).toBe(true);
    expect(envStore.admissionReservationAncillaryBookingPartsIds).toBe('not json');
  });

  test('confirmed: the exchange\'s admissions must be there, in a confirmed status', () => {
    envStore.__partIdsBeforeExchange = ['old1'];
    const none = run(() => exchanges.checkBookingAroundExchange(booking([{ id: 'old1', status: 'EXCHANGED' }]), 'confirmed'));
    expect(named(none, 'The booking holds the admissions the exchange sold')[0].ok).toBe(false);
    const wrong = run(() => exchanges.checkBookingAroundExchange(booking([{ id: 'old1', status: 'EXCHANGED' }, { id: 'new1', status: 'PREBOOKED' }]), 'confirmed'));
    expect(named(wrong, 'New admission new1 from the exchange is FULFILLED or CONFIRMED - actual: PREBOOKED')[0].ok).toBe(false);
  });

  test('withdrawn: only the parts held before are checked; what is left of the exchange is told', () => {
    envStore.__partIdsBeforeExchange = ['old1'];
    const r = run(() => exchanges.checkBookingAroundExchange(booking([{ id: 'old1', status: 'FULFILLED' }, { id: 'new1', status: 'RELEASED' }]), 'withdrawn'));
    expect(mockBookingCalls[0][2]).toEqual(['FULFILLED', 'CONFIRMED']);
    expect(r.results).toEqual([]);
    expect(logged(r, 'INFO', 'Parts of the withdrawn exchange still in the booking: new1 RELEASED')).toBe(true);
    const clean = run(() => exchanges.checkBookingAroundExchange(booking([{ id: 'old1', status: 'FULFILLED' }]), 'withdrawn'));
    expect(clean.logs.some((l) => l.includes('still in the booking'))).toBe(false);
  });

  test('#1037 an exchange asked with an overrule code has no fee; an offer not naming the code is a warning', () => {
    envStore = { overruleCode: 'TECHNICAL_FAILURE' };
    expect(exchanges.overruleCodeSent()).toBe('TECHNICAL_FAILURE');
    const free = run(() => exchanges.checkOverruledExchangeFee({ exchangeFee: price(0), appliedOverruleCode: 'TECHNICAL_FAILURE' }, 0, 'TECHNICAL_FAILURE'));
    expect(free.results).toEqual([{ name: 'Exchange offer[0] asked with overrule code TECHNICAL_FAILURE has no exchange fee (technical exchange)', ok: true }]);
    expect(free.logs).toEqual([]);
    const charged = run(() => exchanges.checkOverruledExchangeFee({ exchangeFee: price(1250) }, 1, 'TECHNICAL_FAILURE'));
    expect(failed(charged)).toHaveLength(1);
    expect(failed(charged)[0].message).toContain('exchangeFee is 1250 EUR');
    expect(logged(charged, 'WARNING', 'does not name the overrule code applied')).toBe(true);
    expect(failed(run(() => exchanges.checkOverruledExchangeFee({}, 0, 'TECHNICAL_FAILURE')))).toHaveLength(1);
    expect(run(() => exchanges.checkOverruledExchangeFee({ exchangeFee: price(1250) }, 0, null)).results).toEqual([]);
    for (const none of ['null', 'CODE_DOES_NOT_EXIST', '', undefined]) {
      envStore = { overruleCode: none };
      expect(exchanges.overruleCodeSent()).toBeNull();
    }
  });
});
