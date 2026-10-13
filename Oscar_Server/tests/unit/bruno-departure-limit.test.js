// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-departure-limit.test.js — #704: a scenario's own departure date, and
 * the probe that expects a past or too-far departure refused.
 */

const path = require('node:path');

const LIB = path.resolve(__dirname, '../../../Bruno_Collection/library-bruno');

function withBru(vars, fn) {
  const tests = [];
  const logs = [];
  const jestTest = global.test;
  global.bru = { getEnvVar: (k) => vars[k], setEnvVar: (k, v) => { vars[k] = v; }, deleteEnvVar: (k) => { delete vars[k]; } };
  global.test = (name, body) => {
    try { body(); tests.push([name, 'pass']); } catch (e) { tests.push([name, 'fail', e.message]); }
  };
  global.validationLogger = (m) => logs.push(m);
  try { return { result: fn(), tests, logs }; } finally {
    delete global.bru;
    global.test = jestTest;
  }
}

describe('the departure date of a scenario', () => {
  const { scenarioTripDate } = withBru({}, () => require(path.join(LIB, 'scenarioParser.js'))).result;
  // 23:30 UTC: already the next day east of Greenwich.
  const NOW = new Date('2026-10-11T23:30:00Z');

  test('days from today, on the UTC calendar, past and future', () => {
    const at = (n) => withBru({}, () => scenarioTripDate({ departureDaysFromToday: n }, '2026-10-20', null, NOW));
    expect(at(0).result).toBe('2026-10-11');
    expect(at(-1).result).toBe('2026-10-10');
    expect(at(90).result).toBe('2027-01-09');
    expect(at(91).result).toBe('2027-01-10');
    expect(at(-1).logs[0]).toMatch(/1 day\(s\) ago .* 2026-10-10/);
  });

  test('absent, not a whole number or out of range: the usual date', () => {
    for (const n of [undefined, null, '90', 2.5, -367, 1001]) {
      const r = withBru({}, () => scenarioTripDate({ departureDaysFromToday: n }, '2026-10-20', null, NOW));
      expect(r.result).toBe('2026-10-20');
    }
    expect(withBru({}, () => scenarioTripDate(null, '2026-10-20', null, NOW)).result).toBe('2026-10-20');
  });
});

describe('the departure-date probe', () => {
  const dl = require(path.join(LIB, 'departureLimit.js'));
  const armed = { departureExpectRejection: 'true', departureDaysFromToday: '91' };

  test('what the provider did, and the words for the date', () => {
    expect(dl.departureOutcome(400, {})).toBe('refused');
    expect(dl.departureOutcome(undefined, {})).toBe('refused');
    expect(dl.departureOutcome(200, { offers: [] })).toBe('no-offer');
    expect(dl.departureOutcome(200, {})).toBe('no-offer');
    expect(dl.departureOutcome(200, { offers: [{}] })).toBe('accepted');
    expect(dl.describeDays('-1')).toBe('1 day(s) ago');
    expect(dl.describeDays(91)).toBe('91 day(s) from today');
    expect(dl.describeDays(null)).toBe('a date the provider must not sell');
  });

  test('off: nothing is checked and the flow goes on', () => {
    const r = withBru({}, () => dl.checkDepartureRefused(400, {}));
    expect(r.result).toBe(false);
    expect(r.tests).toEqual([]);
  });

  test('refused with a Problem: passed, and the scenario ends', () => {
    const r = withBru({ ...armed, departureDaysFromToday: '-1' }, () => dl.checkDepartureRefused(400, { title: 'Past', detail: 'departed', code: 'DEPARTURE_IN_PAST' }));
    expect(r.result).toBe(true);
    expect(r.tests.length).toBeGreaterThan(0);
    expect(r.tests.filter((t) => t[1] === 'fail')).toEqual([]);
    expect(r.tests[0][0]).toMatch(/1 day\(s\) ago, POST \/offers.*client error/);
  });

  test('a 5xx is not a refusal the probe accepts', () => {
    const r = withBru({ ...armed }, () => dl.checkDepartureRefused(500, { title: 'Oops' }));
    expect(r.result).toBe(true);
    expect(r.tests.some((t) => t[1] === 'fail')).toBe(true);
  });

  test('no offer: passed, with the Problem named, or a warning when none says why', () => {
    const named = withBru({ ...armed }, () => dl.checkDepartureRefused(200, { offers: [], problems: [{ code: 'SALES_HORIZON_EXCEEDED' }] }));
    expect(named.result).toBe(true);
    expect(named.tests).toEqual([[expect.stringMatching(/91 day\(s\) from today.*no offer is given/), 'pass']]);
    expect(named.logs.join('\n')).toContain('SALES_HORIZON_EXCEEDED');
    const silent = withBru({ ...armed }, () => dl.checkDepartureRefused(200, { offers: [] }));
    expect(silent.logs.join('\n')).toMatch(/\[WARNING\].*no problem saying why/);
  });

  test('offers given: failed, and the scenario ends without a booking', () => {
    const r = withBru({ ...armed }, () => dl.checkDepartureRefused(200, { offers: [{}, {}] }));
    expect(r.result).toBe(true);
    expect(r.tests).toEqual([[expect.stringMatching(/no offer is given/), 'fail', 'POST /offers gave 2 offer(s) for a departure 91 day(s) from today']]);
  });

  test('step 01 asks the probe before the passenger-limit one, and ends the scenario on it', () => {
    const fs = require('node:fs');
    const yml = fs.readFileSync(path.resolve(__dirname, '../../../Bruno_Collection/02-Common Requests/01. POST Get Offer.yml'), 'utf8');
    const probe = yml.indexOf('departureLimit.js").checkDepartureRefused(res.getStatus(), _tripIdsBody)');
    expect(probe).toBeGreaterThan(0);
    expect(probe).toBeLessThan(yml.indexOf('checkOffersOverLimit('));
    expect(yml.slice(probe, probe + 300)).toMatch(/loopbackOrStop\("POST Get Offer \(departure date probe\)"\);\s*return;/);
  });
});
