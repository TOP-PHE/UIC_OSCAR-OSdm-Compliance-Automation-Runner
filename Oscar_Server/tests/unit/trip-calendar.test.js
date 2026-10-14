// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #717: the days a scenario's trip can run, from its Test Data trains.
const path = require('node:path');
const { clockOf, matchLeg, tripCalendar, annotateTripCalendars } = require('../../src/utils/tripCalendar');
const { schemaProblems } = require('../../src/utils/datafileSchema');

const A = 'urn:uic:stn:7100001';
const B = 'urn:uic:stn:7100002';
const C = 'urn:uic:stn:7100003';
const train = (id, from, to, days, services, label = `T${id}`) => ({
  id, label, resource_type: 'TRAIN',
  data: JSON.stringify({ originURN: from, destinationURN: to, daysOfWeek: days, services }),
});
const svc = (vehicleNumber, departureTime, arrivalTime) => ({ vehicleNumber, departureTime, arrivalTime });
const resources = [
  train(1, A, B, ['MON', 'TUE', 'SUN'], [svc('R 1', '08:00:00+02:00', '08:50:00+02:00'), svc('R 3', '10:00:00+02:00', '10:50:00+02:00')]),
  train(2, B, C, ['SUN'], [svc('Os 2', '09:05:00+02:00', '09:40:00+02:00')]),
  train(3, B, C, [], [svc('Os 4', '11:00:00+02:00', '11:30:00+02:00')]),
  { id: 9, resource_type: 'JOURNEY', data: { legs: [] } },
];
const leg = (origin, destination, start, end, vehicleNumber) => ({
  origin, destination, startDatetime: `%TRIP_DATE%T${start}`, endDatetime: `%TRIP_DATE%T${end}`, vehicleNumber,
});
const texts = (r) => r.notes.map((n) => `${n.level}: ${n.text}`);

describe('clockOf', () => {
  test('the clock of any of the forms a trip stores', () => {
    expect(clockOf('%TRIP_DATE%T09:10:00+02:00')).toBe('09:10');
    expect(clockOf('2026-10-19T09:10:00')).toBe('09:10');
    expect(clockOf('09:10')).toBe('09:10');
    expect(clockOf('')).toBe('');
    expect(clockOf(undefined)).toBe('');
  });
});

describe('matchLeg', () => {
  const trains = resources.slice(0, 3).map((r) => ({ id: r.id, label: r.label, data: JSON.parse(r.data) }));
  test('by stop places (leading zeros ignored) and train number, else departure time', () => {
    expect(matchLeg({ origin: 'urn:uic:stn:007100001', destination: B, vehicleNumber: 'R 3' }, trains).service.vehicleNumber).toBe('R 3');
    const byTime = matchLeg({ origin: A, destination: B, startDatetime: '%TRIP_DATE%T08:00:00' }, trains);
    expect([byTime.service.vehicleNumber, byTime.by]).toEqual(['R 1', 'time']);
    expect(matchLeg({ origin: A, destination: C, vehicleNumber: 'R 1' }, trains)).toBeNull();
    expect(matchLeg({ origin: A, destination: B, vehicleNumber: 'X', startDatetime: '%TRIP_DATE%T07:00' }, trains)).toBeNull();
    expect(matchLeg({ destination: B }, trains)).toBeNull();
  });
});

