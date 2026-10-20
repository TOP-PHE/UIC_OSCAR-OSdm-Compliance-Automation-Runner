// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #899: a provider that takes the purchaser only in the booking. A checklist
 * import reads question A5.1 into the framework (`purchaserAfterBooking`),
 * and the run's copy sends the invalid purchaser probe in the booking.
 */

const path = require('node:path');
const U = require('../../src/utils/undeclaredSteps');
const { frameworkFromChecklist, defaultFramework } = require('../../src/utils/referenceConfiguration');

const NONE_AFTER = { purchaserAfterBooking: false };
const scenarios = () => ({
  scenarios: [
    { code: 'A', bookingPurchaserMode: 'invalid' },
    { code: 'B', bookingPurchaserMode: ' INVALID ' },
    { code: 'C', bookingPurchaserMode: 'deferred' },
    { code: 'D', bookingPurchaserMode: 'inline' },
    { code: 'E' },
    null,
    { code: 'F', bookingPurchaserMode: 'invalid_at_booking' },
  ],
});

describe('the run\'s copy', () => {
  test('a provider taking no purchaser after the booking gets the invalid probe in the booking', () => {
    const datafile = scenarios();
    expect(U.withPurchaserProbeAtBooking(datafile, NONE_AFTER)).toBe(2);
    expect(datafile.scenarios.map((s) => s?.bookingPurchaserMode)).toEqual(
      ['invalid_at_booking', 'invalid_at_booking', 'deferred', 'inline', undefined, undefined, 'invalid_at_booking']);
  });

  test('a provider taking it afterwards, or saying nothing, keeps the probe after the booking', () => {
    for (const framework of [{}, { purchaserAfterBooking: true }, null]) {
      const datafile = scenarios();
      expect(U.withPurchaserProbeAtBooking(datafile, framework)).toBe(0);
      expect(datafile).toEqual(scenarios());
    }
    expect(U.withPurchaserProbeAtBooking({}, NONE_AFTER)).toBe(0);
    expect(U.withPurchaserProbeAtBooking(null, NONE_AFTER)).toBe(0);
  });

  test('the deferred scenario is still only warned, as before (#809)', () => {
    expect(U.undeclaredStepWarnings({ bookingPurchaserMode: 'deferred' }, NONE_AFTER)).toEqual(['purchaserAfterBooking']);
    expect(U.undeclaredStepWarnings({ bookingPurchaserMode: 'invalid' }, NONE_AFTER)).toEqual([]);
  });
});

describe('checklist question A5.1', () => {
  const tick = (code) => ({ [`data.purchaser=${code}`]: true });

  test('required in the booking, or not needed: none after the booking; later allowed: the default', () => {
    expect(frameworkFromChecklist(tick('AT_BOOKING')).purchaserAfterBooking).toBe(false);
    expect(frameworkFromChecklist(tick('NOT_NEEDED')).purchaserAfterBooking).toBe(false);
    expect(frameworkFromChecklist(tick('LATER_ALLOWED'))).toEqual(defaultFramework());
  });

  test('over a framework: the answer replaces what it said; no answer keeps it', () => {
    const base = { ...defaultFramework(), ...NONE_AFTER };
    expect(frameworkFromChecklist(tick('LATER_ALLOWED'), { base }).purchaserAfterBooking).toBeUndefined();
    expect(frameworkFromChecklist({}, { base }).purchaserAfterBooking).toBe(false);
    expect(frameworkFromChecklist({ 'data.purchaser=AT_BOOKING': false }, { base: defaultFramework() }).purchaserAfterBooking).toBeUndefined();
  });
});

describe('the data file schema', () => {
  test('takes the new mode', () => {
    const schema = require(path.join(__dirname, '..', '..', '..', 'Bruno_Collection', 'json_validator', 'datafile.schema.json'));
    const text = JSON.stringify(schema);
    expect(text).toContain('"invalid_at_booking"');
  });
});
