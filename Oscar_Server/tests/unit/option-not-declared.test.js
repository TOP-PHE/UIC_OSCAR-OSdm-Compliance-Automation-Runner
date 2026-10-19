// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #780 PR C: a probe asking on purpose for an offer search option value the
 * Test Framework leaves out. The catalogue picks the value at copy time; the
 * collection grades the answer as the currency probe does (#781).
 */

const fs = require('node:fs');
const path = require('node:path');

const { annotateDatafile } = require('../../src/utils/frameworkGating');
const { catalogueFor, catalogueDatafile, undeclaredOptionValue } = require('../../src/utils/scenarioCatalogue');
const { adaptCatalogueDatafile } = require('../../src/utils/catalogueMatch');
const { schemaProblems } = require('../../src/utils/datafileSchema');

const LIB = path.join(__dirname, '..', '..', '..', 'Bruno_Collection', 'library-bruno');
const DATA = path.join(LIB, '..', 'data_base');
const { askedValues, undeclaredOutcome } = require(path.join(LIB, 'optionNotDeclared.js'));

const offer = (id, travelClass) => ({
  offerId: id,
  products: [{ id: `${id}-A`, type: 'ADMISSION', travelClass, serviceClass: { type: travelClass === 'FIRST' ? 'HIGH' : 'STANDARD' } }],
  admissionOfferParts: [{ id: `${id}-AP`, products: [{ productId: `${id}-A` }] }],
});

describe('the catalogue picks a value the framework leaves out', () => {
  const catalogue = JSON.parse(fs.readFileSync(path.join(DATA, 'scenario_catalogue.json'), 'utf8'));
  const simulator = JSON.parse(fs.readFileSync(path.join(DATA, 'simulator_datafile.json'), 'utf8'));
  const FW = { salesFlows: ['SALE'], passengerTypes: ['ADULT'] };
  const entry = (fw) => catalogueFor(catalogue, simulator, fw).find((e) => e.code === 'OTST_OFFER_OPTION_NOT_DECLARED');

  test('the first left out, in the order of the options; none from absent lists, nor the offer mode', () => {
    expect(undeclaredOptionValue({})).toBeNull();
    expect(undeclaredOptionValue({ offerSearchOptions: { offerModes: ['INDIVIDUAL'] } })).toBeNull();
    expect(undeclaredOptionValue({ offerSearchOptions: { offerModes: ['INDIVIDUAL'], travelClasses: ['SECOND'], serviceClassTypes: ['STANDARD'] } }))
      .toMatchObject({ key: 'travelClasses', field: 'travelClass', value: 'FIRST', member: 'travelClasses' });
    expect(undeclaredOptionValue({ offerSearchOptions: { requestedOfferParts: ['ADMISSION'] } }).value).toBe('RESERVATION');
    expect(undeclaredOptionValue({ offerCriteria: { flexibilities: ['NON_FLEXIBLE'] } })).toMatchObject({ key: 'flexibilities', value: 'FULL_FLEXIBLE' });
    expect(undeclaredOptionValue({ offerSearchOptions: { travelClasses: ['FIRST', 'SECOND'], productTags: [] } })).toMatchObject({ key: 'productTags', value: 'ADMISSION_POINT2POINT' });
  });

  test('nothing left out: listed once, not copiable; else the entry names the value', () => {
    expect(entry(FW).missing).toEqual(['an offer search option whose list leaves a value out (Offer search options, Tariff Flexibility)']);
    const e = entry({ ...FW, offerSearchOptions: { serviceClassTypes: ['STANDARD'] } });
    expect(e.missing).toEqual([]);
    expect(e.optionOf).toEqual({ key: 'serviceClassTypes', field: 'serviceClass', value: 'BEST' });
    expect(e.purpose).toMatch(/Value asked: offerSearchCriteria\.serviceClassTypes BEST\.$/);
    expect(e.requirements.offerRequest.convertible).toBe(false);
  });

  test('the copy asks that value alone with the probe armed, no offer search probe; the file stays valid and warns nothing', () => {
    const fw = { ...FW, offerSearchOptions: { travelClasses: ['SECOND'] } };
    const entries = catalogueFor(catalogue, simulator, fw);
    const { datafile } = adaptCatalogueDatafile(catalogueDatafile(catalogue, simulator), entries, fw);
    const sc = datafile.scenarios.find((s) => s.code === 'OTST_OFFER_OPTION_NOT_DECLARED');
    expect(sc.offerSearchCriteria).toEqual({ serviceClass: [], travelClass: ['FIRST'], flexibilities: [], offerMode: null, requestedOfferParts: [] });
    expect(sc.offerOptionExpectRejection).toBe('on');
    expect(sc.offerSearchProbe).toBeUndefined();
    const schema = JSON.parse(fs.readFileSync(path.join(LIB, '..', 'json_validator', 'datafile.schema.json'), 'utf8'));
    expect(schemaProblems(datafile, schema).problems).toEqual([]);
    annotateDatafile(datafile, fw);
    expect(datafile.scenarios.find((s) => s.code === 'OTST_OFFER_OPTION_NOT_DECLARED').__featureNotDeclaredWarnings).toBeUndefined();
  });

  test('a flexibility probe does not choose that flexibility for the sale', () => {
    const fw = { ...FW, offerCriteria: { flexibilities: ['NON_FLEXIBLE'] } };
    const entries = catalogueFor(catalogue, simulator, fw);
    const { datafile } = adaptCatalogueDatafile(catalogueDatafile(catalogue, simulator), entries, fw);
    const sc = datafile.scenarios.find((s) => s.code === 'OTST_OFFER_OPTION_NOT_DECLARED');
    expect(sc.offerSearchCriteria.flexibilities).toEqual(['FULL_FLEXIBLE']);
    expect(sc.desiredFlexibility).not.toBe('FULL_FLEXIBLE');
  });

  test('without the probe flag, the same value warns as before', () => {
    const df = { scenarios: [{ code: 'A', offerSearchCriteria: { travelClass: ['FIRST'] } }] };
    annotateDatafile(df, { offerSearchOptions: { travelClasses: ['SECOND'] } });
    expect(df.scenarios[0].__featureNotDeclaredWarnings).toEqual(['offerOption:travelClasses=FIRST']);
  });
});

describe('the collection grades the answer', () => {
  const criteria = { travelClasses: ['FIRST'] };

  test('the values asked, as text', () => {
    expect(askedValues({ travelClasses: ['FIRST'], requestedOfferParts: ['RESERVATION'] })).toEqual(['requestedOfferParts RESERVATION', 'travelClasses FIRST']);
    expect(askedValues(null)).toEqual([]);
  });

  test('refused, none, ignored, kept, silent', () => {
    expect(undeclaredOutcome(400, {}, criteria)).toBe('refused');
    expect(undeclaredOutcome(501, {}, criteria)).toBe('refused');
    expect(undeclaredOutcome(200, { offers: [] }, criteria)).toBe('none');
    expect(undeclaredOutcome(200, {}, criteria)).toBe('none');
    expect(undeclaredOutcome(200, { offers: [offer('a', 'SECOND')] }, criteria, ['travelclasses'])).toBe('ignored');
    expect(undeclaredOutcome(200, { offers: [offer('a', 'FIRST')] }, criteria)).toBe('kept');
    expect(undeclaredOutcome(200, { offers: [offer('a', 'SECOND')] }, criteria)).toBe('silent');
    expect(undeclaredOutcome(200, { offers: [offer('a', 'SECOND'), offer('b', 'FIRST')] }, criteria)).toBe('silent');
  });

  test('after 01: a passing test, a failing one when kept, a warning when silent; not armed, nothing', () => {
    const run = (env, status, body) => {
      const logs = [];
      const results = [];
      global.bru = { getEnvVar: (k) => env[k], setEnvVar: () => {} };
      global.test = (name, fn) => { try { fn(); results.push([name, 'pass']); } catch (e) { results.push([name, 'fail', e.message]); } };
      global.validationLogger = (line) => { logs.push(line); };
      let ended;
      try {
        ended = require(path.join(LIB, 'optionNotDeclared.js')).checkUndeclaredOption(status, body);
      } finally { delete global.bru; delete global.test; }
      return { ended, logs, results };
    };
    const env = { offerOptionExpectRejection: 'true', offerSearchCriteria: JSON.stringify(criteria) };
    const name = '🧪 Undeclared option probe [travelClasses FIRST, POST /offers]: the offers do not keep to the value asked';
    expect(run({}, 200, { offers: [] })).toEqual({ ended: false, logs: [], results: [] });
    expect(run(env, 200, { offers: [] }).results).toEqual([[name, 'pass']]);
    const kept = run(env, 200, { offers: [offer('a', 'FIRST')] });
    expect(kept.results[0][1]).toBe('fail');
    expect(kept.results[0][2]).toMatch(/the Test Framework should declare it/);
    const silent = run(env, 200, { offers: [offer('a', 'SECOND')] });
    expect(silent.results).toEqual([[name, 'pass']]);
    expect(silent.logs.at(-1)).toMatch(/^\[WARNING\] 🧪 Undeclared option probe: offers that do not keep to travelClasses FIRST/);
    const ignored = run(env, 200, { offers: [offer('a', 'SECOND')], problems: [{ code: 'PARAMETER_NOT_SUPPORTED', pointers: ['offerSearchCriteria.travelClasses'] }] });
    expect(ignored.results).toEqual([[name, 'pass']]);
    expect(ignored.logs.at(-1)).toMatch(/said|says it ignored/);
    const refused = run(env, 400, { code: 'INVALID_REQUEST', title: 'no' });
    expect(refused.ended).toBe(true);
    expect(refused.results.length).toBeGreaterThan(0);
    const empty = run({ offerOptionExpectRejection: 'true', offerSearchCriteria: '{}' }, 200, {});
    expect(empty.results[0][1]).toBe('fail');
  });

  test('01 calls it before the status check; the parser arms it and resets it', () => {
    const step = fs.readFileSync(path.join(LIB, '..', '02-Common Requests', '01. POST Get Offer.yml'), 'utf8');
    expect(step.indexOf('optionNotDeclared.js").checkUndeclaredOption(res.getStatus(), _tripIdsBody)'))
      .toBeGreaterThan(step.indexOf('currencies.js").checkCurrencyNotSold('));
    expect(step.indexOf('optionNotDeclared.js")')).toBeLessThan(step.indexOf('// Validate HTTP response status'));
    for (const file of [path.join(LIB, 'scenarioParser.js'), path.join(LIB, '..', 'opencollection.yml')]) {
      expect(fs.readFileSync(file, 'utf8')).toContain('"currencyExpectRejection", "offerOptionExpectRejection",');
    }
    expect(fs.readFileSync(path.join(LIB, 'scenarioParser.js'), 'utf8')).toContain('bru.setEnvVar("offerOptionExpectRejection",');
  });
});
