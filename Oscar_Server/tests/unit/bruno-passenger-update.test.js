// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-passenger-update.test.js — which passengers step 03 updates, and what
 * steps 03/04 then expect (passengerUpdateScope; a member the provider does
 * not return is a WARNING, a different one a FAIL).
 */

const path = require('node:path');
const { withBrunoExpect } = require('../helpers/bruno-chai');

let envStore = {};
let varStore = {};
global.bru = {
  getEnvVar:    (k) => (Object.prototype.hasOwnProperty.call(envStore, k) ? envStore[k] : undefined),
  setEnvVar:    (k, v) => { envStore[k] = v; },
  deleteEnvVar: (k) => { delete envStore[k]; },
  getVar:       (k) => (Object.prototype.hasOwnProperty.call(varStore, k) ? varStore[k] : undefined),
  setVar:       (k, v) => { varStore[k] = v; },
};

let mockResults = [];
let mockLogs = [];
jest.mock('../../../Bruno_Collection/library-bruno/displays.js', () => ({
  ...jest.requireActual('../../../Bruno_Collection/library-bruno/displays.js'),
  validationLogger: (line) => { mockLogs.push(line); },
}));
jest.mock('../../../Bruno_Collection/library-bruno/testCapture.js', () => ({
  bruTest: (name, fn) => {
    try { fn(); mockResults.push({ name, ok: true }); } catch (e) { mockResults.push({ name, ok: false, message: e.message }); }
  },
}));

const sp = require('../../../Bruno_Collection/library-bruno/scenarioParser.js');
const { patchMultiPassengerResponse } = require('../../../Bruno_Collection/library-bruno/passengers.js');
global.validationLogger = () => {};

const SIMULATOR_FILE = path.join(__dirname, '..', '..', '..', 'Bruno_Collection', 'data_base', 'simulator_datafile.json');

beforeEach(() => { envStore = {}; varStore = {}; mockResults = []; mockLogs = []; });

// The passengerAdditionalData the parser gives a two-adult scenario of the
// simulator's data file, after `change` is applied to that scenario.
function expectedAfterParse(change) {
  const file = JSON.parse(require('node:fs').readFileSync(SIMULATOR_FILE, 'utf8'));
  const scenario = file.scenarios.find((s) => s.code === 'SIM_SALE_SEARCH_2ADT_SAVER_38');
  change(scenario);
  envStore.scenario_override = scenario.code;
  // The parser calls Bruno's own `test` as it goes; Jest's cannot nest.
  const jestTest = global.test;
  global.test = (name, fn) => { try { fn(); } catch { /* not what this file checks */ } };
  try { withBrunoExpect(() => sp.parseScenarioData(file)); } finally { global.test = jestTest; }
  const passengers = file.passengersList.find((l) => l.id === scenario.passengersListId).passengers;
  return { data: JSON.parse(envStore.passengerAdditionalData), passengers, scope: envStore.passengerUpdateScope };
}

describe('passengerUpdateScope', () => {
  test('MAIN in any case is MAIN; anything else is ALL', () => {
    expect(sp.passengerUpdateScope({ passengerUpdateScope: 'main' })).toBe('MAIN');
    expect(sp.passengerUpdateScope({ passengerUpdateScope: 'MAIN' })).toBe('MAIN');
    for (const value of ['ALL', '', null, undefined, 'OTHER']) {
      expect(sp.passengerUpdateScope({ passengerUpdateScope: value })).toBe('ALL');
    }
    expect(sp.passengerUpdateScope(undefined)).toBe('ALL');
  });

  test('ALL: every passenger is expected with the update values', () => {
    const { data, passengers, scope } = expectedAfterParse(() => {});
    expect(scope).toBe('ALL');
    expect(data.map((d) => d.updateFirstName)).toEqual(passengers.map((p) => p.updateFirstName ?? p.firstName));
  });

  test('MAIN: only the first passenger is expected with the update values', () => {
    const { data, passengers, scope } = expectedAfterParse((s) => { s.passengerUpdateScope = 'MAIN'; });
    expect(scope).toBe('MAIN');
    expect(data[0].updateFirstName).toBe(passengers[0].updateFirstName ?? passengers[0].firstName);
    expect(data[1].updateFirstName).toBe(passengers[1].firstName);
    expect(data[1].updateDateOfBirth).toBe(passengers[1].dateOfBirth);
  });

  test('no passenger update: every passenger is expected as booked', () => {
    const { data, passengers } = expectedAfterParse((s) => {
      s.salesFlowActions = { ...s.salesFlowActions, patchPassengers: false };
    });
    expect(data.map((d) => d.updateFirstName)).toEqual(passengers.map((p) => p.firstName));
    expect(data.map((d) => d.updateDateOfBirth)).toEqual(passengers.map((p) => p.dateOfBirth));
  });
});

describe('patchMultiPassengerResponse: a member not returned', () => {
  const sent = {
    updateFirstName: 'Ana', updateLastName: 'Example', updateDateOfBirth: '1990-01-02',
    updateEmail: 'ana@example.org', updatePhoneNumber: '+33100000000', updateGender: 'X',
  };
  const run = (passenger) => {
    envStore.offerPassengerNumber = '1';
    envStore.passengerAdditionalData = JSON.stringify([sent]);
    withBrunoExpect(() => patchMultiPassengerResponse({ passenger: { id: 'P1', type: 'PERSON', ...passenger } }, 0));
    return mockResults;
  };
  const failed = (results) => results.filter((r) => !r.ok).map((r) => r.name);

  test('all returned and equal: no failure, no warning', () => {
    const results = run({
      dateOfBirth: sent.updateDateOfBirth,
      detail: { firstName: 'Ana', lastName: 'Example', contact: { email: sent.updateEmail, phoneNumber: sent.updatePhoneNumber } },
    });
    expect(failed(results)).toEqual([]);
    expect(mockLogs.filter((l) => l.startsWith('[WARNING]'))).toEqual([]);
  });

  test('names only (no date of birth, no contact): three warnings, no failure', () => {
    const results = run({ detail: { firstName: 'Ana', lastName: 'Example' } });
    expect(failed(results)).toEqual([]);
    const warnings = mockLogs.filter((l) => l.startsWith('[WARNING]'));
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('Date of birth not returned by the provider (sent: 1990-01-02)');
    expect(results.map((r) => r.name)).toContain('Passenger 0 - Email not returned by the provider (WARNING, optional member)');
  });

  test('a different value fails', () => {
    const results = run({ dateOfBirth: '1990-01-03', detail: { firstName: 'Anna', lastName: 'Example' } });
    expect(failed(results)).toEqual([
      'Passenger 0 - First name is correct (expected: Ana, actual: Anna)',
      'Passenger 0 - Date of birth is correct (expected: 1990-01-02, actual: 1990-01-03)',
    ]);
  });
});
