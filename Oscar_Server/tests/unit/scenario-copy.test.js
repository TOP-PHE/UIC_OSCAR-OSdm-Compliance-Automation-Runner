// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * scenario-copy.test.js — the rules of copying scenarios between providers
 * (#540), and the shared trip filling (public/js/trip-apply.js) they use.
 */

const { planCopy, applyCopy } = require('../../src/utils/scenarioCopy');
const TripApply = require('../../public/js/trip-apply');

const TRAINS = [
  { id: 't1', resource_type: 'TRAIN', label: 'IC Basel-Paris', data: {
    originURN: 'urn:uic:stn:8500010', destinationURN: 'urn:uic:stn:8727100', operatorCode: 'X1',
    productCategoryRef: 'IC', services: [
      { vehicleNumber: 'X100', departureTime: '08:00:00+02:00', arrivalTime: '11:00:00+02:00' },
      { vehicleNumber: 'X102', departureTime: '10:00:00+02:00', arrivalTime: '13:00:00+02:00' }] } },
  { id: 't2', resource_type: 'TRAIN', label: 'Paris-Lyon', data: JSON.stringify({
    originURN: 'urn:uic:stn:8727100', destinationURN: 'urn:uic:stn:8772319', vehicleNumber: 'Y7',
    departureTime: '12:00:00+02:00', arrivalTime: '14:00:00+02:00' }) },
  { id: 'j1', resource_type: 'JOURNEY', label: 'Basel-Lyon', data: { legs: [
    { trainResourceId: 't1', serviceIndex: 1 }, { trainResourceId: 't2', serviceIndex: 0 }] } },
];

const FRAMEWORK = { osdmVersion: '3.6', salesFlows: ['SALE', 'REFUND'], fulfillment: { types: ['ETICKET'], media: ['PDF_A4'] } };

function source() {
  return {
    osdmVersion: '3.4',
    systemInfoParameters: { api_base: 'https://source.example' },
    knownDeviations: [{ step: 'x', expected_status: 501 }],
    scenariosToRun: ['S1', 'S2'],
    scenarios: [
      { code: 'S1', scenarioType: 'SALE', osdmVersion: '3.4', tripRequirementId: 1, passengersListId: 1,
        purchaserListId: 1, requestedFulfillmentOptionsListId: 1, created_by: 'tm@d.example', shared: true,
        __featureNotDeclaredWarnings: ['x'] },
      { code: 'S2', scenarioType: 'REFUND', osdmVersion: '3.4', tripRequirementId: 1, passengersListId: 1,
        requestedFulfillmentOptionsListId: 2, partialRefundByLeg: [1], created_by: 'tm@d.example' },
      { code: 'S3', scenarioType: 'SALE', tripRequirementId: 2, passengersListId: 1, requestedFulfillmentOptionsListId: 1 },
    ],
    tripRequirements: [
      { id: 1, tripType: 'SEARCH', departureDay: 'TOMORROW', trip: { origin: 'urn:a', destination: 'urn:b', vehicleNumber: 'OLD1', searchCriteria: { x: 1 } } },
      { id: 2, tripType: 'SPECIFICATION', legs: [{ origin: 'urn:a', destination: 'urn:m' }, { origin: 'urn:m', destination: 'urn:b' }] },
    ],
    passengersList: [{ id: 1, passengers: [{ type: 'ADULT' }] }],
    purchaserList: [{ id: 1, purchaser: { name: 'P' } }],
    requestedFulfillmentOptionsList: [
      { id: 1, requestedFulfillmentOptions: [{ fulfillmentType: 'ETICKET', fulfillmentMedia: 'PDF_A4' }] },
      { id: 2, requestedFulfillmentOptions: [{ fulfillmentType: 'TICKETLESS', fulfillmentMedia: 'NONE' },
        { fulfillmentType: 'ETICKET', fulfillmentMedia: 'PDF_A4' }] },
    ],
  };
}

function target() {
  return {
    systemInfoParameters: { api_base: 'https://target.example' },
    scenariosToRun: ['S1'],
    scenarios: [{ code: 'S1', tripRequirementId: 1, passengersListId: 1, requestedFulfillmentOptionsListId: 1, created_by: 'other@d.example' }],
    tripRequirements: [{ id: 1, tripType: 'SEARCH', trip: { origin: 'urn:z' } }],
    passengersList: [{ id: 1, passengers: [{ type: 'ADULT' }] }],
    requestedFulfillmentOptionsList: [{ id: 1, requestedFulfillmentOptions: [{ fulfillmentType: 'ETICKET', fulfillmentMedia: 'PDF_A4' }] }],
  };
}

const opts = (extra = {}) => ({
  codes: ['S1', 'S2'], tripMap: { 1: { type: 'train', train_id: 't1', service_index: 1 } },
  frameworkConfig: FRAMEWORK, resources: TRAINS, email: 'ana@d.example', ...extra,
});

describe('planCopy', () => {
  test('lists each trip entry once, with the scenarios that use it', () => {
    const plan = planCopy(source(), ['S1', 'S2', 'S3'], FRAMEWORK);
    expect(plan.trips.map(t => [t.id, t.usedBy, t.needsJourney])).toEqual([[1, ['S1', 'S2'], false], [2, ['S3'], true]]);
    expect(plan.trips[0]).toMatchObject({ origin: 'urn:a', destination: 'urn:b', vehicleNumber: 'OLD1', legs: 1 });
  });

  test('flags undeclared features, reduced fulfillment and the OSDM version before the copy', () => {
    const w = Object.fromEntries(planCopy(source(), ['S1', 'S2'], FRAMEWORK).scenarios.map(s => [s.code, s.warnings]));
    expect(w.S1).toEqual(['OSDM version becomes 3.6 (the target\'s Test Framework).']);
    expect(w.S2).toEqual(expect.arrayContaining([
      expect.stringContaining('partialRefundByLeg'),
      expect.stringContaining('Fulfillment options are reduced'),
    ]));
  });

  test('names codes the source does not hold', () => {
    expect(planCopy(source(), ['S1', 'NOPE'], FRAMEWORK).missing).toEqual(['NOPE']);
  });
});

describe('applyCopy', () => {
  test('re-points the trip with the editor\'s own filling, once for all scenarios sharing it', () => {
    const { datafile, copied } = applyCopy(source(), target(), opts());
    expect(copied).toEqual([{ from: 'S1', to: 'S1_2' }, { from: 'S2', to: 'S2' }]);
    const added = datafile.scenarios.slice(1);
    expect(new Set(added.map(s => s.tripRequirementId)).size).toBe(1);
    const trip = datafile.tripRequirements.find(t => t.id === added[0].tripRequirementId);
    const expected = TripApply.applyTrainService({ origin: 'urn:a', destination: 'urn:b', vehicleNumber: 'OLD1', searchCriteria: { x: 1 } },
      TripApply.normalizeTrainData(JSON.parse(JSON.stringify(TRAINS[0].data))), TRAINS[0].data.services[1]);
    expect(trip).toEqual({ id: 2, tripType: 'SEARCH', departureDay: 'TOMORROW', trip: expected });
    expect(trip.trip.vehicleNumber).toBe('X102');
  });

  test('a multi-leg trip mapped to a journey becomes the journey\'s legs', () => {
    const { datafile } = applyCopy(source(), target(), opts({ codes: ['S3'], tripMap: { 2: { type: 'journey', journey_id: 'j1' } } }));
    const sc = datafile.scenarios.find(s => s.code === 'S3');
    const trip = datafile.tripRequirements.find(t => t.id === sc.tripRequirementId);
    expect(trip.tripType).toBe('SPECIFICATION');
    expect(trip.legs.map(l => l.vehicleNumber)).toEqual(['X102', 'Y7']);
  });

  test.each([
    ['no mapping', {}, /Trip 1 has no train or journey chosen/],
    ['an unknown train', { 1: { type: 'train', train_id: 'nope' } }, /not in the target's Test Data/],
    ['a journey given as a train', { 1: { type: 'train', train_id: 'j1' } }, /not in the target's Test Data/],
    ['an unknown journey', { 1: { type: 'journey', journey_id: 't1' } }, /journey that is not in the target/],
  ])('refuses %s, and changes nothing', (_l, tripMap, message) => {
    const tgt = target();
    const result = applyCopy(source(), tgt, opts({ tripMap }));
    expect(result.datafile).toBeUndefined();
    expect(result.errors.join(' ')).toMatch(message);
    expect(tgt).toEqual(target());
  });

  test('a multi-leg trip cannot be mapped to one train', () => {
    const result = applyCopy(source(), target(), opts({ codes: ['S3'], tripMap: { 2: { type: 'train', train_id: 't1' } } }));
    expect(result.errors.join(' ')).toMatch(/several legs: map it to a journey/);
  });

  test('copies belong to whoever copies, are not shared, and take the target framework\'s OSDM version', () => {
    const { datafile } = applyCopy(source(), target(), opts());
    for (const sc of datafile.scenarios.slice(1)) {
      expect(sc).toMatchObject({ created_by: 'ana@d.example', shared: false, osdmVersion: '3.6' });
      expect(Object.keys(sc).some(k => k.startsWith('__'))).toBe(false);
    }
  });

  test('fulfillment keeps what the target declares', () => {
    const { datafile } = applyCopy(source(), target(), opts({ codes: ['S2'] }));
    const sc = datafile.scenarios.find(s => s.code === 'S2');
    expect(datafile.requestedFulfillmentOptionsList.find(e => e.id === sc.requestedFulfillmentOptionsListId).requestedFulfillmentOptions)
      .toEqual([{ fulfillmentType: 'ETICKET', fulfillmentMedia: 'PDF_A4' }]);
  });

  test('entries are copied to fresh ids, never reusing an entry already in the target', () => {
    const { datafile } = applyCopy(source(), target(), opts());
    const [s1, s2] = datafile.scenarios.slice(1);
    expect(s1.tripRequirementId).toBe(2);
    expect(s1.passengersListId).toBe(3);                   // the target's entry 1 has the same content: not reused
    expect(s2.passengersListId).toBe(s1.passengersListId); // one copy for scenarios that shared it
    expect(datafile.passengersList).toHaveLength(2);
    expect(s1.purchaserListId).toBe(4);                    // fresh across every list, not per list
    expect(datafile.purchaserList).toEqual([{ id: 4, purchaser: { name: 'P' } }]);
    expect(s2.purchaserListId).toBeUndefined();
  });

  test('a fresh id never lands on a reference another scenario already holds', () => {
    // Another tester's scenario points to entries the lists do not hold (left
    // dangling by an earlier edit). A copied entry under that id would become
    // theirs, and show in their view.
    const tgt = target();
    tgt.scenarios.push({ code: 'BEN', tripRequirementId: 2, passengersListId: 3, purchaserListId: 4,
      requestedFulfillmentOptionsListId: 5, created_by: 'ben@d.example' });
    const { datafile } = applyCopy(source(), tgt, opts());
    const ben = datafile.scenarios.find(s => s.code === 'BEN');
    for (const [list, ref] of [['tripRequirements', 'tripRequirementId'], ['passengersList', 'passengersListId'],
      ['purchaserList', 'purchaserListId'], ['requestedFulfillmentOptionsList', 'requestedFulfillmentOptionsListId']]) {
      expect((datafile[list] || []).find(e => e.id === ben[ref])).toBeUndefined();
    }
  });

  test('ids stay safe integers and unique when the target holds an id at 2^53', () => {
    const tgt = target();
    tgt.passengersList.push({ id: 2 ** 53, passengers: [] });
    tgt.tripRequirements.push({ id: Number.MAX_SAFE_INTEGER, tripType: 'SEARCH', trip: {} });
    const { datafile } = applyCopy(source(), tgt, opts());
    for (const list of ['tripRequirements', 'passengersList', 'requestedFulfillmentOptionsList']) {
      const ids = datafile[list].map(e => e.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
    for (const s of datafile.scenarios.slice(1)) expect(Number.isSafeInteger(s.passengersListId)).toBe(true);
  });

  test('nothing but scenarios and their entries crosses over', () => {
    const { datafile } = applyCopy(source(), target(), opts());
    expect(datafile.systemInfoParameters).toEqual({ api_base: 'https://target.example' });
    expect(datafile.knownDeviations).toBeUndefined();
    expect(datafile.scenariosToRun).toEqual(['S1']);
    expect(datafile.osdmVersion).toBeUndefined();
    expect(datafile.scenarios[0]).toEqual(target().scenarios[0]);
    expect(datafile.tripRequirements[0]).toEqual(target().tripRequirements[0]);
  });

  test('a missing scenario or passenger entry is an error', () => {
    expect(applyCopy(source(), target(), opts({ codes: ['NOPE'] })).errors).toEqual(['Scenario NOPE is not in the source.']);
    const src = source(); src.passengersList = [];
    expect(applyCopy(src, target(), opts({ codes: ['S1'] })).errors.join(' ')).toMatch(/passengers the source does not hold/);
  });

  test('one scenario in error stops the whole copy, even when the others would copy', () => {
    const tgt = target();
    const result = applyCopy(source(), tgt, opts({ codes: ['S1', 'S3'] }));   // S3's trip has no mapping
    expect(result.datafile).toBeUndefined();
    expect(result.errors).toEqual(['Trip 2 has no train or journey chosen.']);
    expect(tgt).toEqual(target());
  });

  test('into an empty target', () => {
    const { datafile, copied } = applyCopy(source(), {}, opts({ codes: ['S1'] }));
    expect(copied).toEqual([{ from: 'S1', to: 'S1' }]);
    expect(datafile.tripRequirements).toHaveLength(1);
    expect(datafile.requestedFulfillmentOptionsList).toHaveLength(1);
  });
});

describe('trip-apply', () => {
  test('a legacy single-service train is read as services[0]', () => {
    const d = TripApply.normalizeTrainData({ vehicleNumber: 'V', departureTime: '08:00', arrivalTime: '09:00', productCategory: 'EC' });
    expect(d.services).toEqual([{ vehicleNumber: 'V', departureTime: '08:00', arrivalTime: '09:00' }]);
    expect(d.productCategoryRef).toBe('EC');
  });

  test('fields neither the train nor the service defines are kept', () => {
    const t = TripApply.applyTrainService({ origin: 'keep', extra: 1 }, { destinationURN: 'D' }, {});
    expect(t).toEqual({ origin: 'keep', extra: 1, destination: 'D' });
  });

  test('a train whose stored data is not an object offers no service, and does not throw', () => {
    for (const data of [true, 5, 'x', '7', '[1]', null, [1, 2]]) {
      expect(TripApply.trainService([{ id: 'odd', resource_type: 'TRAIN', data }], 'odd', 0))
        .toEqual({ train: expect.any(Object), d: expect.objectContaining({ services: [] }), svc: {} });
    }
  });

  test('a journey leg whose train is missing is left out', () => {
    expect(TripApply.journeyToTripLegs({ data: { legs: [{ trainResourceId: 'gone' }, { trainResourceId: 't2' }] } }, TRAINS))
      .toHaveLength(1);
  });

  test('scenarios.js fills trips through this module', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../public/js/scenarios.js'), 'utf8');
    expect(src).toContain('OscarTripApply.applyTrainService(t, picked.d, picked.svc)');
    expect(src).toContain('return OscarTripApply.normalizeTrainData(d);');
    expect(src).toContain('return OscarTripApply.journeyToTripLegs(j, wizData.resources);');
    const html = require('fs').readFileSync(require('path').join(__dirname, '../../public/scenarios.html'), 'utf8');
    expect(html.indexOf('/js/trip-apply.js')).toBeGreaterThan(-1);
    expect(html.indexOf('/js/trip-apply.js')).toBeLessThan(html.indexOf('/js/scenarios.js'));
  });
});
