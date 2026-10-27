// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #838: the reference configurations of the simulated providers. The stored
 * files are what the generator gives from the checklists, the simulator's
 * profiles and the data file; they agree with the simulator; and each gives
 * a full configuration the import (#810) takes.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const R = require('../../src/utils/referenceConfiguration');
const B = require('../../src/utils/configurationBundle');
const { referenceOf, textOf, OUT_DIR } = require('../../scripts/generate-reference-configurations');

const REPO = path.resolve(__dirname, '..', '..', '..');
const DATAFILE_TEXT = fs.readFileSync(path.join(REPO, 'Bruno_Collection', 'data_base', R.DATAFILE_NAME), 'utf8');
const DATAFILE = JSON.parse(DATAFILE_TEXT);
const profileOf = p => JSON.parse(fs.readFileSync(path.join(REPO, 'OSDM_Simulator', 'providers', `${p}.json`), 'utf8'));
const storedOf = p => fs.readFileSync(path.join(OUT_DIR, `${R.referenceName(p)}.json`), 'utf8');

// A top-level function of scenarios.js, with the `const` lines it needs.
const PAGE = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'scenarios.js'), 'utf8').split('\n');
function lift(name) {
  const start = PAGE.findIndex(l => l.startsWith(`function ${name}(`));
  const end = PAGE.findIndex((l, i) => i > start && l === '}');
  return PAGE.slice(start, end + 1).join('\n');
}
// A top-level `const` of the page, to the line that ends it.
function pageConst(name) {
  const start = PAGE.findIndex(l => l.startsWith(`const ${name} =`));
  const end = PAGE.findIndex((l, i) => i >= start && l.trimEnd().endsWith(';'));
  return PAGE.slice(start, end + 1).join('\n') + '\n';
}

