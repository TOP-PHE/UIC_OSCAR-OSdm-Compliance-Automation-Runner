'use strict';

// #711: the journey planner over Test Data's train sets (public/js/journey-planner.js).
const { planJourneys, stopKey, parseTime, commonDays } = require('../../public/js/journey-planner.js');

const train = (id, origin, destination, services, extra = {}) => ({
  id, label: `T${id}`, resource_type: 'TRAIN',
  data: JSON.stringify({ originURN: origin, destinationURN: destination, services, ...extra }),
});
const svc = (vehicleNumber, departureTime, arrivalTime) => ({ vehicleNumber, departureTime, arrivalTime });

const A = 'urn:uic:stn:1000001';
const B = 'urn:uic:stn:1000002';
const C = 'urn:uic:stn:1000003';
const D = 'urn:uic:stn:1000004';

describe('stopKey', () => {
  test('a code with or without its leading zeros or its urn is the same place', () => {
    expect(stopKey('urn:uic:stn:005457076')).toBe(stopKey('urn:uic:stn:5457076'));
    expect(stopKey('5457076')).toBe(stopKey('URN:UIC:STN:5457076'));
    expect(stopKey('urn:uic:stn:0')).toBe('urn:uic:stn:0');
    expect(stopKey('')).toBe('');
    expect(stopKey('urn:uic:stn:5457076')).not.toBe(stopKey('urn:uic:stn:5457077'));
  });
});

describe('parseTime', () => {
  test('reads the clock and UTC', () => {
    expect(parseTime('09:10:00+02:00')).toEqual({ local: 550, utc: 430 });
    expect(parseTime('09:10')).toEqual({ local: 550, utc: 550 });
    expect(parseTime('23:59:59Z')).toEqual({ local: 1439, utc: 1439 });
    expect(parseTime('01:00-0130')).toEqual({ local: 60, utc: 150 });
    expect(parseTime('09:10z')).toEqual({ local: 550, utc: 550 });
    expect(parseTime('09:10+2')).toBeNull();
    expect(parseTime('09:10 CET')).toBeNull();
    expect(parseTime('24:00')).toBeNull();
    expect(parseTime('')).toBeNull();
    expect(parseTime('2026-10-14T09:10')).toBeNull();
  });
});

describe('commonDays', () => {
  test('null is every day', () => {
    expect(commonDays(null, ['MON'])).toEqual(['MON']);
    expect(commonDays(['MON', 'TUE'], ['TUE'])).toEqual(['TUE']);
    expect(commonDays(['MON'], ['SUN'])).toEqual([]);
    expect(commonDays(null, null)).toBeNull();
  });
});

