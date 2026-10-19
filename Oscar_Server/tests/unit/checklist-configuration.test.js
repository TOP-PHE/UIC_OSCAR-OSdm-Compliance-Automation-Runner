// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #862: what a provider's checklist sets up (checklistConfiguration.js), and
 * the station zones it uses, pinned to the collection's.
 */

const C = require('../../src/utils/checklistConfiguration');
const Z = require('../../src/utils/stationZones');
const RC = require('../../src/utils/referenceConfiguration');
const collectionZones = require('../../../Bruno_Collection/library-bruno/stationTimeZones');

const WINTER = Date.UTC(2026, 0, 15);
const SUMMER = Date.UTC(2026, 6, 15);

describe('#862 station zones', () => {
  test('the table is the collection\'s', () => {
    expect({ ...Z.UIC_COUNTRY_ZONES }).toEqual({ ...collectionZones.UIC_COUNTRY_ZONES });
  });

  test('the offset of a station\'s zone, only for a 7-digit UIC code', () => {
    expect(Z.offsetOfStopPlace('urn:uic:stn:8503000', WINTER)).toBe('+01:00');
    expect(Z.offsetOfStopPlace('urn:uic:stn:8503000', SUMMER)).toBe('+02:00');
    expect(Z.offsetOfStopPlace('urn:uic:stn:7015400', WINTER)).toBe('+00:00');
    expect(Z.offsetOfStopPlace('urn:uic:stn:0000001', WINTER)).toBeNull();
    expect(Z.offsetOfStopPlace('urn:uic:stn:80000001', WINTER)).toBeNull();
    expect(Z.offsetOfStopPlace('', WINTER)).toBeNull();
  });
});

describe('#862 reading the answers', () => {
  test('stations, times and products as providers write them', () => {
    expect(C.stationOf('urn:uic:stn:8503000')).toBe('urn:uic:stn:8503000');
    expect(C.stationOf('8503000 Zürich HB')).toBe('urn:uic:stn:8503000');
    expect(C.stationOf('80000001 Berlin Hbf')).toBe('urn:uic:stn:80000001');
    expect(C.stationOf('Zürich HB')).toBe('');
    expect(C.timeAt('8:05', 'urn:uic:stn:8503000', WINTER)).toBe('08:05:00+01:00');
    expect(C.timeAt('08.05', 'urn:uic:stn:8503000', SUMMER)).toBe('08:05:00+02:00');
    expect(C.timeAt('08h05', 'urn:uic:stn:0000001', WINTER)).toBe('08:05:00');
    expect(C.timeAt('25:00', 'urn:uic:stn:8503000', WINTER)).toBe('');
    expect(C.timeAt('', 'urn:uic:stn:8503000', WINTER)).toBe('');
    expect(C.productOf('EuroCity, urn:uic:sbc:EC; operator urn:uic:rics:1185')).toEqual({
      productCategoryName: 'EuroCity', productCategoryRef: 'urn:uic:sbc:EC', operatorCode: 'urn:uic:rics:1185',
    });
    expect(C.productOf('urn:x:product-category:IC')).toEqual({ productCategoryName: '', productCategoryRef: 'urn:x:product-category:IC', operatorCode: '' });
    expect(C.productOf('')).toEqual({ productCategoryName: '', productCategoryRef: '', operatorCode: '' });
  });
});

