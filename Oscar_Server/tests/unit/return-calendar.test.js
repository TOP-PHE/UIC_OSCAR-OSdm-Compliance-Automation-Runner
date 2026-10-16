// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * return-calendar.test.js — #778: a return scenario is dated on a day a train
 * goes back after the return time, and warned when none does.
 * Case from a real provider: the way back has one train, leaving at 14:05, not
 * on Thursdays; the scenarios asked for 17:00, two days after the outbound.
 */

const path = require('node:path');
const fs = require('node:fs');
const { returnServices, annotateTripCalendars } = require('../../src/utils/tripCalendar');
const { schemaProblems } = require('../../src/utils/datafileSchema');

const LIB = path.resolve(__dirname, '../../../Bruno_Collection/library-bruno');
const { returnDays, dateForTrip } = require(path.join(LIB, 'tripCalendar.js'));

const A = 'urn:uic:stn:8400058';
const H = 'urn:uic:stn:8000152';
const P = 'urn:uic:stn:5457076';
const NOT_THU = ['MON', 'TUE', 'WED', 'FRI', 'SAT', 'SUN'];
const train = (id, from, to, days, services) => ({
  id, label: `T${id}`, resource_type: 'TRAIN',
  data: JSON.stringify({ originURN: from, destinationURN: to, daysOfWeek: days, services }),
});
const svc = (vehicleNumber, departureTime) => ({ vehicleNumber, departureTime, arrivalTime: '23:00:00+02:00' });
const resources = [
  train(1, A, H, [], [svc('21', '08:00:00+02:00')]),
  train(2, H, A, NOT_THU, [svc('20', '14:05:00+02:00')]),
  train(3, P, H, ['SAT'], [svc('20', '08:00:00+02:00'), svc('22', '06:00:00+02:00')]),
  train(4, P, H, [], [svc('24', '18:00:00+02:00')]),
];
const search = (from, to, start) => ({ tripType: 'SEARCH', trip: { origin: from, destination: to, startDatetime: `%TRIP_DATE%T${start}` } });

describe('server: returnServices', () => {
  test('the services of the way back, with the days their train runs, in departure order', () => {
    expect(returnServices(search(A, H, '08:00:00'), resources)).toEqual([{ departure: '14:05', number: '20', days: NOT_THU }]);
    expect(returnServices(search(H, P, '14:50:00'), resources)).toEqual([
      { departure: '06:00', number: '22', days: ['SAT'] },
      { departure: '08:00', number: '20', days: ['SAT'] },
      { departure: '18:00', number: '24' },
    ]);
  });

  test('a SPECIFICATION goes back from its last stop place to its first', () => {
    const spec = { tripType: 'SPECIFICATION', legs: [
      { origin: 'urn:uic:stn:8600626', destination: H, startDatetime: '%TRIP_DATE%T07:00:00' },
      { origin: H, destination: A, startDatetime: '%TRIP_DATE%T14:05:00' },
    ] };
    expect(returnServices(spec, resources)).toEqual([]);
    spec.legs[0].origin = P;
    expect(returnServices({ ...spec, legs: [spec.legs[0], { origin: H, destination: H }] }, resources)).toEqual([]);
    expect(returnServices({ tripType: 'SPECIFICATION', legs: [{ origin: A, destination: P }, { origin: P, destination: H }] }, resources).map((s) => s.number)).toEqual(['20']);
  });

  test('no way back known: nothing, and the trip is annotated as before', () => {
    expect(returnServices(search(A, P, '08:00:00'), resources)).toEqual([]);
    expect(returnServices({ tripType: 'SEARCH', trip: {} }, resources)).toEqual([]);
    const df = { tripRequirements: [search(A, P, '08:00:00')] };
    annotateTripCalendars(df, resources);
    expect(df.tripRequirements[0].__returnServices).toBeUndefined();
    expect(df.tripRequirements[0].__calendarNotes).toHaveLength(1);
  });

  test('annotateTripCalendars adds __returnServices, and Test Data text is never a template', () => {
    const df = { tripRequirements: [search(A, H, '08:00:00')] };
    const withTemplate = [...resources, train(5, H, A, ['MON'], [svc('{{x}}', '16:00:00+02:00')])];
    expect(annotateTripCalendars(df, withTemplate)).toBe(1);
    expect(df.tripRequirements[0].__returnServices.map((s) => s.number)).toEqual(['20', '{ {x} }']);
  });

  test('the annotated file still passes the collection\'s schema check', () => {
    const schema = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../Bruno_Collection/json_validator/datafile.schema.json'), 'utf8'));
    const df = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../Bruno_Collection/data_base/simulator_datafile.json'), 'utf8'));
    const before = schemaProblems(df, schema);
    df.tripRequirements.find((t) => t.tripType === 'SEARCH').__returnServices = [{ departure: '14:05', number: '20', days: ['MON'] }];
    expect(schemaProblems(df, schema)).toEqual(before);
  });
});

