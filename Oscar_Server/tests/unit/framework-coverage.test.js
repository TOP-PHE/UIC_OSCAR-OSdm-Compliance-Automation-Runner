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
    expect(c.summary).toEqual({ declared: 6, covered: 5, passed: 1, withDefects: 0, failed: 3, neverRun: 1, notCovered: 1, toRunAgain: 3, latestRunAt: '2026-10-21 08:00:00' });
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

  test('a failure is blocking only when it stops the flow (#956 part 4)', () => {
    const check = (category, extra = {}) => ({ request_name: '07. GET Booking', assertion_name: `x ${category}`, category, ...extra });
    expect(C.failureOf([])).toBeNull();
    expect(C.failureOf([check('field_validation'), check('response_structure')])).toEqual({ blocking: false, step: '07. GET Booking', check: 'x field_validation' });
    expect(C.failureOf([check('field_validation'), { ...check('http_status'), request_name: '02. POST Booking' }]))
      .toEqual({ blocking: true, step: '02. POST Booking', check: 'x http_status' });
    for (const c of ['script_error', 'prerequisite']) expect(C.failureOf([check(c)]).blocking).toBe(true);
    // #988: critical is read from the check's text, not from the stored
    // severity: an id holding "500" was stored critical until 1.11.410.
    expect(C.failureOf([check('business_logic', { assertion_name: '→ 500 server error' })]).blocking).toBe(true);
    const partWithId = 'admission[8] has a counterpart in the booking (offer part id=7193ec2c-36a1-4eaa-ae58-15000c27799f, passenger types ADULT)';
    expect(C.failureOf([check('business_logic', { assertion_name: partWithId, severity: 'critical' })]).blocking).toBe(false);
    // #988: no offer, or no trip to ask offers for, stops the scenario at 01.
    for (const name of ['Offers found in response', 'Exchange offers found in response',
      'Trips collection: a trip to ask offers for — none',
      "Trips collection: the scenario's SEARCH trip gives an origin and a destination"]) {
      expect(C.failureOf([check('business_logic', { request_name: '01. POST Get Offer', assertion_name: name })]).blocking).toBe(true);
    }
    expect(C.failureOf([check('business_logic', { assertion_name: 'y'.repeat(400) })]).check).toHaveLength(300);
    // #982: a run stored before 1.11.408 holds the collection's status check as business_logic.
    const status400 = check('business_logic', { request_name: '02. POST Create Booking', assertion_name: 'HTTP response status — expected 200, actual: 400' });
    expect(C.failureOf([check('field_validation'), status400])).toEqual({ blocking: true, step: '02. POST Create Booking', check: status400.assertion_name });
    expect(C.isBlockingCheck(null)).toBe(false);
    expect(C.resultOf({ failed: 2, total: 9, failure: { blocking: false } })).toBe('defects');
    expect(C.resultOf({ failed: 2, total: 9, failure: { blocking: true } })).toBe('failed');
    expect(C.resultOf({ failed: 2, total: 9 })).toBe('failed');
    expect(C.stateOf([{ result: 'passed' }, { result: 'defects' }])).toBe('defects');
    expect(C.stateOf([{ result: 'defects' }, { result: 'failed' }])).toBe('failed');
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

describe('#972 G1: a product named by words of its name', () => {
  const fw = { products: [{ code: 'P_FLEX', name: 'Flexi saver' }, { code: 'P_BOUND', name: 'Train-bound saver' }] };

  test('is the declared product the collection would take, by code first', () => {
    expect(C.productIdsOf('P_BOUND', fw)).toEqual(['product:P_BOUND']);
    expect(C.productIdsOf('flexi saver', fw)).toEqual(['product:P_FLEX']);
    expect(C.productIdsOf('saver', fw)).toEqual(['product:P_FLEX', 'product:P_BOUND']);
    expect(C.productIdsOf('night', fw)).toEqual(['product:night']);
  });

  test('so the declared product counts as tested, and nothing reads "not declared"', () => {
    const df = datafile([{ code: 'S', scenarioType: 'SALE', tripRequirementId: 1, passengersListId: 1, expectedProduct: 'flexi saver' }]);
    const c = C.coverageOf({ framework: { ...fw, salesFlows: ['SALE'] }, datafile: df });
    expect(c.functions.find((f) => f.id === 'product:P_FLEX').state).toBe('never-run');
    expect([...C.functionsOf(df.scenarios[0], df)]).toContain('product:flexi saver');
  });
});

describe('#972 G2: the fare declarations', () => {
  const fares = { clusters: ['NON_FLEX'], combinationModels: ['CLUSTERING'], statedRefundFee: true, reservations: ['BICYCLE'], salesFlows: ['SALE', 'REFUND_FULL'], freeUnderAge: 6 };

  test('give rows once FARE is declared, none otherwise', () => {
    const rows = C.declaredFunctions({ distributionModes: ['PRODUCT', 'FARE'], fares }).filter((f) => f.group === 'Fares');
    expect(rows.map((f) => [f.id, f.label])).toEqual([
      ['fareCluster:NON_FLEX', 'Fare cluster NON_FLEX'], ['fareCombination:CLUSTERING', 'Fares combined by CLUSTERING'],
      ['fareReservation:BICYCLE', 'Fare reservation for a bicycle'], ['fareSalesFlow:SALE', 'Fares: sale'],
      ['fareSalesFlow:REFUND_FULL', 'Fares: full refund'], ['fare:statedRefundFee', 'Refund fee stated by the distributor'],
      ['fare:freeUnderAge', 'Free under 6'],
    ]);
    expect(C.declaredFunctions({ fares }).some((f) => f.group === 'Fares')).toBe(false);
  });

  test('a bicycle with a fare reservation is that reservation, not a passenger type', () => {
    const df = datafile([], {
      passengersList: [{ id: 3, passengers: [{ type: 'PERSON' }, { type: 'BICYCLE' }] }],
      offerSearchCriteriaList: [{ id: 1, offerSearchCriteria: [{ requestedOfferParts: ['FARE_ADMISSION', 'FARE_RESERVATION'] }] }],
    });
    const bike = { code: 'B', scenarioType: 'SALE', tripRequirementId: 2, passengersListId: 3, offerSearchCriteriaListId: 1, requestedSections: [{ startPlace: 'a', endPlace: 'b' }] };
    const ids = [...C.functionsOf(bike, df)];
    expect(ids).toEqual(expect.arrayContaining(['fareSalesFlow:SALE', 'fareReservation:BICYCLE', 'passengerType:ADULT']));
    expect(ids).not.toContain('passengerType:BICYCLE');
    const refund = { ...bike, code: 'R', scenarioType: 'REFUND', fareRefundFee: 250 };
    expect([...C.functionsOf(refund, df)]).toEqual(expect.arrayContaining(['fareSalesFlow:REFUND_FULL', 'fare:statedRefundFee', 'fareCombination:CLUSTERING']));
    const child = [...C.functionsOf(bike, df, { entry: { limit: 'FREE_CHILD', combinationModel: 'COMBINING' } })];
    expect(child).toEqual(expect.arrayContaining(['fare:freeUnderAge', 'fareCombination:COMBINING']));
  });
});
