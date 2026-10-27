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

  test('a declared option the provider does not take is contradicted', () => {
    const report = { options: [
      { option: 'offerSearchCriteria.flexibilities', result: 'ignored-silent', declared: true },
      { option: 'passenger.prmNeeds', result: 'not-implemented', declared: true },
      { option: 'passenger.gender', result: 'honoured', declared: true },
    ] };
    expect(o.compareWithDeclarations(report).contradicted.map((r) => r.option))
      .toEqual(['offerSearchCriteria.flexibilities', 'passenger.prmNeeds']);
  });
});
