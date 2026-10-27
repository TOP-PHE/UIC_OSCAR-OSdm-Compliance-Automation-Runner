// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #227 part 2: what the Test Framework tells the offer request options
 * scenario, and how the collection holds the answers to it.
 */

const path = require('node:path');
const d = require('../../src/utils/offerOptionDiscovery');

const LIB = path.join(__dirname, '..', '..', '..', 'Bruno_Collection', 'library-bruno');
const o = require(path.join(LIB, 'offerOptions.js'));

describe('the settings and codes a framework writer stores', () => {
  test('absent, or within bounds, is fine', () => {
    expect(d.offerOptionDiscoveryProblem({})).toBeNull();
    expect(d.offerOptionDiscoveryProblem({ offerOptionDiscovery: { maxRequests: 3, invalidValues: 'random' } })).toBeNull();
    expect(d.offerOptionDiscoveryProblem({ offerOptionDiscovery: { maxRequests: null } })).toBeNull();
    expect(d.offerOptionDiscoveryProblem({ corporateCodes: [{ code: 'A', issuer: 'urn:x' }], promotionCodes: [{ code: 'P' }] })).toBeNull();
  });

  test.each([
    [{ offerOptionDiscovery: 30 }, 'must be an object'],
    [{ offerOptionDiscovery: { maxRequests: 201 } }, 'from 3 to 200'],
    [{ offerOptionDiscovery: { maxRequests: 10.5 } }, 'from 3 to 200'],
    [{ offerOptionDiscovery: { invalidValues: 'none' } }, 'random or skip'],
    [{ offerOptionDiscovery: { seed: 1 } }, 'does not know'],
    [{ corporateCodes: 'ACME' }, 'a list of at most 20'],
    [{ corporateCodes: [{ code: 1 }] }, 'not { code, issuer }'],
    [{ corporateCodes: [{ code: 'A', issuer: 3 }] }, 'not { code, issuer }'],
    [{ promotionCodes: Array.from({ length: 21 }, (_, i) => ({ code: `P${i}` })) }, 'at most 20'],
    [{ promotionCodes: [{ code: 'x'.repeat(61) }] }, 'up to 60'],
    [{ corporateCodes: [{ code: 'A', issuer: 'urn:{{x}}' }] }, 'template'],
  ])('%j is refused', (fw, words) => {
    expect(d.offerOptionDiscoveryProblem(fw)).toContain(words);
  });

  test('codes are trimmed, kept once, and the issuer only where the list has one', () => {
    expect(d.codesOf([{ code: ' A ', issuer: 'urn:x' }, { code: 'A' }, { code: '' }, null, { code: 'B' }], true))
      .toEqual([{ code: 'A', issuer: 'urn:x' }, { code: 'B' }]);
    expect(d.codesOf([{ code: 'P', issuer: 'urn:x' }], false)).toEqual([{ code: 'P' }]);
    expect(d.codesOf('x', true)).toEqual([]);
  });
});

