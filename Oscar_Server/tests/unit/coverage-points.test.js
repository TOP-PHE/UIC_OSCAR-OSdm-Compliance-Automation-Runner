// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #972 part 2: the points to look at (coveragePoints.js). The report reads a
 * known deviation from the line the collection logs, so the line is made by
 * the collection's own noteKnownDeviation() here.
 */

const P = require('../../src/utils/coveragePoints');

const env = {};
global.bru = { getEnvVar: (k) => env[k], setEnvVar: (k, v) => { env[k] = v; } };
const { noteKnownDeviation } = require('../../../Bruno_Collection/library-bruno/loopback.js');

afterAll(() => { delete global.bru; });

function logged(fn) {
  const lines = [];
  const spy = jest.spyOn(console, 'log').mockImplementation((line) => { lines.push(line); });
  try { fn(); } finally { spy.mockRestore(); }
  return lines;
}

describe('known deviations, read from the run log', () => {
  test('the line the collection writes is read back', () => {
    const lines = logged(() => {
      noteKnownDeviation('04. GET Passenger', 501, { note: 'GET Passenger is not implemented' });
      noteKnownDeviation('11. GET Refund Offer', 405, null);
    });
    expect(P.knownDeviationsOf(lines)).toEqual([
      { step: '04. GET Passenger', status: 501, note: 'GET Passenger is not implemented' },
      { step: '11. GET Refund Offer', status: 405, note: 'declared in the provider baseline' },
    ]);
  });

  test('a line stored with a prefix is read; the same deviation twice is one', () => {
    const [line] = logged(() => noteKnownDeviation('13. PATCH Refund Offer', 409, { note: 'n' }));
    expect(P.knownDeviationsOf([`2026-10-26T08:00:00Z ${line}`, line])).toEqual([{ step: '13. PATCH Refund Offer', status: 409, note: 'n' }]);
  });

  test('any other line is not a known deviation', () => {
    for (const line of [
      '[WARNING] Known deviation (documented):  returned HTTP 409 — n.',
      '[WARNING] Known deviation (documented): 13. PATCH returned HTTP 40 — n.',
      '[WARNING] Known deviation (documented): 13. PATCH returned 409',
      '[INFO] 13. PATCH returned HTTP 409',
      null,
    ]) expect(P.knownDeviationOf(line)).toBeNull();
    expect(P.knownDeviationOf('[WARNING] Known deviation (documented): 13. PATCH returned HTTP 409')).toEqual({ step: '13. PATCH', status: 409, note: '' });
  });
});

describe('a point and its finding', () => {
  const at = (n) => ({ id: `run-${n}`, completed_at: `2026-10-2${n} 08:00:00` });
  const check = { request_name: '07. GET Booking after Fulfillments', assertion_name: 'Price is 12.50', http_status: 200 };
  const seen = (n, extra = {}) => ({ check, capability: 'sale', blocking: false, test: { key: 'T', entry: null }, code: `C${n}`, run: at(n), ...extra });

  test('the kind follows the finding, the #735 draft and the check', () => {
    const failures = [{ check, run: at(1), code: 'C1' }];
    const kindWith = (findings, suggestions) => [...P.linkFailures(failures, { findings, suggestions }).values()][0].kind;
    const f = (category, status) => [{ id: 'f', title: 'x', step: check.request_name, category, status, observed: 'price is n' }];
    expect(kindWith([])).toBe('provider');
    expect(kindWith(f('provider_deviation', 'open'))).toBe('provider');
    expect(kindWith(f('provider_deviation', 'resolved'))).toBe('accepted');
    expect(kindWith(f('spec_question', 'open'))).toBe('question');
    expect(kindWith(f('oscar_issue', 'resolved'))).toBe('oscar');
    expect(kindWith([], { oscarIssues: [P.keyOfCheck(check)] })).toBe('oscar');
    expect(P.isAcceptedFinding({ category: 'provider_deviation', status: 'discussing' })).toBe(false);
  });

  test('a match only by step and scenario names the finding as possible, without its category', () => {
    const findings = [{ id: 'f', title: 'Another problem', step: check.request_name, category: 'provider_deviation', status: 'resolved', scenarioCode: 'C1' }];
    const links = P.linkFailures([{ check, run: at(1), code: 'C1' }], { findings });
    const [link] = links.values();
    expect(link).toMatchObject({ finding: null, possible: { id: 'f' }, kind: 'provider' });
    const { points } = P.pointsOf([seen(1)], { links, findings });
    expect(points[0]).toMatchObject({ finding: null, possibleFinding: { id: 'f', title: 'Another problem', category: 'provider_deviation', status: 'resolved' } });
  });

  test('a point keeps 10 runs and its first and last day; the list stops at its maximum', () => {
    const many = Array.from({ length: 12 }, (_, i) => seen(i % 9 + 1, { code: `C${i}`, run: { id: `run-${i}`, completed_at: `2026-10-${String(10 + i).padStart(2, '0')} 08:00:00` } }));
    const { points } = P.pointsOf(many);
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ occurrences: 12, firstSeen: '2026-10-10 08:00:00', lastSeen: '2026-10-21 08:00:00' });
    expect(points[0].runs).toHaveLength(10);
    expect(points[0].tests).toEqual([{ key: 'T', entry: null, codes: many.map((s) => s.code) }]);

    const distinct = Array.from({ length: P.MAX_POINTS + 3 }, (_, i) => seen(1, { check: { ...check, assertion_name: `Check ${'x'.repeat(i)}` } }));
    const capped = P.pointsOf(distinct);
    expect(capped.points).toHaveLength(P.MAX_POINTS);
    expect(capped.truncated).toBe(true);
    expect(capped.points.at(-1).number).toBe(P.MAX_POINTS);
  });

  test('within a capability the blocking points come first', () => {
    // The blocking step sorts after the other by name: only the blocking rule puts it first.
    const late = { ...check, request_name: '13. PATCH Refund Offer', assertion_name: 'HTTP response status — expected 200, actual: 500', http_status: 500 };
    const { points } = P.pointsOf([seen(1), seen(2, { check: late, blocking: true })], { capabilities: ['sale'] });
    expect(points.map((p) => [p.number, p.step, p.blocking])).toEqual([[1, '13. PATCH Refund Offer', true], [2, '07. GET Booking after Fulfillments', false]]);
  });

  test('a known deviation names the finding that put it in the runs, not another of the same step', () => {
    const dev = { step: '13. PATCH Refund Offer', status: 409, note: '' };
    const f = (extra) => ({ id: 'f', title: 't', step: 'PATCH Refund Offer', expectedStatus: 409, category: 'provider_deviation', status: 'open', ...extra });
    const named = (findings) => P.pointsOf([{ deviation: dev, capability: 'refund.full', test: { key: 'T', entry: null }, code: 'C', run: at(1) }], { findings }).points[0].finding;
    expect(named([f({ baselineInRun: true })])).toMatchObject({ id: 'f' });
    expect(named([f({ baselineInRun: false })])).toBeNull();
    expect(named([f({ baselineInRun: true, expectedStatus: 405 })])).toBeNull();
  });

  test('one problem under two capabilities, or in an expected refusal, is two points', () => {
    const { points } = P.pointsOf([seen(1), seen(2, { capability: 'fulfilment.documents' }), seen(3, { refusal: true })],
      { capabilities: ['sale', 'fulfilment.documents'] });
    expect(points.map((p) => [p.number, p.capability, p.expectedRefusal])).toEqual([[1, 'sale', false], [2, 'sale', true], [3, 'fulfilment.documents', false]]);
  });
});
