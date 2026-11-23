// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-booking-stages.test.js — postCreateBookingResponse(), stage by stage
 * (#1407). The function checks the answer of `02. POST Create Booking` and of
 * every read of the booking after it; it was split into one function per
 * stage, behaviour unchanged. These tests hold what each stage does on a
 * booking as the simulator gives it and on what a provider may say otherwise:
 * the checks made and their outcome, the lines logged, the variables kept
 * for the next steps.
 */

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
let mockAsked = [];
let mockOutcome = null;
let mockSummary = null;
let mockDuring = null;
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
  processRequestedInformation: (given) => { mockAsked.push(given); if (mockDuring) mockDuring(given); return mockOutcome; },
  summariseRequestedInformation: () => mockSummary,
}));

const bookings = require(path.join(LIB, 'bookings.js'));
const { buildOfferCollection } = require('../../../OSDM_Simulator/src/osdm/offers');
const { createBooking } = require('../../../OSDM_Simulator/src/osdm/bookings');
const variants = require('../../../OSDM_Simulator/src/osdm/variants');
const { loadProviders } = require('../../../OSDM_Simulator/src/config');

const gamma = loadProviders(path.join(ROOT, 'OSDM_Simulator', 'providers')).get('gamma');
const NOW = Date.parse('2026-11-02T09:00:00Z');
const stop = (code) => ({ objectType: 'StopPlaceRef', stopPlaceRef: `urn:uic:stn:${code}` });

// A sale as the simulator answers it: the offer chosen and the booking made of it.
function sale(count = 1) {
  const passengers = Array.from({ length: count }, (_, i) => ({ externalRef: `0000${i + 1}`, type: 'PERSON', dateOfBirth: '1990-01-15' }));
  const request = {
    tripSearchCriteria: { origin: stop('0000001'), destination: stop('0000002'), departureTime: '2026-11-20T08:00:00' },
    anonymousPassengerSpecifications: passengers,
  };
  const { response, remembered } = buildOfferCollection(request, gamma, NOW);
  const offer = response.offers[0];
  const known = new Map(remembered.map((entry) => [entry.offer.offerId, entry]));
  const booking = createBooking({
    offers: [{ offerId: offer.offerId, passengerRefs: offer.passengerRefs }],
    passengerSpecifications: passengers.map((p, i) => ({ ...p, detail: { firstName: `Ada${i}`, lastName: 'Example' } })),
  }, (id) => known.get(id), gamma, NOW);
  return { offer: structuredClone(offer), answer: structuredClone({ booking: variants.bookingAsAnswered(booking), ...variants.bookingProblems(booking) }) };
}

// The function called as a step calls it. The clock is the simulator's, so
// that the booking's deadline is ahead; `change` alters the booking first.
function run(s, { step = '02. POST Create Booking', expected = ['PREBOOKED'], fulfilment = ['ON_HOLD', 'AVAILABLE'], vars = {}, change = null, now = NOW + 60_000 } = {}) {
  const given = structuredClone(s);
  if (change) change(given.answer.booking, given);
  env = { passengerCount: String((given.answer.booking?.passengers || []).length), ...vars };
  mockResults = [];
  mockLogs = [];
  mockAsked = [];
  global.req = { getName: () => step };
  const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
  let thrown = null;
  try {
    withBrunoExpect(() => bookings.postCreateBookingResponse(given.offer, given.answer, expected, fulfilment));
  } catch (e) {
    thrown = e;
  } finally {
    clock.mockRestore();
  }
  return { results: mockResults, logs: mockLogs, env, thrown, asked: mockAsked, booking: given.answer.booking };
}
const named = (r, text) => r.results.filter((x) => x.name.includes(text));
const logged = (r, text) => r.logs.filter((l) => l.includes(text));
const parts = (booking) => booking.bookedOffers.flatMap((bo) => [...(bo.admissions || []), ...(bo.reservations || []), ...(bo.ancillaries || [])]);

beforeEach(() => { mockOutcome = { provided: [], additional: [] }; mockSummary = { parseOk: false, leaves: [] }; mockDuring = null; });
afterAll(() => { delete global.bru; delete global.req; });

const ONE = sale(1);
const TWO = sale(2);