describe('tripCalendar', () => {
  test('a SEARCH trip takes its train\'s days', () => {
    const r = tripCalendar({ tripType: 'SEARCH', trip: leg(A, B, '08:00:00', '08:50:00', 'R 1') }, resources);
    expect(r).toEqual({ operatingDays: ['MON', 'TUE', 'SUN'], notes: [] });
  });

  test('a SPECIFICATION runs on the days all its legs run', () => {
    const r = tripCalendar({ tripType: 'SPECIFICATION', legs: [leg(A, B, '08:00:00', '08:50:00', 'R 1'), leg(B, C, '09:05:00', '09:40:00', 'Os 2')] }, resources);
    expect(r).toEqual({ operatingDays: ['SUN'], notes: [] });
  });

  test('a train without calendar, or with no Test Data train, is named and not counted', () => {
    const r = tripCalendar({ tripType: 'SPECIFICATION', legs: [leg(A, B, '10:00:00', '10:50:00', 'R 3'), leg(B, C, '11:00:00', '11:30:00', 'Os 4')] }, resources);
    expect(r.operatingDays).toEqual(['MON', 'TUE', 'SUN']);
    expect(texts(r)).toEqual(['INFO: Train Os 4 (T3) has no calendar in Test Data: the days it runs are not checked. Test Data → Fill missing calendars asks the provider.']);
    const none = tripCalendar({ tripType: 'SEARCH', trip: leg(A, C, '08:00:00', '09:00:00', 'Z') }, resources);
    expect(none.operatingDays).toBeNull();
    expect(texts(none)).toEqual(['INFO: No Test Data train matches the trip 7100001 → 7100003: the days it runs are not checked.']);
  });

  test('legs with no day in common, a time that is not the train\'s, legs that do not connect', () => {
    const r = tripCalendar({ tripType: 'SPECIFICATION', legs: [
      leg(A, B, '08:05:00', '08:50:00', 'R 1'),
      leg(C, B, '08:30:00', '09:00:00', 'nope'),
      leg(B, C, '09:05:00', '09:40:00', 'Os 2'),
    ] }, resources);
    expect(texts(r)).toEqual([
      'WARNING: Leg 2 starts at 7100003, but leg 1 ends at 7100002: the legs do not connect.',
      'WARNING: Leg 2 leaves at 08:30, before leg 1 arrives at 08:50.',
      'WARNING: Leg 1 (7100001 → 7100002) leaves at 08:05, but train R 1 (T1) leaves at 08:00 in Test Data.',
      'INFO: No Test Data train matches leg 2 (7100003 → 7100002): the days it runs are not checked.',
    ]);
    expect(r.operatingDays).toEqual(['SUN']);
    const apart = tripCalendar({ tripType: 'SPECIFICATION', legs: [leg(A, B, '06:00', '07:00', 'R 5'), leg(B, C, '09:05', '09:40', 'Os 2')] },
      resources.concat([train(4, A, B, ['MON'], [svc('R 5', '06:00', '07:00')])]));
    expect(apart.operatingDays).toEqual([]);
    expect(texts(apart).at(-1)).toBe('WARNING: The trains of this trip have no day in common in Test Data: no date suits them all.');
  });

  test('a leg arriving after midnight does not make the next one early', () => {
    const r = tripCalendar({ tripType: 'SPECIFICATION', legs: [leg(A, B, '23:00:00', '00:30:00'), leg(B, C, '00:45:00', '01:30:00')] }, []);
    expect(texts(r).filter((t) => t.startsWith('WARNING'))).toEqual([]);
  });

  test('Test Data text never reaches the run as a template', () => {
    const r = tripCalendar({ tripType: 'SEARCH', trip: leg(A, B, '07:00', '08:00', '{{access_token}}') },
      [train(5, A, B, [], [svc('{{access_token}}', '07:00', '08:00')], '{{x}}')]);
    expect(JSON.stringify(r)).not.toContain('{{');
    expect(JSON.stringify(r)).not.toContain('}}');
  });
});

describe('annotateTripCalendars', () => {
  test('annotates the trips it knows something about, and leaves the rest', () => {
    const df = { tripRequirements: [
      { id: 1, tripType: 'SEARCH', trip: leg(A, B, '08:00:00', '08:50:00', 'R 1') },
      { id: 2, tripType: 'SEARCH', trip: {} },
      null,
    ] };
    expect(annotateTripCalendars(df, resources)).toBe(1);
    expect(df.tripRequirements[0].__operatingDays).toEqual(['MON', 'TUE', 'SUN']);
    expect(df.tripRequirements[0].__calendarNotes).toBeUndefined();
    expect(df.tripRequirements[1]).toEqual({ id: 2, tripType: 'SEARCH', trip: {} });
    expect(annotateTripCalendars({}, resources)).toBe(0);
  });

  test('the annotated file still passes the collection\'s schema check', () => {
    const schema = JSON.parse(require('node:fs').readFileSync(path.resolve(__dirname, '../../../Bruno_Collection/json_validator/datafile.schema.json'), 'utf8'));
    const df = JSON.parse(require('node:fs').readFileSync(path.resolve(__dirname, '../../../Bruno_Collection/data_base/simulator_datafile.json'), 'utf8'));
    const before = schemaProblems(df, schema);
    const trip = df.tripRequirements.find((t) => t.tripType === 'SEARCH');
    trip.__operatingDays = ['SUN'];
    trip.__calendarNotes = [{ level: 'INFO', text: 'x' }];
    expect(schemaProblems(df, schema)).toEqual(before);
  });
});
