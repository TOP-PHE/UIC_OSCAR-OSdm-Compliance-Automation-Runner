// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * run-filters.test.js — what a batch runs, chosen at launch (#1029): the
 * facets of a scenario, the checks of a selection and what it keeps.
 */

const path = require('node:path');
const RF = require('../../src/utils/runFilters');
const K = require('../../src/utils/capabilities');
const { capabilityCoverageOf } = require('../../src/utils/capabilityCoverage');

const DATA = path.resolve(__dirname, '../../../Bruno_Collection/data_base');
const simulator = require(path.join(DATA, 'simulator_datafile.json'));
const catalogue = require(path.join(DATA, 'scenario_catalogue.json')).entries;

describe('the category of a scenario', () => {
  test('the simulator\'s deliberate errors, expected refusals, else happy flows', () => {
    expect(RF.categoryOf({ code: 'SIM_WRONG_BOOKING_PRICE_38' })).toBe('simulated');
    expect(RF.categoryOf({ code: 'SIM_FAULT_OFFER_500_38' })).toBe('simulated');
    expect(RF.categoryOf({ code: 'ANY', simulatorFaults: 'OFFER_500' })).toBe('simulated');
    expect(RF.categoryOf({ code: 'ANY', simulatorFaults: ['OFFER_500'] })).toBe('simulated');
    expect(RF.categoryOf({ code: 'ANY', simulatorFaults: ' ' })).toBe('happy');
    expect(RF.categoryOf({ code: 'NHF_SALE_NO_PASSENGER' })).toBe('refusal');
    expect(RF.categoryOf({ code: 'OTST_REFUND_TWICE', scenarioType: 'REFUND', refundAgainProbe: 'on' })).toBe('refusal');
    expect(RF.categoryOf({ code: 'OTST_SALE_ONE_WAY_1ADT', scenarioType: 'SALE' })).toBe('happy');
    expect([RF.categoryOf(null), RF.categoryOf({})]).toEqual(['happy', 'happy']);
  });

  test('on the simulator\'s data file: every SIM_WRONG_ and SIM_FAULT_ is a simulated error, nothing else is', () => {
    for (const s of simulator.scenarios) {
      const simulated = /^SIM_(WRONG|FAULT)_/.test(s.code);
      expect([s.code, RF.categoryOf(s) === 'simulated']).toEqual([s.code, simulated]);
      if (!simulated) expect([s.code, RF.categoryOf(s)]).toEqual([s.code, K.isRefusalTest(s) ? 'refusal' : 'happy']);
    }
  });
});

describe('the group and the form', () => {
  test('the group is the one the coverage report gives the scenario\'s main capability', () => {
    // The coverage report's own reading: one run per scenario, every row.
    const sample = simulator.scenarios.filter((s, i) => i % 7 === 0 && !/^SIM_(WRONG|FAULT)_/.test(s.code));
    const runs = Object.fromEntries(sample.map((s, i) => [s.code, { id: `r${i}`, status: 'COMPLETED', steps: [], checks: [], total: 1, failed: 0 }]));
    const df = { ...simulator, scenarios: sample, scenariosToRun: sample.map((s) => s.code) };
    const report = capabilityCoverageOf({ framework: {}, datafile: df, catalogue, runs });
    const groupOfCode = new Map();
    for (const row of report.capabilities) for (const t of row.tests) for (const f of t.forms) groupOfCode.set(f.code, row.group);
    for (const r of report.expectedRefusals) for (const f of r.forms) groupOfCode.set(f.code, K.CAPABILITY.get(r.capability).group);
    expect(groupOfCode.size).toBeGreaterThan(50);
    for (const [code, group] of groupOfCode) {
      expect([code, RF.groupOf(sample.find((s) => s.code === code), df, catalogue)]).toEqual([code, group]);
    }
  });

  test('the form of the offer request', () => {
    const df = { tripRequirements: [{ id: 1, tripType: 'SEARCH' }, { id: 2, tripType: 'SPECIFICATION' }] };
    expect(RF.formOf({ tripRequirementId: 1 }, df)).toBe('SEARCH');
    expect(RF.formOf({ tripRequirementId: 2 }, df)).toBe('SPECIFICATION');
    expect(RF.formOf({ tripRequirementId: 1, offersByTripIds: 'on' }, df)).toBe('TRIP_IDS');
    expect(RF.formOf({ tripRequirementId: 9 }, df)).toBe('SEARCH');
  });
});

