// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * test-requests.test.js — #1342 PR 3: the pure rules of a test request
 * (utils/testRequests.js): the body, the Idempotency-Key, each run's verdict
 * and the whole request's, the long poll's wait.
 */

const TR = require('../../src/utils/testRequests');

const P = '3f2a91c0-1d2e-4c5b-8a9f-0123456789ab';
const Q = '4f2a91c0-1d2e-4c5b-8a9f-0123456789ab';

describe('requestOf()', () => {
  test('scenarios by code: distinct, the providers distinct', () => {
    expect(TR.requestOf({ providers: [P, P, Q], scenarios: ['A', 'A', 'B'], reference: 'ci 42' }))
      .toEqual({ providers: [P, Q], scenarios: ['A', 'B'], reference: 'ci 42' });
  });

  test('a selection is cut from every scenario seen, whatever base it names', () => {
    const r = TR.requestOf({ providers: [P], selection: { base: 'list', categories: ['happy'] } });
    expect(r.selection.base).toBe('all');
    expect(r.selection.categories).toEqual(['happy']);
  });

  test.each([
    ['no body', undefined],
    ['no provider', { scenarios: ['A'] }],
    ['a provider that is not an id', { providers: ['x'], scenarios: ['A'] }],
    ['21 providers', { providers: Array.from({ length: 21 }, (_, i) => P.slice(0, -2) + String(i).padStart(2, '0')), scenarios: ['A'] }],
    ['neither scenarios nor selection', { providers: [P] }],
    ['both', { providers: [P], scenarios: ['A'], selection: {} }],
    ['an empty list of scenarios', { providers: [P], scenarios: [] }],
    ['a code that is not text', { providers: [P], scenarios: [{}] }],
    ['501 scenarios', { providers: [P], scenarios: Array.from({ length: 501 }, (_, i) => `C${i}`) }],
    ['a bad selection', { providers: [P], selection: { categories: ['nonsense'] } }],
    ['a reference with a line break', { providers: [P], scenarios: ['A'], reference: 'a\nb' }],
    ['a reference too long', { providers: [P], scenarios: ['A'], reference: 'x'.repeat(101) }],
  ])('refused: %s', (_, body) => {
    expect(TR.requestOf(body).error).toEqual(expect.any(String));
  });
});

describe('the same request, asked again', () => {
  test('hashOf() ignores order, and tells another request apart', () => {
    const a = TR.requestOf({ providers: [P, Q], scenarios: ['A', 'B'] });
    const b = TR.requestOf({ providers: [Q, P], scenarios: ['B', 'A'] });
    const c = TR.requestOf({ providers: [P, Q], scenarios: ['A', 'B'], reference: 'other' });
    expect(TR.hashOf(a)).toBe(TR.hashOf(b));
    expect(TR.hashOf(a)).not.toBe(TR.hashOf(c));
  });

  test('idempotencyKeyOf(): absent, accepted, refused', () => {
    expect(TR.idempotencyKeyOf(undefined)).toEqual({ key: null });
    expect(TR.idempotencyKeyOf('ci-build-1001')).toEqual({ key: 'ci-build-1001' });
    for (const bad of ['short', 'x'.repeat(101), 'has space here', 'quote"inside', ['ci-build-1001']]) {
      expect(TR.idempotencyKeyOf(bad).error).toEqual(expect.any(String));
    }
  });
});

describe('verdicts', () => {
  const run = (status, error_message = null) => ({ status, error_message });

  test('each run', () => {
    expect(TR.verdictOf(run('QUEUED'), 0, 0)).toEqual({ state: 'queued', verdict: null, reason: null });
    expect(TR.verdictOf(run('RUNNING'), 0, 3)).toEqual({ state: 'running', verdict: null, reason: null });
    expect(TR.verdictOf(run('CANCELLED'), 0, 0).verdict).toBe('cancelled');
    expect(TR.verdictOf(run('COMPLETED'), 0, 5)).toEqual({ state: 'finished', verdict: 'passed', reason: null });
    expect(TR.verdictOf(run('FAILED'), 2, 5).verdict).toBe('failed');
    // A run that ended without a result is never the provider's failure (#1287).
    expect(TR.verdictOf(run('FAILED', 'RUN_NOT_FINISHED'), 0, 5)).toEqual({ state: 'finished', verdict: 'not_a_result', reason: 'RUN_NOT_FINISHED' });
    expect(TR.verdictOf(run('FAILED', 'NO_CHECKS'), 0, 0).reason).toBe('NO_CHECKS');
    expect(TR.verdictOf(run('FAILED', 'TOKEN_AUTH_ERROR'), 0, 0)).toMatchObject({ verdict: 'not_a_result', reason: 'TOKEN_AUTH_ERROR' });
    expect(TR.verdictOf(run('COMPLETED'), 0, 0)).toMatchObject({ verdict: 'not_a_result', reason: 'NO_CHECKS' });
  });

  test('the whole request: running until every run is finished; then failed, incomplete or passed', () => {
    const v = (state, verdict = null) => ({ state, verdict });
    expect(TR.summaryOf([v('finished', 'passed'), v('running')])).toMatchObject({ state: 'running', verdict: null });
    expect(TR.summaryOf([v('finished', 'passed'), v('queued')])).toMatchObject({ state: 'queued', verdict: null });
    expect(TR.summaryOf([v('finished', 'passed'), v('finished', 'failed'), v('finished', 'not_a_result')]))
      .toEqual({ state: 'finished', verdict: 'failed', counts: { queued: 0, running: 0, passed: 1, failed: 1, not_a_result: 1, cancelled: 0 } });
    expect(TR.summaryOf([v('finished', 'passed'), v('finished', 'cancelled')]).verdict).toBe('incomplete');
    expect(TR.summaryOf([v('finished', 'passed')]).verdict).toBe('passed');
    expect(TR.summaryOf([]).verdict).toBe('incomplete');
  });
});

test('waitOf(): 0 to 60 seconds', () => {
  expect(TR.waitOf(undefined)).toBe(0);
  expect(TR.waitOf('')).toBe(0);
  expect(TR.waitOf('30')).toBe(30);
  expect(TR.waitOf('60')).toBe(60);
  for (const bad of ['61', '-1', '1.5', 'abc', '1000', ['5']]) expect(TR.waitOf(bad)).toBeNull();
});