describe('what the framework declares', () => {
  const fw = {
    reductionCards: [{ code: 'C25', issuer: 'urn:x:rail', name: 'Card 25' }],
    products: [{ code: 'TB', name: 'Train bound', flexibility: 'NON_FLEXIBLE' }],
    currencies: { sold: ['CZK', 'EUR'], default: 'EUR' },
    offerCriteria: { flexibilities: ['SEMI_FLEXIBLE'] },
    offerSearchOptions: { travelClasses: ['ANY_CLASS', 'SECOND'], serviceClassTypes: [], productTags: ['ADMISSION_POINT2POINT'] },
    corporateCodes: [{ code: 'ACME', issuer: 'urn:x:acme' }],
    promotionCodes: [],
    tripSearchParameters: ['VIAS'],
    distributionModes: ['PRODUCT'],
  };

  test('values from the declarations, and what the framework says the provider supports', () => {
    const { values, declared } = d.declarationsOf(fw);
    expect(values).toEqual({
      'passenger.cards': [{ type: 'REDUCTION_CARD', code: 'C25', issuer: 'urn:x:rail' }],
      'offerSearchCriteria.productSelections': [{ productCode: 'TB' }],
      'offerSearchCriteria.currency': 'EUR',
      'offerSearchCriteria.flexibilities': ['SEMI_FLEXIBLE'],
      'offerSearchCriteria.productTags': ['ADMISSION_POINT2POINT'],
      'offerSearchCriteria.travelClasses': ['SECOND'],
      corporateCodes: [{ code: 'ACME', issuer: 'urn:x:acme' }],
    });
    expect(declared).toMatchObject({
      'offerSearchCriteria.serviceClassTypes': false,
      promotionCodes: false,
      'tripSearchCriteria.vias': true,
      'tripSearchCriteria.arrivalTime': false,
      requestedSections: false,
    });
  });

  test('nothing declared, nothing named: an absent list means every value', () => {
    expect(d.declarationsOf({})).toEqual({ values: {}, declared: {} });
    expect(d.declarationsOf({ config: { currencies: { sold: ['SEK'] } } }).values).toEqual({ 'offerSearchCriteria.currency': 'SEK' });
  });

  test('the run\'s copy gives the discovery scenarios their settings, their own winning', () => {
    const datafile = {
      scenarios: [
        { code: 'A', offerOptionDiscovery: 'on' },
        { code: 'B', offerOptionDiscovery: true, offerOptionMaxRequests: 12, offerOptionInvalidValues: 'random', offerOptionValues: { corporateCodes: [{ code: 'MINE', issuer: 'u' }] } },
        { code: 'C' },
        null,
      ],
    };
    const framework = { ...fw, offerOptionDiscovery: { maxRequests: 40, invalidValues: 'skip' } };
    expect(d.withOfferOptionDeclarations(datafile, framework)).toBe(2);
    const [a, b, c] = datafile.scenarios;
    expect(a).toMatchObject({ offerOptionMaxRequests: 40, offerOptionInvalidValues: 'skip' });
    expect(a.offerOptionValues['offerSearchCriteria.currency']).toBe('EUR');
    expect(a.__offerOptionDeclared.promotionCodes).toBe(false);
    expect(b).toMatchObject({ offerOptionMaxRequests: 12, offerOptionInvalidValues: 'random' });
    expect(b.offerOptionValues.corporateCodes).toEqual([{ code: 'MINE', issuer: 'u' }]);
    expect(c).toEqual({ code: 'C' });
    expect(d.withOfferOptionDeclarations({ scenarios: [{ code: 'C' }] }, fw)).toBe(0);
    expect(d.withOfferOptionDeclarations(null, fw)).toBe(0);
    const bare = { scenarios: [{ code: 'D', offerOptionDiscovery: 'on' }] };
    expect(d.withOfferOptionDeclarations(bare, {})).toBe(1);
    expect(bare.scenarios[0]).toEqual({ code: 'D', offerOptionDiscovery: 'on', __offerOptionDeclared: {} });
  });
});

