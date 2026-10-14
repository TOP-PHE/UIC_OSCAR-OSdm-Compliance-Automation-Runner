// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-trip-calendar.test.js — #717: the run's date is a day the trip's
 * trains run, unless the scenario names the day.
 */

const path = require('node:path');

const LIB = path.resolve(__dirname, '../../../Bruno_Collection/library-bruno');
const { weekdayCode, dateForTrip } = require(path.join(LIB, 'tripCalendar.js'));

function withBru(vars, fn) {
  const logs = [];
  global.bru = { getEnvVar: (k) => vars[k], setEnvVar: (k, v) => { vars[k] = v; }, deleteEnvVar: (k) => { delete vars[k]; } };
  global.validationLogger = (m) => logs.push(m);
  try { return { result: fn(), logs }; } finally {
    delete global.bru;
  }
}

describe('weekdayCode', () => {
  test('the calendar day of a date', () => {
    expect(weekdayCode('2026-10-19')).toBe('MON');
    expect(weekdayCode('2026-10-25T23:30:00+02:00')).toBe('SUN');
    expect(weekdayCode('')).toBe('');
    expect(weekdayCode('soon')).toBe('');
  });
});

describe('dateForTrip', () => {
  const trip = (days, notes) => ({ __operatingDays: days, ...(notes ? { __calendarNotes: notes } : {}) });

  test('no annotation: the date stays and nothing is said', () => {
    expect(dateForTrip('2026-10-19', false, {})).toEqual({ date: '2026-10-19', lines: [] });
    expect(dateForTrip('2026-10-19', false, null)).toEqual({ date: '2026-10-19', lines: [] });
  });

  test('moves to the first following day the trains run', () => {
    const r = dateForTrip('2026-10-19', false, trip(['SAT', 'SUN']));
    expect(r.date).toBe('2026-10-24');
    expect(r.lines).toEqual(['[INFO] 📅 Departure 2026-10-24 (SAT), 5 day(s) after 2026-10-19: the first day the trip\'s trains run (SAT, SUN).']);
    expect(dateForTrip('2026-10-19', false, trip(['MON'])).date).toBe('2026-10-19');
    expect(dateForTrip('2026-12-31', false, trip(['FRI'])).date).toBe('2027-01-01');
  });

  test('a day the scenario names is kept, with a warning when the trains do not run', () => {
    const r = dateForTrip('2026-10-19', true, trip(['SUN']));
    expect(r.date).toBe('2026-10-19');
    expect(r.lines).toEqual(['[WARNING] 📅 Departure 2026-10-19 (MON) is the day the scenario names, but its trains run on SUN in Test Data: the provider may not offer them that day.']);
    expect(dateForTrip('2026-10-25', true, trip(['SUN'])).lines).toEqual([]);
  });

  test('no day in common, or no known day: the date stays', () => {
    expect(dateForTrip('2026-10-19', false, trip([])).date).toBe('2026-10-19');
    expect(dateForTrip('2026-10-19', false, trip(['XYZ'])).date).toBe('2026-10-19');
  });

  test('the server\'s notes are logged, at INFO unless they are warnings', () => {
    const r = dateForTrip('2026-10-19', false, trip(null, [{ level: 'WARNING', text: 'late' }, { level: 'ERROR', text: 'odd' }, { text: 3 }]));
    expect(r.lines).toEqual(['[WARNING] 📅 late', '[INFO] 📅 odd']);
  });
});

describe('tripDateFor in the parser', () => {
  const { tripDateFor } = withBru({}, () => require(path.join(LIB, 'scenarioParser.js'))).result;
  const NOW = new Date('2026-10-14T10:00:00Z');

  test('a trip of weekend trains runs at the weekend', () => {
    const r = withBru({}, () => tripDateFor({}, '2026-10-19', { __operatingDays: ['SAT', 'SUN'] }, NOW));
    expect(r.result).toBe('2026-10-24');
    expect(r.logs.join('\n')).toContain('the first day the trip\'s trains run');
  });

  test('"Departure day" and departureDaysFromToday are the scenario\'s own day', () => {
    const day = withBru({}, () => tripDateFor({}, '2026-10-19', { departureDay: 'TUESDAY', __operatingDays: ['SUN'] }, NOW));
    expect(day.result).toBe('2026-10-20');
    expect(day.logs.join('\n')).toContain('[WARNING] 📅 Departure 2026-10-20 (TUE) is the day the scenario names');
    const probe = withBru({}, () => tripDateFor({ departureDaysFromToday: -1 }, '2026-10-19', { __operatingDays: ['SUN'] }, NOW));
    expect(probe.result).toBe('2026-10-13');
  });

  test('a trip without annotation runs as before', () => {
    expect(withBru({}, () => tripDateFor({}, '2026-10-19', {}, NOW)).result).toBe('2026-10-19');
    expect(withBru({}, () => tripDateFor({}, '2026-10-19', { departureDay: 'FRIDAY' }, NOW)).result).toBe('2026-10-23');
  });
});

describe('the parser uses it for both kinds of trip', () => {
  test('SEARCH and SPECIFICATION dates go through tripDateFor', () => {
    const src = require('node:fs').readFileSync(path.join(LIB, 'scenarioParser.js'), 'utf8');
    expect(src.match(/= tripDateFor\(scenario, nextWeekdayString, tripRequirement\);/g)).toHaveLength(2);
    expect(src).not.toMatch(/= scenarioTripDate\(scenario, nextWeekdayString/);
  });
});
