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
    expect(read.configuration.datafile.scenarios).toHaveLength(DATAFILE.scenarios.length);
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
    for (const [i, trip] of DATAFILE.tripRequirements.entries()) {
      const legs = trip.tripType === 'SPECIFICATION' ? trip.legs : [trip.trip];
      if (legs.length !== 1) continue;
      const fromPage = ctx.trainFromTrip(trip, i).data;
      expect(trains.some(t => JSON.stringify(t.data) === JSON.stringify(fromPage))).toBe(true);
    }
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
  });
});

test('the version changes with the data file', () => {
  const ref = JSON.parse(storedOf('beta'));
  expect(R.versionOf(ref, DATAFILE_TEXT)).not.toBe(R.versionOf(ref, DATAFILE_TEXT + ' '));
});
