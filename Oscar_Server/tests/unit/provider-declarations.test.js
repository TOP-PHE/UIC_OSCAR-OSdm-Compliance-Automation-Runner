// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #809, from two real providers' runs: a trip specification is never sent with
 * an empty carrier; "no passenger update" in the Test Framework holds at run
 * time; a provider can say it takes no purchaser after the booking.
 */

const fs = require('node:fs');
const path = require('node:path');
const { withBrunoExpect } = require('../helpers/bruno-chai');
const U = require('../../src/utils/undeclaredSteps');
const { annotateDatafile } = require('../../src/utils/frameworkGating');
const { missingFor } = require('../../src/utils/scenarioCatalogue');

let envStore = {};
global.bru = {
  getEnvVar: (k) => (Object.hasOwn(envStore, k) ? envStore[k] : undefined),
  setEnvVar: (k, v) => { envStore[k] = v; },
  deleteEnvVar: (k) => { delete envStore[k]; },
  getVar: () => undefined,
  setVar: () => {},
};
let mockLogs = [];
const sp = require('../../../Bruno_Collection/library-bruno/scenarioParser.js');
// The collection logs through the global displays.js sets.
global.validationLogger = (line) => { mockLogs.push(line); };

const SIMULATOR_FILE = path.join(__dirname, '..', '..', '..', 'Bruno_Collection', 'data_base', 'simulator_datafile.json');
const simulatorFile = () => JSON.parse(fs.readFileSync(SIMULATOR_FILE, 'utf8'));

describe('#809 a trip specification names its carrier, or says why it cannot', () => {
  // The offer request's trip specification and the parser's checks, for a
  // specification scenario of the simulator after `change` is applied to its trip.
  function parse(change) {
    envStore = {}; mockLogs = [];
    const file = simulatorFile();
    const scenario = file.scenarios.find((s) => s.code === 'SIM_SALE_SEAT_PREFERENCE_1ADT_38');
    change(file.tripRequirements.find((t) => t.id === scenario.tripRequirementId));
    envStore.scenario_override = scenario.code;
    const checks = [];
    const jestTest = global.test;
    global.test = (name, fn) => { try { fn(); checks.push([name, true]); } catch (e) { checks.push([name, false, e.message]); } };
    try { withBrunoExpect(() => sp.parseScenarioData(file)); } finally { global.test = jestTest; }
    return { spec: JSON.parse(envStore.offerTripSpecifications)[0], checks };
  }
  const carrierChecks = (checks) => checks.filter(([name]) => name.includes('names its carrier'));

  test('with an operator code: the carrier is sent, and no check is added', () => {
    const { spec, checks } = parse(() => {});
    expect(spec.legs[0].timedLeg.service.carriers).toEqual([{ ref: 'urn:x_osdm_simulator:carrier:gamma' }]);
    expect(carrierChecks(checks)).toEqual([]);
  });

  test.each([['absent', (leg) => { delete leg.operatorCode; }], ['empty', (leg) => { leg.operatorCode = ''; }], ['blank', (leg) => { leg.operatorCode = '  '; }]])(
    'operator code %s: no carriers member at all, a failed check and an [ERROR] naming the train and the fix', (_, f) => {
      const { spec, checks } = parse((trip) => f(trip.legs[0]));
      expect(spec.legs[0].timedLeg.service).not.toHaveProperty('carriers');
      expect(JSON.stringify(spec)).not.toContain('{}');
      const [check] = carrierChecks(checks);
      expect(check[0]).toBe('Trip specification leg 1 names its carrier (operator code)');
      expect(check[1]).toBe(false);
      expect(check[2]).toContain('Give the train its operator code in Test Data');
      expect(mockLogs.some((l) => l.startsWith('[ERROR] Leg 1 (train '))).toBe(true);
    });

  test('every specification trip of the simulator names its carrier', () => {
    for (const trip of simulatorFile().tripRequirements.filter((t) => t.tripType === 'SPECIFICATION')) {
      for (const leg of trip.legs) expect(leg.operatorCode).toBe('urn:x_osdm_simulator:carrier:gamma');
    }
  });

  test('the two warnings read the Test Framework\'s words', () => {
    const sc = { code: 'X' };
    expect(sp.featureNotDeclaredWarning(sc, 'passengerUpdate')).toContain('Step 03 is skipped in this run');
    expect(sp.featureNotDeclaredWarning(sc, 'purchaserAfterBooking')).toContain('POST /bookings/{id}/purchaser');
  });
});

