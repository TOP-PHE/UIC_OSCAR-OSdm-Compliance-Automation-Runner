// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-product-category.test.js — #729: a leg's productCategory is sent only
 * when the Test Data gives its reference, name and short name, the three
 * members OSDM requires. A provider refused `"productCategory": {}` as a
 * malformed request.
 */

const { withBrunoExpect } = require('../helpers/bruno-chai');

let envStore = {};
global.bru = {
  getEnvVar:    (k) => (Object.prototype.hasOwnProperty.call(envStore, k) ? envStore[k] : undefined),
  setEnvVar:    (k, v) => { envStore[k] = v; },
  deleteEnvVar: (k) => { delete envStore[k]; },
};

let mockLogs = [];

const sp = require('../../../Bruno_Collection/library-bruno/scenarioParser.js');
// scenarioParser logs through the global displays.js sets when it is loaded.
global.validationLogger = (line) => { mockLogs.push(line); };

beforeEach(() => { envStore = {}; mockLogs = []; });

const leg = (category) => new TripLegDefinition(
  'urn:uic:stn:5457076', '2026-10-24T00:01:00+02:00', 'urn:uic:stn:5433295', '2026-10-24T02:49:00+02:00',
  category.ref, category.name, category.shortName, '579', 'urn:uic:rics:1154',
);

// The service of the one leg osdmTripSpecification writes for `category`.
function serviceFor(category) {
  const jestTest = global.test;
  global.test = (name, fn) => { fn(); };
  try { withBrunoExpect(() => sp.osdmTripSpecification([leg(category)])); } finally { global.test = jestTest; }
  return JSON.parse(envStore.offerTripSpecifications)[0].legs[0].timedLeg.service;
}

describe('productCategory in a trip specification', () => {
  test('all three members: sent as given', () => {
    const service = serviceFor({ ref: 'urn:x:pc:EC', name: 'EuroCity', shortName: 'EC' });
    expect(service.productCategory).toEqual({ productCategoryRef: 'urn:x:pc:EC', name: 'EuroCity', shortName: 'EC' });
    expect(mockLogs.some((l) => l.includes('product category not sent'))).toBe(false);
  });

  test('none given (undefined, null or empty): the member is not written at all', () => {
    for (const missing of [undefined, null, '', '  ']) {
      const service = serviceFor({ ref: missing, name: missing, shortName: missing });
      expect(Object.keys(service)).toEqual(['vehicleNumbers', 'carriers']);
    }
    expect(mockLogs.some((l) => l.includes('product category not sent'))).toBe(false);
  });

  test('some given: not sent, and the log says why', () => {
    const service = serviceFor({ ref: 'urn:x:pc:EC', name: undefined, shortName: 'EC' });
    expect(service).not.toHaveProperty('productCategory');
    expect(mockLogs).toContain('[INFO] Leg 1: product category not sent — OSDM needs its reference, name and short name together.');
  });

  test('productCategoryOf', () => {
    expect(sp.productCategoryOf({ productCategoryRef: 'r', productCategoryName: 'n', productCategoryShortName: 's' }))
      .toEqual({ productCategoryRef: 'r', name: 'n', shortName: 's' });
    expect(sp.productCategoryOf({ productCategoryRef: 'r', productCategoryName: 'n' })).toBeNull();
    expect(sp.productCategoryOf(undefined)).toBeNull();
  });
});