describe('the last run', () => {
  const scenario = { code: 'A', scenarioType: 'SALE' };
  const { scenarioHash } = require('../../src/utils/frameworkCoverage');
  const hash = scenarioHash(scenario);

  test('never run, failed by its status or a failed check, else passed', () => {
    expect(RF.lastRunOf(undefined, scenario, 'V2')).toEqual({ lastRun: 'never', toRunAgain: true });
    expect(RF.lastRunOf({ status: 'FAILED', failed: 0 }, scenario, 'V2').lastRun).toBe('failed');
    expect(RF.lastRunOf({ status: 'COMPLETED', failed: 2 }, scenario, 'V2').lastRun).toBe('failed');
    expect(RF.lastRunOf({ status: 'COMPLETED', failed: 0 }, scenario, 'V2').lastRun).toBe('passed');
  });

  test('to run again when older than the collection or the scenario, or not known', () => {
    const run = (extra) => ({ status: 'COMPLETED', failed: 0, collection_version: 'V2', scenario_hash: hash, ...extra });
    expect(RF.lastRunOf(run(), scenario, 'V2').toRunAgain).toBe(false);
    expect(RF.lastRunOf(run({ collection_version: 'V1' }), scenario, 'V2').toRunAgain).toBe(true);
    expect(RF.lastRunOf(run({ scenario_hash: 'other' }), scenario, 'V2').toRunAgain).toBe(true);
    expect(RF.lastRunOf(run({ collection_version: null, scenario_hash: null }), scenario, 'V2').toRunAgain).toBe(true);
  });
});

describe('a selection', () => {
  test('is checked: an object of known keys and values', () => {
    expect(RF.selectionProblem(null)).toMatch(/must be an object/);
    expect(RF.selectionProblem([])).toMatch(/must be an object/);
    expect(RF.selectionProblem({ colour: 'red' })).toMatch(/selection\.colour is not known/);
    expect(RF.selectionProblem({ base: 'some' })).toMatch(/selection\.base must be one of all, list/);
    expect(RF.selectionProblem({ lastRun: 'yesterday' })).toMatch(/selection\.lastRun must be one of/);
    expect(RF.selectionProblem({ categories: 'happy' })).toMatch(/selection\.categories must be a list/);
    expect(RF.selectionProblem({ categories: ['happy', 'sad'] })).toMatch(/selection\.categories: unknown value "sad"/);
    expect(RF.selectionProblem({ groups: ['Sale', 'Nope'] })).toMatch(/selection\.groups: unknown value "Nope"/);
    expect(RF.selectionProblem({ forms: ['SEARCH', 'BY_FAX'] })).toMatch(/selection\.forms: unknown value "BY_FAX"/);
    expect(RF.selectionProblem({})).toBeNull();
    expect(RF.selectionProblem({ base: 'list', categories: [], groups: ['Refund'], forms: ['TRIP_IDS'], lastRun: 'failed' })).toBeNull();
  });

  const facets = [
    { code: 'H1', category: 'happy', group: 'Sale', form: 'SEARCH', lastRun: 'passed', toRunAgain: false },
    { code: 'H2', category: 'happy', group: 'Refund', form: 'TRIP_IDS', lastRun: 'failed', toRunAgain: false },
    { code: 'R1', category: 'refusal', group: 'Refund', form: 'SEARCH', lastRun: 'never', toRunAgain: true },
    { code: 'S1', category: 'simulated', group: 'Sale', form: 'SPECIFICATION', lastRun: 'failed', toRunAgain: true },
  ];

  test('by default keeps the happy flows and the expected refusals, not the simulated errors', () => {
    expect(RF.selectCodes(facets, {})).toEqual(['H1', 'H2', 'R1']);
    expect(RF.DEFAULT_SELECTION.categories).toEqual(['happy', 'refusal']);
  });

  test('keeps what every filter ticks: OR within a filter, AND between them', () => {
    expect(RF.selectCodes(facets, { categories: ['simulated'] })).toEqual(['S1']);
    expect(RF.selectCodes(facets, { categories: ['happy', 'refusal'], groups: ['Refund'] })).toEqual(['H2', 'R1']);
    expect(RF.selectCodes(facets, { categories: ['happy', 'refusal', 'simulated'], forms: ['SEARCH'] })).toEqual(['H1', 'R1']);
    expect(RF.selectCodes(facets, { categories: ['happy', 'refusal', 'simulated'], lastRun: 'failed' })).toEqual(['H2', 'S1']);
    expect(RF.selectCodes(facets, { categories: ['happy', 'refusal', 'simulated'], lastRun: 'toRunAgain' })).toEqual(['R1', 'S1']);
    expect(RF.selectCodes(facets, { categories: [] })).toEqual([]);
  });

  test('the preview counts what the base holds, value by value, and what the selection keeps', () => {
    const p = RF.previewOf(facets, { categories: ['refusal'] });
    expect(p.total).toBe(4);
    expect(p.selected).toBe(1);
    expect(p.counts.categories).toEqual({ happy: 2, refusal: 1, simulated: 1 });
    expect(p.counts.forms).toEqual({ SEARCH: 2, SPECIFICATION: 1, TRIP_IDS: 1 });
    expect(p.counts.groups.Refund).toBe(2);
    expect(Object.keys(p.counts.groups)).toEqual([...K.GROUPS]);
    expect(p.counts.lastRun).toEqual({ all: 4, toRunAgain: 2, failed: 2 });
    expect(p.labels.categories).toEqual(RF.CATEGORY_TEXT);
  });

  test('the facets follow the data file, in the order of the codes asked', () => {
    const codes = ['SIM_WRONG_BOOKING_PRICE_38', 'NOT_IN_THE_FILE', 'SIM_SALE_SEARCH_1ADT_38'];
    const f = RF.facetsOf(codes, { datafile: simulator, entries: catalogue });
    expect(f.map((x) => [x.code, x.category])).toEqual([['SIM_WRONG_BOOKING_PRICE_38', 'simulated'], ['SIM_SALE_SEARCH_1ADT_38', 'happy']]);
    expect(f[1]).toMatchObject({ group: 'Sale', form: 'SEARCH', lastRun: 'never', toRunAgain: true });
  });
});