describe('the collection holds the answers to the declarations', () => {
  test('declared but not taken is contradicted; taken but declared unsupported is a suggestion', () => {
    const report = {
      options: [
        { option: 'corporateCodes', declared: true, source: 'declared', result: 'refused' },
        { option: 'passenger.cards', declared: true, source: 'declared', result: 'honoured' },
        { option: 'promotionCodes', declared: false, source: 'invalid', result: 'accepted' },
        { option: 'tripSearchCriteria.arrivalTime', declared: false, source: 'default', result: 'accepted' },
        { option: 'embed', source: 'default', result: 'error' },
        { option: 'offerSearchCriteria.currency', declared: true, source: 'declared', result: 'not-reached' },
      ],
    };
    const { contradicted, undeclared } = o.compareWithDeclarations(report);
    expect(contradicted.map((r) => r.option)).toEqual(['corporateCodes']);
    expect(undeclared.map((r) => r.option)).toEqual(['tripSearchCriteria.arrivalTime']);
    expect(o.compareWithDeclarations(null)).toEqual({ contradicted: [], undeclared: [] });
    const lines = o.reportLines({ version: '3.8.0', budget: 30, used: 1, seed: 1, mandatory: { ok: true, message: '' }, options: report.options, combinations: [], all: null });
    expect(lines.some((l) => l.includes('corporateCodes [declared]:'))).toBe(true);
    expect(lines.some((l) => l.includes('promotionCodes [declared not supported]:'))).toBe(true);
  });

  test('a run fails each declared option the provider does not take, and names the others to declare', async () => {
    const env = {
      offerOptionDiscovery: 'true', osdmVersion: '3.8.0', api_base: 'https://x', access_token: 't', scenarioCode: 'S',
      __offerOptionFull: JSON.stringify({
        anonymousPassengerSpecifications: [{ externalRef: 'P1', type: 'PERSON' }],
        tripSearchCriteria: { origin: { objectType: 'StopPlaceRef', stopPlaceRef: 'urn:uic:stn:1' }, destination: { objectType: 'StopPlaceRef', stopPlaceRef: 'urn:uic:stn:2' }, departureTime: '2026-11-10T08:00:00' },
      }),
      offerOptionValues: JSON.stringify({ corporateCodes: [{ code: 'ACME', issuer: 'urn:x' }] }),
      offerOptionDeclared: JSON.stringify({ corporateCodes: true, 'passenger.gender': false }),
    };
    const checks = [];
    const logs = [];
    global.bru = {
      getEnvVar: (k) => env[k],
      setEnvVar: (k, v) => { env[k] = v; },
      sendRequest: (req, cb) => {
        const body = JSON.parse(req.data);
        if (body.corporateCodes) cb({ response: { status: 400, data: { code: 'CORPORATE_CODE_UNKNOWN' } } });
        else cb(null, { status: 200, data: { offers: [{ offerId: 'O' }] } });
      },
    };
    global.test = (name, fn) => { try { fn(); checks.push([name, 'pass']); } catch (e) { checks.push([name, e.message]); } };
    global.validationLogger = (line) => logs.push(line);
    try {
      expect(await o.runOptionDiscovery(200, { offers: [{ offerId: 'O' }] })).toBe(true);
    } finally {
      delete global.bru; delete global.test; delete global.validationLogger;
    }
    const failed = checks.filter(([, r]) => r !== 'pass');
    expect(failed).toEqual([['🧭 Offer request option corporateCodes — declared in the Test Framework, taken by the provider',
      expect.stringMatching(/^refused \(HTTP 400\): CORPORATE_CODE_UNKNOWN\. Either the provider/)]]);
    expect(logs.some((l) => /declared as not supported in the Test Framework: passenger\.gender\b/.test(l))).toBe(true);
  });

  test('a declared option not taken fails in words, for every result that counts (#990)', () => {
    const results = ['honoured', 'accepted', 'ignored-said', 'ignored-silent', 'no-offer-said', 'no-offer-silent',
      'invalid-said', 'invalid-silent', 'refused', 'not-implemented', 'error', 'not-tested', 'not-reached'];
    const counted = results.filter((result) => o.compareWithDeclarations({ options: [{ option: 'x', declared: true, result }] }).contradicted.length === 1);
    expect(Object.keys(o.NOT_TAKEN_WORDS).sort()).toEqual(counted.sort());
    expect(o.notTakenText({ result: 'ignored-silent', status: 200, message: 'the offers do not keep to currency, and nothing says so' }))
      .toBe('ignored without saying so (HTTP 200): the offers do not keep to currency, and nothing says so. Either the provider does not take it, and the Test Framework should not declare it, or the provider should.');
    expect(o.notTakenText({ result: 'error' })).toMatch(/^answered with an error: no detail\. /);
    expect(o.notTakenText({ result: 'unknown-code', status: 500, message: 'm' })).toMatch(/^unknown-code \(HTTP 500\): m\. /);
    // A detail already in those words is not preceded by them again.
    const silent = { result: 'no-offer-silent', status: 200, message: 'no offer, and nothing says why (OSDM: the answer should say no offer fits the options, or offer others)' };
    expect(o.notTakenText(silent)).toMatch(/^HTTP 200: no offer, and nothing says why \(OSDM: /);
    expect(o.notTakenText({ ...silent, status: 0 })).toMatch(/^no offer, and nothing says why \(OSDM: /);
  });
});

// #227 part 3: the checklist's questions A2.5, P1.19–P1.21.
describe('the discovery settings read from a checklist', () => {
  const { frameworkFromChecklist } = require('../../src/utils/referenceConfiguration');

  test('the ceiling, the choice and both code tables', () => {
    const fw = frameworkFromChecklist({
      'fw.offerOptionDiscovery.maxRequests': '40',
      'fw.offerOptionDiscovery.invalidValues=skip': true,
      'data.corporateCodes=YES': true,
      'data.corporateCode.1.code': 'CORP-1', 'data.corporateCode.1.issuer': 'urn:issuer',
      'data.corporateCode.2.code': '{{access_token}}',
      'data.corporateCode.3.code': 'x'.repeat(61),
      'data.promotionCodes=YES': true,
      'data.promotionCode.1.code': 'PROMO', 'data.promotionCode.2.code': 'PROMO',
    });
    expect(fw.offerOptionDiscovery).toEqual({ maxRequests: 40, invalidValues: 'skip' });
    expect(fw.corporateCodes).toEqual([{ code: 'CORP-1', issuer: 'urn:issuer' }]);
    expect(fw.promotionCodes).toEqual([{ code: 'PROMO' }]);
    expect(d.offerOptionDiscoveryProblem(fw)).toBeNull();
  });

  test('a ceiling outside 3 to 200 is dropped; NO is an empty list; nothing answered changes nothing', () => {
    for (const n of ['2', '201', '7.5']) {
      const fw = frameworkFromChecklist({ 'fw.offerOptionDiscovery.maxRequests': n });
      expect(fw.offerOptionDiscovery).toBeUndefined();
      expect(d.offerOptionDiscoveryProblem(fw)).toBeNull();
    }
    const no = frameworkFromChecklist({ 'data.corporateCodes=NO': true, 'data.promotionCodes=NO': true });
    expect(no).toMatchObject({ corporateCodes: [], promotionCodes: [] });
    const none = frameworkFromChecklist({});
    expect(none.corporateCodes).toBeUndefined();
    expect(none.promotionCodes).toBeUndefined();
    const base = { offerOptionDiscovery: { maxRequests: 12 }, promotionCodes: [{ code: 'KEPT' }] };
    expect(frameworkFromChecklist({}, { base })).toMatchObject(base);
  });
});