describe('the booking itself', () => {
  test('a booking as the simulator gives it passes every check of the function, in the order of its stages', () => {
    const r = run(ONE);
    expect(r.thrown).toBeNull();
    expect(r.results.filter((x) => !x.ok)).toEqual([]);
    const first = (text) => r.results.findIndex((x) => x.name.includes(text));
    const order = ["'booking' object exists", 'booking.id is a non-empty string', 'booking confirmation deadline is a valid future datetime',
      'booking.bookedOffers is a non-empty array', 'provisionalPrice structure exists', 'Price fields exist (currency, amount) in provisionalPrice',
      'provisionalPrice is not below', 'Booking contains exactly the expected number of passengers'].map(first);
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(r.logs[0]).toBe('[DEBUG] ► postCreateBookingResponse');
  });

  test('its id is kept for the next steps; an empty id fails its check; a code that is not text fails, an absent one is said and not checked', () => {
    const r = run(ONE);
    expect(r.env.bookingId).toBe(r.booking.id);
    expect(named(r, 'booking.bookingCode is a non-empty string when present')).toEqual([expect.objectContaining({ ok: true })]);
    const noId = run(ONE, { change: (b) => { b.id = ''; } });
    expect(named(noId, 'booking.id is a non-empty string')[0].ok).toBe(false);
    const oddCode = run(ONE, { change: (b) => { b.bookingCode = ''; } });
    expect(named(oddCode, 'booking.bookingCode')[0].ok).toBe(false);
    for (const absent of [undefined, null]) {
      const none = run(ONE, { change: (b) => { b.bookingCode = absent; } });
      expect(named(none, 'booking.bookingCode')).toEqual([]);
      expect(logged(none, 'booking.bookingCode is absent (optional per OSDM spec)')).toHaveLength(1);
    }
  });

  test('an answer without a booking stops the step with its reason', () => {
    for (const wrong of [null, 'text', undefined]) {
      const r = run(ONE, { change: (b, given) => { given.answer.booking = wrong; } });
      expect(r.thrown.message).toBe("No booking found or 'booking' is not an object.");
      expect(r.logs).toContain("[ERROR] No booking found or 'booking' is not an object.");
      expect(r.results).toEqual([]);
    }
  });
});

describe('the passengers\' ids', () => {
  const refs = TWO.answer.booking.passengers.map((p) => p.externalRef);
  const ids = TWO.answer.booking.passengers.map((p) => p.id);

  test('kept in the order the passengers were submitted, whatever the order of the answer', () => {
    const same = run(TWO, { vars: { bookingPassengerReferences: JSON.stringify(refs) } });
    expect(same.env.passengerIdList).toEqual(ids);
    expect(logged(same, 'Provider returned booking passengers in a different order')).toEqual([]);
    const reordered = run(TWO, { vars: { bookingPassengerReferences: refs }, change: (b) => { b.passengers.reverse(); } });
    expect(reordered.env.passengerIdList).toEqual(ids);
    expect(logged(reordered, '[WARNING] Provider returned booking passengers in a different order than submitted.')).toHaveLength(1);
    expect(logged(reordered, `[FULL] Passenger IDs: [${ids}]`)).toHaveLength(1);
  });

  test('without the submitted references, or when they do not read, the order of the booking is kept and said', () => {
    for (const given of [undefined, 'not json', JSON.stringify(['zzz'])]) {
      const r = run(TWO, { vars: { bookingPassengerReferences: given }, change: (b) => { b.passengers.reverse(); } });
      expect(r.env.passengerIdList).toEqual([...ids].reverse());
      expect(logged(r, '[DEBUG] passengerIdList kept in booking order')).toHaveLength(1);
    }
  });

  test('a passenger without an id is said; no passenger at all is an error line and an empty list', () => {
    const one = run(TWO, { change: (b) => { delete b.passengers[1].id; } });
    expect(one.logs).toContain('[WARNING] Passenger at index 1 has no ID.');
    const none = run(TWO, { change: (b) => { b.passengers = []; } });
    expect(none.logs).toContain('[ERROR] Passengers structure is invalid or empty.');
    expect(none.env.passengerIdList).toEqual([]);
  });
});