describe('planJourneys', () => {
  const resources = [
    train(1, A, B, [svc('1', '08:00', '09:00'), svc('2', '10:00', '11:00')]),
    train(2, 'urn:uic:stn:001000002', C, [svc('3', '09:03', '09:30'), svc('4', '09:20', '10:00'), svc('5', '13:30', '14:00')]),
    train(3, C, D, [svc('6', '10:10', '11:00')]),
    train(4, B, D, [svc('7', '11:10', '12:30')]),
    { id: 9, resource_type: 'JOURNEY', data: { legs: [] } },
  ];

  test('chains legs at a shared stop place, with the transfer time and the maximum wait', () => {
    const r = planJourneys(resources, A, C);
    expect(r.error).toBeUndefined();
    // 08:00 A→B 09:00, then 09:20 B→C (09:03 is too short; 13:30 is too long a wait after 09:00; after 11:00 it is 150 min, kept).
    expect(r.journeys.map((j) => j.steps.map((s) => s.vehicleNumber).join('+'))).toEqual(['1+4', '2+5']);
    const [first] = r.journeys;
    expect(first.legs).toEqual([{ trainResourceId: 1, serviceIndex: 0 }, { trainResourceId: 2, serviceIndex: 1 }]);
    expect(first.waits).toEqual([20]);
    expect(first.durationMinutes).toBe(120);
    expect(first.via).toEqual(['urn:uic:stn:001000002']);
    expect(first.days).toBeNull();
  });

  test('finds three legs, sorted by duration, and keeps the minimum number of legs', () => {
    const r = planJourneys(resources, A, D);
    expect(r.journeys.map((j) => j.steps.map((s) => s.vehicleNumber).join('+'))).toEqual(['2+7', '1+4+6', '1+7']);
    expect(planJourneys(resources, A, D, { maxLegs: 2 }).journeys.map((j) => j.legs.length)).toEqual([2, 2]);
    // A direct train is not a journey unless one leg is allowed.
    expect(planJourneys(resources, A, B).journeys).toEqual([]);
    expect(planJourneys(resources, A, B, { minLegs: 1 }).journeys).toHaveLength(2);
  });

  test('the transfer and wait limits are settings', () => {
    expect(planJourneys(resources, A, C, { minTransferMinutes: 0 }).journeys.map((j) => j.steps[1].vehicleNumber)).toContain('3');
    expect(planJourneys(resources, A, C, { maxWaitMinutes: 60 }).journeys).toHaveLength(1);
  });

  test('times in other offsets are compared in UTC', () => {
    // 09:30+02:00 reads later than 09:00+01:00 on the clock, but leaves half an hour before.
    const r = planJourneys([
      train(1, A, B, [svc('1', '08:00:00+01:00', '09:00:00+01:00')]),
      train(2, B, C, [svc('2', '09:30:00+02:00', '11:00:00+02:00'), svc('3', '10:30:00+02:00', '11:00:00+02:00')]),
    ], A, C);
    expect(r.journeys.map((j) => j.steps[1].vehicleNumber)).toEqual(['3']);
  });

  test('a leg after midnight can only end a journey', () => {
    const rs = [
      train(1, A, B, [svc('night', '22:00', '00:30')]),
      train(2, B, C, [svc('morning', '06:00', '07:00')]),
      train(3, D, A, [svc('evening', '21:00', '21:30')]),
    ];
    expect(planJourneys(rs, A, C, { maxWaitMinutes: 1440 }).journeys).toEqual([]);
    expect(planJourneys(rs, D, B).journeys.map((j) => j.durationMinutes)).toEqual([210]);
  });

  test('operating days must have a day in common', () => {
    const rs = [
      train(1, A, B, [svc('1', '08:00', '09:00')], { daysOfWeek: ['MON', 'TUE'] }),
      train(2, B, C, [svc('2', '09:30', '10:00')], { daysOfWeek: ['TUE', 'WED'] }),
      train(3, B, D, [svc('3', '09:30', '10:00')], { daysOfWeek: ['SUN'] }),
    ];
    expect(planJourneys(rs, A, C).journeys[0].days).toEqual(['TUE']);
    expect(planJourneys(rs, A, D).journeys).toEqual([]);
  });

  test('never passes a stop place twice, nor uses a service twice', () => {
    const rs = [
      train(1, A, B, [svc('1', '08:00', '09:00')]),
      train(2, B, A, [svc('2', '09:10', '10:00')]),
      train(3, A, C, [svc('3', '10:10', '11:00')]),
      train(4, B, C, [svc('4', '12:00', '13:00')]),
    ];
    const r = planJourneys(rs, A, C, { maxWaitMinutes: 600 });
    expect(r.journeys.map((j) => j.steps.map((s) => s.vehicleNumber).join('+'))).toEqual(['1+4']);
  });

  test('unsaved trains, untimed services and loops are left out', () => {
    const rs = [
      { id: null, resource_type: 'TRAIN', data: { originURN: A, destinationURN: B, services: [svc('x', '08:00', '09:00')] } },
      train(2, A, B, [svc('y', '', '09:00')]),
      train(3, A, A, [svc('z', '08:00', '09:00')]),
      train(4, B, C, [svc('w', '09:30', '10:00')]),
    ];
    expect(planJourneys(rs, A, C).journeys).toEqual([]);
  });

  test('says when the origin or destination is missing or the same', () => {
    expect(planJourneys(resources, '', C).error).toMatch(/origin and a destination/);
    expect(planJourneys(resources, A, 'urn:uic:stn:0001000001').error).toMatch(/same stop place/);
  });

  test('limits the results and stops a search that grows too large', () => {
    // Many services between three places: the result list is capped.
    const many = [];
    for (let i = 0; i < 60; i++) {
      const t = (h) => `${String(h).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`;
      many.push(train(1000 + i, A, B, [svc(`a${i}`, t(6), t(7))]));
      many.push(train(2000 + i, B, C, [svc(`b${i}`, t(8), t(9))]));
    }
    const r = planJourneys(many, A, C, { limit: 5, maxWaitMinutes: 300 });
    expect(r.journeys).toHaveLength(5);
    expect(r.total).toBeGreaterThan(5);
    expect(r.truncated).toBe(false);

    // A dense network over many stops hits the budget instead of running on.
    const dense = [];
    const stops = Array.from({ length: 40 }, (_, k) => `urn:uic:stn:2${String(k).padStart(6, '0')}`);
    let id = 1;
    for (const o of stops) {
      for (const d of stops) {
        if (o === d) continue;
        dense.push(train(id++, o, d, Array.from({ length: 8 }, (_, h) => svc(`${id}-${h}`, `${String(6 + h).padStart(2, '0')}:00`, `${String(6 + h).padStart(2, '0')}:30`))));
      }
    }
    const started = Date.now();
    const big = planJourneys(dense, stops[0], stops[1], { maxWaitMinutes: 600 });
    expect(big.truncated).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
