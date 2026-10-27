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
    const kindWith = (findings, suggestions) => P.pointsOf([seen(1)], { links: P.linkFailures(failures, { findings, suggestions }), findings }).points[0].kind;
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
    expect(link).toMatchObject({ finding: null, possible: { id: 'f' }, oscar: false });
    const { points } = P.pointsOf([seen(1)], { links, findings });
    expect(points[0]).toMatchObject({ kind: 'provider', finding: null, possibleFinding: { id: 'f', title: 'Another problem', category: 'provider_deviation', status: 'resolved' } });
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

  test('one check failing at several steps is one point; a status check keeps its step (maintainer, 2026-10-26)', () => {
    const at = (step, extra = {}) => ({ ...check, request_name: step, ...extra });
    const steps = ['10. POST Exchange Offers', '11. POST Exchange Operations', '12. GET Exchange Offer'];
    const same = steps.map((step, i) => seen(i + 1, { check: at(step) }));
    const status = (step) => at(step, { assertion_name: 'HTTP response status — expected 200, actual: 500', http_status: 500 });
    const { points } = P.pointsOf([...same, seen(4, { check: status('02. POST Create Booking') }), seen(5, { check: status('06. POST Obtaining Fulfillments from Booking') })]);
    expect(points.map((p) => [p.check, p.steps])).toEqual([
      ['HTTP response status — expected N, actual: N', ['02. POST Create Booking']],
      ['HTTP response status — expected N, actual: N', ['06. POST Obtaining Fulfillments from Booking']],
      ['Price is N', steps],
    ]);
    expect(points[2]).toMatchObject({ step: steps[0], occurrences: 3, keys: steps.map((s) => P.keyOfCheck(at(s))) });
  });

  test('a point takes the finding of any of its steps, and its checks are those an acceptance covers', () => {
    const later = { ...check, request_name: '11. GET Refund Offer' };
    const failures = [{ check, run: at(1), code: 'C1' }, { check: later, run: at(2), code: 'C2' }];
    const accepted = [{ id: 'f', title: 'Price', step: later.request_name, category: 'provider_deviation', status: 'resolved', observed: 'price is n' }];
    const out = P.pointsOf([seen(1), seen(2, { check: later })], { links: P.linkFailures(failures, { findings: accepted }), findings: accepted });
    expect(out.points).toEqual([expect.objectContaining({ kind: 'accepted', finding: expect.objectContaining({ id: 'f' }), steps: [check.request_name, later.request_name] })]);
    expect([...out.accepted]).toEqual([check, later]);
    expect(out.oscar.size).toBe(0);
    const oscar = P.pointsOf([seen(1)], { links: P.linkFailures([failures[0]], { suggestions: { oscarIssues: [P.keyOfCheck(check)] } }) });
    expect([...oscar.oscar]).toEqual([check]);
    expect(oscar.accepted.size).toBe(0);
    // A #735 draft of the second step marked as OSCAR's makes the whole point OSCAR's.
    const second = P.pointsOf([seen(1), seen(2, { check: later })], { links: P.linkFailures(failures, { suggestions: { oscarIssues: [P.keyOfCheck(later)] } }) });
    expect(second.points.map((p) => p.kind)).toEqual(['oscar']);
    expect([...second.oscar]).toEqual([check, later]);
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

describe('what a point\'s latest run saw (#990)', () => {
  const at = (n) => ({ id: `run-${n}`, completed_at: `2026-10-2${n} 08:00:00` });
  const failed = (text, extra = {}) => ({
    request_name: '01. POST Get Offer', assertion_name: 'Offer request: the offers keep to the flexibilities asked (FULL_FLEXIBLE)', http_status: 200, error_msg: text, ...extra,
  });
  const seen = (n, check, extra = {}) => ({ check, capability: 'offers.search', blocking: false, test: { key: 'T', entry: null }, code: `C${n}`, run: at(n), ...extra });

  test('a point keeps the failure text of its latest run, whatever the order its runs come in', () => {
    const { points } = P.pointsOf([
      seen(2, failed('2 of 2 offer(s) do not (offer a: NON_FLEXIBLE)')),
      seen(3, failed('3 of 3 offer(s) do not (offer b: SEMI_FLEXIBLE)')),
      seen(1, failed('1 of 1 offer(s) do not (offer c: NON_FLEXIBLE)')),
    ]);
    expect(points).toHaveLength(1);
    expect(points[0].check).toBe('Offer request: the offers keep to the flexibilities asked (FULL_FLEXIBLE)');
    expect(points[0].observed).toEqual({ text: '3 of 3 offer(s) do not (offer b: SEMI_FLEXIBLE)', at: '2026-10-23 08:00:00', code: 'C3' });
  });

  test('in one run the first text met stays; a run that kept no text does not erase another\'s', () => {
    const other = { request_name: '02. POST Create Booking' };
    const first = P.pointsOf([seen(2, failed('first')), seen(2, failed('second', other))]).points;
    expect(first[0].observed.text).toBe('first');
    const kept = P.pointsOf([seen(1, failed('older')), seen(2, failed(null)), seen(3, failed('  '))]).points;
    expect(kept[0].observed).toEqual({ text: 'older', at: '2026-10-21 08:00:00', code: 'C1' });
    expect(P.pointsOf([seen(1, failed(undefined))]).points[0].observed).toBeNull();
    const dev = { deviation: { step: '13. PATCH Refund Offer', status: 409, note: '' }, capability: 'refund.full', test: { key: 'T', entry: null }, code: 'C', run: at(1) };
    expect(P.pointsOf([dev]).points[0].observed).toBeNull();
  });

  test('the text is one line, cut at its maximum', () => {
    expect(P.observedText({ error_msg: '  a\n  b\tc  ' })).toBe('a b c');
    const long = P.observedText({ error_msg: `${'x'.repeat(P.MAX_OBSERVED)}\ny` });
    expect(long).toHaveLength(P.MAX_OBSERVED);
    expect(long.endsWith('…')).toBe(true);
    expect(P.observedText({ error_msg: 'x'.repeat(P.MAX_OBSERVED) })).toHaveLength(P.MAX_OBSERVED);
    expect([P.observedText(null), P.observedText({}), P.observedText({ error_msg: 42 })]).toEqual(['', '', '42']);
  });

  test('a check loses its leading pictograph, not its key', () => {
    const compass = String.fromCodePoint(0x1F9ED);
    const tagged = failed('refused (HTTP 400): X', { assertion_name: `${compass} Offer request option offerSearchCriteria.currency — declared in the Test Framework, taken by the provider` });
    const { points } = P.pointsOf([seen(1, tagged)]);
    expect(points[0].check).toBe('Offer request option offerSearchCriteria.currency — declared in the Test Framework, taken by the provider');
    expect(points[0].keys).toEqual([P.keyOfCheck(tagged)]);
    // The key is still that of the text the run stored, not of the text shown.
    expect(points[0].keys[0]).not.toBe(P.keyOfCheck({ ...tagged, assertion_name: points[0].check }));
    expect(P.plainCheck(`${String.fromCodePoint(0x26A0, 0xFE0F)}  Warn`)).toBe('Warn');
    expect(P.plainCheck('[OSCAR request] 12 ok')).toBe('[OSCAR request] 12 ok');
    expect(P.plainCheck(null)).toBe('');
  });
});
