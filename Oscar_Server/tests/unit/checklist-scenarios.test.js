// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #862 PR 2: which reference scenarios a provider's checklist copies, on the
 * real catalogue and the simulator's data file.
 */

const fs = require('node:fs');
const path = require('node:path');
const CS = require('../../src/utils/checklistScenarios');
const { catalogueFor } = require('../../src/utils/scenarioCatalogue');

const base = path.join(__dirname, '..', '..', '..', 'Bruno_Collection', 'data_base');
const catalogue = JSON.parse(fs.readFileSync(path.join(base, 'scenario_catalogue.json'), 'utf8'));
const simulator = JSON.parse(fs.readFileSync(path.join(base, 'simulator_datafile.json'), 'utf8'));
const framework = JSON.parse(fs.readFileSync(path.join(base, 'reference', 'simulator-gamma.json'), 'utf8')).framework;

const train = { id: 't1', label: 'T', origin: 'A', destination: 'B', services: [{ index: 0, vehicleNumber: '1', departureTime: '08:00', arrivalTime: '09:00' }] };
const journey2 = { id: 'j2', label: 'J', legs: 2 };
const plan = (testData, existingCodes = []) => CS.scenarioPlan({ catalogue, simulator, framework, testData, existingCodes });

test('a train and a journey of two legs: every entry the framework declares is copied, on them', () => {
  const p = plan({ trains: [train], journeys: [journey2] });
  const allowed = catalogueFor(catalogue, simulator, framework).filter(e => e.missing.length === 0).map(e => e.code);
  expect(p.copy.map(c => c.code)).toEqual(allowed);
  expect(p.noJourney).toEqual([]);
  expect(p.noTestData).toEqual([]);
  const mappings = Object.values(p.tripMap);
  expect(mappings).toContainEqual({ type: 'train', train_id: 't1', service_index: 0 });
  expect(mappings).toContainEqual({ type: 'journey', journey_id: 'j2' });
  expect(mappings.every(m => m.type === 'train' || m.journey_id === 'j2')).toBe(true);
});

test('no journey of two legs: the scenarios with such a trip are left out, and said so', () => {
  const p = plan({ trains: [train], journeys: [] });
  expect(p.noJourney.length).toBeGreaterThan(0);
  const left = new Set(p.noJourney.map(n => n.code));
  for (const c of p.copy) expect(left.has(c.code)).toBe(false);
  expect(p.noJourney[0].legs).toEqual([2]);
});

test('no Test Data at all: nothing is copied', () => {
  const p = plan({ trains: [], journeys: [] });
  expect(p.copy).toEqual([]);
  expect(p.noTestData.length).toBeGreaterThan(0);
});

test('codes the data file holds are already there, not copied again', () => {
  const all = plan({ trains: [train], journeys: [journey2] });
  const held = all.copy.slice(0, 3).map(c => c.code);
  const p = plan({ trains: [train], journeys: [journey2] }, held);
  expect(p.alreadyThere).toEqual(held);
  expect(p.copy.map(c => c.code)).toEqual(all.copy.slice(3).map(c => c.code));
});

test('the page sees the plan without the source data file and the trip map', () => {
  const shown = CS.shownPlan(plan({ trains: [train], journeys: [] }), 'none');
  expect(Object.keys(shown).sort()).toEqual(['alreadyThere', 'choice', 'copy', 'noJourney', 'noTestData', 'notDeclared']);
  expect(shown.choice).toBe('none');
});

test('helpers', () => {
  expect(CS.mappingOf('train::abc::2')).toEqual({ type: 'train', train_id: 'abc', service_index: 2 });
  expect(CS.mappingOf('journey::j1')).toEqual({ type: 'journey', journey_id: 'j1' });
  expect(CS.codesOf({ scenarios: [{ code: 'A' }, null, { code: '' }, { code: 7 }, { code: 'B' }] })).toEqual(['A', 'B']);
  expect(CS.codesOf(null)).toEqual([]);
});

// #959: the exchange to another route goes on another train than its sale.
test('two routes in the Test Data: the exchange to another route is copied onto both', () => {
  const back = { ...train, id: 't2', origin: 'B', destination: 'C', services: [{ index: 3, vehicleNumber: '2', departureTime: '10:00', arrivalTime: '11:00' }] };
  const p = plan({ trains: [train, back], journeys: [journey2] });
  expect(p.copy.map(c => c.code)).toContain('OTST_EXCHANGE_OTHER_ROUTE_1ADT');
  const source = p.source.scenarios.find(s => s.code === 'OTST_EXCHANGE_OTHER_ROUTE_1ADT');
  expect(p.tripMap[String(source.tripRequirementId)]).toEqual({ type: 'train', train_id: 't1', service_index: 0 });
  expect(p.tripMap[String(source.exchange.tripRequirementId)]).toEqual({ type: 'train', train_id: 't2', service_index: 3 });
});