describe('what a batch ran, in words (#1029 PR 3)', () => {
  test('the categories are always said, a filter keeping every value is not', () => {
    expect(RF.selectionLabel({})).toBe('Happy flows + Expected refusals');
    expect(RF.selectionLabel(RF.DEFAULT_SELECTION)).toBe('Happy flows + Expected refusals');
    expect(RF.selectionLabel({ categories: [...RF.CATEGORIES] })).toBe('Every category');
    expect(RF.selectionLabel({ categories: ['simulated'] })).toBe('Simulated errors');
  });

  test('the run list, the groups, the forms and the last run, in that order', () => {
    expect(RF.selectionLabel({ categories: ['refusal'], groups: ['Refund'] })).toBe('Expected refusals · Refund');
    expect(RF.selectionLabel({
      base: 'list', categories: ['simulated'], groups: ['Sale', 'Refund', 'Exchange', 'Fares'], forms: ['TRIP_IDS', 'SEARCH'], lastRun: 'failed',
    })).toBe('Run list · Simulated errors · 4 capabilities · Trip id + Search · Failed at the last run');
    expect(RF.selectionLabel({ lastRun: 'toRunAgain', forms: ['SPECIFICATION'] })).toBe('Happy flows + Expected refusals · Specification · To run again');
  });

  test('every value of a filter in another order is still every value', () => {
    expect(RF.selectionLabel({ groups: [...K.GROUPS].reverse(), forms: [...RF.FORMS].reverse() })).toBe('Happy flows + Expected refusals');
  });

  test('up to three values are named, more are counted', () => {
    expect(RF.selectionLabel({ groups: K.GROUPS.slice(0, 3) })).toBe(`Happy flows + Expected refusals · ${K.GROUPS.slice(0, 3).join(' + ')}`);
    expect(RF.selectionLabel({ groups: K.GROUPS.slice(0, 4) })).toBe('Happy flows + Expected refusals · 4 capabilities');
  });
});
