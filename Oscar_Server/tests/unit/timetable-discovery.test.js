// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * timetable-discovery.test.js — unit tests for the #157 harvest/group/merge
 * logic. These cover the pure transforms only; the live trips-collection HTTP
 * call and DB writes are exercised manually against a real sandbox.
 */

const {
  dayOfWeekCode,
  timePartOf,
  searchDates,
  harvestTrips,
  harvestOfferCatalog,
  routeKey,
  serviceKey,
  groupAndMerge,
} = require('../../src/services/timetable-discovery');

// Build a TripCollectionResponse fragment with a single timed leg.
function leg({ origin, dest, originName, destName, dep, arr, veh, pcRef, pcName, pcShort, carrier }) {
  return {
    timedLeg: {
      start: {
        stopPlaceRef: { objectType: 'StopPlaceRef', stopPlaceRef: origin },
        stopPlaceName: originName,
        serviceDeparture: { timetabledTime: dep },
      },
      end: {
        stopPlaceRef: { objectType: 'StopPlaceRef', stopPlaceRef: dest },
        stopPlaceName: destName,
        serviceArrival: { timetabledTime: arr },
      },
      service: {
        vehicleNumbers: Array.isArray(veh) ? veh : [veh],
        productCategory: { productCategoryRef: pcRef, name: pcName, shortName: pcShort },
        carriers: carrier ? [{ ref: carrier }] : [],
      },
    },
  };
}

// ── dayOfWeekCode ─────────────────────────────────────────────────────────────
describe('dayOfWeekCode', () => {
  test('reads the calendar date, not UTC, for offset times', () => {
    // 2026-06-01 is a Monday. Even at +14:00 it should stay Monday.
    expect(dayOfWeekCode('2026-06-01T09:10:00+02:00')).toBe('MON');
    expect(dayOfWeekCode('2026-06-07T23:59:00-05:00')).toBe('SUN');
  });
  test('returns empty string for unparseable input', () => {
    expect(dayOfWeekCode('')).toBe('');
    expect(dayOfWeekCode(null)).toBe('');
    expect(dayOfWeekCode('not-a-date')).toBe('');
  });
});

// ── timePartOf ───────────────────────────────────────────────────────────────
describe('timePartOf', () => {
  test('keeps only the time-of-day portion', () => {
    expect(timePartOf('2026-06-01T09:10:00+02:00')).toBe('09:10:00+02:00');
    expect(timePartOf('16:35:00')).toBe('16:35:00');
    expect(timePartOf('')).toBe('');
  });
});

// ── searchDates ──────────────────────────────────────────────────────────────
describe('searchDates', () => {
  test('returns N consecutive local dates from the given start', () => {
    const out = searchDates(3, new Date(2026, 5, 1)); // June 1, 2026 (local)
    expect(out).toEqual(['2026-06-01', '2026-06-02', '2026-06-03']);
  });
  test('crosses month boundaries', () => {
    const out = searchDates(2, new Date(2026, 4, 31)); // May 31
    expect(out).toEqual(['2026-05-31', '2026-06-01']);
  });
  test('clamps to 1..14, treats falsy/missing as the default 7', () => {
    expect(searchDates(-3, new Date(2026, 0, 1))).toHaveLength(1);   // below min → clamp to 1
    expect(searchDates(99, new Date(2026, 0, 1))).toHaveLength(14);  // above max → clamp to 14
    expect(searchDates(undefined, new Date(2026, 0, 1))).toHaveLength(7); // missing → default 7
    expect(searchDates(0, new Date(2026, 0, 1))).toHaveLength(7);    // 0 (falsy) → default 7
  });
});

