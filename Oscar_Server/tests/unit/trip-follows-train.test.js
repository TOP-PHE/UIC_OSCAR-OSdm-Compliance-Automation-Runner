// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * trip-follows-train.test.js — #787: "Apply test data" copies a train set's
 * values into a trip, so a train number corrected in Test Data left every
 * trip built from it on the old one. Saving the set now offers those trips
 * the set as saved.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const TripApply = require('../../public/js/trip-apply');

const BEFORE = {
  originURN: 'urn:uic:stn:8500010', destinationURN: 'urn:uic:stn:8503000', operatorCode: 'X',
  services: [
    { vehicleNumber: 'OSDM-104', departureTime: '11:10:00+02:00', arrivalTime: '12:05:00+02:00' },
    { vehicleNumber: 'OSDM-106', departureTime: '13:10:00+02:00', arrivalTime: '14:05:00+02:00' },
  ],
};
const AFTER = {
  ...BEFORE,
  services: [
    { vehicleNumber: 'OSDM_104', departureTime: '11:10:00+02:00', arrivalTime: '12:05:00+02:00' },
    { vehicleNumber: 'OSDM-106', departureTime: '13:10:00+02:00', arrivalTime: '14:05:00+02:00' },
  ],
};
const built = (svc) => TripApply.applyTrainService({ origin: 'keep' }, TripApply.normalizeTrainData(JSON.parse(JSON.stringify(BEFORE))), svc);

describe('#787 trips built from a train set', () => {
  test('a block or leg with the set\'s route and a service\'s number is built from it', () => {
    const trip = { id: 1, tripType: 'SPECIFICATION', legs: [built(BEFORE.services[1]), { origin: 'urn:other', destination: 'urn:x', vehicleNumber: 'OSDM-104' }, built(BEFORE.services[0])] };
    expect(TripApply.blocksBuiltFrom(trip, BEFORE)).toEqual([{ target: 0, serviceIndex: 1 }, { target: 2, serviceIndex: 0 }]);
    expect(TripApply.blocksBuiltFrom({ trip: built(BEFORE.services[0]) }, BEFORE)).toEqual([{ target: 'trip', serviceIndex: 0 }]);
    expect(TripApply.blocksBuiltFrom({ trip: built(BEFORE.services[0]) }, { ...BEFORE, originURN: '' })).toEqual([]);
    expect(TripApply.blocksBuiltFrom(null, BEFORE)).toEqual([]);
  });

  test('only the blocks the edit changes are updated, and the set as it was is not touched', () => {
    const before = JSON.parse(JSON.stringify(BEFORE));
    const trips = [
      { id: 1, legs: [built(BEFORE.services[0]), built(BEFORE.services[1])] },
      { id: 2, trip: built(BEFORE.services[1]) },
      { id: 3, trip: { origin: 'urn:a', destination: 'urn:b', vehicleNumber: 'OSDM-104' } },
    ];
    const updates = TripApply.tripUpdatesFromTrain(trips, before, AFTER);
    expect(updates).toEqual([{ tripIndex: 0, target: 0, serviceIndex: 0 }]);
    expect(before).toEqual(BEFORE);
    TripApply.applyTripUpdate(trips[0], updates[0], AFTER);
    expect(trips[0].legs[0].vehicleNumber).toBe('OSDM_104');
    expect(trips[0].legs[0].origin).toBe(BEFORE.originURN);
    expect(TripApply.tripUpdatesFromTrain(trips, AFTER, AFTER)).toEqual([]);
  });

  test('a time changed in the set reaches the trip; a service removed changes nothing', () => {
    const trips = [{ id: 1, trip: built(BEFORE.services[1]) }];
    const later = { ...BEFORE, services: [BEFORE.services[0], { ...BEFORE.services[1], departureTime: '13:20:00+02:00' }] };
    const [u] = TripApply.tripUpdatesFromTrain(trips, BEFORE, later);
    TripApply.applyTripUpdate(trips[0], u, later);
    expect(trips[0].trip.startDatetime).toBe('%TRIP_DATE%T13:20:00+02:00');
    expect(TripApply.tripUpdatesFromTrain([{ trip: built(BEFORE.services[1]) }], BEFORE, { ...BEFORE, services: [BEFORE.services[0]] })).toEqual([]);
  });
});

describe('#787 the Test Config page', () => {
  const lines = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'scenarios.js'), 'utf8').split('\n');
  const source = lines.join('\n');
  const lift = (name, context) => {
    const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
    const end = lines.findIndex((l, i) => i > start && l === '}');
    return vm.runInNewContext(`(${lines.slice(start, end + 1).join('\n')})`, context);
  };

  const setUp = (confirmed) => {
    const state = {
      tripRequirements: [
        { id: 1, legs: [built(BEFORE.services[0])] },
        { id: 2, legs: [built(BEFORE.services[0])] },
      ],
      scenarios: [{ tripRequirementId: 1 }, { tripRequirementId: 2, ro: true }],
    };
    const toasts = [];
    let dirty = 0;
    const ctx = {
      state,
      OscarTripApply: TripApply,
      isReadOnlyForMe: (sc) => !!sc.ro,
      confirm: () => confirmed,
      markDirty: () => { dirty++; },
      oscarToast: (m) => toasts.push(m),
      reRenderScenarioDetail: () => {},
      document: { querySelectorAll: () => [] },
      Number,
    };
    ctx.tripEditableByMe = lift('tripEditableByMe', ctx);
    const offer = lift('offerTripUpdateFromTrain', ctx);
    return { state, toasts, offer, dirty: () => dirty };
  };

  test('the trips built from the set are updated after a confirmation, not those of a read-only scenario', () => {
    const t = setUp(true);
    t.offer(BEFORE, { label: 'Zurich-Bern', data: JSON.stringify(AFTER) });
    expect(t.state.tripRequirements.map((tr) => tr.legs[0].vehicleNumber)).toEqual(['OSDM_104', 'OSDM-104']);
    expect(t.dirty()).toBe(1);
    expect(t.toasts[0]).toContain('1 trip(s) updated from "Zurich-Bern"');
  });

  test('nothing changes without the confirmation', () => {
    const t = setUp(false);
    t.offer(BEFORE, { label: 'Zurich-Bern', data: AFTER });
    expect(t.state.tripRequirements.map((tr) => tr.legs[0].vehicleNumber)).toEqual(['OSDM-104', 'OSDM-104']);
    expect(t.dirty()).toBe(0);
  });

  test('the train save offers it, for a set that was saved before', () => {
    expect(source).toContain('const before = isNew ? null : structuredClone(OscarTripApply.resourceData(t));');
    expect(source).toContain('if (before) offerTripUpdateFromTrain(before, saved);');
  });
});