describe('the confirmation deadline', () => {
  const future = '2026-11-02T09:30:00Z';
  const deadline = (r) => named(r, 'booking confirmation deadline is a valid future datetime');

  test('at the booking\'s root under its OSDM name: checked, kept, and no word about where it is', () => {
    const r = run(ONE, { change: (b) => { b.confirmationTimeLimit = future; } });
    expect(deadline(r)).toEqual([{ name: 'booking confirmation deadline is a valid future datetime — source: booking.confirmationTimeLimit (OSDM-standard)', ok: true }]);
    expect(r.env.bookingConfirmationTimeLimit).toBe(future);
    expect(logged(r, "rather than the OSDM-standard 'confirmationTimeLimit'")).toEqual([]);
  });

  test('at the root under the name OSDM gives the parts: taken, with a warning', () => {
    const r = run(ONE, { change: (b) => { delete b.confirmationTimeLimit; b.confirmableUntil = future; } });
    expect(deadline(r)[0]).toEqual({ name: 'booking confirmation deadline is a valid future datetime — source: booking.confirmableUntil (vendor extension at booking level)', ok: true });
    expect(r.env.bookingConfirmationTimeLimit).toBe(future);
    expect(logged(r, "[WARNING] Provider exposes the booking-level confirmation deadline as 'confirmableUntil'")).toHaveLength(1);
  });

  test('on the parts only: the earliest of them is the booking\'s, with a warning', () => {
    const r = run(ONE, { change: (b) => {
      delete b.confirmationTimeLimit;
      delete b.confirmableUntil;
      const all = parts(b);
      all[0].confirmableUntil = '2026-11-02T09:40:00Z';
      b.bookedOffers[0].ancillaries = [{ id: 'X1', confirmableUntil: '2026-11-02T09:20:00Z' }, { id: 'X2', confirmableUntil: 'not a date' }];
    } });
    expect(r.env.bookingConfirmationTimeLimit).toBe('2026-11-02T09:20:00Z');
    expect(deadline(r)[0].ok).toBe(true);
    expect(deadline(r)[0].name).toContain('min(bookedOffers[].ancillaries[].confirmableUntil)');
    expect(deadline(r)[0].name).toContain('Picked the earliest of 2 part deadline(s)');
    expect(logged(r, '[WARNING] Provider does not expose a booking-level confirmation deadline')).toHaveLength(1);
  });

  test('nowhere: nothing to check, the variable emptied', () => {
    const r = run(ONE, { vars: { bookingConfirmationTimeLimit: 'an earlier one' }, change: (b) => {
      delete b.confirmationTimeLimit;
      delete b.confirmableUntil;
      for (const part of parts(b)) delete part.confirmableUntil;
    } });
    expect(deadline(r)).toEqual([]);
    expect(r.env.bookingConfirmationTimeLimit).toBe('');
    expect(logged(r, '[DEBUG] booking has no confirmation deadline anywhere')).toHaveLength(1);
  });

  test('already passed, or not a date: the check fails', () => {
    const past = run(ONE, { change: (b) => { b.confirmationTimeLimit = '2026-11-02T08:00:00Z'; } });
    expect(deadline(past)[0].ok).toBe(false);
    expect(deadline(past)[0].message).toContain('confirmation deadline is already in the past: 2026-11-02T08:00:00Z');
    const odd = run(ONE, { change: (b) => { b.confirmationTimeLimit = 'not a date'; } });
    expect(deadline(odd)[0]).toEqual(expect.objectContaining({ ok: false, message: 'confirmation deadline is not a valid date' }));
  });

  test('once the booking is confirmed, the deadline it still shows is neither checked nor kept', () => {
    const r = run(ONE, { step: '07. GET Booking after Fulfillments', expected: ['FULFILLED', 'CONFIRMED'], fulfilment: ['FULFILLED', 'CONFIRMED'],
      change: (b) => { b.confirmationTimeLimit = '2026-11-02T08:00:00Z'; } });
    expect(deadline(r)).toEqual([]);
    expect(logged(r, '[INFO] Booking already confirmed: its confirmation deadline (2026-11-02T08:00:00Z, source: booking.confirmationTimeLimit (OSDM-standard)) is ignored')).toHaveLength(1);
    expect('bookingConfirmationTimeLimit' in r.env).toBe(false);
  });
});

