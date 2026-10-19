// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #885: a provider that lets only the main passenger be updated. The Test
 * Framework says so (`passengerUpdateScope: 'MAIN'`), the run's copy and the
 * catalogue's copies update the main passenger only, and a checklist import
 * reads question A3.5 into the framework.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const U = require('../../src/utils/undeclaredSteps');
const { annotateDatafile } = require('../../src/utils/frameworkGating');
const { frameworkFromChecklist, defaultFramework } = require('../../src/utils/referenceConfiguration');
const { catalogueFor, catalogueDatafile } = require('../../src/utils/scenarioCatalogue');
const { adaptCatalogueDatafile } = require('../../src/utils/catalogueMatch');

global.bru = { getEnvVar: () => undefined, setEnvVar: () => {}, getVar: () => undefined, setVar: () => {} };
const sp = require('../../../Bruno_Collection/library-bruno/scenarioParser.js');

const DATA = path.join(__dirname, '..', '..', '..', 'Bruno_Collection', 'data_base');
const MAIN = { passengerUpdateScope: 'MAIN' };

describe('the framework says only the main passenger can be updated', () => {
  test('read from passengerUpdateScope, any case; never when there is no update at all', () => {
    expect(U.mainPassengerOnly(MAIN)).toBe(true);
    expect(U.mainPassengerOnly({ passengerUpdateScope: 'main' })).toBe(true);
    expect(U.mainPassengerOnly({})).toBe(false);
    expect(U.mainPassengerOnly({ passengerUpdateScope: 'ALL' })).toBe(false);
    expect(U.mainPassengerOnly({ passengerUpdate: false, passengerUpdateScope: 'MAIN' })).toBe(false);
    expect(U.mainPassengerOnly(null)).toBe(false);
  });

  test('a warning only for a scenario asking every passenger itself', () => {
    expect(U.undeclaredStepWarnings({ passengerUpdateScope: 'ALL' }, MAIN)).toEqual(['passengerUpdateScope']);
    expect(U.undeclaredStepWarnings({ passengerUpdateScope: 'all' }, MAIN)).toEqual(['passengerUpdateScope']);
    expect(U.undeclaredStepWarnings({}, MAIN)).toEqual([]);
    expect(U.undeclaredStepWarnings({ passengerUpdateScope: 'MAIN' }, MAIN)).toEqual([]);
    expect(U.undeclaredStepWarnings({ passengerUpdateScope: 'ALL', salesFlowActions: { patchPassengers: false } }, MAIN)).toEqual([]);
    expect(U.undeclaredStepWarnings({ passengerUpdateScope: 'ALL' }, {})).toEqual([]);
    const df = { scenarios: [{ code: 'A', passengerUpdateScope: 'ALL' }, { code: 'B' }] };
    annotateDatafile(df, MAIN);
    expect(df.scenarios[0].__featureNotDeclaredWarnings).toEqual(['passengerUpdateScope']);
    expect(df.scenarios[1].__featureNotDeclaredWarnings).toBeUndefined();
  });

  test('the run\'s copy updates the main passenger only; a scenario not updating is left alone', () => {
    const df = { scenarios: [null, { code: 'A' }, { code: 'B', passengerUpdateScope: 'ALL' }, { code: 'C', passengerUpdateScope: 'MAIN' },
      { code: 'D', salesFlowActions: { patchPassengers: false } }] };
    expect(U.withoutUndeclaredPassengerUpdate(df, MAIN)).toBe(2);
    expect(df.scenarios.slice(1).map((s) => s.passengerUpdateScope)).toEqual(['MAIN', 'MAIN', 'MAIN', undefined]);
    expect(df.scenarios[4].salesFlowActions).toEqual({ patchPassengers: false });
    expect(U.withoutUndeclaredPassengerUpdate({ scenarios: [{ code: 'A' }] }, {})).toBe(0);
  });

  test('no update at all still wins: the update is turned off, the scope left', () => {
    const df = { scenarios: [{ code: 'A' }] };
    expect(U.withoutUndeclaredPassengerUpdate(df, { passengerUpdate: false, passengerUpdateScope: 'MAIN' })).toBe(1);
    expect(df.scenarios[0]).toEqual({ code: 'A', salesFlowActions: { patchPassengers: false } });
  });

  test('the collection says what happens, in the Test Framework\'s words', () => {
    const text = sp.featureNotDeclaredWarning({ code: 'X' }, 'passengerUpdateScope');
    expect(text).toMatch(/^\[WARNING\] Scenario "X" updates every passenger/);
    expect(text).toContain('only the main passenger');
    expect(text).toContain('(Passenger Types)');
  });

  test('the parser reads the copy\'s MAIN as it reads a scenario\'s own', () => {
    expect(sp.passengerUpdateScope({ passengerUpdateScope: 'MAIN' })).toBe('MAIN');
    expect(sp.passengerUpdateScope({})).toBe('ALL');
  });
});