describe('#809 steps the provider does not offer', () => {
  const noUpdate = { passengerUpdate: false };
  const noLatePurchaser = { purchaserAfterBooking: false };

  test('a scenario updates its passengers unless it says false, as the collection reads it', () => {
    expect(U.updatesPassengers({})).toBe(true);
    expect(U.updatesPassengers({ salesFlowActions: {} })).toBe(true);
    expect(U.updatesPassengers({ salesFlowActions: { patchPassengers: true } })).toBe(true);
    for (const v of [false, 'false', 'true', null]) expect(U.updatesPassengers({ salesFlowActions: { patchPassengers: v } })).toBe(false);
  });

  test('warnings only where the framework says false and the scenario uses the step', () => {
    expect(U.undeclaredStepWarnings({}, {})).toEqual([]);
    expect(U.undeclaredStepWarnings({}, noUpdate)).toEqual(['passengerUpdate']);
    expect(U.undeclaredStepWarnings({ salesFlowActions: { patchPassengers: false } }, noUpdate)).toEqual([]);
    expect(U.undeclaredStepWarnings({ bookingPurchaserMode: ' Deferred ' }, noLatePurchaser)).toEqual(['purchaserAfterBooking']);
    expect(U.undeclaredStepWarnings({ bookingPurchaserMode: 'invalid' }, noLatePurchaser)).toEqual([]);
    expect(U.undeclaredStepWarnings({ bookingPurchaserMode: 'deferred' }, { purchaserAfterBooking: true })).toEqual([]);
  });

  test('the annotation carries them, so the run log says so', () => {
    const datafile = { scenarios: [{ code: 'A' }, { code: 'B', bookingPurchaserMode: 'deferred', salesFlowActions: { patchPassengers: false } }] };
    annotateDatafile(datafile, { ...noUpdate, ...noLatePurchaser });
    expect(datafile.scenarios[0].__featureNotDeclaredWarnings).toContain('passengerUpdate');
    expect(datafile.scenarios[1].__featureNotDeclaredWarnings).toContain('purchaserAfterBooking');
    expect(datafile.scenarios[1].__featureNotDeclaredWarnings).not.toContain('passengerUpdate');
  });

  test('the run\'s copy turns the passenger update off, keeping the other actions; nothing when the framework allows it', () => {
    const datafile = { scenarios: [null, { code: 'A', salesFlowActions: { getBooking: false } }, { code: 'B' }, { code: 'C', salesFlowActions: { patchPassengers: false } }] };
    expect(U.withoutUndeclaredPassengerUpdate(structuredClone(datafile), {})).toBe(0);
    expect(U.withoutUndeclaredPassengerUpdate(datafile, noUpdate)).toBe(2);
    expect(datafile.scenarios[1].salesFlowActions).toEqual({ getBooking: false, patchPassengers: false });
    expect(datafile.scenarios[2].salesFlowActions).toEqual({ patchPassengers: false });
    expect(U.withoutUndeclaredPassengerUpdate({}, noUpdate)).toBe(0);
  });

  test('the catalogue refuses a late purchaser to a provider without it, and only then', () => {
    const req = { salesFlows: [], passengerTypes: [], purchaserAfterBooking: true };
    const fw = { salesFlows: [] };
    expect(missingFor(req, { ...fw, purchaserAfterBooking: false })).toContain('a purchaser written after the booking (Passenger Types)');
    expect(missingFor(req, fw)).toEqual([]);
    expect(missingFor({ ...req, purchaserAfterBooking: false }, { ...fw, purchaserAfterBooking: false })).toEqual([]);
  });
});
