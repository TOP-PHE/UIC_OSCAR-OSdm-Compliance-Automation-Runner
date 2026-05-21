// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-scenarioparser.test.js — increment 3 of the library-bruno harness (#85).
 *
 * Covers the pure exported builders of scenarioParser.js that don't depend on
 * the Bruno `test()`/`expect()` globals:
 *   - osdmOfferSearchCriteria — conditional assembly of the offerSearchCriteria
 *   - osdmFulfillmentOptions  — set only when a non-empty array is given
 *   - resetScenarioEnvVars    — clears the business env vars, leaves others
 *
 * Harness: a mocked `bru` (env/var stores) + a no-op validationLogger, same
 * pattern as bruno-envutils / bruno-requestsbuilder. scenarioParser transitively
 * requires displays/validators/model — these only define functions/classes and
 * touch `bru` at call time, so requiring them under the mock is safe. displays
 * re-exposes a real validationLogger on globalThis at load, so we force it back
 * to a no-op afterwards to keep reset logging silent.
 */

let envStore = {};
let varStore = {};
global.bru = {
  getEnvVar:    (k) => (Object.prototype.hasOwnProperty.call(envStore, k) ? envStore[k] : undefined),
  setEnvVar:    (k, v) => { envStore[k] = v; },
  deleteEnvVar: (k) => { delete envStore[k]; },
  getVar:       (k) => (Object.prototype.hasOwnProperty.call(varStore, k) ? varStore[k] : undefined),
  setVar:       (k, v) => { varStore[k] = v; },
};
global.validationLogger = () => {};

const sp = require('../../../Bruno_Collection/library-bruno/scenarioParser.js');
// displays.js (required transitively) assigns a real validationLogger onto
// globalThis at load; force a no-op so reset logging stays silent in tests.
global.validationLogger = () => {};

beforeEach(() => { envStore = {}; varStore = {}; });

describe('osdmOfferSearchCriteria', () => {
  test('includes every provided field', () => {
    sp.osdmOfferSearchCriteria(
      'EUR', 'INDIVIDUAL', [{ type: 'ADMISSION' }], ['NON_FLEXIBLE'],
      ['NOT_APPLICABLE'], ['FIRST'], ['tag1'], [{ productId: 'P1' }], '2026-06-01'
    );
    const out = JSON.parse(envStore.offerSearchCriteria);
    expect(out.currency).toBe('EUR');
    expect(out.offerMode).toBe('INDIVIDUAL');
    expect(out.requestedOfferParts).toEqual([{ type: 'ADMISSION' }]);
    expect(out.flexibilities).toEqual(['NON_FLEXIBLE']);
    expect(out.serviceClassTypes).toEqual(['NOT_APPLICABLE']);
    expect(out.travelClasses).toEqual(['FIRST']);
    expect(out.productTags).toEqual(['tag1']);
    expect(out.productSelections).toEqual([{ productId: 'P1' }]);
    expect(out.inboundDate).toBe('2026-06-01');
  });

  test('omits empty / absent fields → {}', () => {
    sp.osdmOfferSearchCriteria('', '', [], [], [], [], [], [], '');
    expect(JSON.parse(envStore.offerSearchCriteria)).toEqual({});
  });

  test('partial: currency only', () => {
    sp.osdmOfferSearchCriteria('EUR');
    expect(JSON.parse(envStore.offerSearchCriteria)).toEqual({ currency: 'EUR' });
  });

  test('ignores a non-array offerParts', () => {
    sp.osdmOfferSearchCriteria('EUR', 'INDIVIDUAL', 'not-an-array');
    const out = JSON.parse(envStore.offerSearchCriteria);
    expect(out).not.toHaveProperty('requestedOfferParts');
    expect(out.currency).toBe('EUR');
  });
});

describe('osdmFulfillmentOptions', () => {
  test('non-empty array → sets offerFulfillmentOptions', () => {
    sp.osdmFulfillmentOptions([{ type: 'ETICKET', media: 'PDF_A4' }]);
    expect(JSON.parse(envStore.offerFulfillmentOptions)).toEqual([{ type: 'ETICKET', media: 'PDF_A4' }]);
  });

  test('empty array → does not set the var', () => {
    sp.osdmFulfillmentOptions([]);
    expect(envStore.offerFulfillmentOptions).toBeUndefined();
  });

  test('non-array → does not set the var', () => {
    sp.osdmFulfillmentOptions(null);
    expect(envStore.offerFulfillmentOptions).toBeUndefined();
  });
});

describe('resetScenarioEnvVars', () => {
  test('clears business env vars but leaves unrelated keys', () => {
    Object.assign(envStore, {
      offerId: 'O1', bookingId: 'B1', scenarioCode: 'X', fulfillmentIds: '["F1"]',
      offerSearchCriteria: '{}', placeSelections: '[]', placeSelectionMode: 'SEATMAP_AT_OFFER',
      __unrelatedKeep: 'keep',
    });
    sp.resetScenarioEnvVars();
    for (const k of ['offerId', 'bookingId', 'scenarioCode', 'fulfillmentIds', 'offerSearchCriteria', 'placeSelections', 'placeSelectionMode']) {
      expect(envStore[k]).toBeUndefined();
    }
    expect(envStore.__unrelatedKeep).toBe('keep');
  });
});

describe('resolveSalesFlowActions (issue #107)', () => {
  test('missing/invalid object → optional features OFF, patch/get ON', () => {
    for (const input of [undefined, null, 'nope', 42, []]) {
      expect(sp.resolveSalesFlowActions(input)).toEqual({
        patchPassengers: true,  placeSelection: false, addAncillary: false,
        getBooking: true,       deleteAncillary: false,
      });
    }
  });

  test('explicit true overrides the OFF default', () => {
    expect(sp.resolveSalesFlowActions({ placeSelection: true, addAncillary: true }))
      .toEqual({
        patchPassengers: true, placeSelection: true, addAncillary: true,
        getBooking: true,      deleteAncillary: false,
      });
  });

  test('explicit false overrides the ON default (patchPassengers opt-out)', () => {
    expect(sp.resolveSalesFlowActions({ patchPassengers: false }).patchPassengers).toBe(false);
  });

  test('only strict boolean true counts as on (truthy non-true → off)', () => {
    const out = sp.resolveSalesFlowActions({ placeSelection: 'true', addAncillary: 1 });
    expect(out.placeSelection).toBe(false);
    expect(out.addAncillary).toBe(false);
  });

  test('result keys are exactly the five known actions', () => {
    expect(Object.keys(sp.resolveSalesFlowActions({})).sort()).toEqual(
      ['addAncillary', 'deleteAncillary', 'getBooking', 'patchPassengers', 'placeSelection']
    );
  });
});
