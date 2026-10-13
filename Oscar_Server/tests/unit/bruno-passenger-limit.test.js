// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-passenger-limit.test.js — #699: the passenger-limit probe, and a
 * partial refund of a third of the passengers.
 */

const path = require('node:path');

const LIB = path.resolve(__dirname, '../../../Bruno_Collection/library-bruno');

function withBru(vars, fn) {
  const tests = [];
  const logs = [];
  global.bru = { getEnvVar: (k) => vars[k], setEnvVar: (k, v) => { vars[k] = v; } };
  global.test = (name, body) => {
    try { body(); tests.push([name, 'pass']); } catch (e) { tests.push([name, 'fail', e.message]); }
  };
  global.validationLogger = (m) => logs.push(m);
  try { return { result: fn(), tests, logs }; } finally {
    delete global.bru; delete global.test;
  }
}

describe('the passenger-limit probe', () => {
  const pl = require(path.join(LIB, 'passengerLimit.js'));
  const request = { anonymousPassengerSpecifications: Array.from({ length: 20 }, (_, i) => ({ externalRef: String(i) })) };
  const armed = { passengerLimitExpectRejection: 'true', OfferCollectionRequest: JSON.stringify(request) };

  test('what the provider did, and how many passengers were asked', () => {
    expect(pl.overLimitOutcome(400, {})).toBe('refused');
    expect(pl.overLimitOutcome(500, null)).toBe('refused');
    expect(pl.overLimitOutcome(200, { offers: [] })).toBe('no-offer');
    expect(pl.overLimitOutcome(200, { offers: [{}] })).toBe('accepted');
    expect(pl.overLimitOutcome(200, {})).toBe('accepted');
    expect(pl.passengerCountOf(request)).toBe(20);
    expect(pl.passengerCountOf({ passengerSpecifications: [{}, {}] })).toBe(2);
    expect(pl.passengerCountOf(null)).toBe(0);
  });

  test('off: nothing is checked and the flow goes on', () => {
    const r = withBru({}, () => [pl.checkOffersOverLimit(400, {}), pl.checkBookingOverLimit(200, {})]);
    expect(r.result).toEqual([false, false]);
    expect(r.tests).toEqual([]);
  });

  test('offers refused with a Problem: passed, and the scenario ends', () => {
    const r = withBru({ ...armed }, () => pl.checkOffersOverLimit(400, { title: 'Too many', detail: 'at most 19' }));
    expect(r.result).toBe(true);
    expect(r.tests.filter(t => t[1] === 'fail')).toEqual([]);
    expect(r.tests[0][0]).toMatch(/20 passengers, POST \/offers.*client error/);
  });

  test('no offer given: passed, and the scenario ends; offers given: the booking decides', () => {
    expect(withBru({ ...armed }, () => pl.checkOffersOverLimit(200, { offers: [], problems: [{ code: 'X' }] })).result).toBe(true);
    const r = withBru({ ...armed }, () => pl.checkOffersOverLimit(200, { offers: [{}] }));
    expect(r.result).toBe(false);
    expect(r.tests).toEqual([]);
  });

  test('a booking over the limit fails; a refused one passes; either ends the scenario', () => {
    const ok = withBru({ ...armed }, () => pl.checkBookingOverLimit(422, { detail: 'too many passengers' }));
    expect(ok.result).toBe(true);
    expect(ok.tests.filter(t => t[1] === 'fail')).toEqual([]);
    const bad = withBru({ ...armed }, () => pl.checkBookingOverLimit(200, { booking: {} }));
    expect(bad.result).toBe(true);
    expect(bad.tests.find(t => t[1] === 'fail')[0]).toMatch(/POST \/bookings.*client error/);
    expect(bad.logs.some(l => /accepted 20 passengers/.test(l))).toBe(true);
  });
});

