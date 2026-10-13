// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * copy-report.test.js — #681 part 3: the report of a copy from the catalogue,
 * one implementation for the page and the server (public/js/copy-report.js).
 */

const { copyReport, reportLines } = require('../../public/js/copy-report');

const scenarios = [
  { code: 'OTST_A', missing: [], toComplete: [] },
  { code: 'OTST_B', missing: [], toComplete: ['an overrule code'] },
  { code: 'OTST_C', missing: ['sales flow REFUND_FULL'], toComplete: [] },
  { code: 'OTST_D', missing: [], toComplete: [] },
  null,
];

describe('copyReport', () => {
  test('the ticked scenarios are ready or to complete; every refused one is listed, ticked or not', () => {
    expect(copyReport(scenarios, ['OTST_A', 'OTST_B'])).toEqual({
      ready: ['OTST_A'],
      toComplete: [{ code: 'OTST_B', reasons: ['an overrule code'] }],
      refused: [{ code: 'OTST_C', missing: ['sales flow REFUND_FULL'] }],
    });
  });

  test('nothing ticked, nothing given', () => {
    expect(copyReport(scenarios, []).ready).toEqual([]);
    expect(copyReport(undefined, undefined)).toEqual({ ready: [], toComplete: [], refused: [] });
  });
});

describe('reportLines', () => {
  const report = copyReport(scenarios, ['OTST_A', 'OTST_B', 'OTST_D']);

  test('a summary, then what each scenario to complete still needs', () => {
    expect(reportLines(report, false)).toEqual([
      '2 ready to run · 1 to complete first · 1 not allowed by the Test Framework',
      'OTST_B: an overrule code',
    ]);
  });

  test('with a run list of ALL, the scenarios to complete would run: said', () => {
    expect(reportLines(report, true).at(-1)).toMatch(/^Your run list is ALL: OTST_B will run, and fail, until completed/);
    expect(reportLines(copyReport(scenarios, ['OTST_A']), true)).toHaveLength(1);
  });
});
