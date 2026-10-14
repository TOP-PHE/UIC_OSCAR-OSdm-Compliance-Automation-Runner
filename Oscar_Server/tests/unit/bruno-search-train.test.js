// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-search-train.test.js — #722: a search goes by place and time, and the
 * train is chosen in the answer; the train filter is tested on its own.
 */

let envStore = {};
global.bru = {
  getEnvVar:    (k) => (Object.prototype.hasOwnProperty.call(envStore, k) ? envStore[k] : undefined),
  setEnvVar:    (k, v) => { envStore[k] = v; },
  deleteEnvVar: (k) => { delete envStore[k]; },
};
let mockResults = [];
let mockLogs = [];
jest.mock('../../../Bruno_Collection/library-bruno/displays.js', () => ({
  validationLogger: (line) => { mockLogs.push(line); },
  logStepStart: () => {},
}));
jest.mock('../../../Bruno_Collection/library-bruno/testCapture.js', () => ({
  bruTest: (name, fn) => {
    try { fn(); mockResults.push({ name, ok: true }); } catch (e) { mockResults.push({ name, ok: false, message: e.message }); }
  },
  expectTypeOrNull: () => {},
  expectScale: () => {},
}));
global.validationLogger = (line) => { mockLogs.push(line); };

const st = require('../../../Bruno_Collection/library-bruno/searchTrain.js');
const { searchTripOffers } = require('../../../Bruno_Collection/library-bruno/offers.js');

const trip = (id, start, ...numbers) => ({
  id,
  startTime: start,
  legs: numbers.map((n) => ({ timedLeg: { service: { vehicleNumbers: [n] } } })),
});
const offer = (offerId, tripId) => ({ offerId, tripCoverage: { coveredTripId: tripId } });
const partOffer = (offerId, tripId) => ({ offerId, admissionOfferParts: [{ tripCoverage: { coveredTripId: tripId } }] });

const answer = {
  trips: [
    trip('T1', '2026-10-24T07:30:00+02:00', '101'),
    trip('T2', '2026-10-24T08:15:00+02:00', '277'),
    trip('T3', '2026-10-24T09:00:00+02:00', '103', '104'),
  ],
  offers: [offer('O1', 'T1'), offer('O2a', 'T2'), partOffer('O2b', 'T2'), offer('O3', 'T3')],
};
const ids = (offers) => offers.map((o) => o.offerId);

describe('trainFilterOn', () => {
  test('only "true" or true turns it on', () => {
    expect(st.trainFilterOn({ trainFilter: 'true' })).toBe(true);
    expect(st.trainFilterOn({ trainFilter: ' TRUE ' })).toBe(true);
    expect(st.trainFilterOn({ trainFilter: true })).toBe(true);
    for (const off of [undefined, null, {}, { trainFilter: '' }, { trainFilter: 'false' }, { trainFilter: 'on' }]) {
      expect(st.trainFilterOn(off)).toBe(false);
    }
  });
});

describe('offersOnSearchTrip', () => {
  test('the trip of the Test Data train, by its offers or its parts', () => {
    const r = st.offersOnSearchTrip(answer, { vehicleNumber: '277', departureTime: '2026-10-24T07:00:00' });
    expect(ids(r.offers)).toEqual(['O2a', 'O2b']);
    expect(r.tripId).toBe('T2');
    expect(r.lines).toEqual([expect.stringMatching(/^\[INFO\] .*3 trips.*2 of 4 offer\(s\).*train 277/)]);
  });

  test('a train of a connection counts', () => {
    expect(ids(st.offersOnSearchTrip(answer, { vehicleNumber: '104' }).offers)).toEqual(['O3']);
  });

  test('no train named: the first trip leaving at the time asked or later', () => {
    const r = st.offersOnSearchTrip(answer, { departureTime: '2026-10-24T08:00:00' });
    expect(ids(r.offers)).toEqual(['O2a', 'O2b']);
    expect(r.lines.every((l) => l.startsWith('[INFO]'))).toBe(true);
  });

  test('the train not in the answer: a warning, then the time', () => {
    const r = st.offersOnSearchTrip(answer, { vehicleNumber: '999', departureTime: '2026-10-24T08:30:00' });
    expect(ids(r.offers)).toEqual(['O3']);
    expect(r.lines[0]).toMatch(/^\[WARNING\] .*no trip of the answer runs train 999/);
  });

  test('nothing at the time asked or later: every offer kept, with a warning', () => {
    const r = st.offersOnSearchTrip(answer, { departureTime: '2026-10-24T22:00:00' });
    expect(ids(r.offers)).toEqual(ids(answer.offers));
    expect(r.tripId).toBeNull();
    expect(r.lines).toEqual([expect.stringMatching(/^\[WARNING\] .*no trip of the answer leaves at 22:00/)]);
  });

  test('one trip: every offer kept, quietly when it is the train asked', () => {
    const one = { trips: [trip('T', '2026-10-24T08:00:00+02:00', '277')], offers: [offer('A', 'T'), { offerId: 'B' }] };
    expect(st.offersOnSearchTrip(one, { vehicleNumber: '277' })).toEqual({ offers: one.offers, lines: [], tripId: 'T' });
    const other = st.offersOnSearchTrip(one, { vehicleNumber: '5' });
    expect(ids(other.offers)).toEqual(['A', 'B']);
    expect(other.lines).toHaveLength(2);
    expect(other.lines[1]).toMatch(/^\[WARNING\] .*the one trip of the answer \(train 277\) is used/);
  });

  test('offers that name no trip are not dropped', () => {
    const blind = { trips: answer.trips, offers: [{ offerId: 'X' }, { offerId: 'Y' }] };
    const r = st.offersOnSearchTrip(blind, { vehicleNumber: '277' });
    expect(ids(r.offers)).toEqual(['X', 'Y']);
    expect(r.lines[0]).toMatch(/^\[WARNING\] .*no offer names the trip/);
  });

  test('no trips in the answer, or no answer: as it is, no line', () => {
    expect(st.offersOnSearchTrip({ offers: [offer('A', 'T')] }, { vehicleNumber: '1' })).toEqual({ offers: [offer('A', 'T')], lines: [], tripId: null });
    expect(st.offersOnSearchTrip(null, {})).toEqual({ offers: [], lines: [], tripId: null });
  });
});