// ── harvestTrips ─────────────────────────────────────────────────────────────
describe('harvestTrips', () => {
  test('harvests every timed leg of every trip', () => {
    const resp = {
      trips: [
        { legs: [leg({
          origin: 'urn:uic:stn:8500010', dest: 'urn:uic:stn:8400058',
          originName: 'Basel', destName: 'Amsterdam',
          dep: '2026-06-01T09:10:00+02:00', arr: '2026-06-01T16:35:00+02:00',
          veh: 'OSDM_202', pcRef: 'urn:uic:sbc:HS', pcName: 'High Speed', pcShort: 'HS',
          carrier: 'urn:uic:rics:1184',
        })] },
        { legs: [
          leg({ origin: 'urn:uic:stn:8500010', dest: 'urn:uic:stn:8000001',
            dep: '2026-06-01T10:00:00+02:00', arr: '2026-06-01T12:00:00+02:00',
            veh: 'OSDM_300', pcRef: 'urn:uic:sbc:IC', pcName: 'InterCity', pcShort: 'IC' }),
          leg({ origin: 'urn:uic:stn:8000001', dest: 'urn:uic:stn:8400058',
            dep: '2026-06-01T12:30:00+02:00', arr: '2026-06-01T15:00:00+02:00',
            veh: 'OSDM_301', pcRef: 'urn:uic:sbc:IC', pcName: 'InterCity', pcShort: 'IC' }),
        ] },
      ],
    };
    const recs = harvestTrips(resp);
    expect(recs).toHaveLength(3);
    expect(recs[0]).toMatchObject({
      originURN: 'urn:uic:stn:8500010',
      destinationURN: 'urn:uic:stn:8400058',
      operatorCode: 'urn:uic:rics:1184',
      productCategoryRef: 'urn:uic:sbc:HS',
      productCategoryShortName: 'HS',
      vehicleNumber: 'OSDM_202',
      departureTime: '09:10:00+02:00',
      arrivalTime: '16:35:00+02:00',
      dayOfWeek: 'MON',
    });
  });

  test('skips non-timed legs (transfers/walks) and tolerates empty input', () => {
    const resp = { trips: [{ legs: [{ transferLeg: {} }, { continuousLeg: {} }] }] };
    expect(harvestTrips(resp)).toEqual([]);
    expect(harvestTrips({})).toEqual([]);
    expect(harvestTrips(null)).toEqual([]);
  });

  test('joins multiple vehicle numbers', () => {
    const resp = { trips: [{ legs: [leg({
      origin: 'a', dest: 'b', dep: '2026-06-01T08:00:00+02:00', arr: '2026-06-01T09:00:00+02:00',
      veh: ['ICE 100', 'ICE 101'], pcRef: 'r', pcName: 'n', pcShort: 's',
    })] }] };
    expect(harvestTrips(resp)[0].vehicleNumber).toBe('ICE 100/ICE 101');
  });
});

// ── routeKey / serviceKey ────────────────────────────────────────────────────
describe('keys', () => {
  test('routeKey combines origin + destination + product category', () => {
    expect(routeKey({ originURN: 'a', destinationURN: 'b', productCategoryRef: 'c' })).toBe('a|b|c');
  });
  test('serviceKey combines vehicle + departure + arrival', () => {
    expect(serviceKey({ vehicleNumber: 'v', departureTime: 'd', arrivalTime: 'a' })).toBe('v|d|a');
  });
});