describe.each(R.PROVIDERS)('the reference of %s', (provider) => {
  const stored = JSON.parse(storedOf(provider));
  const profile = profileOf(provider);

  test('is what the generator gives (regenerate with scripts/generate-reference-configurations.js)', () => {
    expect(storedOf(provider)).toBe(textOf(referenceOf(provider)));
  });

  test('declares everything its run list asks: no scenario of it is warned (#949)', () => {
    const datafile = structuredClone(DATAFILE);
    require('../../src/utils/frameworkGating').annotateDatafile(datafile, stored.framework);
    const run = new Set(stored.scenariosToRun);
    const warned = datafile.scenarios
      .filter(s => run.has(s.code) && s.__featureNotDeclaredWarnings)
      .map(s => `${s.code}: ${s.__featureNotDeclaredWarnings.join(', ')}`);
    expect(run.size).toBeGreaterThan(100);
    expect(warned).toEqual([]);
  });

  test('agrees with the simulator: version, currencies, return models', () => {
    const fw = stored.framework;
    expect(fw.osdmVersion).toBe(profile.osdmVersion);
    expect(fw.currencies.default).toBe(profile.currency);
    expect([...fw.currencies.sold].sort()).toEqual([profile.currency, ...Object.keys(profile.otherCurrencies || {})].sort());
    expect(fw.returnModels).toEqual(profile.osdmVersion.startsWith('3.6') ? ['SEPARATE'] : ['SEPARATE', 'COMBINED']);
    expect(fw.ancillaries).toEqual([]);
    for (const code of R.IROPS_MANDATORY) expect(fw.iropsCodes.refund).toContain(code);
  });

  test('runs the scenarios of its version, none that fails on purpose', () => {
    expect(stored.scenariosToRun.length).toBeGreaterThan(0);
    const byCode = new Map(DATAFILE.scenarios.map(s => [s.code, s]));
    for (const code of stored.scenariosToRun) {
      expect(byCode.get(code).osdmVersion).toBe(profile.osdmVersion);
      expect(code).not.toMatch(/^SIM_(WRONG|FAULT)_/);
    }
  });

  test('gives a full configuration the import reads, with the provider\'s run list', () => {
    const conf = R.configurationOf(stored, DATAFILE, { version: R.versionOf(stored, DATAFILE_TEXT), at: '2026-10-18T00:00:00Z' });
    const read = B.readConfiguration(conf);
    expect(read.refusal).toBeUndefined();
    expect(read.configuration.datafile.scenariosToRun).toEqual(stored.scenariosToRun);
    // #914: the provider's scenarios only, every one of its version, with what they name.
    const part = R.providerPartOf(DATAFILE, profile.osdmVersion);
    expect(read.configuration.datafile.scenarios.map(s => s.code)).toEqual(part.scenarios.map(s => s.code));
    expect(read.configuration.datafile.scenarios.every(s => s.osdmVersion === profile.osdmVersion)).toBe(true);
    expect(read.configuration.datafile.tripRequirements).toEqual(part.tripRequirements);
    for (const code of stored.scenariosToRun) expect(part.scenarios.some(s => s.code === code)).toBe(true);
    expect(conf[B.CONFIGURATION_KEY].reference).toEqual({ name: R.referenceName(provider), version: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(DATAFILE.scenariosToRun).not.toBe(read.configuration.datafile.scenariosToRun);
  });
});

test('gamma\'s run list is the data file\'s own', () => {
  expect(JSON.parse(storedOf('gamma')).scenariosToRun).toEqual(DATAFILE.scenariosToRun);
});

describe('the Test Data', () => {
  const resources = R.testResourcesFromDatafile(DATAFILE);
  const trains = resources.filter(r => r.resource_type === 'TRAIN');
  const journeys = resources.filter(r => r.resource_type === 'JOURNEY');

  test('one train per distinct leg, one journey per trip of several legs naming them', () => {
    const multi = DATAFILE.tripRequirements.filter(t => t.tripType === 'SPECIFICATION' && t.legs.length > 1);
    expect(journeys).toHaveLength(multi.length);
    const ids = new Set(trains.map(t => t.id));
    for (const j of journeys) for (const leg of j.data.legs) expect(ids.has(leg.trainResourceId)).toBe(true);
    expect(new Set(resources.map(r => r.id)).size).toBe(resources.length);
    expect(new Set(trains.map(t => JSON.stringify(t.data))).size).toBe(trains.length);
  });

  test('a one-leg trip gives the train the page would make from it (trainFromTrip)', () => {
    const ctx = vm.createContext({});
    vm.runInContext(`${lift('trainFromTrip')}\nthis.trainFromTrip = trainFromTrip;`, ctx);
    // #1022: provider by provider, as a reference is made. Each provider has
    // its copy of the trips naming a carrier, which differ from gamma's in the
    // carrier only: one train of the whole file stands for all of them.
    const checked = new Set();
    for (const version of new Set(DATAFILE.scenarios.map(s => s.osdmVersion))) {
      const part = R.providerPartOf(DATAFILE, version);
      const own = R.testResourcesFromDatafile(part).filter(r => r.resource_type === 'TRAIN');
      for (const [i, trip] of part.tripRequirements.entries()) {
        checked.add(trip.id);
        const legs = trip.tripType === 'SPECIFICATION' ? trip.legs : [trip.trip];
        if (legs.length !== 1) continue;
        const fromPage = ctx.trainFromTrip(trip, i).data;
        expect(own.some(t => JSON.stringify(t.data) === JSON.stringify(fromPage))).toBe(true);
      }
    }
    expect(checked.size).toBe(DATAFILE.tripRequirements.length);
  });
});

describe('the framework from the checklist', () => {
  test('the defaults are the page\'s emptyFramework()', () => {
    const ctx = vm.createContext({});
    vm.runInContext(`${pageConst('WIZ_IROPS_MANDATORY')}${pageConst('OSDM_ANCILLARY_TYPES')}${lift('emptyFramework')}\nthis.f = emptyFramework();`, ctx);
    expect(R.defaultFramework()).toEqual(JSON.parse(JSON.stringify(ctx.f)));
  });

  test('ticks, texts and numbers go to their place; a list asked with nothing ticked is empty', () => {
    const fw = R.frameworkFromChecklist({
      'fw.osdmVersion=3.7': true,
      'fw.salesFlows=SALE': true, 'fw.salesFlows=REFUND_FULL': true, 'fw.salesFlows.comment': 'x',
      'fw.ancillaries.comment': 'none',
      'fw.iropsCodes.refund=PAYMENT_FAILURE': true,
      'fw.maxPassengers': '9', 'fw.passengerAgeRanges.CHILD.min': '4',
      'fw.currencies.sold': 'CHF, EUR', 'fw.currencies.default': 'CHF',
      'fw.placeSelection.supportedModes=ADD_TO_BOOKING': true,
      'data.reductionCards=YES': true,
    });
    expect(fw).toMatchObject({ osdmVersion: '3.7', salesFlows: ['SALE', 'REFUND_FULL'], ancillaries: [], maxPassengers: 9,
      currencies: { sold: ['CHF', 'EUR'], default: 'CHF' }, placeSelection: { seatMap: false, supportedModes: ['ADD_TO_BOOKING'] } });
    expect(fw.passengerAgeRanges.CHILD).toEqual({ min: 4, max: 15 });
    expect(fw.iropsCodes.refund).toEqual([...R.IROPS_MANDATORY, 'PAYMENT_FAILURE']);
    expect(fw.iropsCodes.exchange).toEqual([...R.IROPS_MANDATORY]);
    expect(fw.rail).toEqual(R.defaultFramework().rail);
  });

  test('a question the reference does not place stops the generator', () => {
    expect(() => R.frameworkFromChecklist({ 'fw.newQuestion=X': true })).toThrow(/fw\.newQuestion/);
  });

  test('a checklist and a profile of different versions are refused', () => {
    expect(() => R.buildReference({ provider: 'alpha', profile: { osdmVersion: '3.8.0' }, answers: { 'fw.osdmVersion=3.6': true }, datafile: DATAFILE }))
      .toThrow(/3\.6.*3\.8\.0/);
    expect(() => R.buildReference({ provider: 'delta', profile: {}, answers: {}, datafile: DATAFILE })).toThrow(/delta/);
    // #920: 3.1 is not 3.10, though "3.10.0" starts with "3.1".
    expect(() => R.buildReference({ provider: 'epsilon', profile: { osdmVersion: '3.10.0' }, answers: { 'fw.osdmVersion=3.1': true }, datafile: DATAFILE }))
      .toThrow(/3\.1.*3\.10\.0/);
  });
});

describe('a version per provider (#912)', () => {
  const ref = JSON.parse(storedOf('delta'));
  const version = (datafile) => R.versionOf(ref, datafile);
  const copy = () => JSON.parse(DATAFILE_TEXT);
  const own = (df) => df.scenarios.find(s => s.osdmVersion === '3.9.0');

  test('the text or the parsed file give the same version; formatting does not count', () => {
    expect(version(DATAFILE_TEXT)).toBe(version(DATAFILE));
    expect(version(DATAFILE_TEXT + ' ')).toBe(version(DATAFILE));
  });

  test('a scenario, trip or passenger list added for another provider leaves it as it is', () => {
    const df = copy();
    const tripId = Math.max(...df.tripRequirements.map(t => t.id)) + 1;
    df.tripRequirements.push({ id: tripId, tripType: 'SEARCH', trip: { origin: 'urn:uic:stn:0000077', destination: 'urn:uic:stn:0000002' } });
    df.passengersList.push({ id: 999, passengers: [] });
    df.scenarios.push({ ...own(df), code: 'SIM_NEW_38', osdmVersion: '3.8.0', tripRequirementId: tripId, passengersListId: 999 });
    df.scenariosToRun = [...df.scenariosToRun, 'SIM_NEW_38'];
    expect(version(df)).toBe(version(DATAFILE));
  });

  test('its own scenario, the trip it names, the first purchaser or a root key move it', () => {
    const changes = [
      (df) => { own(df).description += '.'; },
      (df) => { df.tripRequirements.find(t => t.id === own(df).tripRequirementId).description += '.'; },
      (df) => { df.purchaserList[0].purchaser[0].purchaserFirstName += 'x'; },
      (df) => { df.systemInfoParameters = { ...df.systemInfoParameters, added: 'x' }; },
    ];
    for (const change of changes) {
      const df = copy();
      change(df);
      expect(version(df)).not.toBe(version(DATAFILE));
    }
  });

  test('its part holds its scenarios, what they name, the first purchaser, and not the file\'s run list', () => {
    const part = R.providerPartOf(DATAFILE, '3.9.0');
    expect(part.scenarios.length).toBeGreaterThan(0);
    expect(part.scenarios.every(s => s.osdmVersion === '3.9.0')).toBe(true);
    expect(part.scenariosToRun).toBeUndefined();
    expect(part.purchaserList[0]).toEqual(DATAFILE.purchaserList[0]);
    const tripIds = new Set(part.scenarios.flatMap(s => [s.tripRequirementId, ...(s.exchange?.tripRequirementId == null ? [] : [s.exchange.tripRequirementId])]));
    expect(part.tripRequirements.map(t => t.id).sort()).toEqual([...tripIds].sort());
    // A trip no scenario of the version names stays out (#914: every trip of gamma's is named by delta's copies too).
    const df = copy();
    df.tripRequirements.push({ id: 9999, tripType: 'SEARCH', trip: { origin: 'urn:uic:stn:0000077', destination: 'urn:uic:stn:0000002' } });
    expect(R.providerPartOf(df, '3.9.0').tripRequirements.some(t => t.id === 9999)).toBe(false);
  });

  test('its part holds a trip that only an exchange of its scenarios names (#959)', () => {
    const df = copy();
    df.tripRequirements.push({ id: 9998, tripType: 'SEARCH', trip: { origin: 'urn:uic:stn:0000077', destination: 'urn:uic:stn:0000002' } });
    df.scenarios.find(s => s.osdmVersion === '3.9.0').exchange = { tripRequirementId: 9998 };
    expect(R.providerPartOf(df, '3.9.0').tripRequirements.some(t => t.id === 9998)).toBe(true);
  });

  test('its Test Data are the trains of its own trips, each with a number and a carrier (#1019)', () => {
    const carrier = JSON.parse(fs.readFileSync(path.join(REPO, 'OSDM_Simulator', 'providers', 'delta.json'), 'utf8')).carrier.ref;
    expect(ref.testResources).toEqual(R.namedTrains(R.testResourcesFromDatafile(R.providerPartOf(DATAFILE, '3.9.0')), carrier));
    for (const train of ref.testResources.filter(r => r.resource_type === 'TRAIN')) {
      expect(train.data.operatorCode).not.toBe('');
      for (const s of train.data.services) expect(s.vehicleNumber).not.toBe('');
    }
  });

  test('a train of a search trip gets the carrier of the provider and a number of its own; one naming them keeps its own (#1019)', () => {
    const plain = { id: 4, resource_type: 'TRAIN', label: 'Trip 7 0000001–0000002', data: { originURN: 'urn:uic:stn:0000001', destinationURN: 'urn:uic:stn:0000002',
      operatorCode: '', services: [{ vehicleNumber: '', departureTime: '08:00:00+01:00', arrivalTime: '12:00:00+01:00' }] } };
    const named = { id: 5, resource_type: 'TRAIN', label: 'Train 1854 0000004–0000005', data: { originURN: 'urn:uic:stn:0000004', destinationURN: 'urn:uic:stn:0000005',
      operatorCode: 'urn:x:own', services: [{ vehicleNumber: '1854', departureTime: '09:00:00+01:00', arrivalTime: '10:00:00+01:00' }] } };
    const journey = { id: 6, resource_type: 'JOURNEY', label: 'Trip 9', data: { legs: [{ trainResourceId: 4, serviceIndex: 0 }] } };
    const [a, b, c] = R.namedTrains([plain, named, journey], 'urn:x:sim');
    expect(a).toMatchObject({ label: 'Train 9004 0000001–0000002', data: { operatorCode: 'urn:x:sim', services: [{ vehicleNumber: '9004', departureTime: '08:00:00+01:00' }] } });
    expect(b).toEqual(named);
    expect(c).toBe(journey);
    expect(plain.data.operatorCode).toBe('');
  });
});
