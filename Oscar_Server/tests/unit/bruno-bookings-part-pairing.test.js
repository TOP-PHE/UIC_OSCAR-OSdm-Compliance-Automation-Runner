// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-bookings-part-pairing.test.js — #550: the booking validator pairs the
 * offer's parts with the booking's parts by content, not by position
 * (Bruno_Collection/library-bruno/bookings.js#pairOfferParts and the
 * validateOfferParts orchestrator, exported as validateBookedOfferParts).
 *
 * A provider may list the booked parts in another order than the offer. The
 * old code compared offer part i with booked part i, so the same booking gave
 * a different number of assertions and failures from run to run.
 *
 * Harness: as the other library-bruno tests, a minimal `bru`; here testCapture
 * records every assertion (name, pass/fail, message) and tests/helpers/bruno-chai.js
 * stands in for Bruno's chai `expect`, so the assertions can be
 * compared one by one between orders.
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
}));
jest.mock('../../../Bruno_Collection/library-bruno/requestedInformation.js', () => ({
  processRequestedInformation: () => {},
  summariseRequestedInformation: () => '',
}));

const { pairOfferParts, validateBookedOfferParts } = require('../../../Bruno_Collection/library-bruno/bookings.js');

// ─── Fixture: one admission per passenger, five passengers ──────────────────
// The order and the passenger types are those of the run described in #550.
// The two adults and the two seniors also differ in price and after-sales
// fee, so a wrong pair shows in more than the passenger type.
const PASSENGERS = [
  { ref: 'PAX1', type: 'ADULT',  amount: 5000 },
  { ref: 'PAX2', type: 'SENIOR', amount: 3500 },
  { ref: 'PAX3', type: 'YOUTH',  amount: 2500 },
  { ref: 'PAX4', type: 'ADULT',  amount: 4800 },
  { ref: 'PAX5', type: 'SENIOR', amount: 3300 },
];

function offerPart(p, i) {
  return {
    id: `offer-adm-${i + 1}`,
    validFrom: '2026-10-18T08:00:00+02:00',
    validUntil: '2026-10-18T23:59:00+02:00',
    price: { amount: p.amount, currency: 'EUR', scale: 2 },
    offerMode: 'INDIVIDUAL',
    isReservationRequired: false,
    refundable: 'YES',
    exchangeable: 'YES',
    summaryProductId: 'PRODUCT-STD',
    passengerRefs: [p.ref],
    afterSalesConditions: [
      { condition: 'REFUND', afterSaleFee: { amount: Math.round(p.amount / 10), currency: 'EUR', scale: 2 } },
    ],
    appliedPassengerTypes: [{ passengerRef: p.ref, type: p.type, description: p.type.toLowerCase() }],
  };
}

// The provider's view: its own ids and passenger references, Z timestamps.
function bookedPart(p, i) {
  const o = offerPart(p, i);
  return {
    ...o,
    id: `booked-adm-${i + 1}`,
    status: 'PREBOOKED',
    validFrom: '2026-10-18T06:00:00Z',
    validUntil: '2026-10-18T21:59:00Z',
    passengerRefs: undefined,
    passengerIds: [`prov-${p.ref}`],
    appliedPassengerTypes: [{ passengerRef: `prov-${p.ref}`, type: p.type, description: p.type.toLowerCase() }],
  };
}

const OFFER = PASSENGERS.map(offerPart);
const BOOKED = PASSENGERS.map(bookedPart);

// The booking order of the run that failed: SENIOR, YOUTH, ADULT, SENIOR, ADULT.
const ISSUE_ORDER = [1, 2, 3, 4, 0];

function permutations(list) {
  if (list.length <= 1) return [list];
  return list.flatMap((x, i) => permutations([...list.slice(0, i), ...list.slice(i + 1)]).map((rest) => [x, ...rest]));
}

function run(offerParts, bookedParts, partType = 'admission') {
  mockResults = [];
  mockLogs = [];
  withBrunoExpect(() => validateBookedOfferParts(offerParts, bookedParts, partType, ['PREBOOKED']));
  return { results: mockResults, logs: mockLogs, ids: bru.getEnvVar('admissionReservationAncillaryBookingPartsIds') };
}

beforeEach(() => {
  envStore = {};
  delete global.req;
});

