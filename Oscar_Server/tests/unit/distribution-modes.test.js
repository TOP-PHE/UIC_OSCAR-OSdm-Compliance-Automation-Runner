// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #936: the distribution modes (product, fare or both) in the Test
 * Framework: what a framework declares, what a scenario needs, the run's
 * warning, the catalogue, the collection's text and the references.
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  DISTRIBUTION_MODES, declaredDistributionModes, distributionModeDeclared, distributionModesOf,
  undeclaredDistributionModes, distributionModesProblem,
} = require('../../src/utils/distributionModes');
const { annotateDatafile } = require('../../src/utils/frameworkGating');
const { catalogueFor } = require('../../src/utils/scenarioCatalogue');
const { buildReference } = require('../../src/utils/referenceConfiguration');

const ROOT = path.join(__dirname, '..', '..', '..');
const DATA = path.join(ROOT, 'Bruno_Collection', 'data_base');
const catalogue = JSON.parse(fs.readFileSync(path.join(DATA, 'scenario_catalogue.json'), 'utf8'));
const simulator = JSON.parse(fs.readFileSync(path.join(DATA, 'simulator_datafile.json'), 'utf8'));

global.bru = { getEnvVar: () => undefined, setEnvVar: () => {}, getVar: () => undefined, setVar: () => {} };
global.validationLogger = () => {};
const sp = require(path.join(ROOT, 'Bruno_Collection', 'library-bruno', 'scenarioParser.js'));
global.validationLogger = () => {};

const clone = (v) => structuredClone(v);

describe('#936 what a framework declares', () => {
  test('nothing declared, or nothing known, is product only (decision E1)', () => {
    expect(declaredDistributionModes(undefined)).toEqual(['PRODUCT']);
    expect(declaredDistributionModes({})).toEqual(['PRODUCT']);
    expect(declaredDistributionModes({ distributionModes: 'FARE' })).toEqual(['PRODUCT']);
    expect(declaredDistributionModes({ distributionModes: ['OTHER'] })).toEqual(['PRODUCT']);
  });

  test('a declared list is kept, in the order product then fare', () => {
    expect(declaredDistributionModes({ distributionModes: ['FARE'] })).toEqual(['FARE']);
    expect(declaredDistributionModes({ distributionModes: ['FARE', 'PRODUCT'] })).toEqual(['PRODUCT', 'FARE']);
    expect(distributionModeDeclared({ distributionModes: ['FARE'] }, 'PRODUCT')).toBe(false);
    expect(distributionModeDeclared({}, 'PRODUCT')).toBe(true);
    expect(distributionModeDeclared({}, 'FARE')).toBe(false);
  });

  test('a stored list must hold one or both modes, each once', () => {
    expect(distributionModesProblem(undefined)).toBeNull();
    expect(distributionModesProblem(['PRODUCT'])).toBeNull();
    expect(distributionModesProblem(['FARE', 'PRODUCT'])).toBeNull();
    expect(distributionModesProblem([])).toContain('one or both');
    expect(distributionModesProblem('FARE')).toContain('one or both');
    expect(distributionModesProblem(null)).toContain('one or both');
    expect(distributionModesProblem(['PRODUCT', 'TICKET'])).toContain('"TICKET", which is not a mode');
    expect(distributionModesProblem(['FARE', 'FARE'])).toContain('twice');
  });
});

describe('#936 what a scenario needs', () => {
  // SIM_WRONG_FARE_UNREQUESTED_* asks for products only (ADMISSION) and gets
  // fares nobody asked for (check O14): a product sale.
  const fareCode = (code) => /^SIM_(FARE|NHF_FARE|WRONG_FARE)_/.test(code) && !code.startsWith('SIM_WRONG_FARE_UNREQUESTED_');

  test('every simulator scenario: the fare ones fare, a fare one booking the product both, the others product', () => {
    const wrong = [];
    for (const s of simulator.scenarios) {
      let expected = ['PRODUCT'];
      if (fareCode(s.code)) expected = s.bookMode === 'PRODUCT' ? ['PRODUCT', 'FARE'] : ['FARE'];
      const modes = distributionModesOf(s, simulator);
      if (JSON.stringify(modes) !== JSON.stringify(expected)) wrong.push(`${s.code}: ${modes.join('+')}`);
    }
    expect(wrong).toEqual([]);
  });

  test('the three cases that decide it', () => {
    const scenario = (extra) => ({ code: 'X', offerSearchCriteria: { requestedOfferParts: ['ADMISSION'] }, ...extra });
    expect(distributionModesOf(scenario({}))).toEqual(['PRODUCT']);
    expect(distributionModesOf(scenario({ offerSearchCriteria: { requestedOfferParts: ['FARE_RESERVATION'] } }))).toEqual(['FARE']);
    // #905: a scenario expecting no fare tests a fare provider, whatever it asks.
    expect(distributionModesOf(scenario({ expectFares: false }))).toEqual(['FARE']);
    expect(distributionModesOf(scenario({ expectFares: 'false' }))).toEqual(['FARE']);
    // #207: it asks for fares and books the product.
    expect(distributionModesOf(scenario({ expectFares: false, bookMode: 'PRODUCT' }))).toEqual(['PRODUCT', 'FARE']);
    // ALL asks for every part, but is not a fare request on its own.
    expect(distributionModesOf(scenario({ offerSearchCriteria: { requestedOfferParts: ['ALL'] } }))).toEqual(['PRODUCT']);
    expect(distributionModesOf(null)).toEqual([]);
  });

  test('the criteria are read as the collection reads them: own, else the list entry', () => {
    const datafile = { offerSearchCriteriaList: [{ id: 7, offerSearchCriteria: [{ requestedOfferParts: ['FARE_ADMISSION'] }] }] };
    expect(distributionModesOf({ code: 'L', offerSearchCriteriaListId: 7 }, datafile)).toEqual(['FARE']);
  });

  test('the modes a framework does not declare', () => {
    const fare = { code: 'F', offerSearchCriteria: { requestedOfferParts: ['FARE_ADMISSION'] } };
    expect(undeclaredDistributionModes(fare, {})).toEqual(['FARE']);
    expect(undeclaredDistributionModes(fare, { distributionModes: ['FARE'] })).toEqual([]);
    expect(undeclaredDistributionModes({ code: 'P' }, { distributionModes: ['FARE'] })).toEqual(['PRODUCT']);
  });
});