// ── groupAndMerge ────────────────────────────────────────────────────────────
describe('groupAndMerge', () => {
  const harvest = (extra = {}) => Object.assign({
    originURN: 'urn:uic:stn:8500010', destinationURN: 'urn:uic:stn:8400058',
    originName: 'Basel', destName: 'Amsterdam',
    operatorCode: 'urn:uic:rics:1184',
    productCategoryRef: 'urn:uic:sbc:HS', productCategoryName: 'High Speed', productCategoryShortName: 'HS',
    vehicleNumber: 'OSDM_202', departureTime: '09:10:00+02:00', arrivalTime: '16:35:00+02:00',
    dayOfWeek: 'MON',
  }, extra);

  test('creates a new train set when no existing route matches', () => {
    const { toCreate, toUpdate, summary } = groupAndMerge([harvest()], []);
    expect(toUpdate).toHaveLength(0);
    expect(toCreate).toHaveLength(1);
    expect(toCreate[0].data).toMatchObject({
      originURN: 'urn:uic:stn:8500010',
      destinationURN: 'urn:uic:stn:8400058',
      operatorCode: 'urn:uic:rics:1184',
      productCategoryRef: 'urn:uic:sbc:HS',
      productCategoryShortName: 'HS',
      daysOfWeek: ['MON'],
      services: [{ vehicleNumber: 'OSDM_202', departureTime: '09:10:00+02:00', arrivalTime: '16:35:00+02:00' }],
    });
    // Catalog arrays initialised empty for the tester to fill in.
    expect(toCreate[0].data.ticketTypes).toEqual([]);
    expect(summary).toMatchObject({ routesDiscovered: 1, created: 1, updated: 0, servicesAdded: 1 });
  });

  test('dedups identical services across days and unions the operating-days calendar', () => {
    const mon = harvest({ dayOfWeek: 'MON' });
    const tue = harvest({ dayOfWeek: 'TUE' });   // same vehicle/times, different day
    const { toCreate } = groupAndMerge([mon, tue], []);
    expect(toCreate).toHaveLength(1);
    expect(toCreate[0].data.services).toHaveLength(1);          // collapsed to one service
    expect(toCreate[0].data.daysOfWeek).toEqual(['MON', 'TUE']); // both days captured
  });

  test('every leg of a multi-leg trip becomes its own route set', () => {
    const legA = harvest({ destinationURN: 'urn:uic:stn:MID', destName: 'Mid', vehicleNumber: 'A1', productCategoryRef: 'urn:uic:sbc:IC' });
    const legB = harvest({ originURN: 'urn:uic:stn:MID', originName: 'Mid', vehicleNumber: 'B2', productCategoryRef: 'urn:uic:sbc:IC' });
    const { toCreate } = groupAndMerge([legA, legB], []);
    expect(toCreate).toHaveLength(2);
  });

  test('merges new services into an existing route set without clobbering manual edits', () => {
    const existing = [{
      id: 'train-1', resource_type: 'TRAIN', label: 'My Basel→Amsterdam',
      data: {
        originURN: 'urn:uic:stn:8500010', destinationURN: 'urn:uic:stn:8400058',
        productCategoryRef: 'urn:uic:sbc:HS',
        operatorCode: 'urn:uic:rics:9999',                    // manually corrected
        daysOfWeek: ['MON'],
        services: [{ vehicleNumber: 'OSDM_202', departureTime: '09:10:00+02:00', arrivalTime: '16:35:00+02:00' }],
        ticketTypes: ['FLEXI'], travelClasses: ['FIRST'],     // manual edits
      },
    }];
    // A brand-new service on the same route, on a new day.
    const newSvc = harvest({ vehicleNumber: 'OSDM_204', departureTime: '13:10:00+02:00', arrivalTime: '20:35:00+02:00', dayOfWeek: 'WED' });
    const { toCreate, toUpdate } = groupAndMerge([newSvc], existing);

    expect(toCreate).toHaveLength(0);
    expect(toUpdate).toHaveLength(1);
    const d = toUpdate[0].data;
    expect(d.services).toHaveLength(2);                        // appended, not replaced
    expect(d.daysOfWeek).toEqual(['MON', 'WED']);              // unioned
    expect(d.operatorCode).toBe('urn:uic:rics:9999');          // manual edit preserved
    expect(d.ticketTypes).toEqual(['FLEXI']);                  // manual catalog preserved
    expect(d.travelClasses).toEqual(['FIRST']);
  });

  test('does not emit an update when nothing changed', () => {
    const existing = [{
      id: 'train-1', resource_type: 'TRAIN', label: 'x',
      data: {
        originURN: 'urn:uic:stn:8500010', destinationURN: 'urn:uic:stn:8400058',
        productCategoryRef: 'urn:uic:sbc:HS', daysOfWeek: ['MON'],
        services: [{ vehicleNumber: 'OSDM_202', departureTime: '09:10:00+02:00', arrivalTime: '16:35:00+02:00' }],
      },
    }];
    const { toUpdate, toCreate } = groupAndMerge([harvest()], existing);
    expect(toCreate).toHaveLength(0);
    expect(toUpdate).toHaveLength(0);
  });

  test('fills empty descriptive fields on an existing set but never overwrites', () => {
    const existing = [{
      id: 'train-1', resource_type: 'TRAIN', label: 'x',
      data: {
        originURN: 'urn:uic:stn:8500010', destinationURN: 'urn:uic:stn:8400058',
        productCategoryRef: 'urn:uic:sbc:HS', daysOfWeek: ['MON'],
        operatorCode: '',                       // empty → should be filled
        productCategoryShortName: 'KEEP',        // set → must be preserved
        services: [{ vehicleNumber: 'OSDM_202', departureTime: '09:10:00+02:00', arrivalTime: '16:35:00+02:00' }],
      },
    }];
    const newSvc = harvest({ vehicleNumber: 'OSDM_999', dayOfWeek: 'MON', productCategoryShortName: 'HS' });
    const { toUpdate } = groupAndMerge([newSvc], existing);
    expect(toUpdate).toHaveLength(1);
    expect(toUpdate[0].data.operatorCode).toBe('urn:uic:rics:1184'); // filled
    expect(toUpdate[0].data.productCategoryShortName).toBe('KEEP');  // preserved
  });

  test('ignores empty harvest noise', () => {
    const { toCreate, toUpdate, summary } = groupAndMerge([{ originURN: '', destinationURN: '', vehicleNumber: '' }], []);
    expect(toCreate).toHaveLength(0);
    expect(toUpdate).toHaveLength(0);
    expect(summary.routesDiscovered).toBe(0);
  });
});

