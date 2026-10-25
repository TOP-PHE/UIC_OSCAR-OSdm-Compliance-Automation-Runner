// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * coverageWorkbook.js — the Test Framework coverage as an Excel workbook
 * (#956, part 3). Pure. Four sheets: Summary, By flow and element, By
 * scenario, By function. `report` is the answer of GET /v1/company/coverage.
 */

const { workbook } = require('./xlsxWorkbook');
const { RESULT_TEXT } = require('./coverageMatrix');

const DECLARATION_TEXT = { declared: 'Declared', 'not-declared': 'Not declared', 'every-value': 'Every value declared', 'declared-not-supported': 'Declared not supported' };
const arr = (v) => (Array.isArray(v) ? v : []);
const resultText = (r) => RESULT_TEXT[r] || String(r || '');
const yesNo = (v) => {
  if (v === true) return 'Yes';
  if (v === false) return 'No';
  return '';
};
// "CODE: Failed at <step> (<check>)", one line per scenario not passed.
function failedLine(f) {
  let line = f.code + ': ' + resultText(f.result);
  if (f.step) line += ' at ' + f.step;
  if (f.check) line += ' (' + f.check + ')';
  return line;
}
const failedText = (list) => arr(list).map(failedLine).join('\n');
const findingsText = (list) => arr(list).map((f) => `${f.title} (${f.category}, ${f.status})`).join('\n');

function summarySheet(report, { title, generatedAt }) {
  const s = report.summary || {};
  const rows = [
    ['Company or provider', title], ['Generated', generatedAt], ['Runs read', `the last ${report.days} day(s)`],
    ['Collection version now', report.collectionVersion || ''], ['Test Framework stored', yesNo(report.framework)],
    ['Data file stored', yesNo(report.datafile)], ['Functions declared', s.declared], ['With a scenario', s.covered],
    ['Passed', s.passed], ['Passed with defects', s.withDefects ?? 0], ['Failed', s.failed], ['Never run', s.neverRun], ['Without a scenario', s.notCovered],
    ['To run again', s.toRunAgain], ['Latest run', s.latestRunAt || ''],
  ];
  return { name: 'Summary', columns: [{ title: 'Item', width: 26 }, { title: 'Value', width: 60 }], rows };
}

function matrixSheet(report) {
  return {
    name: 'By flow and element',
    columns: [
      { title: 'Flow', width: 18 }, { title: 'Element group', width: 22 }, { title: 'Element tested', width: 42 },
      { title: 'Result', width: 26 }, { title: 'Test Framework', width: 20 }, { title: 'Scenarios', width: 10 },
      { title: 'Passed', width: 9 }, { title: 'Passed with defects', width: 12 }, { title: 'Failed', width: 9 }, { title: 'Never run', width: 10 },
      { title: 'To run again', width: 12 }, { title: 'Provider says not supported (scenarios)', width: 18 },
      { title: 'Open findings', width: 40 }, { title: 'Scenarios not passed', width: 70 }, { title: 'Scenario codes', width: 60 },
    ],
    rows: arr(report.matrix).map((r) => [
      r.flowLabel, r.group, r.label, resultText(r.result), DECLARATION_TEXT[r.declaration] || r.declaration || '',
      r.counts?.scenarios ?? 0, r.counts?.passed ?? 0, r.counts?.withDefects ?? 0, r.counts?.failed ?? 0, r.counts?.neverRun ?? 0,
      yesNo(r.toRunAgain), r.providerNotSupported ?? 0, findingsText(r.findings), failedText(r.failedScenarios), arr(r.scenarios).join('\n'),
    ]),
  };
}

function scenarioSheet(report) {
  return {
    name: 'By scenario',
    columns: [
      { title: 'Scenario', width: 40 }, { title: 'Description', width: 60 }, { title: 'Flow', width: 18 },
      { title: 'Elements tested', width: 50 }, { title: 'Result', width: 12 }, { title: 'Checks passed', width: 12 },
      { title: 'Checks failed', width: 12 }, { title: 'First failed step', width: 30 }, { title: 'First failed check', width: 60 },
      { title: 'Latest run', width: 20 }, { title: 'Run id', width: 38 }, { title: 'To run again', width: 12 },
      { title: 'Not declared (warnings)', width: 30 }, { title: 'Provider says not supported', width: 60 },
    ],
    rows: arr(report.scenarios).map((s) => [
      s.code, s.description, s.flowLabel, arr(s.elements).join('\n'), resultText(s.result),
      s.run ? s.run.passed : null, s.run ? s.run.failed : null, s.run?.failedStep || '', s.run?.failedCheck || '',
      s.run?.at || '', s.run?.id || '', yesNo(s.toRunAgain),
      arr(s.notDeclared).join('\n'), arr(s.providerNotSupported).join('\n'),
    ]),
  };
}

function functionSheet(report) {
  return {
    name: 'By function',
    columns: [
      { title: 'Group', width: 22 }, { title: 'Function declared', width: 42 }, { title: 'State', width: 14 },
      { title: 'To run again', width: 12 }, { title: 'Scenarios', width: 60 }, { title: 'Open findings', width: 40 },
    ],
    rows: arr(report.functions).map((f) => [
      f.group, f.label, resultText(f.state), yesNo(f.toRunAgain),
      arr(f.scenarios).map((s) => `${s.code}: ${resultText(s.result)}`).join('\n'), findingsText(f.findings),
    ]),
  };
}

/** The workbook of a coverage report, as a Buffer. */
function coverageWorkbook(report, { title = '', generatedAt = '' } = {}) {
  return workbook([summarySheet(report, { title, generatedAt }), matrixSheet(report), scenarioSheet(report), functionSheet(report)]);
}

module.exports = { coverageWorkbook, DECLARATION_TEXT };
