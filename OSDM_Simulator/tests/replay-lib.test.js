// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #611: the pure part of the replay.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { providerOf, normalize, recordOf, compareRecordings, lineCoverage } = require('../scripts/replay-lib');

test('the provider of a scenario is the one of its version', () => {
  assert.equal(providerOf('SIM_SALE_SEARCH_1ADT_36'), 'alpha');
  assert.equal(providerOf('SIM_RETURN_COMBINED_1ADT_37'), 'beta');
  assert.equal(providerOf('SIM_EXCHANGE_1ADT_38'), 'gamma');
  assert.equal(providerOf('SIM_X_39'), null);
  assert.equal(providerOf('SIM_X'), null);
});

test('what changes from one run to the next is replaced; what a check says is kept', () => {
  assert.equal(normalize('booking GAMMA-BKG-0123456789abcdef by gamma.tst01 at 2026-10-11T07:44:05.123Z'), 'booking <id> by <client> at <instant>');
  assert.equal(normalize('code GAMMA3FA1C2, run 7f2b1f6e-1c2d-4e5f-9a8b-0123456789ab, waited 61 s, ~75s, 1500ms'), 'code <code>, run <uuid>, waited <duration>, ~<duration>, <duration>');
  assert.equal(normalize('[2026-10-11 09:14:43,670 Europe/Paris] control 1234567890'), '[<instant> Europe/Paris] control <number>');
  assert.equal(normalize('refundableAmount=318835 + refundFee=0, expected: FULFILLED'), 'refundableAmount=318835 + refundFee=0, expected: FULFILLED');
});

const report = (entries) => ({ iterationIndex: 0, results: entries, summary: {} });

test('a record: the checks in order, skipped requests left out, and the WARNING lines', () => {
  const r = recordOf(report([
    { name: 'Skipped', skipped: true, postResponseTestResults: [{ description: 'x', status: 'fail' }] },
    { name: '01. POST Get Offer', preRequestTestResults: [{ description: 'pre', status: 'pass' }],
      postResponseTestResults: [{ description: 'offer GAMMA-OFR-0123456789abcdef ok', status: 'pass' }, { description: 'price', status: 'fail' }],
      testResults: [] },
  ]), 'noise\n  [WARNING] booking GAMMA-BKG-0123456789abcdef reordered\n[INFO] ignored\n');
  assert.deepEqual(r, {
    checks: 3,
    failed: 1,
    list: [['01. POST Get Offer', 'pre', 'pass'], ['01. POST Get Offer', 'offer <id> ok', 'pass'], ['01. POST Get Offer', 'price', 'fail']],
    warnings: ['[WARNING] booking <id> reordered'],
  });
  assert.deepEqual(recordOf([report([])], ''), { checks: 0, failed: 0, list: [], warnings: [] });
});

test('two recordings: the same, then every kind of difference', () => {
  const one = { checks: 2, failed: 0, list: [['01', 'a', 'pass'], ['02', 'b', 'pass']], warnings: ['[WARNING] w'] };
  assert.deepEqual(compareRecordings({ A: one }, { A: structuredClone(one) }), []);
  const verdict = structuredClone(one);
  verdict.list[1][2] = 'fail';
  verdict.failed = 1;
  const differences = compareRecordings({ A: one, B: one }, { A: verdict, C: one });
  assert.equal(differences.length, 4);
  assert.match(differences[0], /^A: 2 checks, 0 failed → 2 checks, 1 failed$/);
  assert.match(differences[1], /^A: check 2 differs:/);
  assert.match(differences[2], /^B: only in the first recording$/);
  assert.match(differences[3], /^C: only in the second recording$/);
  const warned = { ...one, warnings: ['[WARNING] other'] };
  assert.deepEqual(compareRecordings({ A: one }, { A: warned }), ['A: warning gone: [WARNING] w', 'A: warning added: [WARNING] other']);
});

test('line coverage: the innermost range decides; blank and comment lines are not counted', () => {
  const text = 'function a() {\n  return 1;\n}\n// note\n\nfunction b() {\n  return 2;\n}\n';
  const b = text.indexOf('function b');
  const v8 = [{ url: 'file:///x/library-bruno/m.js', functions: [
    { ranges: [{ startOffset: 0, endOffset: text.length, count: 1 }] },
    { ranges: [{ startOffset: b, endOffset: text.length - 1, count: 0 }] },
  ] }, { url: 'file:///x/other/n.js', functions: [] }, { url: 'node:internal', functions: [] }];
  const { files, total } = lineCoverage(v8, '/library-bruno/', () => text);
  assert.deepEqual(files, { '/x/library-bruno/m.js': { lines: 6, covered: 3 } });
  assert.deepEqual(total, { lines: 6, covered: 3 });
});
