// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-passenger-ages.test.js — #705: passengers on the edges of the age
 * ranges, their dates of birth worked out from the day of travel, and the
 * passenger type the chosen offer applies.
 */

const path = require('node:path');
const fs = require('node:fs');

const LIB = path.resolve(__dirname, '../../../Bruno_Collection/library-bruno');

function withBru(vars, fn) {
  const tests = [];
  const logs = [];
  const jestTest = global.test;
  global.bru = { getEnvVar: (k) => vars[k], setEnvVar: (k, v) => { vars[k] = v; } };
  global.test = (name, body) => {
    try { body(); tests.push([name, 'pass']); } catch (e) { tests.push([name, 'fail', e.message]); }
  };
  global.validationLogger = (m) => logs.push(m);
  try { return { result: fn(), tests, logs }; } finally {
    delete global.bru;
    global.test = jestTest;
  }
}

const ages = require(path.join(LIB, 'passengerAges.js'));

describe('the date of birth from the age on the day of travel', () => {
  const born = (years, after, day = '2026-11-20') => ages.birthDateFor({ bornYearsBeforeTravel: years, bornDaysAfter: after }, day);

  test('whole years before, and days after', () => {
    expect(born(15, undefined)).toBe('2011-11-20');
    expect(born(15, 1)).toBe('2011-11-21');
    expect(born(26, 0)).toBe('2000-11-20');
    expect(born(0, 0)).toBe('2026-11-20');
    expect(born(15, 1, '2026-12-31')).toBe('2012-01-01');
  });

  test('a 29 February the year of birth lacks becomes the 28th', () => {
    expect(born(15, undefined, '2028-02-29')).toBe('2013-02-28');
    expect(born(16, undefined, '2028-02-29')).toBe('2012-02-29');
  });

  test('nothing without a whole number of years in range, or a day', () => {
    for (const years of [undefined, null, '15', 1.5, -1, 121]) expect(born(years, 0)).toBeNull();
    expect(born(15, 0, null)).toBeNull();
    expect(born(15, 0, '20/11/2026')).toBeNull();
    expect(born(15, 400)).toBe('2011-11-20');
  });
});

describe('the passenger types applied by the chosen offer', () => {
  const part = (ref, type, amount) => ({
    passengerRefs: [ref],
    price: { amount },
    ...(type ? { appliedPassengerTypes: [{ passengerRef: ref, type }] } : {}),
  });
  const expected = [{ ref: 'c', type: 'CHILD' }, { ref: 'y', type: 'YOUTH' }, { ref: 'a', type: 'ADULT' }];

  test('who names a type to check', () => {
    expect(ages.expectedTypesOf([
      { reference: 'c', expectedPassengerType: 'CHILD' }, { reference: 'x' }, { reference: 'z', expectedPassengerType: '' }, null,
    ])).toEqual([{ ref: 'c', type: 'CHILD' }]);
  });

  test('each passenger priced as its type: passed', () => {
    const offer = { admissionOfferParts: [part('c', 'CHILD', 50), part('y', 'YOUTH', 75), part('a', 'ADULT', 100)] };
    const checks = ages.checkAppliedTypes(offer, expected);
    expect(checks.map(c => [c.ok, c.level])).toEqual([[true, 'fail'], [true, 'fail'], [true, 'fail']]);
    expect(checks[0].name).toBe('Offer: passenger c is priced as CHILD — applied: CHILD');
    expect(ages.compareWithAdult(offer, expected).map(c => c.ok)).toEqual([true, true]);
  });

  test('another type: failed; none given: a warning', () => {
    const offer = { admissionOfferParts: [part('c', 'YOUTH', 75), part('y', null, 75), part('a', 'ADULT', 100)] };
    const [child, youth] = ages.checkAppliedTypes(offer, expected);
    expect(child).toMatchObject({ ok: false, level: 'fail', message: 'passenger c is priced as YOUTH, not CHILD' });
    expect(youth).toMatchObject({ ok: false, level: 'warn' });
  });

  test('a younger passenger not cheaper than the adult: a warning line, not a check', () => {
    const offer = { admissionOfferParts: [part('c', 'CHILD', 100), part('y', 'YOUTH', 75), part('a', 'ADULT', 100)] };
    const [child] = ages.compareWithAdult(offer, expected);
    expect(child).toEqual({ ok: false, text: 'passenger c (CHILD) pays 100, the adult a 100: not less (a commercial choice, not an OSDM rule)' });
    expect(ages.compareWithAdult(offer, [{ ref: 'c', type: 'CHILD' }])).toEqual([]);
  });

  test('glue: nothing without expected types; tests and warnings with them', () => {
    expect(withBru({ __expectedPassengerTypes: '[]' }, () => ages.checkOfferAges()).tests).toEqual([]);
    const offer = { admissionOfferParts: [part('c', 'CHILD', 50), part('y', null, 75), part('a', 'ADULT', 100)] };
    const r = withBru({ __expectedPassengerTypes: JSON.stringify(expected), offer }, () => ages.checkOfferAges());
    expect(r.tests.map(t => t[1])).toEqual(['pass', 'pass']);
    expect(r.logs.join('\n')).toMatch(/\[WARNING\] Offer: passenger y is priced as YOUTH — no admission of passenger y gives appliedPassengerTypes/);
    expect(r.logs.join('\n')).toMatch(/\[INFO\] Prices by age: passenger c \(CHILD\) pays 50, the adult a 100/);
  });

  test('step 01 runs the check once the offer is chosen, and the parser fills both variables, reset per scenario', () => {
    const yml = fs.readFileSync(path.resolve(__dirname, '../../../Bruno_Collection/02-Common Requests/01. POST Get Offer.yml'), 'utf8');
    expect(yml.indexOf('passengerAges.js").checkOfferAges()')).toBeGreaterThan(yml.indexOf('checkOfferLegClasses(jsonData)'));
    const parser = fs.readFileSync(path.join(LIB, 'scenarioParser.js'), 'utf8');
    expect(parser.match(/bru\.setEnvVar\("__travelDay", _(spec|search)TripDate\)/g)).toHaveLength(2);
    expect(parser).toContain('bru.setEnvVar("__expectedPassengerTypes", JSON.stringify(expectedTypesOf(passengersList.passengers)));');
    const oc = fs.readFileSync(path.resolve(LIB, '../opencollection.yml'), 'utf8');
    for (const text of [parser, oc]) {
      expect(text).toContain('"__travelDay"');
      expect(text).toContain('"__expectedPassengerTypes"');
    }
  });
});
