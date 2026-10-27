// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * coverageWorkbook.js — the Test Framework coverage as an Excel workbook
 * (#956, part 3). Pure. Seven sheets: Summary, then the coverage by
 * capability (#972 part 3: Capabilities, Expected refusals, Points to look
 * at, and Offer request parameters when a run of the options scenario holds
 * a report, #995), then the detail: By flow and element, By scenario, By
 * function.
 * `report` is the answer of GET /v1/company/coverage.
 */

const { workbook } = require('./xlsxWorkbook');
const { RESULT_TEXT } = require('./coverageMatrix');
const { RESULT_TEXT: CAPABILITY_TEXT } = require('./capabilityCoverage');

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
const capabilityText = (r) => CAPABILITY_TEXT[r] || String(r || '');
const KIND_TEXT = Object.freeze({
  provider: 'For the provider', accepted: 'Accepted deviation', unsupported: 'Not supported by the provider (not counted against it)',
  question: 'Question on the specification', oscar: "OSCAR's own (not counted against the provider)",
});
// The provider's position on a point (#994): who took it, as the report shows
// it (a published report names the role only), and when.
function positionBy(position) {
  if (!position) return '';
  return [position.by, position.role ? `(${position.role})` : ''].filter(Boolean).join(' ');
}
const numbersText = (list) => arr(list).filter((n) => Number.isInteger(n)).map((n) => `#${n}`).join(', ');
const formsRun = (tests) => arr(tests).reduce((n, t) => n + arr(t.forms).filter((x) => x.result !== 'not-run').length, 0);
// "CODE (FORM): Result at <step> — <check>", one line per form.
function formLine(x) {
  let line = x.code + (x.form ? ` (${x.form})` : '') + ': ' + capabilityText(x.result);
  if (x.step) line += ' at ' + x.step + (x.check ? ' — ' + x.check : '');
  else if (x.check) line += ' — ' + x.check;
  // #1008: the point of the check that blocked it.
  if (Number.isInteger(x.point) && x.point > 0) line += ` (point #${x.point})`;
  return line;
}
const testsText = (tests) => arr(tests).map((x) => `${x.entry || x.key}: ${capabilityText(x.result)}\n${arr(x.forms).map((y) => '  ' + formLine(y)).join('\n')}`).join('\n');
const findingOf = (p) => p.finding || p.possibleFinding || null;

function capabilitySummaryRows(report) {
  const s = report.byCapability?.summary || {};
  const r = s.expectedRefusals || {};
  const p = s.pointsToLookAt || {};
  return [
    ['Capabilities tested', s.tested ?? 0], ['  Passed', s.passed ?? 0], ['  Passed with deviation', s.deviation ?? 0],
    ['  Passed with points', s.points ?? 0], ['  Blocked', s.blocked ?? 0], ['  Not supported by the provider', s.notSupported ?? 0],
    ['Capabilities declared and not tested', s.notTested ?? 0], ['Capabilities out of scope', s.outOfScope ?? 0],
    ['Expected refusals', r.total ?? 0], ['  Refused as expected', r.refused ?? 0], ['  Not refused, accepted deviation', r.deviation ?? 0],
    ['  Not refused', r.notRefused ?? 0], ['  Not run', r.notRun ?? 0],
    ['Points to look at', (p.total ?? 0) + (p.truncated ? ' (the first 500 only)' : '')], ['  For the provider', p.provider ?? 0],
    ['  Accepted deviations', p.accepted ?? 0], ['  Not supported by the provider', p.unsupported ?? 0],
    ['  Questions on the specification', p.questions ?? 0], ["  OSCAR's own", p.oscar ?? 0],
    ['Scenarios set apart (neither in the run list nor run)', s.apart ?? 0],
  ];
}

function summarySheet(report, { title, generatedAt }) {
  const s = report.summary || {};
  const rows = [
    ['Company or provider', title], ['Generated', generatedAt], ['Runs read', `the last ${report.days} day(s)`],
    ['Collection version now', report.collectionVersion || ''], ['Test Framework stored', yesNo(report.framework)],
    ['Data file stored', yesNo(report.datafile)], ...capabilitySummaryRows(report),
    ['Functions declared', s.declared], ['With a scenario', s.covered],
    ['Passed', s.passed], ['Passed with defects', s.withDefects ?? 0], ['Failed', s.failed], ['Never run', s.neverRun], ['Without a scenario', s.notCovered],
    ['To run again', s.toRunAgain], ['Latest run', s.latestRunAt || ''],
  ];
  return { name: 'Summary', columns: [{ title: 'Item', width: 44 }, { title: 'Value', width: 60 }], rows };
}

function capabilitiesSheet(report) {
  return {
    name: 'Capabilities',
    columns: [
      { title: 'Group', width: 18 }, { title: 'Capability', width: 44 }, { title: 'Optional', width: 10 }, { title: 'Test Framework', width: 20 },
      { title: 'Result', width: 26 }, { title: 'Tests', width: 8 }, { title: 'Forms run', width: 10 }, { title: 'Proven on the way (runs)', width: 14 },
      { title: 'Points', width: 16 }, { title: 'Tests and forms', width: 80 }, { title: 'Problems on the way', width: 40 },
    ],
    rows: arr(report.byCapability?.capabilities).map((c) => [
      c.group, c.label, yesNo(Boolean(c.optional)), DECLARATION_TEXT[c.declaration] || c.declaration || '', capabilityText(c.result),
      arr(c.tests).length, formsRun(c.tests), c.provenBy?.count ?? 0, numbersText(c.points), testsText(c.tests),
      arr(c.sideProblems).map((x) => `${x.code}: ${capabilityText(x.result)}`).join('\n'),
    ]),
  };
}

function refusalsSheet(report) {
  return {
    name: 'Expected refusals',
    columns: [
      { title: 'Expected refusal', width: 40 }, { title: 'Purpose', width: 60 }, { title: 'Capability probed', width: 36 },
      { title: 'Result', width: 22 }, { title: 'Forms', width: 70 }, { title: 'Points', width: 12 },
    ],
    rows: arr(report.byCapability?.expectedRefusals).map((r) => [
      r.entry || r.key, r.purpose || '', r.capabilityLabel, capabilityText(r.result), arr(r.forms).map(formLine).join('\n'), numbersText(r.points),
    ]),
  };
}

function pointsSheet(report) {
  return {
    name: 'Points to look at',
    columns: [
      { title: 'Point', width: 8 }, { title: 'Kind', width: 26 }, { title: 'Capability', width: 36 }, { title: 'Expected refusal', width: 10 },
      { title: 'Steps', width: 40 }, { title: 'Expected (the check)', width: 70 }, { title: 'Seen (latest run)', width: 70 },
      { title: 'HTTP status', width: 10 }, { title: 'Problem code', width: 24 },
      { title: 'Blocking', width: 10 }, { title: 'Times seen', width: 10 }, { title: 'Tests', width: 40 }, { title: 'Scenario codes', width: 50 },
      { title: 'First seen', width: 20 }, { title: 'Last seen', width: 20 }, { title: 'Finding', width: 40 }, { title: 'Finding category', width: 18 },
      { title: 'Finding status', width: 14 }, { title: 'Finding is only possible', width: 12 }, { title: 'Provider position', width: 36 },
      { title: 'Position taken by', width: 30 }, { title: 'Position date', width: 20 }, { title: 'Position comment', width: 60 },
      { title: 'Note', width: 40 }, { title: 'Run ids', width: 38 },
    ],
    rows: arr(report.byCapability?.points).map((p) => {
      const finding = findingOf(p);
      const position = p.finding?.position || null;
      return [
        p.number, KIND_TEXT[p.kind] || p.kind || '', p.capabilityLabel, yesNo(Boolean(p.expectedRefusal)),
        arr(p.steps).length ? arr(p.steps).join('\n') : (p.step || ''), p.check, p.observed?.text || '', p.status ?? null, p.problemCode || '',
        yesNo(Boolean(p.blocking)), p.occurrences ?? 0, arr(p.tests).map((x) => x.entry || x.key).join('\n'),
        arr(p.tests).flatMap((x) => arr(x.codes)).join('\n'), p.firstSeen || '', p.lastSeen || '',
        finding ? finding.title : '', finding ? finding.category : '', finding ? finding.status : '',
        finding ? yesNo(!p.finding) : '', position ? position.label : '', positionBy(position), position?.at || '', position?.comment || '',
        p.note || '', arr(p.runs).map((r) => r.runId).join('\n'),
      ];
    }),
  };
}

// #995: the offer request options' results, one row per request, when a run
// of the options scenario holds a report.
const COMBINATION_WORDS = Object.freeze({ answered: 'Answered', 'no-offer': 'No offer', refused: 'Refused (a point)', 'not-sent': 'Not sent' });
const OPTION_DECLARED = (d) => {
  if (d === true) return 'Declared';
  if (d === false) return 'Declared not supported';
  return 'Not declared';
};
function valueSent(p) {
  if (p.value === undefined || p.value === null) return '';
  return p.source ? `${p.value} (${p.source})` : String(p.value);
}

function mandatoryRow(e) {
  if (!e.mandatory) return ['Mandatory parameters only', '', '', null, 'Not in the report', '', ''];
  return ['Mandatory parameters only', '', '', null, e.mandatory.ok ? 'Answered' : 'NOT answered', '', e.mandatory.message || ''];
}

function optionRowsOf(e) {
  const rows = [['Summary', '', '', null, e.text || '', '', ''], mandatoryRow(e)];
  for (const p of arr(e.parameters)) rows.push(['One parameter', p.option, valueSent(p), p.status ?? null, p.resultText || p.result || '', OPTION_DECLARED(p.declared), p.message || '']);
  for (const c of arr(e.combinations)) rows.push(['Combination', arr(c.options).join(' + '), '', c.status ?? null, COMBINATION_WORDS[c.state] || c.state || '', '', c.message || '']);
  if (e.all) {
    rows.push(['Every supported parameter at once', e.all.count == null ? '' : String(e.all.count), '', e.all.status ?? null,
      COMBINATION_WORDS[e.all.state] || e.all.state || '', '', e.all.message || '']);
  }
  return rows.map((r) => [e.code, e.runId || '', e.at || '', ...r]);
}

function optionsSheet(report) {
  const entries = arr(report.byCapability?.offerOptions);
  if (entries.length === 0) return null;
  return {
    name: 'Offer request parameters',
    columns: [
      { title: 'Scenario', width: 36 }, { title: 'Run id', width: 38 }, { title: 'Date', width: 20 }, { title: 'Request', width: 30 },
      { title: 'Parameter(s)', width: 50 }, { title: 'Value sent', width: 30 }, { title: 'HTTP', width: 8 }, { title: 'Result', width: 34 },
      { title: 'Test Framework', width: 22 }, { title: 'Detail', width: 70 },
    ],
    rows: entries.flatMap(optionRowsOf),
  };
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

const CHANGE_TEXT = Object.freeze({ still: 'Still open', new: 'New', fixed: 'Fixed', notRetested: 'Not run again' });

// #972 part 4: what changed since the previous report shared with the certifier.
function comparisonSheet(comparison) {
  const points = comparison.points || {};
  const pointRows = Object.keys(CHANGE_TEXT).flatMap((change) => arr(points[change]).map((p) => [
    CHANGE_TEXT[change], p.number ?? null, p.previousNumber ?? null, p.capabilityLabel || p.capability || '',
    arr(p.steps).join('\n'), p.check || '', '', '',
  ]));
  const capabilityRows = arr(comparison.capabilities).map((c) => [
    'Capability result', null, null, c.label || c.id, '', '', capabilityText(c.before), capabilityText(c.now),
  ]);
  return {
    name: `Since report ${comparison.previous?.number ?? ''}`.trim(),
    columns: [
      { title: 'What changed', width: 18 }, { title: 'Point now', width: 10 }, { title: 'Point before', width: 12 },
      { title: 'Capability', width: 36 }, { title: 'Steps', width: 40 }, { title: 'Check', width: 70 },
      { title: 'Result before', width: 24 }, { title: 'Result now', width: 24 },
    ],
    rows: [...pointRows, ...capabilityRows],
  };
}

/**
 * The workbook of a coverage report, as a Buffer. A published report (#972
 * part 4) passes its comparison with the previous shared report, which comes
 * second.
 */
function coverageWorkbook(report, { title = '', generatedAt = '', comparison = null } = {}) {
  return workbook([
    summarySheet(report, { title, generatedAt }), ...(comparison ? [comparisonSheet(comparison)] : []),
    capabilitiesSheet(report), refusalsSheet(report), pointsSheet(report), ...[optionsSheet(report)].filter(Boolean),
    matrixSheet(report), scenarioSheet(report), functionSheet(report),
  ]);
}

module.exports = { coverageWorkbook, DECLARATION_TEXT, KIND_TEXT, CHANGE_TEXT, COMBINATION_WORDS };