// ── harvestOfferCatalog ──────────────────────────────────────────────────────
describe('harvestOfferCatalog', () => {
  test('collects travel/service classes (any depth) and ancillary types from offers', () => {
    const resp = {
      offers: [
        {
          offerId: 'o1',
          admissionOfferParts: [{ products: [{ travelClass: 'SECOND', serviceClass: 'STANDARD' }] }],
          ancillaryOfferParts: [{ type: 'WIFI' }, { type: 'FOOD_ON_BOARD', category: 'Meal' }],
        },
        {
          offerId: 'o2',
          reservationOfferParts: [{ deep: { travelClass: 'FIRST' } }],
          ancillaryOfferParts: [{ category: 'Gift' }],   // no type → category fallback
        },
      ],
    };
    const cat = harvestOfferCatalog(resp);
    expect(cat.travelClasses.sort()).toEqual(['FIRST', 'SECOND']);
    expect(cat.serviceClasses).toEqual(['STANDARD']);
    expect(cat.ancillaries.sort()).toEqual(['FOOD_ON_BOARD', 'Gift', 'WIFI']);
  });

  test('returns empty arrays for a trips-collection response (no offers[])', () => {
    expect(harvestOfferCatalog({ trips: [{}] })).toEqual({ travelClasses: [], serviceClasses: [], ancillaries: [] });
    expect(harvestOfferCatalog(null)).toEqual({ travelClasses: [], serviceClasses: [], ancillaries: [] });
  });
});

// ── groupAndMerge with the offer catalog ─────────────────────────────────────
describe('groupAndMerge — offer catalog prefill', () => {
  const harvest = () => ({
    originURN: 'A', destinationURN: 'B', productCategoryRef: 'P',
    vehicleNumber: 'V1', departureTime: '09:00:00', arrivalTime: '10:00:00', dayOfWeek: 'MON',
  });
  const catalog = { travelClasses: ['FIRST', 'SECOND'], serviceClasses: ['STANDARD'], ancillaries: ['WIFI'] };

  test('seeds Service Configuration on a new set', () => {
    const { toCreate } = groupAndMerge([harvest()], [], catalog);
    expect(toCreate[0].data.travelClasses).toEqual(['FIRST', 'SECOND']);
    expect(toCreate[0].data.serviceClasses).toEqual(['STANDARD']);
    expect(toCreate[0].data.ancillaries).toEqual(['WIFI']);
  });

  test('fills only empty arrays on an existing set; never overwrites manual edits', () => {
    const existing = [{
      id: 't1', resource_type: 'TRAIN', label: 'x',
      data: {
        originURN: 'A', destinationURN: 'B', productCategoryRef: 'P', daysOfWeek: ['MON'],
        services: [{ vehicleNumber: 'V1', departureTime: '09:00:00', arrivalTime: '10:00:00' }],
        travelClasses: ['THIRD'],   // manual edit → must be preserved
        serviceClasses: [],          // empty → fillable
        ancillaries: [],             // empty → fillable
      },
    }];
    const { toUpdate } = groupAndMerge([harvest()], existing, catalog);
    expect(toUpdate).toHaveLength(1);                       // catalog fill alone triggers an update
    expect(toUpdate[0].data.travelClasses).toEqual(['THIRD']);     // preserved
    expect(toUpdate[0].data.serviceClasses).toEqual(['STANDARD']); // filled
    expect(toUpdate[0].data.ancillaries).toEqual(['WIFI']);        // filled
  });
});
