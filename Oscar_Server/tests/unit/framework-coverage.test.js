// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #956: how far what a Test Framework declares is tested
 * (utils/frameworkCoverage.js, pure).
 */

const path = require('node:path');
const C = require('../../src/utils/frameworkCoverage');

const DATA = path.join(__dirname, '..', '..', '..', 'Bruno_Collection', 'data_base');
const simulator = require(path.join(DATA, 'simulator_datafile.json'));
const references = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']
  .map((p) => [p, require(path.join(DATA, 'reference', `simulator-${p}.json`))]);

const datafile = (scenarios, extra = {}) => ({
  scenarios,
  tripRequirements: [{ id: 1, tripType: 'SEARCH', trip: {} }, { id: 2, tripType: 'SPECIFICATION', legs: [] }],
  passengersList: [
    { id: 1, passengers: [{ type: 'PERSON' }] },
    { id: 2, passengers: [{ type: 'PERSON', expectedPassengerType: 'CHILD', bornYearsBeforeTravel: 8 }, { type: 'PERSON', reductionCards: [{ code: 'CARD_A' }] }] },
  ],
  ...extra,
});

describe('the functions a framework declares', () => {
  test('explicit lists only, one row each, product distribution by default', () => {
    const ids = C.declaredFunctions({
      salesFlows: ['SALE', 'REFUND_PARTIAL', 'REFUND_IROPS'], partialRefundScopes: ['LEG'],
      returnModels: ['SEPARATE'], currencies: { sold: ['EUR', 'CHF'], default: 'EUR' },
      reductionCards: [{ code: 'CARD_A', name: 'Card A' }], offerSearchOptions: { travelClasses: ['FIRST'] },
      iropsCodes: { refund: ['STRIKE'] }, maxPassengers: 9, promotionCodes: [],
    }).map((f) => f.id);
    expect(ids).toEqual([
      'distribution:PRODUCT', 'salesFlow:SALE', 'salesFlow:REFUND_PARTIAL', 'salesFlow:REFUND_IROPS', 'partialRefund:LEG',
      'returnModel:SEPARATE', 'currency:EUR', 'currency:CHF', 'offerOption:travelClasses:FIRST', 'offerOptionDiscovery',
      'card:CARD_A', 'overrule:STRIKE', 'limit:maxPassengers',
    ]);
    expect(C.declaredFunctions({ partialRefundScopes: ['LEG'] }).map((f) => f.id)).toEqual(['distribution:PRODUCT']);
    expect(C.declaredFunctions({ config: { salesFlows: ['SALE'] } }).map((f) => f.label)).toEqual(['Product-based', 'Sale']);
  });
});

describe('the functions a scenario exercises', () => {
  test('flows, forms, passengers, cards, codes and options', () => {
    const df = datafile([]);
    const sale = C.functionsOf({ code: 'S', scenarioType: 'SALE', tripRequirementId: 2, passengersListId: 2, offerSearchCriteria: { currency: 'CHF', travelClass: 'FIRST' } }, df);
    expect([...sale]).toEqual(expect.arrayContaining(['distribution:PRODUCT', 'salesFlow:SALE', 'offerRequestForm:SPECIFICATION',
      'passengerType:CHILD', 'passengerType:ADULT', 'card:CARD_A', 'limit:ageRanges', 'currency:CHF', 'offerOption:travelClasses:FIRST']));
    const refund = C.functionsOf({ code: 'R', scenarioType: 'REFUND', partialRefundByLeg: 'on', overruleCode: 'STRIKE', tripRequirementId: 1, passengersListId: 1 }, df);
    expect([...refund]).toEqual(expect.arrayContaining(['salesFlow:REFUND_PARTIAL', 'partialRefund:LEG', 'salesFlow:REFUND_IROPS', 'overrule:STRIKE', 'currency:default']));
    const noCode = C.functionsOf({ code: 'N', scenarioType: 'REFUND', overruleCode: 'CODE_DOES_NOT_EXIST' }, df);
    expect([...noCode].some((id) => id.startsWith('overrule:') || id === 'salesFlow:REFUND_IROPS')).toBe(false);
    expect(C.functionsOf(null, df).size).toBe(0);
  });

  test('every simulator reference: each scenario of its run list exercises something it declares', () => {
    for (const [provider, ref] of references) {
      const declared = new Set(C.declaredFunctions(ref.framework).map((f) => f.id));
      const sub = { ...simulator, scenarios: simulator.scenarios.filter((s) => ref.scenariosToRun.includes(s.code)) };
      const coverage = C.coverageOf({ framework: ref.framework, datafile: sub });
      expect([provider, coverage.notDeclared]).toEqual([provider, []]);
      expect([provider, coverage.summary.covered > coverage.summary.notCovered]).toEqual([provider, true]);
      for (const s of sub.scenarios) {
        expect([provider, s.code, [...C.functionsOf(s, sub)].some((id) => declared.has(id))]).toEqual([provider, s.code, true]);
      }
    }
  });
});

