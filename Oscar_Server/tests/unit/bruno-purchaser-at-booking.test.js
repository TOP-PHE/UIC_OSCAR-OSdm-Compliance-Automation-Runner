// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-purchaser-at-booking.test.js — #899: the invalid purchaser probe sent
 * in the booking, for a provider that takes the purchaser only there.
 */

const path = require('node:path');

const LIB = path.resolve(__dirname, '../../../Bruno_Collection/library-bruno');
const pab = require(path.join(LIB, 'purchaserAtBooking.js'));

const VALID = { detail: { firstName: 'Paula', lastName: 'Purchaser', contact: { email: 'paula@example.org', phoneNumber: '+33199000010' } } };

// A Bruno stand-in over one variable store; returns what the step did.
function withBru(vars, fn) {
  const tests = [];
  const logs = [];
  let next = null;
  global.bru = {
    getEnvVar: (k) => vars[k],
    setEnvVar: (k, v) => { vars[k] = v; },
    runner: { setNextRequest: (name) => { next = name; } },
  };
  global.test = (name, body) => {
    try { body(); tests.push([name, 'pass']); } catch (e) { tests.push([name, 'fail', e.message]); }
  };
  global.validationLogger = (m) => logs.push(m);
  try { return { result: fn(), tests, logs, next, vars }; } finally {
    delete global.bru; delete global.test;
  }
}

describe('the pure rules', () => {
  test('the mode, and the pass read from its variable', () => {
    expect(pab.isAtBookingProbe('invalid_at_booking')).toBe(true);
    expect(pab.isAtBookingProbe(' Invalid_At_Booking ')).toBe(true);
    expect(pab.isAtBookingProbe('invalid')).toBe(false);
    expect(pab.isAtBookingProbe(undefined)).toBe(false);
    expect(pab.passOf(undefined)).toBe(0);
    expect(pab.passOf('2')).toBe(2);
    expect(pab.passOf('-1')).toBe(0);
    expect(pab.passOf('x')).toBe(0);
    expect(pab.passOf('99')).toBe(pab.SWEEP.length - 1);
    expect(pab.passOf('done')).toBeNull();
  });

  test('each pass spoils one field of a copy, the rest kept', () => {
    const [first, last, email, phone] = pab.SWEEP.map((_, i) => pab.corruptedPurchaser(VALID, i));
    expect(first.purchaser.detail).not.toHaveProperty('firstName');
    expect(first.purchaser.detail.lastName).toBe('Purchaser');
    expect(first.target).toEqual({ scenarioField: 'firstName' });
    expect(last.purchaser.detail).not.toHaveProperty('lastName');
    expect(email.purchaser.detail.contact).toEqual({ email: 'not-an-email', phoneNumber: '+33199000010' });
    expect(email.target).toEqual({ scenarioField: 'email', value: 'not-an-email' });
    expect(phone.purchaser.detail.contact.phoneNumber).toBe('not-a-phone');
    expect(VALID.detail.firstName).toBe('Paula');
    expect(VALID.detail.contact.email).toBe('paula@example.org');
  });

  test('a purchaser holding its contact flat (below OSDM 3.4) is spoiled there', () => {
    const flat = { detail: { firstName: 'P', lastName: 'Q', email: 'p@example.org' } };
    expect(pab.corruptedPurchaser(flat, 2).purchaser.detail).toEqual({ firstName: 'P', lastName: 'Q', email: 'not-an-email' });
    expect(pab.corruptedPurchaser(null, 3).purchaser.detail.contact).toEqual({ phoneNumber: 'not-a-phone' });
  });

  test('after a pass: the next one, then done; an acceptance is told', () => {
    expect(pab.afterPass(0, 400)).toEqual({ next: '1', accepted: false });
    expect(pab.afterPass(pab.SWEEP.length - 1, 400)).toEqual({ next: 'done', accepted: false });
    expect(pab.afterPass(2, 200).accepted).toBe(true);
    expect(pab.bookingIdOf({ booking: { id: 'B1' } })).toBe('B1');
    expect(pab.bookingIdOf(null)).toBe('');
  });
});