describe('a partial refund of a third of the passengers', () => {
  const { resolvePartialRefundScope, buildRefundSpecifications } = require(path.join(LIB, 'partialRefund.js'));
  const passengers = Array.from({ length: 7 }, (_, i) => ({ id: `P${i + 1}`, externalRef: String(i + 1) }));
  const admissions = passengers.map((p, i) => ({ id: `A${i + 1}`, passengerIds: [p.id] }));
  const booking = (fulfillments) => ({ passengers, bookedOffers: [{ admissions }], fulfillments });
  const perPassenger = admissions.map((a, i) => ({ id: `F${i + 1}`, bookingParts: [{ id: a.id }] }));

  test('the last third, rounded up: one specification per ticket when each passenger has their own', () => {
    const r = resolvePartialRefundScope(booking(perPassenger), { byPax: true, paxSel: 'third' });
    expect(r.degraded).toBe(false);
    expect(r.passengerIds).toEqual(['P5', 'P6', 'P7']);
    expect(buildRefundSpecifications(booking(perPassenger), { byPax: true, paxSel: 'third' })).toEqual([
      { fulfillmentId: 'F5', passengerIds: ['P5'] },
      { fulfillmentId: 'F6', passengerIds: ['P6'] },
      { fulfillmentId: 'F7', passengerIds: ['P7'] },
    ]);
  });

  test('one ticket for everyone: one specification naming them all', () => {
    const one = [{ id: 'F', bookingParts: admissions.map(a => ({ id: a.id })) }];
    expect(buildRefundSpecifications(booking(one), { byPax: true, paxSel: 'third' }))
      .toEqual([{ fulfillmentId: 'F', passengerIds: ['P5', 'P6', 'P7'] }]);
  });

  test('a passenger whose parts are in no ticket shown degrades to a full refund', () => {
    const missing = perPassenger.slice(0, 6).concat([{ id: 'F7', bookingParts: [] }, { id: 'F8', bookingParts: [] }]);
    const r = resolvePartialRefundScope(booking(missing), { byPax: true, paxSel: 'third' });
    expect(r.degraded).toBe(true);
    expect(r.reason).toMatch(/^passenger P7:/);
  });

  test('first and last are unchanged: one passenger, one specification', () => {
    expect(buildRefundSpecifications(booking(perPassenger), { byPax: true, paxSel: 'last' }))
      .toEqual([{ fulfillmentId: 'F7', passengerIds: ['P7'] }]);
    expect(buildRefundSpecifications(booking(perPassenger), { byPax: true, paxSel: 'first' }))
      .toEqual([{ fulfillmentId: 'F1', passengerIds: ['P1'] }]);
    // Two passengers: a third, rounded up, is one.
    const two = { passengers: passengers.slice(0, 2), bookedOffers: [{ admissions: admissions.slice(0, 2) }], fulfillments: perPassenger.slice(0, 2) };
    expect(buildRefundSpecifications(two, { byPax: true, paxSel: 'third' })).toEqual([{ fulfillmentId: 'F2', passengerIds: ['P2'] }]);
  });
});

describe('#703 an offer request with no passenger', () => {
  const pl = require(path.join(LIB, 'passengerLimit.js'));

  test('the request goes out with an empty list; off, it is not touched', () => {
    const on = { emptyPassengersExpectRejection: 'true', OfferCollectionRequest: JSON.stringify({ anonymousPassengerSpecifications: [{ externalRef: '1' }], tripSearchCriteria: { x: 1 } }) };
    withBru(on, () => pl.prepareEmptyPassengers());
    expect(JSON.parse(on.OfferCollectionRequest)).toEqual({ anonymousPassengerSpecifications: [], tripSearchCriteria: { x: 1 } });
    const off = { OfferCollectionRequest: '{"anonymousPassengerSpecifications":[{}]}' };
    withBru(off, () => pl.prepareEmptyPassengers());
    expect(off.OfferCollectionRequest).toBe('{"anonymousPassengerSpecifications":[{}]}');
  });

  test('a 4xx Problem passes; a 200 fails; armed, the scenario ends either way', () => {
    const ok = withBru({ emptyPassengersExpectRejection: 'true' }, () => pl.checkEmptyPassengersRefused(400, { title: 'Bad Request', detail: 'no passenger' }));
    expect(ok.result).toBe(true);
    expect(ok.tests.filter(t => t[1] === 'fail')).toEqual([]);
    const bad = withBru({ emptyPassengersExpectRejection: 'true' }, () => pl.checkEmptyPassengersRefused(200, { offers: [{}] }));
    expect(bad.result).toBe(true);
    expect(bad.tests.find(t => t[1] === 'fail')[0]).toMatch(/No passenger probe \[POST \/offers\]: provider rejects with a client error/);
    expect(withBru({}, () => pl.checkEmptyPassengersRefused(400, {})).result).toBe(false);
  });
});