describe('the coverage', () => {
  const framework = { salesFlows: ['SALE', 'REFUND_FULL', 'EXCHANGE_FULL'], currencies: { sold: ['EUR', 'CHF'], default: 'EUR' } };
  const scenarios = [
    { code: 'SALE_OK', scenarioType: 'SALE', tripRequirementId: 1, passengersListId: 1 },
    { code: 'SALE_KO', scenarioType: 'SALE', tripRequirementId: 1, passengersListId: 1, offerSearchCriteria: { currency: 'CHF' } },
    { code: 'REFUND_NEVER', scenarioType: 'REFUND', tripRequirementId: 1, passengersListId: 1 },
  ];
  const run = (id, extra) => ({ id, status: 'COMPLETED', queued_at: '2026-10-20 10:00:00', completed_at: '2026-10-20 10:05:00', total: 10, failed: 0, ...extra });

  test('states, findings, summary, to run again', () => {
    const okHash = C.scenarioHash(scenarios[0]);
    const c = C.coverageOf({
      framework,
      datafile: datafile(scenarios),
      runs: {
        SALE_OK: run('r1', { collection_version: 'V1', scenario_hash: okHash }),
        SALE_KO: run('r2', { failed: 3, collection_version: 'V0', completed_at: '2026-10-21 08:00:00' }),
      },
      findings: [
        { id: 'f1', title: 'CHF refused', category: 'provider_deviation', status: 'open', scenario_code: 'SALE_KO' },
        { id: 'f2', title: 'Old', category: 'open', status: 'resolved', scenario_code: 'SALE_KO' },
      ],
      collectionVersion: 'V1',
    });
    const row = (id) => c.functions.find((f) => f.id === id);
    expect(row('salesFlow:SALE')).toMatchObject({ state: 'failed', toRunAgain: true });
    expect(row('currency:EUR').state).toBe('passed');
    expect(row('currency:EUR').scenarios.map((s) => [s.code, s.result, s.toRunAgain])).toEqual([['SALE_OK', 'passed', false], ['REFUND_NEVER', 'never-run', null]]);
    expect(row('currency:CHF')).toMatchObject({ state: 'failed', findings: [{ id: 'f1', category: 'provider_deviation', scenarioCode: 'SALE_KO' }] });
    expect(row('currency:CHF').scenarios[0].run).toMatchObject({ id: 'r2', passed: 7, failed: 3, collectionVersion: 'V0' });
    expect(row('salesFlow:REFUND_FULL').state).toBe('never-run');
    expect(row('salesFlow:EXCHANGE_FULL').state).toBe('not-covered');
    expect(c.summary).toEqual({ declared: 6, covered: 5, passed: 1, failed: 3, neverRun: 1, notCovered: 1, toRunAgain: 3, latestRunAt: '2026-10-21 08:00:00' });
  });

  test('a changed scenario is to run again; a run that recorded nothing says nothing', () => {
    const changed = { ...scenarios[0], description: 'edited' };
    const c = C.coverageOf({ framework, datafile: datafile([changed]), runs: { SALE_OK: run('r1', { scenario_hash: C.scenarioHash(scenarios[0]) }) } });
    expect(c.functions.find((f) => f.id === 'salesFlow:SALE').scenarios[0].toRunAgain).toBe(true);
    const silent = C.coverageOf({ framework, datafile: datafile([changed]), runs: { SALE_OK: run('r1') } });
    expect(silent.functions.find((f) => f.id === 'salesFlow:SALE').scenarios[0].toRunAgain).toBeNull();
  });

  test('what the framework does not declare is listed apart, on a copy', () => {
    const df = datafile([{ code: 'X', scenarioType: 'SALE', tripRequirementId: 1, passengersListId: 1, offerSearchCriteria: { currency: 'PLN' } }]);
    const c = C.coverageOf({ framework, datafile: df });
    expect(c.notDeclared).toEqual([{ code: 'X', warnings: ['currency:PLN'] }]);
    expect(df.scenarios[0].__featureNotDeclaredWarnings).toBeUndefined();
  });

  test('results of a run, and the latest finished run per scenario', () => {
    expect(C.resultOf(null)).toBe('never-run');
    expect(C.resultOf({ total: 0, failed: 0, status: 'FAILED' })).toBe('failed');
    expect(C.resultOf({ total: 0, failed: 0, status: 'COMPLETED' })).toBe('passed');
    const latest = C.latestRunsOf([
      { id: 'a', scenario_code: 'S', status: 'RUNNING' },
      { id: 'b', scenario_code: 'S', status: 'FAILED' },
      { id: 'c', scenario_code: 'S', status: 'COMPLETED' },
      { id: 'd', scenario_code: null, status: 'COMPLETED' },
    ]);
    expect(Object.fromEntries(Object.entries(latest).map(([k, v]) => [k, v.id]))).toEqual({ S: 'b' });
  });
});