describe('#862 the framework', () => {
  test('answered questions over the current framework; what is not asked stays', () => {
    const current = { ...RC.defaultFramework(), offerCombinations: { count: 2, seed: 1 }, osdmVersion: '3.4' };
    const { framework, unplaced } = C.frameworkOfChecklist({ 'fw.osdmVersion=3.8': true, 'fw.salesFlows=SALE': true, 'fw.salesFlows=REFUND_FULL': true }, current);
    expect(framework.osdmVersion).toBe('3.8');
    expect(framework.salesFlows).toEqual(['SALE', 'REFUND_FULL']);
    expect(framework.offerCombinations).toEqual({ count: 2, seed: 1 });
    expect(unplaced).toEqual([]);
    expect(current.osdmVersion).toBe('3.4');   // the current framework is not changed
  });

  test('other modes, another OSDM version, and what OSCAR cannot place', () => {
    const { framework, unplaced } = C.frameworkOfChecklist({
      'fw.otherModes=BUS': true, 'fw.otherModes=TAXI': true, 'fw.otherModes=FERRY': true,
      'fw.osdmVersion.other': '3.0.5', 'fw.ancillaries.other': 'bike', 'fw.somethingNew=X': true,
    }, null);
    expect(framework.pt).toMatchObject({ enabled: true, subModes: ['BUS'] });
    expect(framework.shared).toMatchObject({ enabled: true, subModes: ['TAXI'] });
    expect(framework.osdmVersion).toBe('3.0.5');
    expect(unplaced).toEqual(['fw.ancillaries.other', 'fw.otherModes=FERRY', 'fw.somethingNew']);
  });

  test('another version is not taken when a listed one is ticked, nor when it is not a version', () => {
    expect(C.frameworkOfChecklist({ 'fw.osdmVersion=3.8': true, 'fw.osdmVersion.other': '3.0.5' }, null).framework.osdmVersion).toBe('3.8');
    const odd = C.frameworkOfChecklist({ 'fw.osdmVersion.other': 'three' }, null);
    expect(odd.framework.osdmVersion).toBe('3.4');
    expect(odd.unplaced).toEqual(['fw.osdmVersion.other']);
  });

  test('the simulator\'s references keep refusing what they do not place', () => {
    expect(() => RC.frameworkFromChecklist({ 'fw.somethingNew=X': true })).toThrow(/does not place/);
  });
});

describe('#862 the Test Data', () => {
  const answers = {
    'svc1.mode=INTERCITY': true,
    'svc1.product': 'EuroCity, urn:uic:sbc:EC; operator urn:uic:rics:1185',
    'svc1.ticketType=NRT_OPTIONAL_RESERVATION': true,
    'svc1.travelClasses=SECOND': true,
    'svc1.daysOfWeek=MON': true,
    'svc1.daysOfWeek=TUE': true,
    'svc1.service.1.origin': '8503000 Zürich HB', 'svc1.service.1.destination': '8500010 Basel SBB',
    'svc1.service.1.departure': '08:02', 'svc1.service.1.arrival': '08:55', 'svc1.service.1.number': 'IC 1',
    'svc1.service.2.origin': '8503000 Zürich HB', 'svc1.service.2.destination': '8500010 Basel SBB',
    'svc1.service.2.departure': '09:02', 'svc1.service.2.arrival': '09:55', 'svc1.service.2.number': 'IC 3',
    'svc1.service.3.origin': 'Zürich HB', 'svc1.service.3.destination': '8500010',
    'jrn.NRT_IRT.sold=ONE_OFFER': true,
    'jrn.NRT_IRT.leg.1.from': '8503000', 'jrn.NRT_IRT.leg.1.to': '8500010', 'jrn.NRT_IRT.leg.1.departs': '08:02',
    'jrn.NRT_IRT.leg.1.arrives': '08:55', 'jrn.NRT_IRT.leg.1.train': 'IC 1',
    'jrn.NRT_IRT.leg.2.from': '8500010', 'jrn.NRT_IRT.leg.2.to': '8700010', 'jrn.NRT_IRT.leg.2.departs': '09:10',
    'jrn.NRT_IRT.leg.2.arrives': '12:10', 'jrn.NRT_IRT.leg.2.train': 'TGV 9211', 'jrn.NRT_IRT.leg.2.ticketType': 'IRT',
    'jrn.IRT_IRT.sold=NO': true,
    'jrn.IRT_IRT.leg.1.from': '8503000',
    'jrn.NRT_NRT.sold=OFFER_PER_LEG': true,
    'jrn.NRT_NRT.leg.1.from': '8503000', 'jrn.NRT_NRT.leg.1.to': 'Basel',
  };
  const { resources, skipped, notes } = C.testDataOfChecklist(answers, { atMs: WINTER });
  const trains = resources.filter(r => r.resource_type === 'TRAIN');
  const journeys = resources.filter(r => r.resource_type === 'JOURNEY');

  test('a train set per route of a service sheet, its services, days and classes', () => {
    expect(trains[0]).toMatchObject({
      id: 1, label: 'Sheet 1: EuroCity 8503000–8500010',
      data: {
        originURN: 'urn:uic:stn:8503000', destinationURN: 'urn:uic:stn:8500010',
        productCategoryName: 'EuroCity', productCategoryRef: 'urn:uic:sbc:EC', operatorCode: 'urn:uic:rics:1185',
        daysOfWeek: ['MON', 'TUE'], ticketTypes: ['NRT_OPTIONAL_RESERVATION'], travelClasses: ['SECOND'],
        services: [
          { vehicleNumber: 'IC 1', departureTime: '08:02:00+01:00', arrivalTime: '08:55:00+01:00' },
          { vehicleNumber: 'IC 3', departureTime: '09:02:00+01:00', arrivalTime: '09:55:00+01:00' },
        ],
      },
    });
  });

  test('a journey per combination sold, its legs on the train sets', () => {
    expect(journeys).toHaveLength(1);
    expect(journeys[0]).toMatchObject({ label: 'Journey NRT_IRT: 8503000–8700010, 2 legs' });
    const [leg1, leg2] = journeys[0].data.legs;
    expect(leg1).toEqual({ trainResourceId: 1, serviceIndex: 0 });
    const second = trains.find(t => t.id === leg2.trainResourceId);
    expect(second.data).toMatchObject({ originURN: 'urn:uic:stn:8500010', destinationURN: 'urn:uic:stn:8700010', ticketTypes: ['IRT'] });
    expect(second.data.services[leg2.serviceIndex]).toEqual({ vehicleNumber: 'TGV 9211', departureTime: '09:10:00+01:00', arrivalTime: '12:10:00+01:00' });
    expect(journeys[0].id).toBe(trains.length + 1);
  });

  test('what cannot be built is said, never guessed', () => {
    expect(skipped).toEqual([
      'Service sheet 1, service 3: no station code for its origin.',
      'Journey NRT_NRT: a leg has no station code.',
    ]);
    expect(notes).toEqual([]);
    const local = C.testDataOfChecklist({ 'svc1.service.1.origin': '0000001', 'svc1.service.1.destination': '0000002', 'svc1.service.1.departure': '08:00' });
    expect(local.resources[0].data.services[0].departureTime).toBe('08:00:00');
    expect(local.notes).toEqual([expect.stringMatching(/^1 train set\(s\) keep local times without a UTC offset/)]);
  });
});