describe('what the booking still asks for', () => {
  const ASKS = 'passengerSpecifications[0].detail.gender';
  const asking = (vars = {}, change = () => {}) => run(TWO, { vars, change: (b) => { b.requestedInformation = ASKS; change(b); } });

  test('nothing asked: said, and nothing processed', () => {
    for (const none of [undefined, null, '']) {
      const r = run(ONE, { change: (b) => { b.requestedInformation = none; } });
      expect(r.asked).toEqual([]);
      expect(logged(r, '[DEBUG] booking.requestedInformation absent')).toHaveLength(1);
    }
  });

  test('what is asked is processed with the passengers\' and the purchaser\'s data, read from the run\'s variables', () => {
    const r = asking({
      passengerAdditionalData: JSON.stringify([{ updateGender: 'MALE' }]),
      bookingPassengerSpecifications: [{ type: 'PERSON' }],
      offerPassengerNumber: '2',
      bookingPurchaserSpecifications: JSON.stringify({ detail: { firstName: 'Pat' } }),
      purchaserAdditionalData: { updateEmail: 'a@b.c' },
    });
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]).toEqual(expect.objectContaining({
      expr: ASKS, tag: 'booking', additional: [{ updateGender: 'MALE' }], specs: [{ type: 'PERSON' }], passengerCount: 2,
      mode: 'autofeed', purchaserAdditional: { updateEmail: 'a@b.c' }, purchaserSpec: { detail: { firstName: 'Pat' } }, purchaserMode: 'autofeed',
    }));
  });

  test('variables that are not set or do not read are an empty list or object; the number of passengers falls back on the booking\'s', () => {
    const r = asking({ passengerAdditionalData: 'not json', bookingPassengerSpecifications: '', bookingPurchaserSpecifications: '[1]', purchaserAdditionalData: 'x' });
    expect(r.asked[0]).toEqual(expect.objectContaining({ additional: [], specs: [], passengerCount: 2, purchaserAdditional: {}, purchaserSpec: {} }));
    const none = asking({ passengerAdditionalData: [{}, {}, {}] }, (b) => { b.passengers = []; });
    expect(none.asked[0].passengerCount).toBe(3);
  });

  test.each([
    ['omit', 'omit'], ['INVALID', 'invalid'], ['off', 'autofeed'], [undefined, 'autofeed'],
  ])('the probe %s asks for the mode %s, for the passengers and for the purchaser alike', (given, mode) => {
    const r = asking({ requestedInformationProbe: given, bookingPurchaserMode: given });
    expect([r.asked[0].mode, r.asked[0].purchaserMode]).toEqual([mode, mode]);
  });

  test('what was fed is kept for the passenger step, which is then no longer skipped', () => {
    mockOutcome = { provided: ['gender'], additional: [{ updateGender: 'FEMALE' }] };
    const r = asking({ skipPatchPassengerRequest: 'true' });
    expect(r.env.passengerAdditionalData).toBe(JSON.stringify([{ updateGender: 'FEMALE' }]));
    expect(r.env.skipPatchPassengerRequest).toBe('false');
    expect('requestedInfoProbeTargets' in r.env).toBe(false);
    mockOutcome = { provided: [], additional: [{ kept: 'out' }] };
    const nothing = asking({ skipPatchPassengerRequest: 'true' });
    expect('passengerAdditionalData' in nothing.env).toBe(false);
    expect(nothing.env.skipPatchPassengerRequest).toBe('true');
  });

  test('what is to be probed is added to the probes already kept; the purchaser\'s part is kept apart', () => {
    mockOutcome = { provided: [], additional: [], probeTargets: [{ scenarioField: 'gender', index: 0 }], purchaserProbeTargets: [{ scenarioField: 'email' }], purchaserAdditional: { updateEmail: 'x' } };
    const r = asking({ requestedInfoProbeTargets: JSON.stringify([{ scenarioField: 'lastName', index: 1 }]) });
    expect(JSON.parse(r.env.requestedInfoProbeTargets)).toEqual([{ scenarioField: 'lastName', index: 1 }, { scenarioField: 'gender', index: 0 }]);
    expect(r.env.passengerAdditionalData).toBe('[]');
    expect(r.env.purchaserAdditionalData).toBe(JSON.stringify({ updateEmail: 'x' }));
    expect(r.env.requestedInfoPurchaserProbeTargets).toBe(JSON.stringify([{ scenarioField: 'email' }]));
    mockOutcome = { provided: [], additional: [], purchaserProvided: ['email'] };
    const fed = asking();
    expect(fed.env.purchaserAdditionalData).toBe('{}');
    expect('requestedInfoPurchaserProbeTargets' in fed.env).toBe(false);
  });

  test('what OSCAR already gave at the offer and is asked again is a warning, per field and passenger', () => {
    mockSummary = { parseOk: true, leaves: [
      { scenarioField: 'gender', passengerRef: 'passenger 1', index: 0 },
      { scenarioField: 'gender', passengerRef: 'passenger 2', index: 1 },
      { scenarioField: 'phoneNumber', passengerRef: 'any passenger', index: 'ANY' },
      { scenarioField: null, passengerRef: 'passenger 1', index: 0 },
    ] };
    const r = asking({ requestedInfoAutoFed: JSON.stringify([{ scenarioField: 'gender', index: 0 }, { scenarioField: 'phoneNumber', index: 3 }]) });
    expect(logged(r, '[WARNING] [P2]')).toEqual([
      "[WARNING] [P2] booking.requestedInformation still requests 'gender' for passenger 1, which OSCAR already provided — requestedInformation should clear once satisfied.",
      "[WARNING] [P2] booking.requestedInformation still requests 'phoneNumber' for any passenger, which OSCAR already provided — requestedInformation should clear once satisfied.",
    ]);
    mockSummary = { parseOk: false, leaves: [{ scenarioField: 'gender', passengerRef: 'passenger 1', index: 0 }] };
    expect(logged(asking({ requestedInfoAutoFed: [{ scenarioField: 'gender', index: 0 }] }), '[P2]')).toEqual([]);
    mockSummary = { parseOk: true, leaves: [{ scenarioField: 'gender', passengerRef: 'passenger 1', index: 0 }] };
    expect(logged(asking({ requestedInfoAutoFed: '[]' }), '[P2]')).toEqual([]);
  });
});

describe('the first booked offer', () => {
  test('its id is kept, under the name OSDM gives it or the older one; a booking without booked offers fails its check', () => {
    const r = run(ONE);
    expect(r.env.bookedOfferId).toBe(r.booking.bookedOffers[0].offerId);
    const older = run(ONE, { change: (b) => { b.bookedOffers[0].id = 'LEGACY-1'; delete b.bookedOffers[0].offerId; } });
    expect(older.env.bookedOfferId).toBe('LEGACY-1');
    const none = run(ONE, { change: (b) => { b.bookedOffers = []; } });
    expect(named(none, 'booking.bookedOffers is a non-empty array (OSDM: required)')[0].ok).toBe(false);
    expect('bookedOfferId' in none.env).toBe(false);
  });
});