describe('the catalogue\'s copies', () => {
  const catalogue = JSON.parse(fs.readFileSync(path.join(DATA, 'scenario_catalogue.json'), 'utf8'));
  const simulator = JSON.parse(fs.readFileSync(path.join(DATA, 'simulator_datafile.json'), 'utf8'));
  const copy = (fw) => {
    const entries = catalogueFor(catalogue, simulator, fw);
    return adaptCatalogueDatafile(catalogueDatafile(catalogue, simulator), entries, fw).datafile.scenarios;
  };
  const FW = { salesFlows: ['SALE', 'REFUND_FULL'], passengerTypes: ['ADULT'] };

  test('every copy that updates its passengers updates the main one only', () => {
    const scenarios = copy({ ...FW, ...MAIN });
    const updating = scenarios.filter((s) => U.updatesPassengers(s));
    expect(updating.length).toBeGreaterThan(0);
    expect(updating.every((s) => s.passengerUpdateScope === 'MAIN')).toBe(true);
    expect(scenarios.filter((s) => !U.updatesPassengers(s)).every((s) => s.passengerUpdateScope === undefined)).toBe(true);
  });

  test('without the declaration, the copies are as before', () => {
    expect(copy(FW).some((s) => s.passengerUpdateScope === 'MAIN')).toBe(false);
  });
});

describe('a checklist\'s A3.5 goes into the framework', () => {
  const tick = (code, extra = {}) => ({ [`data.passengerUpdateScope=${code}`]: true, ...extra });

  test('MAIN, NONE, ALL', () => {
    expect(frameworkFromChecklist(tick('MAIN')).passengerUpdateScope).toBe('MAIN');
    const none = frameworkFromChecklist(tick('NONE'));
    expect(none.passengerUpdate).toBe(false);
    expect(none.passengerUpdateScope).toBeUndefined();
    expect(frameworkFromChecklist(tick('ALL'))).toEqual(defaultFramework());
  });

  test('over a framework: the answer replaces what it said; no answer keeps it', () => {
    const base = { ...defaultFramework(), passengerUpdate: false };
    expect(frameworkFromChecklist(tick('MAIN'), { base })).toMatchObject({ passengerUpdateScope: 'MAIN' });
    expect(frameworkFromChecklist(tick('MAIN'), { base }).passengerUpdate).toBeUndefined();
    const main = { ...defaultFramework(), ...MAIN };
    expect(frameworkFromChecklist(tick('ALL'), { base: main }).passengerUpdateScope).toBeUndefined();
    expect(frameworkFromChecklist({}, { base: main }).passengerUpdateScope).toBe('MAIN');
    expect(frameworkFromChecklist({ 'data.passengerUpdateScope=MAIN': false }, { base: main }).passengerUpdateScope).toBe('MAIN');
  });
});

describe('the Test Framework page', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'scenarios.js'), 'utf8');

  test('a labelled box under the passenger update, checked when the framework says MAIN', () => {
    expect(src).toContain('<label class="fw-subsection-label" for="fw-passenger-update-main"');
    expect(src).toContain(`<input type="checkbox" id="fw-passenger-update-main" data-action="fw-passenger-update-main" \${fw.passengerUpdateScope === 'MAIN' ? 'checked' : ''}>`);
    expect(src.indexOf('id="fw-passenger-update-main"')).toBeGreaterThan(src.indexOf('id="fw-passenger-update"'));
  });

  test('the handler sets and removes it, and saves', () => {
    const ctx = { wizData: { framework: {} }, saves: 0 };
    ctx.saveFrameworkDebounced = () => { ctx.saves += 1; };
    vm.createContext(ctx);
    const flags = src.split('\n').find((l) => l.startsWith('const FW_STEP_FLAGS'));
    vm.runInContext(`${flags}\n${src.slice(src.indexOf('function changePassengerUpdate('), src.indexOf('function setPaxField('))}\nthis.change = changePassengerUpdate;`, ctx);
    expect(ctx.change('fw-passenger-update-main', { checked: true })).toBe(true);
    expect(ctx.wizData.framework).toEqual({ passengerUpdateScope: 'MAIN' });
    ctx.change('fw-passenger-update-main', { checked: false });
    expect(ctx.wizData.framework).toEqual({});
    expect(ctx.saves).toBe(2);
  });
});
