// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * point-positions.test.js — the provider's position on a coverage point
 * (#994): which positions, where they are refused, what they change on the
 * finding, and the finding a first position opens.
 */

const PP = require('../../src/utils/pointPositions');
const { CATEGORIES, STATUSES, SEVERITIES } = require('../../src/api/helpers/findings');
const { ALWAYS_REQUIRED, CAPABILITY } = require('../../src/utils/capabilities');

const point = (extra = {}) => ({
  source: 'check', kind: 'provider', capability: 'fulfilment.documents', capabilityLabel: 'Fulfilment documents', expectedRefusal: false,
  step: '06b. GET Fulfillment', check: 'Fulfillment document is a PDF', status: 200, observed: { text: "expected 'PKPASS' to equal 'PDF_A4'" },
  tests: [{ key: 'T', codes: ['SHARED_SALE'] }], runs: [{ runId: 'r1', code: 'SHARED_SALE', at: '2026-10-25 10:00:00' }], finding: null, ...extra,
});

describe('the positions', () => {
  test('each sets a category, a status and a severity a finding can hold', () => {
    expect(Object.keys(PP.POSITIONS)).toEqual(['fix', 'notSupported', 'onPurpose', 'oscar', 'specification', 'declaration', 'fixed']);
    for (const key of Object.keys(PP.POSITIONS)) {
      const change = PP.findingChange(key);
      expect(CATEGORIES.has(change.category)).toBe(true);
      expect(STATUSES.has(change.status)).toBe(true);
      if (change.severity) expect(SEVERITIES.has(change.severity)).toBe(true);
    }
    expect(PP.choices()).toEqual(Object.entries(PP.POSITIONS).map(([key, p]) => ({ key, label: p.label })));
  });

  test('only "on purpose" resolves the finding: a resolved provider deviation is an accepted one', () => {
    expect(PP.findingChange('onPurpose')).toEqual({ category: 'provider_deviation', status: 'resolved', severity: null });
    for (const key of ['fix', 'fixed']) expect(PP.findingChange(key)).toEqual({ category: 'provider_deviation', status: 'discussing', severity: null });
    expect(PP.findingChange('notSupported')).toEqual({ category: 'not_supported', status: 'discussing', severity: 'not_supported' });
    expect(PP.findingChange('oscar').category).toBe('oscar_issue');
    expect(PP.findingChange('specification').category).toBe('spec_question');
    expect(PP.findingChange('declaration').category).toBe('open');
  });

  test('the capabilities every provider must have exist', () => {
    expect(ALWAYS_REQUIRED).toEqual(['sale', 'offers.search']);
    for (const id of ALWAYS_REQUIRED) expect(CAPABILITY.has(id)).toBe(true);
  });
});

describe('where a position is refused', () => {
  test('an unknown position, a known deviation, a point OSCAR owns', () => {
    expect(PP.positionRefusal(point(), 'maybe')).toBe('Unknown position.');
    expect(PP.positionRefusal(point(), '__proto__')).toBe('Unknown position.');
    expect(PP.positionRefusal(point({ source: 'known-deviation' }), 'fix')).toMatch(/known deviation/);
    expect(PP.positionRefusal(point({ kind: 'oscar' }), 'fix')).toMatch(/OSCAR's own/);
    // OSCAR's by a position taken before: the provider may change its mind.
    expect(PP.positionRefusal(point({ kind: 'oscar', finding: { id: 'f', category: 'oscar_issue' } }), 'fix')).toBeNull();
  });

  test('"not supported" on the sale, the offers by search and an expected refusal', () => {
    expect(PP.positionRefusal(point(), 'notSupported')).toBeNull();
    expect(PP.positionRefusal(point({ capability: 'sale', capabilityLabel: 'Sale' }), 'notSupported')).toBe('Sale is required of every provider: it cannot be "not supported".');
    expect(PP.positionRefusal(point({ capability: 'offers.search', capabilityLabel: '' }), 'notSupported')).toMatch(/^offers\.search is required/);
    expect(PP.positionRefusal(point({ expectedRefusal: true }), 'notSupported')).toMatch(/expected refusal/);
    for (const key of ['fix', 'onPurpose', 'fixed']) expect(PP.positionRefusal(point({ capability: 'sale', expectedRefusal: true }), key)).toBeNull();
  });

  test('a comment of 1 to 4000 characters', () => {
    expect(PP.commentOf('  Mobile only.  ')).toBe('Mobile only.');
    expect(PP.commentOf('')).toBeNull();
    expect(PP.commentOf('   ')).toBeNull();
    expect(PP.commentOf(42)).toBeNull();
    expect(PP.commentOf('x'.repeat(4000))).toHaveLength(4000);
    expect(PP.commentOf('x'.repeat(4001))).toBeNull();
  });
});

describe('the finding a first position opens', () => {
  test('from the point: title, step, scenario, what was expected and seen, its runs', () => {
    expect(PP.findingFields(point(), 'notSupported')).toEqual({
      title: 'Fulfilment documents: Fulfillment document is a PDF', step: '06b. GET Fulfillment', scenarioCode: 'SHARED_SALE', expectedStatus: null,
      observed: "Expected: Fulfillment document is a PDF\nSeen: expected 'PKPASS' to equal 'PDF_A4'", interpretation: '',
      evidence: 'Run r1 (SHARED_SALE, 2026-10-25 10:00:00)', category: 'not_supported',
    });
  });

  test('an error status, several scenarios, nothing seen, a long check', () => {
    const f = PP.findingFields(point({
      status: 422, observed: null, check: 'c'.repeat(300), tests: [{ codes: ['A', 'B'] }], runs: [{ runId: 'r2', code: 'A', at: null }],
    }), 'fix');
    expect(f).toMatchObject({ expectedStatus: 422, scenarioCode: null, observed: `Expected: ${'c'.repeat(300)}`, evidence: 'Run r2 (A)', category: 'provider_deviation' });
    expect(f.title).toHaveLength(200);
    expect(f.title.endsWith('…')).toBe(true);
  });

  test('the thread line and the position as the coverage shows it', () => {
    expect(PP.threadText('fixed', 'Release 4.2.')).toBe('Position: Fixed, please run again.\n\nRelease 4.2.');
    expect(PP.positionView(null)).toBeNull();
    expect(PP.positionView({ position: null })).toBeNull();
    expect(PP.positionView({ position: 'toString' })).toBeNull();
    expect(PP.positionView({ position: 'fix', positionBy: 'tm@x.example', positionRole: 'test_manager', positionAt: '2026-10-27 09:00:00', positionComment: 'To fix.' }))
      .toEqual({ value: 'fix', label: 'Agreed, we will fix it', by: 'tm@x.example', role: 'Test Manager', at: '2026-10-27 09:00:00', comment: 'To fix.' });
    expect(PP.positionView({ position: 'fix', positionRole: 'administrator' }).role).toBeNull();
  });
});
