// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-fare-fulfillments.test.js — which fares a fulfilment holds (#1208).
 *
 * A provider's review: in OSDM 3.x a fare is not a booking part
 * (`BookingPartReference` refers to a reservation, admission, ancillary or
 * fee), so a fare fulfilment names no fare in `bookingParts`. OSCAR read the
 * fares only from there. The forms read now, each seen or allowed: the fares
 * named all the same (a provider gives one fulfilment per fare, each naming
 * its fare), the billing references of OSDM 3.11, and the fare fulfilment that
 * names none (the simulator, as OSDM 3.x says).
 */

const path = require('node:path');

const LIB = path.join(__dirname, '..', '..', '..', 'Bruno_Collection', 'library-bruno');
const F = require(path.join(LIB, 'fareFulfillments.js'));
const fareRefund = require(path.join(LIB, 'fareRefund.js'));

const acc = (id, company = 'urn:x:company:1') => ({ accountingCompany: company, accountingIds: [id] });
const FARES = [{ id: 'fare-1', accountingRef: acc('A1') }, { id: 'fare-2', accountingRef: acc('A2') }];

describe('fareHoldings: who holds which fare', () => {
  test('one fulfilment naming no fare, as OSDM 3.x says: it holds every fare, nothing is named as a part', () => {
    const h = F.fareHoldings({ fares: FARES, fulfillments: [{ id: 'FUL' }] });
    expect(h).toEqual({ fareFulfillments: ['FUL'], byFulfillment: { FUL: ['fare-1', 'fare-2'] }, shared: null, unheld: [], namedAsParts: [] });
  });

  test('a fulfilment per fare, each naming its fare: held as named, and both named as parts', () => {
    const h = F.fareHoldings({ fares: FARES, fulfillments: [{ id: 'F1', bookingParts: [{ id: 'fare-1' }] }, { id: 'F2', bookingParts: [{ id: 'fare-2' }] }] });
    expect(h.byFulfillment).toEqual({ F1: ['fare-1'], F2: ['fare-2'] });
    expect(h.namedAsParts).toEqual(['fulfillment F1 names fare fare-1', 'fulfillment F2 names fare fare-2']);
    expect(h.unheld).toEqual([]);
  });

  test('OSDM 3.11 billing references: the same accounting company and an accounting id in common', () => {
    const billed = (ref) => ({ accountingRef: ref, price: { amount: 1, currency: 'EUR' } });
    const h = F.fareHoldings({ fares: FARES, fulfillments: [{ id: 'F1', billingReferences: [billed(acc('A2'))] }, { id: 'F2', billingReferences: [billed(acc('A1'))] }] });
    expect(h.byFulfillment).toEqual({ F1: ['fare-2'], F2: ['fare-1'] });
    expect(F.billsFare(billed(acc('A1', 'urn:x:other')), FARES[0])).toBe(false);
    expect(F.billsFare(billed({ accountingCompany: 'urn:x:company:1' }), FARES[0])).toBe(false);
  });

  test('one billing reference names one fare, though two fares of one tariff share an accounting id', () => {
    const twins = [{ id: 'fare-1', accountingRef: acc('T'), prices: [{ amount: 50 }] }, { id: 'fare-2', accountingRef: acc('T'), prices: [{ amount: 50 }] }];
    const ref = { accountingRef: acc('T'), price: { amount: 50, currency: 'EUR' } };
    expect(F.fareHoldings({ fares: twins, fulfillments: [{ id: 'F1', billingReferences: [ref, ref] }] }).byFulfillment).toEqual({ F1: ['fare-1', 'fare-2'] });
    expect(F.fareHoldings({ fares: twins, fulfillments: [{ id: 'F1', billingReferences: [ref] }] }).unheld).toEqual(['fare-2']);
    // A reference counts first for the fare its own fulfilment names (the wrong variant on 3.11 and later).
    const named = F.fareHoldings({ fares: twins, fulfillments: [{ id: 'F1', bookingParts: [{ id: 'fare-1' }], billingReferences: [ref] }] });
    expect(named).toMatchObject({ byFulfillment: { F1: ['fare-1'] }, unheld: ['fare-2'] });
  });

  test('a fare named nowhere, with no fare fulfilment naming none to hold it, is unheld (F5)', () => {
    const h = F.fareHoldings({ fares: FARES, fulfillments: [{ id: 'F1', bookingParts: [{ id: 'fare-1' }] }] });
    expect(h.unheld).toEqual(['fare-2']);
    // A product fulfilment is no fare fulfilment: it holds no fare.
    const p = F.fareHoldings({ fares: FARES, fulfillments: [{ id: 'P1', bookingParts: [{ id: 'ADM-1' }] }], productIds: ['ADM-1'] });
    expect(p).toMatchObject({ fareFulfillments: [], unheld: ['fare-1', 'fare-2'] });
  });

  test('several fulfilments naming no fare share the fares; a set holding only some of them cannot tell', () => {
    const h = F.fareHoldings({ fares: FARES, fulfillments: [{ id: 'F1' }, { id: 'F2' }] });
    expect(h.shared).toEqual({ fulfillmentIds: ['F1', 'F2'], fareIds: ['fare-1', 'fare-2'] });
    expect(F.faresHeldBy(h, ['F1', 'F2'])).toEqual({ fareIds: ['fare-1', 'fare-2'], partly: false });
    expect(F.faresHeldBy(h, ['F1'])).toEqual({ fareIds: [], partly: true });
  });

  test('a fulfilment naming only a fare reservation (a booking part) is a fare fulfilment and holds the fares', () => {
    const h = F.fareHoldings({ fares: FARES, fulfillments: [{ id: 'FUL', bookingParts: [{ id: 'PLACE-1' }] }], reservationIds: ['PLACE-1'] });
    expect(h).toMatchObject({ fareFulfillments: ['FUL'], byFulfillment: { FUL: ['fare-1', 'fare-2'] }, namedAsParts: [] });
  });
});

