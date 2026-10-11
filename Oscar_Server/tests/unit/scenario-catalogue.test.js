// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * scenario-catalogue.test.js — the scenario catalogue (#612): the file in the
 * collection is sound against the simulator's data file, the data file it
 * makes passes the upload's schema check, and the golden rule names what a
 * framework lacks.
 */

const path = require('node:path');

// The real schema, not the stub another test file writes into the shared dummy collection.
process.env.COLLECTION_PATH = path.resolve(__dirname, '../../../Bruno_Collection');
const {
  catalogueProblems, catalogueDatafile, catalogueFor, requirementsOf, missingFor, salesFlowsOf,
} = require('../../src/utils/scenarioCatalogue');
const { schemaProblems, loadDatafileSchema } = require('../../src/utils/datafileSchema');

const DATA = path.resolve(__dirname, '../../../Bruno_Collection/data_base');
const catalogue = require(path.join(DATA, 'scenario_catalogue.json'));
const simulator = require(path.join(DATA, 'simulator_datafile.json'));

describe('the catalogue file', () => {
  test('is sound against the simulator data file', () => {
    expect(catalogueProblems(catalogue, simulator)).toEqual([]);
  });

  test('makes a data file the upload accepts, with each reference scenario and only the entries they use', () => {
    const df = catalogueDatafile(catalogue, simulator);
    expect(df.scenarios.map(s => s.code)).toEqual(catalogue.entries.map(e => e.code));
    expect(schemaProblems(df, loadDatafileSchema()).problems).toEqual([]);
    for (const [field, list] of [['tripRequirementId', 'tripRequirements'], ['passengersListId', 'passengersList']]) {
      const used = new Set(df.scenarios.map(s => s[field]));
      expect(df[list].map(e => e.id).sort()).toEqual([...used].sort());
    }
    for (const s of df.scenarios) {
      expect(s.description).toBe(catalogue.entries.find(e => e.code === s.code).purpose);
      expect(s.code.startsWith('SIM_')).toBe(false);
      expect(s.created_by).toBeUndefined();
    }
  });

  test('has no provider-specific or deliberately wrong scenario, and waits long enough on a real provider', () => {
    for (const e of catalogue.entries) {
      expect(e.source).not.toMatch(/^SIM_(WRONG|VARIANT|SALE_CARD|SALE_PRODUCT|GROUP)_/);
      if (e.code.startsWith('NHF_EXPIRED_')) expect(Object.values(e.set)).toEqual([40]);
    }
  });

  test('every reference scenario is a happy flow or a negative probe of its own kind', () => {
    const kinds = catalogueFor(catalogue, simulator, {}).map(e => e.kind);
    expect(new Set(kinds)).toEqual(new Set(['OTST', 'NHF']));
  });
});

describe('problems a catalogue can have', () => {
  const sim = { scenarios: [{ code: 'SIM_A_38', scenarioType: 'SALE' }, { code: 'SIM_WRONG_X_38' }] };
  const entry = (over) => ({ code: 'OTST_A_ONE', source: 'SIM_A_38', purpose: 'A sale for one person.', checks: 10, ...over });
  test.each([
    [[], /no entry/],
    [[entry({ code: 'A_ONE' })], /OTST_/],
    [[entry(), entry()], /appears twice/],
    [[entry({ source: 'SIM_NONE' })], /not a scenario/],
    [[entry({ purpose: '' })], /purpose/],
    [[entry({ checks: 0 })], /checks/],
    [[entry({ set: { tripRequirementId: 2 } })], /may change/],
    [[entry({ source: 'SIM_WRONG_X_38' })], /deliberately wrong/],
  ])('%#', (entries, problem) => {
    expect(catalogueProblems({ entries }, sim).join('; ')).toMatch(problem);
    expect(() => catalogueDatafile({ entries }, sim)).toThrow(/not valid/);
  });
});

describe('requirements and the golden rule', () => {
  test('sales flows by type and partial refund', () => {
    expect(salesFlowsOf({ scenarioType: 'SALE' })).toEqual(['SALE']);
    expect(salesFlowsOf({ scenarioType: 'REFUND' })).toEqual(['SALE', 'REFUND_FULL']);
    expect(salesFlowsOf({ scenarioType: 'REFUND', partialRefundByFulfillment: 'on' })).toEqual(['SALE', 'REFUND_PARTIAL']);
    expect(salesFlowsOf({ scenarioType: 'EXCHANGE' })).toEqual(['SALE', 'EXCHANGE_FULL']);
  });

  test('a combined return needs its model and OSDM 3.7; passenger types other than PERSON must be declared', () => {
    const df = { passengersList: [{ id: 1, passengers: [{ type: 'PERSON' }, { type: 'YOUTH' }] }] };
    const r = requirementsOf({ scenarioType: 'SALE', passengersListId: 1, offerSearchCriteria: { returnOffsetDays: 2, returnModel: 'COMBINED' } }, df);
    expect(r).toEqual({ salesFlows: ['SALE'], returnModel: 'COMBINED', minOsdmVersion: '3.7', passengerTypes: ['YOUTH'] });
    expect(missingFor(r, { salesFlows: ['SALE'], returnModels: ['SEPARATE'], osdmVersion: '3.6.0', passengerTypes: ['ADULT'] }))
      .toEqual(['return model COMBINED', 'OSDM 3.7 or later', 'passenger type YOUTH']);
    expect(missingFor(r, { config: { salesFlows: ['SALE'], returnModels: ['COMBINED'], osdmVersion: '3.8.0', passengerTypes: ['YOUTH'] } })).toEqual([]);
    // A framework from before returnModels does not restrict the model.
    expect(missingFor(r, { salesFlows: ['SALE'], osdmVersion: '3.8', passengerTypes: ['YOUTH'] })).toEqual([]);
    expect(missingFor({ salesFlows: ['SALE', 'REFUND_FULL'], returnModel: null, minOsdmVersion: null, passengerTypes: [] }, null))
      .toEqual(['sales flow SALE', 'sales flow REFUND_FULL']);
  });
});
