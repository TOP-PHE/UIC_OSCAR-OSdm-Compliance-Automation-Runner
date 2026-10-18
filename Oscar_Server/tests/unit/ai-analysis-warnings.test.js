// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #823: the AI analysis sends the warnings the runs logged, apart from the
 * failures, and each scenario's OSDM version and what the Test Framework does
 * not declare of it.
 */

const AN = require('../../src/utils/aiAnalysis');

const warn = (step, message, scenarioCode = 'OTST_A', runId = 'r1') => ({ runId, scenarioCode, step, message });
const fail = (step, check, scenarioCode = 'OTST_A') => ({ runId: 'r1', scenarioCode, step, check, status: 200 });
const batch = (id, records, warnings) => ({ batchId: id, runs: 1, finishedRuns: 1, records, warnings });

describe('#823 warnings grouped like the failures', () => {
  test('the tag and its marks are left out, the run\'s values replaced', () => {
    expect(AN.warningText('[WARNING] ⚠️ ❌ booking.price is 318834 (expected 318835)')).toBe('booking.price is N (expected N)');
    expect(AN.warningText('prefix [WARNING] Name "Jane Doe" not returned')).toBe('Name "…" not returned');
    expect(AN.warningText(null)).toBe('');
  });

  test('one group per step and text, the most frequent first, scenarios listed once', () => {
    const groups = AN.warningGroupsOf([
      warn('07. GET Booking', '[WARNING] afterSaleConditions absent (12)', 'OTST_A', 'r1'),
      warn('07. GET Booking', '[WARNING] afterSaleConditions absent (14)', 'OTST_B', 'r2'),
      warn('07. GET Booking', '[WARNING] afterSaleConditions absent (15)', 'OTST_B', 'r2'),
      warn('01. POST Get Offer', '[WARNING] afterSaleConditions absent (12)'),
      warn(null, '[WARNING] returnModel COMBINED is not declared'),
    ]);
    expect(groups.map((g) => [g.step, g.warning, g.count])).toEqual([
      ['07. GET Booking', 'afterSaleConditions absent (N)', 3],
      ['01. POST Get Offer', 'afterSaleConditions absent (N)', 1],
      [null, 'returnModel COMBINED is not declared', 1],
    ]);
    expect(groups[0].scenarios).toEqual(['OTST_A', 'OTST_B']);
  });

  test('at most MAX_WARNING_GROUPS groups are kept, the most frequent', () => {
    const records = [];
    for (let i = 0; i <= AN.MAX_WARNING_GROUPS; i++) records.push(warn('01', `[WARNING] check ${String.fromCodePoint(65 + (i % 26))}${'x'.repeat(Math.floor(i / 26))}`));
    records.push(warn('01', '[WARNING] check A'));
    const groups = AN.warningGroupsOf(records);
    expect(groups).toHaveLength(AN.MAX_WARNING_GROUPS);
    expect(groups[0]).toMatchObject({ warning: 'check A', count: 2 });
  });
});

describe('#823 what is sent', () => {
  test('one batch: the warnings apart from the failures, without their key', () => {
    const { input, counts } = AN.buildInput({ batches: [batch('b1', [fail('02. POST Booking', 'status is 201')],
      [warn('07. GET Booking', '[WARNING] x absent')])] });
    expect(input.failures).toHaveLength(1);
    expect(input.warnings).toEqual([{ step: '07. GET Booking', warning: 'x absent', count: 1, scenarios: ['OTST_A'], moreScenarios: 0 }]);
    expect(input.batches[0]).toMatchObject({ failedChecks: 1, warnings: 1, warningsTruncated: false });
    expect(counts).toEqual({ groups: 1, warningGroups: 1 });
    expect(input.warningsSummarisedByStep).toBe(false);
  });

  test('two batches: warnings sorted into gone, still warned and new, as OSCAR counts them', () => {
    const { input, counts } = AN.buildInput({ batches: [
      batch('b1', [], [warn('07', '[WARNING] gone'), warn('07', '[WARNING] kept')]),
      batch('b2', [], [warn('07', '[WARNING] kept'), warn('07', '[WARNING] new one')]),
    ] });
    expect(input.warnings).toBeUndefined();
    const texts = (list) => list.map((g) => g.warning);
    expect(texts(input.warningComparison.gone)).toEqual(['gone']);
    expect(texts(input.warningComparison.stillWarned)).toEqual(['kept']);
    expect(texts(input.warningComparison.new)).toEqual(['new one']);
    expect(counts.warningGroups).toBe(2);
  });

  test('too large: the warnings are summarised by step first, the failures only if still too large', () => {
    const many = [];
    // 300 groups, each met by 20 scenarios with long codes: about 330,000 characters.
    for (let i = 0; i < AN.MAX_WARNING_GROUPS; i++) {
      const text = `[WARNING] member ${'m'.repeat(200)}${String.fromCodePoint(97 + (i % 26))}${'z'.repeat(Math.floor(i / 26))}`;
      for (let s = 0; s < 20; s++) many.push(warn(`step ${i % 3}`, text, `OTST_SCENARIO_WITH_A_RATHER_LONG_CODE_${s}`));
    }
    const first = AN.buildInput({ batches: [batch('b1', [fail('02', 'status is 201')], many)] });
    expect(first.warningsSummarisedByStep).toBe(true);
    expect(first.summarisedByStep).toBe(false);
    expect(first.input.warnings).toHaveLength(3);
    expect(first.input.warnings[0]).toMatchObject({ distinctWarnings: 100 });
    expect(first.input.warnings[0].examples).toHaveLength(3);
    expect(first.input.failures[0]).toHaveProperty('check', 'status is N');
  });

  test('each scenario named, by a failure or a warning, carries its OSDM version and what the framework does not declare', () => {
    const scenarios = [
      { code: 'OTST_A', description: 'a sale', osdmVersion: '3.8.0', __featureNotDeclaredWarnings: ['returnModel', 42] },
      { code: 'OTST_B', description: 'a refund' },
    ];
    const { input } = AN.buildInput({ batches: [batch('b1', [fail('02', 'x', 'OTST_A')], [warn('07', '[WARNING] y', 'OTST_B')])], scenarios });
    expect(input.scenarios).toEqual([
      { code: 'OTST_A', description: 'a sale', osdmVersion: '3.8.0', notDeclaredInTestFramework: ['returnModel'] },
      { code: 'OTST_B', description: 'a refund' },
    ]);
  });

  test('the instructions say a warning is not a failure, and that a scenario of another version is the configuration\'s first', () => {
    const one = AN.systemPrompt({});
    expect(one).toContain('warnings lists the warnings the runs logged');
    expect(one).toContain('never report a warning as a failure');
    expect(one).toContain('notDeclaredInTestFramework');
    expect(one).toContain('its failures are the configuration\'s first');
    expect(AN.systemPrompt({ compare: true })).toContain('warningComparison lists the warnings');
  });
});