describe('the price members', () => {
  const money = (amount, currency = 'CZK') => ({ amount, currency, scale: 2 });
  const structure = (r, member) => named(r, `${member} structure exists`);
  const confirmedStage = { step: '07. GET Booking after Fulfillments', expected: ['FULFILLED', 'CONFIRMED'], fulfilment: ['FULFILLED', 'CONFIRMED'] };
  const refundedStage = { step: '14. GET Booking after Patch Refund', expected: ['REFUNDED'], fulfilment: ['REFUNDED'] };

  test('before the confirmation the provisional price is asked for, and its amount kept; the confirmed one is allowed either way', () => {
    const r = run(ONE);
    expect(structure(r, 'provisionalPrice')).toEqual([{ name: 'provisionalPrice structure exists (booking stage: PREBOOKED)', ok: true }]);
    expect(named(r, 'Price fields exist (currency, amount) in provisionalPrice')[0].ok).toBe(true);
    expect(r.env.provisionalPriceAmount).toBe(r.booking.provisionalPrice.amount);
    expect(logged(r, '[DEBUG] confirmedPrice absent at this stage — allowed (lifecycle-scoped member).')).toHaveLength(1);
    const both = run(ONE, { change: (b) => { b.confirmedPrice = money(100); } });
    expect(logged(both, '[DEBUG] confirmedPrice also present at this stage — allowed (optional member).')).toHaveLength(1);
    expect(both.env.confirmedPriceAmount).toBe(100);
  });

  test('missing where its stage asks for it, or without its currency or amount: its two checks say so', () => {
    const none = run(ONE, { change: (b) => { delete b.provisionalPrice; } });
    expect(structure(none, 'provisionalPrice')[0]).toEqual(expect.objectContaining({ ok: false, message: 'provisionalPrice missing — OSDM expects it at this booking stage (PREBOOKED).' }));
    expect(named(none, 'Price fields exist (currency, amount) in provisionalPrice')[0].ok).toBe(false);
    expect('provisionalPriceAmount' in none.env).toBe(false);
    const half = run(ONE, { change: (b) => { delete b.provisionalPrice.currency; } });
    expect(named(half, 'Price fields exist (currency, amount) in provisionalPrice')[0].message).toContain('provisionalPrice.currency missing in booking');
  });

  test('once confirmed, the confirmed price is the one asked for', () => {
    const r = run(ONE, { ...confirmedStage, change: (b) => { b.confirmedPrice = money(26880); } });
    expect(structure(r, 'confirmedPrice')).toEqual([{ name: 'confirmedPrice structure exists (booking stage: FULFILLED,CONFIRMED)', ok: true }]);
    expect(structure(r, 'provisionalPrice')).toEqual([]);
    expect(r.env.confirmedPriceAmount).toBe(26880);
    const none = run(ONE, { ...confirmedStage, change: (b) => { delete b.confirmedPrice; } });
    expect(structure(none, 'confirmedPrice')[0].ok).toBe(false);
  });

  test('after a refund or an exchange, a confirmed price left out is a warning, and one that is there is said beside the amount of before', () => {
    const none = run(ONE, { ...refundedStage, change: (b) => { delete b.confirmedPrice; } });
    expect(structure(none, 'confirmedPrice')).toEqual([]);
    expect(logged(none, '[WARNING] confirmedPrice absent at booking stage REFUNDED')).toHaveLength(1);
    const there = run(ONE, { ...refundedStage, vars: { confirmedPriceAmount: 26880 }, change: (b) => { b.confirmedPrice = money(0); } });
    expect(logged(there, '[INFO] confirmedPrice at stage REFUNDED: 0 CZK (scale 2) — was 26880 before the after-sales operation.')).toHaveLength(1);
    expect(there.env.confirmedPriceAmount).toBe(0);
    const first = run(ONE, { ...refundedStage, vars: { confirmedPriceAmount: '' }, change: (b) => { b.confirmedPrice = money(0); } });
    expect(logged(first, '[INFO] confirmedPrice at stage REFUNDED')).toEqual([]);
  });

  test('a confirmed amount of 0 beside a provisional one, before the confirmation, is said and not kept', () => {
    const r = run(ONE, { vars: { confirmedPriceAmount: 'kept' }, change: (b) => { b.confirmedPrice = money(0); } });
    expect(logged(r, '[WARNING] confirmedPrice.amount is 0 while provisionalPrice.amount is')).toHaveLength(1);
    expect(r.env.confirmedPriceAmount).toBe('kept');
    const after = run(ONE, { ...confirmedStage, change: (b) => { b.confirmedPrice = money(0); } });
    expect(logged(after, '[WARNING] confirmedPrice.amount is 0')).toEqual([]);
    expect(after.env.confirmedPriceAmount).toBe(0);
  });

  test('the two prices are in one currency, which is the offer\'s', () => {
    const r = run(ONE, { vars: { offerCurrency: 'CZK' }, change: (b) => { b.confirmedPrice = money(100); } });
    expect(named(r, 'provisionalPrice.currency matches confirmedPrice.currency')[0].ok).toBe(true);
    expect(named(r, 'booking.provisionalPrice.currency matches offer currency (expected: CZK, actual: CZK)')[0].ok).toBe(true);
    const other = run(ONE, { vars: { offerCurrency: 'EUR' }, change: (b) => { b.confirmedPrice = money(100, 'EUR'); } });
    expect(named(other, 'provisionalPrice.currency matches confirmedPrice.currency')[0]).toEqual(expect.objectContaining({ ok: false, message: 'Currency mismatch: provisional=CZK, confirmed=EUR' }));
    expect(named(other, 'booking.provisionalPrice.currency matches offer currency (expected: EUR, actual: CZK)')[0].ok).toBe(false);
    const unknown = run(ONE);
    expect(named(unknown, 'matches offer currency')).toEqual([]);
    expect(named(unknown, 'matches confirmedPrice.currency')).toEqual([]);
  });

  test('the provisional price is compared with the offer\'s minimal price at 02 and 05 only', () => {
    const below = (r) => named(r, 'provisionalPrice is not below');
    expect(below(run(ONE))).toHaveLength(1);
    expect(below(run(ONE, { step: '05. GET Booking before Fulfillments' }))).toHaveLength(1);
    expect(below(run(ONE, { ...confirmedStage, change: (b) => { b.confirmedPrice = money(26880); } }))).toEqual([]);
  });
});