describe('collection: returnDays', () => {
  const trip = { __returnServices: [{ departure: '14:05', number: '20', days: NOT_THU }] };

  test('the days of the services leaving at or after the return time', () => {
    expect(returnDays(trip, { offsetDays: 2, time: '14:00' })).toEqual({ days: NOT_THU, offset: 2, at: '14:00', lines: [] });
    expect(returnDays(trip, { offsetDays: '2', outboundClock: '%TRIP_DATE%T08:00:00+02:00' }).at).toBe('08:00');
  });

  test('no train back after the return time: a warning naming the times, nothing checked', () => {
    const r = returnDays(trip, { offsetDays: 2, time: '17:00' });
    expect(r.days).toBeNull();
    expect(r.lines).toEqual(['[WARNING] 📅 Return at 17:00: no Test Data train goes back after that time (they leave at 14:05 (20)). The provider may find no return trip: set the scenario\'s return time before the last one.']);
  });

  test('a one-way scenario, no way back known, or a train back without calendar: nothing checked', () => {
    const none = { days: null, offset: 0, at: '', lines: [] };
    expect(returnDays(trip, { offsetDays: undefined, time: '14:00' })).toEqual(none);
    expect(returnDays(trip, null)).toEqual(none);
    expect(returnDays({}, { offsetDays: 2 })).toEqual(none);
    expect(returnDays({ __returnServices: [{ departure: '14:05' }] }, { offsetDays: 2, time: '14:00' }).days).toBeNull();
    expect(returnDays({ __returnServices: [{ departure: 'soon' }] }, { offsetDays: 2 })).toEqual(none);
  });
});

