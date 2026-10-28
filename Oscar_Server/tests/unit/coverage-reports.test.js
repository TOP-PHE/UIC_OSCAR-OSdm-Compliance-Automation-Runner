// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #972 part 4: what a published report says of the previous shared one
 * (coverageReports.js).
 */

const R = require('../../src/utils/coverageReports');

const UUID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const point = (number, keys, extra = {}) => ({
  number, keys, kind: 'provider', capability: 'sale', capabilityLabel: 'Sale', steps: ['07. GET Booking'], check: `Check ${number}`,
  tests: [{ key: 'T', entry: null, codes: ['A'] }], runs: [], ...extra,
});
const report = ({ points = [], capabilities = [], ran = ['A'] } = {}) => ({
  byCapability: {
    capabilities: [...capabilities, { id: 'x', label: 'X', group: 'G', result: 'passed', tests: [{ forms: ran.map((code, i) => ({ code, runId: UUID(i + 1), result: 'passed' })) }] }],
    expectedRefusals: [], points,
    summary: { tested: 3, passed: 1, points: 2, expectedRefusals: { total: 1, refused: 1 }, pointsToLookAt: { total: points.length, provider: points.length } },
  },
});
const previous = (r, extra = {}) => ({ id: 'p', number: 4, sharedAt: '2026-10-20 10:00:00', report: r, ...extra });

describe('the comparison with the previous shared report', () => {
  test('no previous shared report, no comparison', () => {
    expect(R.comparisonOf(report(), null)).toBeNull();
    expect(R.comparisonOf(report(), { id: 'p' })).toBeNull();
  });

  test('still, new, fixed, not run again', () => {
    const before = report({ points: [point(1, ['k1', 'k2']), point(2, ['k3']), point(3, ['k4'], { tests: [{ key: 'U', codes: ['B'] }] })] });
    // k2 is met again at another step: the same problem.
    // Its key met again is not its first: the match looks at every key.
    const now = report({ points: [point(1, ['k8', 'k2'], { kind: 'accepted' }), point(2, ['k9'])] });
    const out = R.comparisonOf(now, previous(before));
    expect(out.previous).toEqual({ id: 'p', number: 4, sharedAt: '2026-10-20 10:00:00' });
    expect(out.counts).toEqual({ still: 1, new: 1, fixed: 1, notRetested: 1 });
    expect(out.points.still).toEqual([expect.objectContaining({ number: 1, previousNumber: 1, kind: 'accepted', previousKind: 'provider' })]);
    expect(out.points.new).toEqual([expect.objectContaining({ number: 2, check: 'Check 2' })]);
    // Point 2's test (A) ran again without it: fixed. Point 3's (B) did not run: nothing can be said.
    expect(out.points.fixed).toEqual([expect.objectContaining({ previousNumber: 2, check: 'Check 2', steps: ['07. GET Booking'] })]);
    expect(out.points.notRetested).toEqual([expect.objectContaining({ previousNumber: 3 })]);
  });

  test('a point with no keys is matched by its key; a run without a UUID does not count as run again', () => {
    const before = report({ points: [point(1, undefined, { key: 'kd:x#409' })] });
    expect(R.comparisonOf(report({ points: [point(5, undefined, { key: 'kd:x#409' })] }), previous(before)).counts.still).toBe(1);
    const notRun = report({ ran: [] });
    notRun.byCapability.capabilities[0].tests[0].forms = [{ code: 'A', runId: 'not-a-uuid' }];
    expect(R.comparisonOf(notRun, previous(before)).counts).toEqual({ still: 0, new: 0, fixed: 0, notRetested: 1 });
  });

  test('the capabilities whose result moved, either way', () => {
    const before = report({ capabilities: [{ id: 'sale', label: 'Sale', group: 'Sale', result: 'points' }, { id: 'gone', label: 'Gone', group: 'G', result: 'passed' }] });
    const now = report({ capabilities: [{ id: 'sale', label: 'Sale', group: 'Sale', result: 'passed' }, { id: 'added', label: 'Added', group: 'G', result: 'blocked' }] });
    expect(R.comparisonOf(now, previous(before)).capabilities).toEqual([
      { id: 'sale', label: 'Sale', group: 'Sale', before: 'points', now: 'passed' },
      { id: 'gone', label: 'Gone', group: 'G', before: 'passed', now: null },
      { id: 'added', label: 'Added', group: 'G', before: null, now: 'blocked' },
    ]);
  });
});

describe('what a report keeps beside its content', () => {
  test('its runs: every UUID of its forms and points, once', () => {
    const r = report({ ran: ['A', 'B'] });
    r.byCapability.expectedRefusals = [{ forms: [{ code: 'N', runId: UUID(7) }, { code: 'M', runId: 'x' }] }];
    r.byCapability.points = [point(1, ['k'], { runs: [{ runId: UUID(1) }, { runId: UUID(8) }, { runId: null }] })];
    expect(R.runIdsOf(r)).toEqual([UUID(1), UUID(2), UUID(7), UUID(8)]);
    expect(R.runIdsOf({})).toEqual([]);
  });

  test('its summary: counts only, whole numbers', () => {
    const s = R.summaryOf(report({ points: [point(1, ['k'])] }));
    expect(s).toEqual({
      tested: 3, passed: 1, deviation: 0, points: 2, blocked: 0, notSupported: 0, notTested: 0, outOfScope: 0,
      expectedRefusals: { total: 1, refused: 1, notRefused: 0, blocked: 0 },
      pointsToLookAt: { total: 1, provider: 1, accepted: 0, questions: 0, oscar: 0 },
    });
    expect(R.summaryOf({ byCapability: { summary: { tested: 'x<script>' } } }).tested).toBe(0);
  });
});
