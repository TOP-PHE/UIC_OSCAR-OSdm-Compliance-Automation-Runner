// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #813: does the provider offer a Test Data journey? The pure part.

const { journeyPlan, probeDates, compareAnswer, probeSummary, collectOfferedTrips, tripToKeep, clock } = require('../../src/services/journeyProbe');

const A = 'urn:uic:stn:5454212';
const B = 'urn:uic:stn:5454300';
const C = 'urn:uic:stn:5400014';

const trains = [
  { id: 't1', resource_type: 'TRAIN', data: { originURN: A, destinationURN: B, daysOfWeek: ['MON', 'TUE', 'WED'], services: [{ vehicleNumber: '1061', departureTime: '04:05:00+02:00', arrivalTime: '04:38:00+02:00' }] } },
  { id: 't2', resource_type: 'TRAIN', data: { originURN: B, destinationURN: C, daysOfWeek: ['TUE', 'WED', 'THU'], services: [{ vehicleNumber: 'R 9', departureTime: '05:00:00', arrivalTime: '06:10:00' }] } },
  { id: 't3', resource_type: 'TRAIN', data: { originURN: B, destinationURN: C, services: [{ vehicleNumber: '7' }] } },
];
const journey = { id: 'j1', resource_type: 'JOURNEY', data: { legs: [{ trainResourceId: 't1', serviceIndex: 0 }, { trainResourceId: 't2', serviceIndex: 0 }] } };

// A provider's trip, legs as [origin, destination, number, dep, arr].
const tripOn = (date, ...legs) => ({ legs: legs.map(([o, d, n, dep, arr]) => ({ timedLeg: {
  start: { stopPlaceRef: o, serviceDeparture: { timetabledTime: `${date}T${dep}:00+02:00` } },
  end: { stopPlaceRef: d, serviceArrival: { timetabledTime: `${date}T${arr}:00+02:00` } },
  service: { vehicleNumbers: [n] } } })) });
const trip = (...legs) => tripOn('2026-10-20', ...legs);

describe('journeyPlan', () => {
  test('legs from Test Data, times to the minute, days all trains run', () => {
    const plan = journeyPlan(journey, trains);
    expect(plan.legs).toEqual([
      { origin: A, destination: B, departure: '04:05', arrival: '04:38', vehicleNumber: '1061' },
      { origin: B, destination: C, departure: '05:00', arrival: '06:10', vehicleNumber: 'R 9' },
    ]);
    expect(plan.missingLegs).toBe(0);
    expect(plan.days).toEqual(['TUE', 'WED']);
  });

  test('a set without days runs every day; a missing set is counted', () => {
    const j = { data: { legs: [{ trainResourceId: 't3' }, { trainResourceId: 'gone' }] } };
    const plan = journeyPlan(j, trains);
    expect(plan.legs).toHaveLength(1);
    expect(plan.missingLegs).toBe(1);
    expect(plan.days).toBeNull();
  });
});

describe('probeDates', () => {
  test('the next three days the journey runs, from today', () => {
    // 2026-10-17 is a Saturday.
    expect(probeDates(['TUE', 'WED'], new Date('2026-10-17T10:00:00Z'))).toEqual(['2026-10-20', '2026-10-21', '2026-10-27']);
    expect(probeDates(null, new Date('2026-10-17T23:30:00Z'))).toEqual(['2026-10-17', '2026-10-18', '2026-10-19']);
    expect(probeDates([], new Date('2026-10-17T10:00:00Z'))).toEqual([]);
  });
});

describe('compareAnswer', () => {
  const legs = journeyPlan(journey, trains).legs;

  test('found: same stop places (leading zeros aside), numbers and times', () => {
    const r = compareAnswer(legs, { trips: [
      trip([A, B, '1062', '04:05', '04:38']),
      trip(['urn:uic:stn:05454212', B, '1061', '04:05', '04:38'], [B, 'x:5400014', 'R9', '05:00', '06:10']),
    ] });
    expect(r.outcome).toBe('found');
    expect(r.trips).toBe(2);
  });

  test('differences: the closest trip of as many legs, and what differs', () => {
    const r = compareAnswer(legs, { trips: [
      trip([A, B, '1061', '04:05', '04:38'], [B, C, 'R 11', '05:20', '06:10']),
      trip([A, C, '99', '04:00', '07:00']),
    ] });
    expect(r.outcome).toBe('differences');
    expect(r.differences).toEqual(['leg 2 is train R 11, not R 9', 'leg 2 leaves at 05:20, not 05:00']);
    expect(r.offered[0]).toBe('5454212 → 5454300 (1061, 04:05–04:38) · 5454300 → 5400014 (R 11, 05:20–06:10)');
    expect(r.offered).toHaveLength(2);
  });

  test('notFound: no trip with as many legs, or none at all', () => {
    const r = compareAnswer(legs, { trips: [trip([A, C, '99', '04:00', '07:00'])] });
    expect(r).toMatchObject({ outcome: 'notFound', differences: [], offered: ['5454212 → 5400014 (99, 04:00–07:00)'], trips: 1 });
    expect(r.candidates).toHaveLength(1);
    expect(compareAnswer(legs, {}).outcome).toBe('notFound');
    expect(compareAnswer(legs, null).trips).toBe(0);
  });

  test('an intermediate stop place named otherwise is a difference', () => {
    const r = compareAnswer(legs, { trips: [trip([A, 'urn:uic:stn:5454399', '1061', '04:05', '04:38'], ['urn:uic:stn:5454399', C, 'R 9', '05:00', '06:10'])] });
    expect(r.differences).toEqual(['leg 1 goes to 5454399, not 5454300', 'leg 2 leaves from 5454399, not 5454300']);
  });
});