describe('#936 the run\'s warning', () => {
  const warned = (datafile) => Object.fromEntries(datafile.scenarios
    .map((s) => [s.code, (s.__featureNotDeclaredWarnings || []).filter((w) => w.startsWith('distributionMode:'))])
    .filter(([, w]) => w.length > 0));

  test('nothing declared: each fare scenario is warned FARE, no product scenario is warned', () => {
    const datafile = clone(simulator);
    annotateDatafile(datafile, {});
    const out = warned(datafile);
    const fare = simulator.scenarios.filter((s) => distributionModesOf(s, simulator).includes('FARE')).map((s) => s.code);
    expect(Object.keys(out).sort()).toEqual(fare.sort());
    expect(new Set(Object.values(out).flat())).toEqual(new Set(['distributionMode:FARE']));
  });

  test('fare only: the product scenarios are warned PRODUCT; both declared: none is warned', () => {
    const datafile = clone(simulator);
    annotateDatafile(datafile, { distributionModes: ['FARE'] });
    const out = warned(datafile);
    expect(out.SIM_SALE_SEARCH_1ADT_38).toEqual(['distributionMode:PRODUCT']);
    expect(out.SIM_FARE_SPEC_1ADT_38).toBeUndefined();
    expect(out.SIM_NHF_FARE_NO_SECTION_SRCH_38).toEqual(['distributionMode:PRODUCT']);
    annotateDatafile(datafile, { distributionModes: ['PRODUCT', 'FARE'] });
    expect(warned(datafile)).toEqual({});
  });

  test('the collection says which mode, and where to declare it', () => {
    const fare = sp.featureNotDeclaredWarning({ code: 'F1' }, 'distributionMode:FARE');
    expect(fare).toMatch(/^\[WARNING\] Scenario "F1" is a fare-based sale \(FARE\), which the Test Framework does not declare \(Distribution\)/);
    expect(sp.featureNotDeclaredWarning({ code: 'P1' }, 'distributionMode:PRODUCT')).toContain('is a product-based sale (PRODUCT)');
    expect(sp.featureNotDeclaredWarning({ code: 'P2' }, 'partialExchangeByLeg')).toContain('REFUND_PARTIAL / EXCHANGE_PARTIAL in salesFlows');
  });
});

describe('#936 the catalogue', () => {
  const missingByCode = (fw) => Object.fromEntries(catalogueFor(catalogue, simulator, fw).map((e) => [e.code, e.missing]));
  // #937: the fare entries need FARE; every other one is a product sale.
  const asksFares = (e) => e.requirements.distributionModes.includes('FARE');

  test('a framework without the key is offered what it was offered before: product only', () => {
    const fw = { salesFlows: ['SALE'] };
    expect(missingByCode(fw)).toEqual(missingByCode({ ...fw, distributionModes: ['PRODUCT'] }));
    const entries = catalogueFor(catalogue, simulator, fw);
    expect(entries.filter((e) => !asksFares(e)).flatMap((e) => e.missing).filter((m) => /distribution/.test(m))).toEqual([]);
    for (const e of entries.filter(asksFares)) expect(e.missing[0]).toBe('fare-based distribution (Distribution)');
  });

  test('a fare-only framework is offered no product entry, and is told why first', () => {
    const entries = catalogueFor(catalogue, simulator, { salesFlows: ['SALE'], distributionModes: ['FARE'] });
    const products = entries.filter((e) => e.requirements.distributionModes.includes('PRODUCT'));
    expect(products.length).toBeGreaterThan(0);
    for (const e of products) expect(e.missing[0]).toBe('product-based distribution (Distribution)');
    // A fare-only entry is not refused for its distribution.
    expect(entries.filter((e) => e.code === 'OTST_FARE_SPEC_1ADT').map((e) => e.missing)).toEqual([[]]);
  });

  test('requirementsOf names the modes of each entry', () => {
    const modes = Object.fromEntries(catalogueFor(catalogue, simulator, {}).map((e) => [e.code, e.requirements.distributionModes]));
    expect(modes.OTST_SALE_ONE_WAY_1ADT).toEqual(['PRODUCT']);
    expect(modes.OTST_FARE_SPEC_1ADT).toEqual(['FARE']);
    expect(modes.NHF_FARE_PRODUCT_ONLY).toEqual(['PRODUCT', 'FARE']);
    for (const [code, m] of Object.entries(modes)) if (!/FARE/.test(code)) expect(m).toEqual(['PRODUCT']);
  });
});
