// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * service-probe.test.js — #787: the offer probe compares each service of a
 * train set with the trains its route's answers show. A set typed with
 * `OSDM-104` passed the probe (a search of the route sells), then every
 * scenario naming the train got no offer: the provider's train is OSDM_104.
 */

const { serviceFindings, servicesUnseen, classifyOfferProbe, harvestTrips } = require('../../src/services/timetable-discovery');

const A = 'urn:uic:stn:8727100';
const B = 'urn:uic:stn:8400058';
const set = (services, extra = {}) => ({
  originURN: A, destinationURN: B, daysOfWeek: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
  productCategoryRef: 'urn:uic:sbc:SQILLS_HS', operatorCode: 'urn:uic:rics:1', services, ...extra,
});
const rec = (vehicleNumber, dep, arr, dayOfWeek, extra = {}) => ({
  originURN: A, destinationURN: B, vehicleNumber, departureTime: dep, arrivalTime: arr, dayOfWeek,
  productCategoryRef: 'urn:uic:sbc:SQILLS_HS', operatorCode: 'urn:uic:rics:1', ...extra,
});
const DAYS = [{ date: '2026-10-19', dayOfWeek: 'MON' }, { date: '2026-10-20', dayOfWeek: 'TUE' }, { date: '2026-10-24', dayOfWeek: 'SAT' }];

describe('#787 each service against the provider\'s answers', () => {
  test('a train found as stored, on the days the set says: nothing to say', () => {
    const records = [rec('OSDM_104', '11:10:00+01:00', '14:30:00+01:00', 'MON'), rec('OSDM_104', '11:10:00+01:00', '14:30:00+01:00', 'TUE')];
    expect(serviceFindings(set([{ vehicleNumber: 'OSDM_104', departureTime: '11:10:00+02:00', arrivalTime: '14:30:00+02:00' }]), records, DAYS)).toEqual([]);
  });

  test('a number typed otherwise: the provider\'s is named', () => {
    const records = [rec('OSDM_104', '11:10:00+01:00', '14:30:00+01:00', 'MON')];
    expect(serviceFindings(set([{ vehicleNumber: 'OSDM-104', departureTime: '11:10:00+02:00' }]), records, DAYS))
      .toEqual(['Train OSDM-104 (11:10): the provider names it OSDM_104; a scenario naming OSDM-104 gets no offer']);
  });

  test('another number at the same time, or none at all', () => {
    const records = [rec('OSDM_999', '11:10:00+01:00', '14:30:00+01:00', 'MON')];
    expect(serviceFindings(set([{ vehicleNumber: 'X1', departureTime: '11:10' }]), records, DAYS))
      .toEqual(['Train X1 (11:10): not found; the provider\'s train at 11:10 is OSDM_999']);
    expect(serviceFindings(set([{ vehicleNumber: 'X1', departureTime: '09:00' }]), records, DAYS))
      .toEqual(['Train X1 (09:00): not found in the provider\'s answers on 2026-10-19, 2026-10-20, 2026-10-24']);
  });

  test('times and days that differ, and the category and operator', () => {
    const records = [
      rec('T1', '11:15:00+01:00', '14:40:00+01:00', 'MON', { productCategoryRef: 'urn:uic:sbc:OSDM_HS', operatorCode: 'urn:uic:rics:2' }),
      rec('T1', '11:15:00+01:00', '14:40:00+01:00', 'SAT'),
    ];
    expect(serviceFindings(set([{ vehicleNumber: 'T1', departureTime: '11:10', arrivalTime: '14:30' }]), records, DAYS)).toEqual([
      'Train T1 (11:10): leaves at 11:15 at the provider',
      'Train T1 (11:10): arrives at 14:40 at the provider, 14:30 here',
      'Train T1 (11:10): not offered on Tue 2026-10-20, a day the set says it runs',
      'Train T1 (11:10): offered on Sat 2026-10-24, a day the set does not list',
      'Product category: the provider names urn:uic:sbc:OSDM_HS, the set urn:uic:sbc:SQILLS_HS',
      'Operator: the provider names urn:uic:rics:2, the set urn:uic:rics:1',
    ]);
  });

  test('another route\'s trains do not count; no service or no day probed says nothing; many findings are cut', () => {
    const elsewhere = [{ ...rec('T1', '11:10', '14:30', 'MON'), destinationURN: 'urn:uic:stn:8500010' }];
    expect(serviceFindings(set([{ vehicleNumber: 'T1', departureTime: '11:10' }]), elsewhere, DAYS)[0]).toContain('not found');
    expect(serviceFindings(set([]), [], DAYS)).toEqual([]);
    expect(serviceFindings(set([{ vehicleNumber: 'T1' }]), [], [])).toEqual([]);
    const many = Array.from({ length: 12 }, (_, i) => ({ vehicleNumber: `N${i}`, departureTime: `0${i % 10}:00` }));
    const out = serviceFindings(set(many), [], DAYS);
    expect(out).toHaveLength(9);
    expect(out[8]).toBe('… and 4 more');
  });

  test('the services still to ask at their own time', () => {
    const records = [rec('OSDM_104', '11:10', '14:30', 'MON')];
    const data = set([{ vehicleNumber: 'OSDM_104', departureTime: '11:10' }, { vehicleNumber: 'OSDM_106', departureTime: '13:10' }, { vehicleNumber: 'X' }]);
    expect(servicesUnseen(data, records).map((s) => s.vehicleNumber)).toEqual(['OSDM_106']);
  });

  test('the probe reads the provider\'s WarningCollection', () => {
    const answer = { trips: [{ id: 't' }], offers: [], warnings: { warnings: [{ code: '2103', detail: 'Could not validate (part of) the routes' }] } };
    expect(classifyOfferProbe(answer).finding).toBe('trip(s) found but offers[] empty (provider says: 2103)');
  });

  test('the records come from the answer\'s trips', () => {
    const answer = { trips: [{ legs: [{ timedLeg: {
      start: { stopPlaceRef: { stopPlaceRef: A }, serviceDeparture: { timetabledTime: '2026-10-19T11:10:00+01:00' } },
      end: { stopPlaceRef: { stopPlaceRef: B }, serviceArrival: { timetabledTime: '2026-10-19T14:30:00+01:00' } },
      service: { vehicleNumbers: ['OSDM_104'] },
    } }] }] };
    const records = harvestTrips(answer, { searchedOrigin: A, searchedDestination: B });
    expect(serviceFindings(set([{ vehicleNumber: 'OSDM_104', departureTime: '11:10:00+02:00', arrivalTime: '14:30:00+02:00' }], { productCategoryRef: '', operatorCode: '' }), records, DAYS.slice(0, 1))).toEqual([]);
  });
});