describe('probeSummary and clock', () => {
  test('one line over the days', () => {
    expect(probeSummary([{ error: 'HTTP 500' }])).toMatch(/answered no search/);
    expect(probeSummary([{ outcome: 'found' }, { outcome: 'found' }])).toBe('Offered on every day searched (2).');
    expect(probeSummary([{ outcome: 'found' }, { outcome: 'notFound' }])).toBe('Offered on 1 of 2 day(s) searched.');
    expect(probeSummary([{ outcome: 'differences' }, { outcome: 'notFound' }])).toMatch(/close trip differs/);
    expect(probeSummary([{ outcome: 'notFound' }])).toMatch(/^Not offered: no trip/);
  });

  test('clock reads a time or a date-time', () => {
    expect(clock('04:05:00+02:00')).toBe('04:05');
    expect(clock('2026-10-20T23:59:00Z')).toBe('23:59');
    expect(clock('')).toBe('');
  });
});

describe('collectOfferedTrips (#815)', () => {
  const legs = journeyPlan(journey, trains).legs;
  const other = (date) => tripOn(date, [A, B, '1061', '04:05', '04:38'], [B, C, 'R 11', '05:20', '06:10']);
  const day = (date, answer) => ({ date, ...compareAnswer(legs, answer) });

  test('each trip once, with the weekdays and dates it was offered; candidates taken out', () => {
    const days = [
      day('2026-10-20', { trips: [other('2026-10-20')] }),
      day('2026-10-21', { trips: [other('2026-10-21'), trip([A, C, '99', '04:00', '07:00'])] }),
      { date: '2026-10-22', error: 'HTTP 500' },
    ];
    const offered = collectOfferedTrips(days);
    expect(days.every((d) => !('candidates' in d))).toBe(true);
    expect(offered).toHaveLength(2);
    expect(offered[0]).toMatchObject({ text: '5454212 → 5454300 (1061, 04:05–04:38) · 5454300 → 5400014 (R 11, 05:20–06:10)', days: ['TUE', 'WED'], dates: ['2026-10-20', '2026-10-21'], asDefined: false });
    expect(offered[0].legs[1]).toMatchObject({ originURN: B, destinationURN: C, vehicleNumber: 'R 11', departureTime: '05:20:00+02:00' });
    expect(offered[0].legs[0]).not.toHaveProperty('dayOfWeek');
  });

  test('a trip as defined is marked', () => {
    const offered = collectOfferedTrips([day('2026-10-20', { trips: [trip([A, B, '1061', '04:05', '04:38'], [B, C, 'R 9', '05:00', '06:10'])] })]);
    expect(offered[0].asDefined).toBe(true);
  });
});

describe('tripToKeep (#815)', () => {
  const leg = { originURN: A, destinationURN: B, vehicleNumber: '1061', departureTime: '04:05:00', arrivalTime: '04:38:00' };

  test('one record per leg and weekday, in weekday order, unknown days dropped', () => {
    const r = tripToKeep({ legs: [leg, { ...leg, originURN: B, destinationURN: C, departureTime: '05:00', arrivalTime: '06:00' }], days: ['WED', 'MON', 'XYZ'] });
    expect(r.days).toEqual(['MON', 'WED']);
    expect(r.records).toHaveLength(4);
    expect(r.records[0]).toMatchObject({ ...leg, dayOfWeek: 'MON', operatorCode: '' });
  });

  test.each([
    [{ legs: [], days: ['MON'] }, /1 to 5 legs/],
    [{ legs: [leg, leg, leg, leg, leg, leg], days: ['MON'] }, /1 to 5 legs/],
    [{ legs: [leg], days: [] }, /at least one weekday/],
    [{ legs: ['x'], days: ['MON'] }, /not an object/],
    [{ legs: [{ ...leg, vehicleNumber: 7 }], days: ['MON'] }, /vehicleNumber is not text/],
    [{ legs: [{ ...leg, originName: 'x'.repeat(201) }], days: ['MON'] }, /longer than 200/],
    [{ legs: [{ ...leg, originName: '{{access_token}}' }], days: ['MON'] }, /holds "\{\{"/],
    [{ legs: [{ ...leg, originURN: '' }], days: ['MON'] }, /no stop place/],
    [{ legs: [{ ...leg, arrivalTime: 'soon' }], days: ['MON'] }, /no departure or arrival time/],
    [null, /1 to 5 legs/],
  ])('refuses %#', (body, message) => {
    expect(tripToKeep(body).error).toMatch(message);
  });
});