describe('checkTrainFilter', () => {
  const byName = (checks) => Object.fromEntries(checks.map((c) => [c.level || 'fail', c]));

  test('a trip of the train, and only that train: both pass', () => {
    const c = byName(st.checkTrainFilter({ trips: [trip('T', 'x', '277')] }, '277'));
    expect(c.fail.ok).toBe(true);
    expect(c.warn.ok).toBe(true);
  });

  test('the train with others: the warning only', () => {
    const c = byName(st.checkTrainFilter(answer, '277'));
    expect(c.fail.ok).toBe(true);
    expect(c.warn.ok).toBe(false);
    expect(c.warn.message).toBe('other trains in the answer: 101, 103+104');
  });

  test('not the train: a failure naming the trains given', () => {
    const c = byName(st.checkTrainFilter({ trips: [trip('T', 'x', '101')] }, '277'));
    expect(c.fail.ok).toBe(false);
    expect(c.fail.message).toBe('trains of the answer: 101');
    expect(byName(st.checkTrainFilter({ trips: [] }, '277')).fail.message).toBe('the answer holds no trip');
  });

  test('no train named: nothing to check', () => {
    expect(st.checkTrainFilter(answer, '')).toEqual([]);
    expect(st.checkTrainFilter(answer, null)).toEqual([]);
  });
});

describe('searchTripOffers (offers.js)', () => {
  const oneWay = (extra = {}) => ({
    TripType: 'SEARCH',
    tripVehicleNumber: '277',
    offerTripSearchCriteria: JSON.stringify({ departureTime: '2026-10-24T07:00:00' }),
    ...extra,
  });
  beforeEach(() => { mockResults = []; mockLogs = []; });

  test('a one-way search keeps the offers of the train, and says so when asked', () => {
    envStore = oneWay();
    expect(ids(searchTripOffers(answer))).toEqual(['O2a', 'O2b']);
    expect(mockLogs).toEqual([]);
    expect(ids(searchTripOffers(answer, { log: true }))).toEqual(['O2a', 'O2b']);
    expect(mockLogs).toHaveLength(1);
    expect(mockResults).toEqual([]);
  });

  test('a specification, offers by trip id, or a return: every offer', () => {
    for (const env of [oneWay({ TripType: 'SPECIFICATION' }), oneWay({ offersByTripIds: 'true' }), oneWay({ returnInboundDate: '2026-10-30' })]) {
      envStore = env;
      expect(ids(searchTripOffers(answer, { log: true }))).toEqual(ids(answer.offers));
    }
    expect(mockLogs).toEqual([]);
  });

  test('with the train filter sent: its checks are recorded', () => {
    envStore = oneWay({ __searchTrainFilter: 'true' });
    searchTripOffers(answer, { log: true });
    expect(mockResults).toEqual([{ name: expect.stringContaining('the answer holds a trip of train 277'), ok: true }]);
    expect(mockLogs[0]).toMatch(/^\[WARNING\] .*every trip of the answer runs train 277 — other trains in the answer: 101, 103\+104/);
  });
});
