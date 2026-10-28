// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #991: a scenario's own `offerOptionDeclared` is laid over the Test
// Framework's `__offerOptionDeclared`, so a simulator scenario can hold the
// provider to a declaration without a framework.

global.bru = { getEnvVar: () => undefined, setEnvVar: () => {}, deleteEnvVar: () => {} };
jest.mock('../../../Bruno_Collection/library-bruno/displays.js', () => ({ validationLogger: () => {} }));

const { declaredOptionsOf } = require('../../../Bruno_Collection/library-bruno/scenarioParser.js');
const o = require('../../../Bruno_Collection/library-bruno/offerOptions.js');

describe('declaredOptionsOf (#991)', () => {
  test('none declared gives null', () => {
    expect(declaredOptionsOf({})).toBeNull();
    expect(declaredOptionsOf({ offerOptionDeclared: null, __offerOptionDeclared: [] })).toBeNull();
  });

  test("the framework's declarations alone, as before", () => {
    expect(JSON.parse(declaredOptionsOf({ __offerOptionDeclared: { promotionCodes: false } }))).toEqual({ promotionCodes: false });
  });

  test("the scenario's own win, key by key", () => {
    const s = {
      __offerOptionDeclared: { promotionCodes: false, 'passenger.gender': true },
      offerOptionDeclared: { promotionCodes: true, 'offerSearchCriteria.flexibilities': true },
    };
    expect(JSON.parse(declaredOptionsOf(s))).toEqual({
      promotionCodes: true, 'passenger.gender': true, 'offerSearchCriteria.flexibilities': true,
    });
  });

  test('only true and false count', () => {
    expect(JSON.parse(declaredOptionsOf({ offerOptionDeclared: { a: 'yes', b: 1, c: true } }))).toEqual({ c: true });
  });

  test('a declared option the provider does not take is contradicted; a declared flexibility ignored only warns (#1035)', () => {
    const report = { options: [
      { option: 'offerSearchCriteria.flexibilities', result: 'ignored-silent', declared: true },
      { option: 'passenger.prmNeeds', result: 'not-implemented', declared: true },
      { option: 'passenger.gender', result: 'honoured', declared: true },
    ] };
    const r = o.compareWithDeclarations(report);
    expect(r.contradicted.map((x) => x.option)).toEqual(['passenger.prmNeeds']);
    expect(r.warned.map((x) => x.option)).toEqual(['offerSearchCriteria.flexibilities']);
  });

  test('a declared flexibility refused, in error or without offer still fails; ignored and said only warns (#1035)', () => {
    const results = ['refused', 'not-implemented', 'error', 'no-offer-said', 'no-offer-silent', 'ignored-said', 'ignored-silent'];
    const rows = results.map((result) => ({ option: 'offerSearchCriteria.flexibilities', result, declared: true }));
    const r = o.compareWithDeclarations({ options: rows });
    expect(r.contradicted.map((x) => x.result)).toEqual(['refused', 'not-implemented', 'error', 'no-offer-said', 'no-offer-silent']);
    expect(r.warned.map((x) => x.result)).toEqual(['ignored-said', 'ignored-silent']);
    // Any other declared option ignored still fails.
    expect(o.compareWithDeclarations({ options: [{ option: 'offerSearchCriteria.travelClasses', result: 'ignored-silent', declared: true }] }).contradicted).toHaveLength(1);
    expect([...o.WARN_WHEN_IGNORED]).toEqual(['offerSearchCriteria.flexibilities']);
    expect(o.warnedText({ option: 'offerSearchCriteria.flexibilities', result: 'ignored-said', status: 200, message: 'm' }))
      .toBe('[WARNING] 🧭 Offer request option offerSearchCriteria.flexibilities — declared in the Test Framework, ignored, and the answer says so (HTTP 200): m. The offers are in another flexibility: a warning, not a failure (the provider offers what it has).');
  });
});