describe('the parts, the fulfilments and the passengers', () => {
  test('a price change is read in the answer of 02 and kept; a later read uses what was kept', () => {
    const r = run(ONE);
    expect(r.env.__bookingPriceChangeSaid).toBe('false');
    const said = run(ONE, { change: (b, given) => { given.answer.problems = [{ code: 'urn:uic:problem:OFFER_PART_PRICE_CHANGE', title: 'the price changed' }]; } });
    expect(said.env.__bookingPriceChangeSaid).toBe('true');
    const later = run(ONE, { step: '05. GET Booking before Fulfillments', vars: { __bookingPriceChangeSaid: 'true' } });
    expect(later.env.__bookingPriceChangeSaid).toBe('true');
  });

  test('the way the reservation was asked for is said when the scenario books it with the optional selections', () => {
    const r = run(ONE, { vars: { bookMandatoryReservations: 'true' } });
    expect(logged(r, '[INFO] Reservation booked via optionalReservationSelections (issue #239)')).toHaveLength(1);
    expect(logged(run(ONE), 'optionalReservationSelections (issue #239)')).toEqual([]);
  });

  test('the booking\'s own fulfilments are kept apart, by id, when it lists some', () => {
    const r = run(ONE, { change: (b) => { b.fulfillments = [{ id: 'F1', status: 'ON_HOLD' }, { status: 'ON_HOLD' }, { id: 'F2', status: 'ON_HOLD' }]; } });
    expect(r.env.__bookingFulfillmentIds).toBe(JSON.stringify(['F1', 'F2']));
    const none = run(ONE, { vars: { __bookingFulfillmentIds: 'kept' }, change: (b) => { b.fulfillments = []; } });
    expect(none.env.__bookingFulfillmentIds).toBe('kept');
  });

  test('the booking holds the number of passengers the scenario has; with no number known, at least one', () => {
    const count = (r) => named(r, 'Booking contains exactly the expected number of passengers');
    expect(count(run(TWO))).toEqual([{ name: 'Booking contains exactly the expected number of passengers - expected: 2, actual: 2', ok: true }]);
    const fewer = run(TWO, { vars: { passengerCount: '3' } });
    expect(count(fewer)[0]).toEqual(expect.objectContaining({ ok: false, message: 'Expected exactly 3 passengers, got 2' }));
    expect(count(run(TWO, { vars: { passengerCount: undefined } }))[0]).toEqual({ name: 'Booking contains exactly the expected number of passengers - expected: 0, actual: 2', ok: true });
    expect(count(run(TWO, { vars: { passengerCount: '' }, change: (b) => { b.passengers = []; } }))[0].ok).toBe(false);
  });
});