describe('#862 the changes', () => {
  test('answers changed, question by question', () => {
    expect(C.answerChanges(
      { 'fw.salesFlows=SALE': true, 'fw.salesFlows.comment': 'only sales', 'info.cleanup=AUTO': true },
      { 'fw.salesFlows=SALE': true, 'fw.salesFlows=REFUND_FULL': true, 'fw.salesFlows.comment': 'only sales', 'data.purchaser=LATER_ALLOWED': true },
    )).toEqual([
      { question: 'data.purchaser', before: null, after: 'LATER_ALLOWED' },
      { question: 'fw.salesFlows', before: 'SALE', after: 'REFUND_FULL, SALE' },
      { question: 'info.cleanup', before: 'AUTO', after: null },
    ]);
  });

  test('framework values by path, the private ones left out', () => {
    expect(C.frameworkChanges({ a: { b: 1, c: [1] }, _m: 1 }, { a: { b: 2, c: [1] }, d: 'x', _m: 2 })).toEqual([
      { path: 'a.b', before: 1, after: 2 },
      { path: 'd', before: null, after: 'x' },
    ]);
  });

  test('Test Data: added, already there, removed by replace', () => {
    const incoming = [{ id: 1, resource_type: 'TRAIN', label: 'T', data: { originURN: 'a' } }, { id: 2, resource_type: 'TRAIN', label: 'U', data: { originURN: 'b' } }];
    const existing = [{ id: 'x', resource_type: 'TRAIN', label: 'Old T', data: { originURN: 'a' } }, { id: 'y', resource_type: 'TRAIN', label: 'Other', data: { originURN: 'z' } }];
    expect(C.testDataChanges(existing, incoming, 'add')).toEqual({ mode: 'add', add: [{ type: 'TRAIN', label: 'U' }], remove: [], alreadyThere: 1, unresolvedLegs: 0 });
    expect(C.testDataChanges(existing, incoming, 'replace').remove).toEqual([{ type: 'TRAIN', label: 'Old T' }, { type: 'TRAIN', label: 'Other' }]);
  });

  test('the preview\'s hash names what is shown: the same input, the same hash; another framework, another', () => {
    const args = { importId: 'i', answers: { 'fw.osdmVersion=3.8': true }, previous: null, current: null, existing: [], mode: 'add', atMs: WINTER };
    const a = C.previewOf(args);
    expect(C.previewOf(args).hash).toBe(a.hash);
    expect(C.previewOf({ ...args, current: { ...RC.defaultFramework(), extra: 1 } }).hash).not.toBe(a.hash);
    expect(C.previewOf({ ...args, mode: 'replace' }).hash).not.toBe(a.hash);
    expect(C.previewOf({ ...args, importId: 'j' }).hash).not.toBe(a.hash);
  });
});