describe('collection: dateForTrip with a return', () => {
  const trip = (out) => ({ ...(out ? { __operatingDays: out } : {}), __returnServices: [{ departure: '14:05', number: '20', days: NOT_THU }] });
  const ret = { offsetDays: 2, time: '14:00' };

  test('an outbound on Tuesday would come back on Thursday: it moves to Wednesday', () => {
    const r = dateForTrip('2026-10-20', false, trip(null), ret);
    expect(r.date).toBe('2026-10-21');
    expect(r.lines).toEqual(['[INFO] 📅 Departure 2026-10-21 (WED), 1 day(s) after 2026-10-20, return 2026-10-23 (FRI) after 14:00: the first such pair of days the trains run.']);
  });

  test('both calendars together: the outbound days are kept', () => {
    // Outbound on Tuesday or Thursday only, back two days later not on Thursday: Thursday.
    expect(dateForTrip('2026-10-20', false, trip(['TUE', 'THU']), ret).date).toBe('2026-10-22');
    const ok = dateForTrip('2026-10-19', false, trip(['MON']), ret);
    expect(ok.date).toBe('2026-10-19');
    expect(ok.lines[0]).toContain('the trains run on both days');
  });

  test('no pair of days: a warning, and the date stays', () => {
    const r = dateForTrip('2026-10-20', false, trip(['TUE']), ret);
    expect(r.date).toBe('2026-10-20');
    expect(r.lines).toEqual(['[WARNING] 📅 No day suits both the outbound trains and the trains going back 2 day(s) later after 14:00 (MON, TUE, WED, FRI, SAT, SUN) in Test Data.']);
  });

  test('a day the scenario names is kept, with a warning when no train goes back', () => {
    const r = dateForTrip('2026-10-20', true, trip(['MON']), ret);
    expect(r.date).toBe('2026-10-20');
    expect(r.lines).toEqual([
      '[WARNING] 📅 Departure 2026-10-20 (TUE) is the day the scenario names, but its trains run on MON in Test Data: the provider may not offer them that day.',
      '[WARNING] 📅 Return 2026-10-22 (THU) follows the day the scenario names, but the trains going back after 14:00 run on MON, TUE, WED, FRI, SAT, SUN in Test Data: the provider may find no return trip.',
    ]);
    expect(dateForTrip('2026-10-19', true, trip(null), ret).lines).toEqual([]);
  });

  test('the return time too late: the outbound rule only, plus the warning', () => {
    const r = dateForTrip('2026-10-19', false, trip(['SAT']), { offsetDays: 2, time: '17:00' });
    expect(r.date).toBe('2026-10-24');
    expect(r.lines[0]).toContain('[WARNING] 📅 Return at 17:00');
    expect(r.lines[1]).toContain('the first day the trip\'s trains run');
  });

  test('a one-way scenario is dated as before', () => {
    expect(dateForTrip('2026-10-20', false, trip(null), { offsetDays: null })).toEqual({ date: '2026-10-20', lines: [] });
    expect(dateForTrip('2026-10-20', false, trip(null))).toEqual({ date: '2026-10-20', lines: [] });
  });
});

describe('collection: tripDateFor passes the scenario\'s return', () => {
  function withBru(fn) {
    const logs = [];
    const vars = {};
    global.bru = { getEnvVar: (k) => vars[k], setEnvVar: (k, v) => { vars[k] = v; }, deleteEnvVar: (k) => { delete vars[k]; } };
    global.validationLogger = (m) => logs.push(m);
    try { return { result: fn(), logs }; } finally { delete global.bru; }
  }
  const { tripDateFor } = withBru(() => require(path.join(LIB, 'scenarioParser.js'))).result;
  const NOW = new Date('2026-10-14T10:00:00Z');
  const back = [{ departure: '14:05', number: '20', days: NOT_THU }];

  test('a SEARCH return with its return time', () => {
    const scenario = { offerSearchCriteria: { returnOffsetDays: 2, returnTime: '14:00' } };
    const r = withBru(() => tripDateFor(scenario, '2026-10-20', { ...search(A, H, '08:00:00+02:00'), __returnServices: back }, NOW));
    expect(r.result).toBe('2026-10-21');
  });

  test('without a return time, the outbound time is the return time', () => {
    const scenario = { offerSearchCriteria: { returnOffsetDays: 2 } };
    const late = { ...search(A, H, '17:00:00+02:00'), __returnServices: back };
    const r = withBru(() => tripDateFor(scenario, '2026-10-20', late, NOW));
    expect(r.result).toBe('2026-10-20');
    expect(r.logs.join('\n')).toContain('[WARNING] 📅 Return at 17:00');
  });

  test('a SPECIFICATION takes the time of its first leg; a one-way scenario is unchanged', () => {
    const spec = { tripType: 'SPECIFICATION', legs: [{ origin: A, destination: H, startDatetime: '%TRIP_DATE%T08:00:00+02:00' }], __returnServices: back };
    expect(withBru(() => tripDateFor({ offerSearchCriteria: { returnOffsetDays: 2 } }, '2026-10-20', spec, NOW)).result).toBe('2026-10-21');
    expect(withBru(() => tripDateFor({}, '2026-10-20', spec, NOW)).result).toBe('2026-10-20');
  });
});