describe('#550 — booked parts are paired with offer parts by content', () => {
  test('the booking in offer order passes every assertion (fixture sanity)', () => {
    const { results: r, logs: l } = run(OFFER, BOOKED);
    expect(r.length).toBeGreaterThan(50);
    expect(r.filter((x) => !x.ok)).toEqual([]);
    expect(l.some((line) => line.startsWith('[INFO]'))).toBe(false);
  });

  test('the order of #550 gives the same assertions and no failure', () => {
    const inOrder = run(OFFER, BOOKED);
    envStore = {};
    const shuffled = run(OFFER, ISSUE_ORDER.map((i) => BOOKED[i]));
    expect(shuffled.results).toEqual(inOrder.results);
    expect(shuffled.ids).toEqual(inOrder.ids);
  });

  test('every one of the 120 orders gives exactly the same assertions and failures', () => {
    const reference = run(OFFER, BOOKED).results;
    for (const order of permutations([0, 1, 2, 3, 4])) {
      envStore = {};
      const { results: r } = run(OFFER, order.map((i) => BOOKED[i]));
      expect({ order, r }).toEqual({ order, r: reference });
    }
  });

  test('a real defect fails the same way whatever the order', () => {
    // The booking says CHILD where the offer said YOUTH: a provider fault.
    const faulty = BOOKED.map((b) => (b.appliedPassengerTypes[0].type === 'YOUTH'
      ? { ...b, appliedPassengerTypes: [{ ...b.appliedPassengerTypes[0], type: 'CHILD' }] }
      : b));
    const reference = run(OFFER, faulty).results;
    const failed = reference.filter((x) => !x.ok).map((x) => x.name);
    expect(failed).toEqual(['admission[2] appliedPassengerTypes[0] - type=YOUTH exists in booking']);
    for (const order of [ISSUE_ORDER, [4, 3, 2, 1, 0], [2, 0, 4, 1, 3]]) {
      envStore = {};
      expect(run(OFFER, order.map((i) => faulty[i])).results).toEqual(reference);
    }
  });

  test('a reordered booking is logged once at INFO, with the pairs', () => {
    const { logs: l } = run(OFFER, ISSUE_ORDER.map((i) => BOOKED[i]));
    const info = l.filter((line) => line.startsWith('[INFO]'));
    expect(info).toEqual([
      '[INFO] admission: the booking lists its parts in another order than the offer; parts paired by content: '
      + 'offer[0] ↔ booking[4], offer[1] ↔ booking[0], offer[2] ↔ booking[1], offer[3] ↔ booking[2], offer[4] ↔ booking[3]',
    ]);
  });

  test('a booking that lacks a part fails once, naming the part, and no field check runs against another part', () => {
    const lacking = ISSUE_ORDER.map((i) => BOOKED[i]).filter((b) => b.id !== 'booked-adm-3');
    const { results: r, ids } = run(OFFER, lacking);
    const failed = r.filter((x) => !x.ok);
    expect(failed).toHaveLength(1);
    expect(failed[0].name).toBe('admission[2] has a counterpart in the booking (offer part id=offer-adm-3, passenger types YOUTH)');
    expect(failed[0].message).toContain('The booking has no admission for offer part id=offer-adm-3');
    expect(failed[0].message).toContain('the offer has 5 admission part(s), the booking 4');
    expect(r.some((x) => x.name.startsWith('admission[2] ') && x.ok)).toBe(false);
    expect(ids).not.toContain(undefined);
    expect(ids).toHaveLength(4);
  });

  test('the missing part is one finding across the booking re-reads (#383)', () => {
    const lacking = BOOKED.slice(0, 4);
    global.req = { getName: () => '02. POST Create Booking' };
    expect(run(OFFER, lacking).results.filter((x) => !x.ok)).toHaveLength(1);
    global.req = { getName: () => '07. GET Booking after Fulfillments' };
    const reread = run(OFFER, lacking);
    expect(reread.results.filter((x) => !x.ok)).toEqual([]);
    expect(reread.logs.some((line) => line.startsWith('[WARNING] admission[4] has a counterpart in the booking')
      && line.includes('already recorded'))).toBe(true);
  });

  test('a missing reservation or ancillary part stays a warning: it may be optional and not selected', () => {
    for (const partType of ['reservation', 'ancillary']) {
      envStore = {};
      const { results: r, logs: l } = run(OFFER, BOOKED.slice(0, 4), partType);
      expect(r.filter((x) => !x.ok)).toEqual([]);
      expect(l).toContain(`[WARNING] No booked ${partType} found for offer ${partType}[4] (id=offer-adm-5, passenger types SENIOR); it may be an optional part that was not selected.`);
    }
  });

  test('a booked part that no offer part takes is logged at INFO, not failed', () => {
    const extra = { ...bookedPart({ ref: 'PAX9', type: 'ADULT', amount: 1 }, 8) };
    const { results: r, logs: l } = run(OFFER, [extra, ...BOOKED]);
    expect(r.filter((x) => !x.ok)).toEqual([]);
    expect(l).toContain('[INFO] admission: the booking has 1 part(s) that no part of the selected offer pairs with: id=booked-adm-9, passenger types ADULT');
  });

  test('#594: such a part is still a part of the booking, so a fulfillment may hold it; each id once', () => {
    // A return booked as two offers: the parts of the other direction pair with
    // no part of the selected offer, and the outbound ticket holds them.
    const extra = { ...bookedPart({ ref: 'PAX9', type: 'ADULT', amount: 1 }, 8) };
    const { ids } = run(OFFER, [extra, ...BOOKED]);
    expect(ids).toContain('booked-adm-9');
    expect(ids).toHaveLength(BOOKED.length + 1);
    // Read again (07 after 05), nothing is listed twice.
    expect(run(OFFER, [extra, ...BOOKED]).ids).toHaveLength(BOOKED.length + 1);
  });
});