describe('what the stages say, and what they hand to the other checks', () => {
  const nonTrip = require(path.join(LIB, 'nonTrip.js'));
  const bookingTrip = require(path.join(LIB, 'bookingTrip.js'));
  const asOffered = require(path.join(LIB, 'bookedAsOffered.js'));
  const future = '2026-11-02T09:30:00Z';
  const second = '05. GET Booking before Fulfillments';
  const confirmedStage = { step: '07. GET Booking after Fulfillments', expected: ['FULFILLED', 'CONFIRMED'], fulfilment: ['FULFILLED', 'CONFIRMED'] };
  const PRICE_CHANGE = { code: 'urn:uic:problem:OFFER_PART_PRICE_CHANGE', title: 'the price changed' };
  afterEach(() => { jest.restoreAllMocks(); });

  test('each stage says what it found in a debug line, and the fulfilments\' summary status is looked at last', () => {
    const r = run(ONE, { change: (b) => { b.confirmationTimeLimit = future; b.confirmedPrice = { ...b.provisionalPrice }; delete b.fulfillmentStatus; } });
    const b = r.booking;
    expect(b.provisionalPrice.scale).toBe(2);
    for (const line of [
      "[DEBUG] 'booking' object exists",
      `[DEBUG] booking.id: ${b.id}`,
      `[DEBUG] booking.bookingCode: ${b.bookingCode}`,
      `[DEBUG] booking confirmation deadline: ${future} (source: booking.confirmationTimeLimit (OSDM-standard))`,
      '[DEBUG] booking.bookedOffers count: 1',
      '[DEBUG] provisionalPrice structure exists',
      '[DEBUG] provisionalPrice fields present (currency, amount), scale 2',
      `[DEBUG] Currency consistent across prices: ${b.provisionalPrice.currency}`,
      '[DEBUG] Booking passenger count - expected: 1, actual: 1',
    ]) expect(r.logs).toContain(line);
    expect(r.logs.at(-1)).toBe('[DEBUG] booking.fulfillmentStatus absent (null or undefined; optional in OSDM v3.8) → test skipped');
    const noScale = run(ONE, { change: (x) => { delete x.provisionalPrice.scale; } });
    expect(noScale.logs).toContain('[DEBUG] provisionalPrice fields present (currency, amount), scale 2 (default)');
  });

  test('the answer\'s warnings and problems are read, once, when the offers\' reader is there', () => {
    const before = global.checkWarningsAndProblems;
    const read = jest.fn();
    global.checkWarningsAndProblems = read;
    try {
      const r = run(ONE);
      expect(read).toHaveBeenCalledTimes(1);
      expect(read.mock.calls[0][0].booking).toBe(r.booking);
    } finally {
      global.checkWarningsAndProblems = before;
    }
  });

  test('a booking that is an empty object fails the first check', () => {
    const r = run(ONE, { change: (b, given) => { given.answer.booking = {}; } });
    expect(named(r, "'booking' object exists")[0].ok).toBe(false);
  });

  test('a booking made before its offer fails; a summary status that is not text fails', () => {
    const older = run(ONE, { change: (b, given) => { b.createdOn = '2026-11-01T08:00:00Z'; given.offer.createdOn = '2026-11-02T08:00:00Z'; } });
    expect(named(older, 'booking.createdOn: 2026-11-01T08:00:00.000Z, offer.createdOn: 2026-11-02T08:00:00.000Z')).toEqual([expect.objectContaining({ ok: false })]);
    const odd = run(ONE, { change: (b) => { b.fulfillmentStatus = 7; } });
    expect(named(odd, 'booking.fulfillmentStatus is a non-empty FulfillmentSummaryStatus code - value: 7')).toEqual([expect.objectContaining({ ok: false })]);
  });

  test('a sale without a trip and the trip sold are looked at, with the stage in words', () => {
    const noTrip = jest.spyOn(nonTrip, 'recordNonTripBookingChecks');
    const trip = jest.spyOn(bookingTrip, 'checkBookingTrip');
    const r = run(ONE);
    expect(noTrip).toHaveBeenCalledTimes(1);
    expect(noTrip.mock.calls[0][0]).toBe(r.booking);
    expect(noTrip.mock.calls[0][1]).toBe('Pre-booked');
    expect(typeof noTrip.mock.calls[0][2]).toBe('function');
    expect(trip).toHaveBeenCalledTimes(1);
    expect(trip.mock.calls[0][0]).toBe(r.booking);
    noTrip.mockClear();
    run(ONE, { ...confirmedStage, change: (b) => { b.confirmedPrice = { ...b.provisionalPrice }; } });
    expect(noTrip.mock.calls[0][1]).toBe('Confirmed');
  });

  test('the submitted references read from text align the ids too; an aligned booking says nothing of its order', () => {
    const refs = TWO.answer.booking.passengers.map((p) => p.externalRef);
    const ids = TWO.answer.booking.passengers.map((p) => p.id);
    const text = run(TWO, { vars: { bookingPassengerReferences: JSON.stringify(refs) }, change: (b) => { b.passengers.reverse(); } });
    expect(text.env.passengerIdList).toEqual(ids);
    const same = run(TWO, { vars: { bookingPassengerReferences: refs } });
    expect(logged(same, 'passengerIdList kept in booking order')).toEqual([]);
  });

  test('a deadline under its OSDM name alone brings no warning; a single deadline on a part is taken', () => {
    const root = run(ONE, { change: (b) => { b.confirmationTimeLimit = future; delete b.confirmableUntil; } });
    expect(logged(root, '[WARNING] Provider')).toEqual([]);
    const one = run(ONE, { change: (b) => {
      delete b.confirmationTimeLimit;
      delete b.confirmableUntil;
      for (const part of parts(b)) delete part.confirmableUntil;
      parts(b)[0].confirmableUntil = future;
    } });
    expect(one.env.bookingConfirmationTimeLimit).toBe(future);
    expect(named(one, 'booking confirmation deadline is a valid future datetime')[0].name).toContain('Picked the earliest of 1 part deadline(s)');
  });

  test('what is asked, with no variable set: empty lists and objects, the booking\'s number of passengers, 0 when it holds none', () => {
    const asks = (vars, change = () => {}) => run(TWO, { vars, change: (b) => { b.requestedInformation = 'passengerSpecifications[0].detail.gender'; change(b); } });
    const r = asks({});
    expect(r.asked[0]).toEqual(expect.objectContaining({ additional: [], specs: [], passengerCount: 2, purchaserAdditional: {}, purchaserSpec: {} }));
    const nulls = asks({ passengerAdditionalData: null, bookingPassengerSpecifications: null, bookingPurchaserSpecifications: null, purchaserAdditionalData: null });
    expect(nulls.asked[0]).toEqual(expect.objectContaining({ additional: [], specs: [], purchaserAdditional: {}, purchaserSpec: {} }));
    const none = asks({}, (b) => { b.passengers = []; });
    expect(none.asked[0].passengerCount).toBe(0);
  });

  test('the checks and the lines of what is asked go to the report as the others do', () => {
    mockDuring = (given) => {
      given.assert('RI: a field asked for is there', true, 'no reason');
      given.assert('RI: a field asked for is missing', false, 'the reason why');
      given.log('INFO', 'a line of the processing');
    };
    const r = run(ONE, { change: (b) => { b.requestedInformation = 'passengerSpecifications[0].detail.gender'; } });
    expect(named(r, 'RI: a field asked for is there')).toEqual([{ name: 'RI: a field asked for is there', ok: true }]);
    expect(named(r, 'RI: a field asked for is missing')).toEqual([expect.objectContaining({ ok: false })]);
    expect(r.logs).toContain('[INFO] a line of the processing');
  });

  test('a provisional price below the offer\'s fails, unless the answer of 02 said the price changed: a warning then', () => {
    const below = (r) => named(r, 'provisionalPrice is not below')[0];
    const lower = (b) => { b.provisionalPrice.amount = 1; };
    expect(below(run(ONE, { change: lower })).ok).toBe(false);
    const said = run(ONE, { change: (b, given) => { lower(b); given.answer.problems = [PRICE_CHANGE]; } });
    expect(below(said).ok).toBe(true);
    expect(logged(said, "[WARNING] provisionalPrice 1 is below the offer's minimalPrice")).toHaveLength(1);
    const zero = run(ONE, { change: (b) => { lower(b); b.confirmedPrice = { amount: 0, currency: b.provisionalPrice.currency, scale: 2 }; } });
    expect(logged(zero, '[WARNING] confirmedPrice.amount is 0 while provisionalPrice.amount is 1 ')).toHaveLength(1);
  });

  test('the parts are compared with the fees of the named places and with what was said of the price', () => {
    const context = jest.spyOn(asOffered, 'contextOf');
    const r = run(ONE, { vars: { __namedPlaceFees: JSON.stringify({ 'RES-1': 500 }) } });
    expect(context).toHaveBeenCalledTimes(1);
    expect(context.mock.calls[0][1]).toBe(r.booking);
    expect(context.mock.calls[0][2]).toEqual({ fees: { 'RES-1': 500 }, priceChangeSaid: false });
    context.mockClear();
    run(ONE, { step: second, vars: { __bookingPriceChangeSaid: 'true' } });
    expect(context.mock.calls[0][2]).toEqual({ fees: {}, priceChangeSaid: true });
  });

  test('admissions, reservations and ancillaries are each compared with the offer\'s', () => {
    const status = (r, kind) => named(r, `Status is PREBOOKED for ${kind}[0]`);
    const plain = run(ONE);
    expect(status(plain, 'admission')).toHaveLength(1);
    expect(status(plain, 'reservation')).toEqual([]);
    expect(status(plain, 'ancillary')).toEqual([]);
    const r = run(ONE, { vars: { bookMandatoryReservations: 'true' }, change: (b, given) => {
      const offered = given.offer.admissionOfferParts[0];
      const booked = b.bookedOffers[0].admissions[0];
      given.offer.reservationOfferParts = [{ ...structuredClone(offered), id: 'OFFER-RES' }];
      given.offer.ancillaryOfferParts = [{ ...structuredClone(offered), id: 'OFFER-ANC' }];
      b.bookedOffers[0].reservations = [{ ...structuredClone(booked), id: 'BOOKED-RES' }];
      b.bookedOffers[0].ancillaries = [{ ...structuredClone(booked), id: 'BOOKED-ANC' }];
    } });
    expect(status(r, 'admission')).toHaveLength(1);
    expect(status(r, 'reservation')).toHaveLength(1);
    expect(status(r, 'ancillary')).toHaveLength(1);
    expect(logged(r, '— 1 reservation(s) in the booking response.')).toHaveLength(1);
  });

  test('the accommodation asked for is looked at on the answer of 02 only', () => {
    const goal = (r) => named(r, '🎯 Accommodation goal');
    expect(goal(run(ONE, { vars: { accommodationSelection: 'COUCHETTE' } }))).toHaveLength(1);
    expect(goal(run(ONE, { step: second, vars: { accommodationSelection: 'COUCHETTE' } }))).toEqual([]);
  });

  test('the fulfilments are checked from the first; a single one is kept by its id', () => {
    const r = run(ONE, { change: (b) => { b.fulfillments = [{ id: 'F1', status: 'ON_HOLD' }]; } });
    expect(named(r, 'Fulfillments exist at index 0')).toHaveLength(1);
    expect(r.env.__bookingFulfillmentIds).toBe(JSON.stringify(['F1']));
  });

  test('one passenger more than the scenario has fails; one passenger is enough when no number is known', () => {
    const count = (r) => named(r, 'Booking contains exactly the expected number of passengers')[0];
    expect(count(run(TWO, { vars: { passengerCount: '1' } }))).toEqual(expect.objectContaining({ ok: false, message: 'Expected exactly 1 passengers, got 2' }));
    expect(count(run(ONE, { vars: { passengerCount: undefined } })).ok).toBe(true);
  });
});
