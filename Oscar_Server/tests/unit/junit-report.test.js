// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * junit-report.test.js — #1342 PR 5: the JUnit XML of a test request
 * (utils/junitReport.js): escaping, characters XML 1.0 refuses, and what each
 * verdict becomes.
 */

const { junitOf, xml } = require('../../src/utils/junitReport');

test('xml(): the five entities, and characters XML 1.0 refuses dropped', () => {
  expect(xml(`a<b>&"c'`)).toBe('a&lt;b&gt;&amp;&quot;c&apos;');
  expect(xml('tab\tline\nend\r')).toBe('tab\tline\nend\r');
  expect(xml(`x${String.fromCodePoint(0)}y${String.fromCodePoint(0x1b)}z${String.fromCodePoint(0xfffe)}`)).toBe('xyz');
  expect(xml(null)).toBe('');
});

test('each verdict becomes its element; a run not finished is skipped', () => {
  const runs = [
    { id: 'r1', scenario_code: 'A', verdict: 'passed', run_url: 'https://o/r1' },
    { id: 'r2', scenario_code: 'B', verdict: 'failed', failures: [{ step: '02', check: 'c', message: 'm' }], truncated: { failures: true } },
    { id: 'r3', scenario_code: 'C', verdict: 'not_a_result', reason: 'NO_CHECKS' },
    { id: 'r4', scenario_code: 'D', verdict: 'cancelled' },
    { id: 'r5', scenario_code: 'E', verdict: null, state: 'running' },
    { id: 'r6', scenario_code: 'F', verdict: 'passed_with_deviation', deviations: [{ step: '03', status: 501, note: '' }], warnings: [{ step: null, message: 'w' }], truncated: { warnings: true } },
  ];
  const out = junitOf({ id: 'T', reference: null, providers: [{ id: 'p', name: 'P', runs }] });
  expect(out).toContain('<testsuites name="OSCAR test request T" tests="6" failures="1" errors="1" skipped="2">');
  expect(out).toContain('<failure message="02: c — m" type="failed">02: c — m\n… more failed checks in OSCAR</failure>');
  expect(out).toContain('<error message="No test result: NO_CHECKS" type="not_a_result"/>');
  expect(out).toContain('<skipped message="cancelled"/>');
  expect(out).toContain('<skipped message="not finished (running)"/>');
  expect(out).toContain('<system-out>Known deviation: 03 returned HTTP 501\nw\n… more warnings in OSCAR</system-out>');
  expect(out).toContain('<property name="run_url" value="https://o/r1"/>');
});

test('#1351: one element a line, two spaces a level; the texts keep their own line breaks', () => {
  const out = junitOf({ id: 'T', reference: null, providers: [{ id: 'p', name: 'P', runs: [
    { id: 'r1', scenario_code: 'A', verdict: 'failed', run_url: 'https://o/r1', failures: [{ step: '05', check: 'c', message: 'm' }], warnings: [{ step: '05', message: 'w1' }] },
  ] }] });
  expect(out.split('\n')).toEqual([
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<testsuites name="OSCAR test request T" tests="1" failures="1" errors="0" skipped="0">',
    '  <testsuite name="P" id="p" tests="1" failures="1" errors="0" skipped="0">',
    '    <testcase classname="P" name="A" time="0">',
    '      <properties>',
    '        <property name="verdict" value="failed"/>',
    '        <property name="run_id" value="r1"/>',
    '        <property name="run_url" value="https://o/r1"/>',
    '      </properties>',
    '      <failure message="05: c — m" type="failed">05: c — m</failure>',
    '      <system-out>05: w1',
    'Run in OSCAR: https://o/r1</system-out>',
    '    </testcase>',
    '  </testsuite>',
    '</testsuites>',
    '',
  ]);
  // No provider: the suites element still closes on a line of its own.
  expect(junitOf({ id: 'E', providers: [] })).toMatch(/skipped="0">\n<\/testsuites>\n$/);
});
