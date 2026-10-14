// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-search-filter.test.js — #719: the trip search's data filter writes
 * only the members it has. OSDM 3.8 makes none of them nullable, and a real
 * provider refuses `"lineNumbers": null` as a malformed request.
 */

let envStore = {};
global.bru = {
  getEnvVar:    (k) => (Object.prototype.hasOwnProperty.call(envStore, k) ? envStore[k] : undefined),
  setEnvVar:    (k, v) => { envStore[k] = v; },
  deleteEnvVar: (k) => { delete envStore[k]; },
  getVar:       () => undefined,
  setVar:       () => {},
};
global.validationLogger = () => {};

const sp = require('../../../Bruno_Collection/library-bruno/scenarioParser.js');
const { TripLegDefinition, VehicleFilter, CarrierFilter, TripDataFilter } = require('../../../Bruno_Collection/library-bruno/model.js');
const { withBrunoExpect } = require('../helpers/bruno-chai');

beforeEach(() => { envStore = { osdmVersion: '3.8.0' }; });

function searchFor(vehicleNumber, operatorCode, searchCriteria = { trainFilter: 'true' }) {
  const jestTest = global.test;
  global.test = (name, fn) => fn();
  try {
    withBrunoExpect(() => sp.osdmTripSearchCriteria([
      new TripLegDefinition('urn:uic:stn:5457076', '2026-10-24T09:37:00', 'urn:uic:stn:5433295', null, null, null, null, vehicleNumber, operatorCode),
    ], null, searchCriteria));
  } finally {
    global.test = jestTest;
  }
  return JSON.parse(envStore.offerTripSearchCriteria);
}

// Every null anywhere in a value, by path.
function nullsIn(value, path = '') {
  if (value === null) return [path];
  if (typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([k, v]) => nullsIn(v, `${path}.${k}`));
}

describe('the trip search filter', () => {
  test('a train only: the vehicle filter, with no line numbers and no carrier filter', () => {
    const tsc = searchFor('277', null);
    expect(tsc.parameters.dataFilter).toEqual({ vehicleFilter: { vehicleNumbers: ['277'], exclude: false } });
    expect(nullsIn(tsc.parameters)).toEqual([]);
  });

  test('an operator only: the carrier filter, and no vehicle filter', () => {
    const tsc = searchFor(null, 'urn:uic:rics:1154');
    expect(tsc.parameters.dataFilter).toEqual({ carrierFilter: { carriers: ['urn:uic:rics:1154'], exclude: false } });
    expect(nullsIn(tsc.parameters)).toEqual([]);
  });

  test('both: both filters', () => {
    const tsc = searchFor('277', 'urn:uic:rics:1154');
    expect(Object.keys(tsc.parameters.dataFilter).sort()).toEqual(['carrierFilter', 'vehicleFilter']);
  });

  test('neither: no data filter at all', () => {
    expect(searchFor(null, null).parameters?.dataFilter).toBeUndefined();
  });

  // #722: the filter is the train filter's own test; any other search goes by
  // place and time, and the train is chosen in the answer.
  test('without the train filter: no parameters at all, whatever the trip names', () => {
    for (const criteria of [null, {}, { trainFilter: '' }, { trainFilter: 'false' }]) {
      const tsc = searchFor('277', 'urn:uic:rics:1154', criteria);
      expect(tsc.parameters).toBeUndefined();
      expect(envStore.__searchTrainFilter).toBe('');
    }
    searchFor('277', null, { trainFilter: true });
    expect(envStore.__searchTrainFilter).toBe('true');
  });

  test('the classes write what they are given, and nothing unset', () => {
    expect(JSON.parse(JSON.stringify(new VehicleFilter(['1'])))).toEqual({ vehicleNumbers: ['1'], exclude: true });
    expect(JSON.parse(JSON.stringify(new VehicleFilter(null, ['S1'], false)))).toEqual({ lineNumbers: ['S1'], exclude: false });
    expect(JSON.parse(JSON.stringify(new VehicleFilter(['1'], null, null)))).toEqual({ vehicleNumbers: ['1'] });
    expect(JSON.parse(JSON.stringify(new CarrierFilter(['x'], undefined)))).toEqual({ carriers: ['x'], exclude: true });
    expect(JSON.parse(JSON.stringify(new TripDataFilter(null, null)))).toEqual({});
  });
});