describe('#550 — pairOfferParts', () => {
  // In the tests below, the booked parts' own text (the last tie-break) sorts
  // them the wrong way round ('a' < 'b'), so only the rule under test can
  // give the right pairs.
  const pairsOf = (offers, booked) => pairOfferParts(offers, booked).pairs.map((p) => [p.offerIndex, p.bookedIndex]);

  test('same id wins over everything else', () => {
    const offers = [{ id: 'A', appliedPassengerTypes: [{ type: 'ADULT' }] }, { id: 'B', appliedPassengerTypes: [{ type: 'CHILD' }] }];
    // The booking keeps the offer's ids but (wrongly) swaps the types.
    const booked = [{ id: 'B', appliedPassengerTypes: [{ type: 'ADULT' }] }, { id: 'A', appliedPassengerTypes: [{ type: 'CHILD' }] }];
    expect(pairsOf(offers, booked)).toEqual([[0, 1], [1, 0]]);
  });

  test('the same passenger references win over the same types', () => {
    const offers = [
      { appliedPassengerTypes: [{ passengerRef: 'P1', type: 'ADULT' }], price: { amount: 1, currency: 'EUR' } },
      { appliedPassengerTypes: [{ passengerRef: 'P2', type: 'ADULT' }], price: { amount: 2, currency: 'EUR' } },
    ];
    // Prices swapped on purpose: the references still decide.
    const booked = [
      { appliedPassengerTypes: [{ passengerRef: 'P2', type: 'ADULT' }], price: { amount: 1, currency: 'EUR' } },
      { appliedPassengerTypes: [{ passengerRef: 'P1', type: 'ADULT' }], price: { amount: 2, currency: 'EUR' } },
    ];
    expect(pairsOf(offers, booked)).toEqual([[0, 1], [1, 0]]);
  });

  test("the offer's passengerRefs are matched with the booked part's passengerIds", () => {
    const offers = [{ passengerRefs: ['P1'] }, { passengerRefs: ['P2'] }];
    const booked = [{ id: 'a', passengerIds: ['P2'] }, { id: 'b', passengerIds: ['P1'] }];
    expect(pairsOf(offers, booked)).toEqual([[0, 1], [1, 0]]);
  });

  test('trip coverage tells apart two legs of the same passenger', () => {
    const leg = (tripId, id) => ({ id, appliedPassengerTypes: [{ type: 'ADULT' }], tripCoverage: { coveredTripId: tripId, coveredLegIds: [`${tripId}-L1`] } });
    expect(pairsOf([leg('T1'), leg('T2')], [leg('T2', 'a'), leg('T1', 'b')])).toEqual([[0, 1], [1, 0]]);
  });

  test('validity is compared as an instant, whatever the time zone', () => {
    const offers = [{ validFrom: '2026-10-18T08:00:00+02:00' }, { validFrom: '2026-10-19T08:00:00+02:00' }];
    const booked = [{ id: 'a', validFrom: '2026-10-19T06:00:00Z' }, { id: 'b', validFrom: '2026-10-18T06:00:00Z' }];
    expect(pairsOf(offers, booked)).toEqual([[0, 1], [1, 0]]);
  });

  test('a part with no counterpart is missing; a booked part left over is extra', () => {
    const offers = [{ id: 'A' }, { id: 'B' }];
    expect(pairOfferParts(offers, [{ id: 'B' }])).toEqual({
      pairs: [{ offerIndex: 1, bookedIndex: 0, typesMatch: true }], missing: [0], extra: [], reordered: true,
    });
    expect(pairOfferParts([{ id: 'A' }], [{ id: 'X' }, { id: 'A' }])).toMatchObject({ missing: [], extra: [0] });
  });

  test('parts that differ in nothing compared are paired by their own content, not their position', () => {
    // Identical for every scored field, different elsewhere (status): the pair
    // must not depend on which comes first in the booking.
    const offers = [{ appliedPassengerTypes: [{ type: 'ADULT' }] }, { appliedPassengerTypes: [{ type: 'ADULT' }] }];
    const b1 = { id: 'x1', appliedPassengerTypes: [{ type: 'ADULT' }], status: 'PREBOOKED' };
    const b2 = { id: 'x2', appliedPassengerTypes: [{ type: 'ADULT' }], status: 'CONFIRMED' };
    const ids = (booked) => pairOfferParts(offers, booked).pairs.map((p) => booked[p.bookedIndex].id);
    expect(ids([b1, b2])).toEqual(ids([b2, b1]));
  });

  test('null entries and non-arrays are tolerated', () => {
    expect(pairOfferParts(null, undefined)).toEqual({ pairs: [], missing: [], extra: [], reordered: false });
    expect(pairOfferParts([{ id: 'A' }, null], [null, { id: 'A' }])).toEqual({
      pairs: [{ offerIndex: 0, bookedIndex: 1, typesMatch: true }], missing: [1], extra: [0], reordered: true,
    });
  });
});