describe('step 02, after the response', () => {
  const armed = (pass, target) => ({
    bookingPurchaserMode: 'invalid_at_booking',
    __purchaserAtBookingProbe: 'true',
    __purchaserAtBookingPass: String(pass),
    __purchaserAtBookingTarget: JSON.stringify(target),
  });

  test('not this probe, or not a probe pass: nothing graded, the flow goes on', () => {
    expect(withBru({ bookingPurchaserMode: 'invalid', __purchaserAtBookingProbe: 'true' }, () => pab.gradePurchaserAtBooking(400, {})).result).toBe(false);
    const clean = withBru({ bookingPurchaserMode: 'invalid_at_booking', __purchaserAtBookingProbe: 'false' }, () => pab.gradePurchaserAtBooking(200, {}));
    expect(clean.result).toBe(false);
    expect(clean.tests).toEqual([]);
  });

  test('a refusal with a Problem passes, and the next pass is sent', () => {
    const r = withBru(armed(0, { scenarioField: 'firstName' }), () => pab.gradePurchaserAtBooking(400, { code: 'MISSING', title: 'firstName required' }));
    expect(r.result).toBe(true);
    expect(r.tests.length).toBeGreaterThan(0);
    expect(r.tests.filter((t) => t[1] === 'fail')).toEqual([]);
    expect(r.tests[0][0]).toMatch(/Purchaser negative sweep in the booking \[purchaser\.firstName\]: provider rejects/);
    expect(r.next).toBe('02. POST Create Booking');
    expect(r.vars.__purchaserAtBookingPass).toBe('1');
    // Kept for the [OSCAR request] check, which runs after this script.
    expect(r.vars.__purchaserAtBookingProbe).toBe('true');
  });

  test('a missing name accepted fails, names the pre-booking, and the sweep goes on', () => {
    const r = withBru(armed(1, { scenarioField: 'lastName' }), () => pab.gradePurchaserAtBooking(200, { booking: { id: 'BK-9' } }));
    expect(r.tests.some((t) => t[1] === 'fail')).toBe(true);
    expect(r.logs.join('\n')).toMatch(/booked with the wrong 'lastName' \(booking BK-9\)/);
    expect(r.vars.__purchaserAtBookingPass).toBe('2');
    expect(r.next).toBe('02. POST Create Booking');
  });

  test('a wrong e-mail accepted is a WARNING, not a failure (an unconstrained string in OSDM)', () => {
    const r = withBru(armed(2, { scenarioField: 'email', value: 'not-an-email' }), () => pab.gradePurchaserAtBooking(200, {}));
    expect(r.tests).toEqual([]);
    expect(r.logs.join('\n')).toMatch(/\[WARNING\]/);
  });

  test('after the last pass, the booking goes with the valid purchaser', () => {
    const r = withBru(armed(pab.SWEEP.length - 1, { scenarioField: 'phoneNumber', value: 'not-a-phone' }), () => pab.gradePurchaserAtBooking(400, { code: 'X' }));
    expect(r.vars.__purchaserAtBookingPass).toBe('done');
    expect(r.next).toBe('02. POST Create Booking');
  });
});

describe('the booking request of each pass', () => {
  const base = {
    requiresPlaceSelection: 'false',
    accommodationSelection: 'NONE',
    api_base: 'https://x',
    bookingPassengerSpecifications: '[{"externalRef":"00001","detail":{"firstName":"John","lastName":"Doe"}}]',
    bookingPassengerReferences: '["00001"]',
    bookingPurchaserSpecifications: JSON.stringify(VALID),
    offerId: 'OFFER-1',
    bookingPurchaserMode: 'invalid_at_booking',
  };
  function build(vars) {
    const store = { ...base, ...vars };
    global.bru = { getEnvVar: (k) => store[k], setEnvVar: (k, v) => { store[k] = v; } };
    global.validationLogger = () => {};
    jest.isolateModules(() => require(path.join(LIB, 'requestsBuilder.js')).buildBookingRequest());
    delete global.bru;
    return { body: JSON.parse(store.BookingRequest), store };
  }

  test('the first pass leaves out the first name and arms the negative test', () => {
    const { body, store } = build({});
    expect(body.purchaser.detail).not.toHaveProperty('firstName');
    expect(body.purchaser.detail.lastName).toBe('Purchaser');
    expect(store.__purchaserAtBookingProbe).toBe('true');
    expect(JSON.parse(store.__purchaserAtBookingTarget)).toEqual({ scenarioField: 'firstName' });
  });

  test('the third pass sends a wrong e-mail', () => {
    expect(build({ __purchaserAtBookingPass: '2' }).body.purchaser.detail.contact.email).toBe('not-an-email');
  });

  test('once done, the valid purchaser, and no negative test', () => {
    const { body, store } = build({ __purchaserAtBookingPass: 'done' });
    expect(body.purchaser).toEqual(VALID);
    expect(store.__purchaserAtBookingProbe).toBe('false');
  });

  test('the other modes are unchanged: inline sends it, invalid leaves it out', () => {
    expect(build({ bookingPurchaserMode: 'inline' }).body.purchaser).toEqual(VALID);
    expect(build({ bookingPurchaserMode: 'invalid' }).body).not.toHaveProperty('purchaser');
  });
});

describe('the [OSCAR request] check', () => {
  const { negativeTestOf } = require(path.join(LIB, 'osdmRequestSchema.js'));
  const vars = (v) => (name) => v[name];

  test('a probe pass of the booking is a negative test; the clean booking is not', () => {
    expect(negativeTestOf({ method: 'POST', path: '/bookings' }, vars({ __purchaserAtBookingProbe: 'true' })))
      .toBe('purchaser negative sweep in the booking');
    expect(negativeTestOf({ method: 'POST', path: '/bookings' }, vars({ __purchaserAtBookingProbe: 'false' }))).toBeNull();
  });
});