describe('the fare refund reads the same holdings', () => {
  const fare = (id, amount) => ({ id, prices: [{ amount, currency: 'EUR', scale: 2 }], combinationConstraint: [{ model: 'CLUSTERING' }], afterSalesCondition: { conditions: [] } });
  const booking = (fulfillments) => ({ bookedOffers: [{ fares: [fare('fare-1', 1000), fare('fare-2', 500)], reservations: [], admissions: [] }], fulfillments });

  test('a fulfilment naming no fare holds both; R2 compares the refund offer with both fares', () => {
    const [only] = fareRefund.fareFulfillmentsOf(booking([{ id: 'FUL', status: 'FULFILLED' }]));
    expect(only.fulfillmentId).toBe('FUL');
    expect(only.fares.map((f) => f.id)).toEqual(['fare-1', 'fare-2']);
    const offer = { id: 'RO', fulfillments: [{ id: 'FUL' }], refundableAmount: { amount: 1200, currency: 'EUR' }, refundFee: { amount: 300, currency: 'EUR' } };
    const checks = fareRefund.refundOfferChecks([offer], [only], { asked: ['FUL'] });
    expect(checks.filter((c) => !c.ok)).toEqual([]);
  });

  test('two fulfilments naming no fare: one refund offer for both is compared once; one for each is not compared', () => {
    const shared = fareRefund.fareFulfillmentsOf(booking([{ id: 'F1' }, { id: 'F2' }]));
    expect(shared.map((f) => [f.fulfillmentId, f.sharedWith])).toEqual([['F1', ['F1', 'F2']], ['F2', ['F1', 'F2']]]);
    const both = { id: 'RO', fulfillments: [{ id: 'F1' }, { id: 'F2' }], refundableAmount: { amount: 1500, currency: 'EUR' }, refundFee: { amount: 0, currency: 'EUR' } };
    expect(fareRefund.refundOfferChecks([both], shared, { asked: ['F1', 'F2'] }).filter((c) => !c.ok)).toEqual([]);
    const one = { ...both, fulfillments: [{ id: 'F1' }], refundableAmount: { amount: 1, currency: 'EUR' } };
    const checks = fareRefund.refundOfferChecks([one, { ...one, id: 'RO2', fulfillments: [{ id: 'F2' }] }], shared, { asked: ['F1', 'F2'] });
    expect(checks.filter((c) => c.level === 'FAIL' && !c.ok)).toEqual([]);
    expect(checks.filter((c) => c.level === 'INFO').map((c) => c.message)).toEqual([
      expect.stringContaining('refund offer RO holds only some of the fulfilments F1, F2'),
      expect.stringContaining('refund offer RO2 holds only some of the fulfilments F1, F2'),
    ]);
  });

  test("R6 warns of a fare named in a refund offer's breakdown, never of a fare reservation (a booking part)", () => {
    const withPlace = { bookedOffers: [{ fares: [fare('fare-1', 1000)], reservations: [{ id: 'PL', distributionMode: 'FARE_MODE', price: { amount: 300, currency: 'EUR' } }], admissions: [] }], fulfillments: [{ id: 'FUL', bookingParts: [{ id: 'PL' }] }] };
    const held = fareRefund.fareFulfillmentsOf(withPlace);
    const offer = (parts) => ({ id: 'RO', fulfillments: [{ id: 'FUL' }], refundableAmount: { amount: 1300, currency: 'EUR' }, refundFee: { amount: 0, currency: 'EUR' }, refundOfferBreakdown: parts.map((id) => ({ bookingParts: [{ id }] })) });
    const r6 = (parts) => fareRefund.refundOfferChecks([offer(parts)], held, { asked: ['FUL'] }).find((c) => c.id === 'R6');
    expect(r6(['PL']).ok).toBe(true);
    expect(r6(['fare-1', 'PL'])).toMatchObject({ level: 'WARNING', ok: false });
    expect(r6(['fare-1', 'PL']).message).toContain('refund offer RO names fare fare-1');
  });

  test('a fulfilment per fare, each naming its fare (the earlier form) still works', () => {
    const named = fareRefund.fareFulfillmentsOf(booking([{ id: 'F1', bookingParts: [{ id: 'fare-1' }] }, { id: 'F2', bookingParts: [{ id: 'fare-2' }] }]));
    expect(named.map((f) => [f.fulfillmentId, f.fares.map((x) => x.id)])).toEqual([['F1', ['fare-1']], ['F2', ['fare-2']]]);
  });
});
