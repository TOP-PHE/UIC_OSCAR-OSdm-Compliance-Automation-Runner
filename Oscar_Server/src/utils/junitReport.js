// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * junitReport.js — a test request's results as JUnit XML (#1342 PR 5), the
 * report CI tools read without work on their side (Jenkins, GitLab, Azure
 * DevOps, GitHub Actions).
 *
 *   <testsuites>                    the test request
 *     <testsuite name=provider>     one per provider
 *       <testcase name=scenario>    one per run
 *         <failure>                 its failed checks (verdict failed)
 *         <error>                   it gave no result (not_a_result)
 *         <skipped>                 cancelled, or not finished yet
 *         <system-out>              its warnings and known deviations
 *         <properties>              verdict, run id, run_url
 *
 * JUnit has no warning element: warnings go in <system-out>, which the tools
 * show with the test case. Every text is escaped, and characters XML 1.0
 * does not allow are dropped. Pure: the answer is built from the test
 * request's results as the API answers them.
 */

// Characters XML 1.0 allows: tab, line feed, carriage return, and from the space on,
// but not the surrogates or U+FFFE / U+FFFF.
function allowed(code) {
  if (code === 0x9 || code === 0xa || code === 0xd) return true;
  if (code < 0x20) return false;
  if (code >= 0xd800 && code <= 0xdfff) return false;
  return code !== 0xfffe && code !== 0xffff;
}

/** Text as XML character data or an attribute value. */
function xml(value) {
  let out = '';
  for (const ch of String(value ?? '')) {
    const code = ch.codePointAt(0);
    if (!allowed(code)) continue;
    if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '"') out += '&quot;';
    else if (ch === "'") out += '&apos;';
    else out += ch;
  }
  return out;
}

const seconds = (run) => {
  const start = Date.parse(String(run.started_at || '').replace(' ', 'T') + 'Z');
  const end = Date.parse(String(run.completed_at || '').replace(' ', 'T') + 'Z');
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? ((end - start) / 1000).toFixed(3) : '0';
};

// " — text" after a label, or nothing.
const dashed = text => (text ? ' — ' + text : '');

function failureText(f) {
  const where = f.step ? f.step + ': ' : '';
  let status = '';
  if (f.http_status) {
    const code = f.problem_code ? ' ' + f.problem_code : '';
    status = ` [HTTP ${f.http_status}${code}]`;
  }
  const seen = f.expected || f.actual ? ` (expected: ${f.expected ?? '—'}; actual: ${f.actual ?? '—'})` : '';
  return `${where}${f.check || 'check'}${status}${dashed(f.message)}${seen}`;
}

// What a run's verdict becomes: <failure>, <error>, <skipped>, or nothing.
function outcomeXml(run) {
  if (run.verdict === 'failed') {
    const failures = run.failures || [];
    const first = failures[0];
    const more = run.truncated?.failures ? xml('\n… more failed checks in OSCAR') : '';
    return `<failure message="${xml(first ? failureText(first) : 'failed checks')}" type="failed">${xml(failures.map(failureText).join('\n'))}${more}</failure>`;
  }
  if (run.verdict === 'not_a_result') {
    const message = 'No test result: ' + (run.reason || 'unknown');
    return `<error message="${xml(message)}" type="not_a_result"/>`;
  }
  if (run.verdict === 'cancelled') return '<skipped message="cancelled"/>';
  if (!run.verdict) {
    const message = 'not finished (' + run.state + ')';
    return `<skipped message="${xml(message)}"/>`;
  }
  return '';
}

// The lines of a run's <system-out>: its known deviations, its warnings, its page.
function outLines(run) {
  const out = [
    ...(run.deviations || []).map(d => `Known deviation: ${d.step} returned HTTP ${d.status}${dashed(d.note)}`),
    ...(run.warnings || []).map(w => (w.step ? `${w.step}: ${w.message}` : w.message)),
  ];
  if (run.truncated?.warnings) out.push('… more warnings in OSCAR');
  if (run.run_url) out.push(`Run in OSCAR: ${run.run_url}`);
  return out;
}

// The indentation of an element at this depth: one element a line, two spaces a
// level, so a person can read the file (#1351). Only the space between
// elements: the text of <failure> and <system-out> is kept as it is.
const pad = depth => '  '.repeat(depth);

// A run's <testcase>, as its lines.
function caseLines(run, suiteName) {
  const props = [['verdict', run.verdict || run.state], ['run_id', run.id], ['run_url', run.run_url]]
    .filter(([, v]) => v)
    .map(([k, v]) => `${pad(4)}<property name="${xml(k)}" value="${xml(v)}"/>`);
  const outcome = outcomeXml(run);
  const out = outLines(run);
  return [
    `${pad(2)}<testcase classname="${xml(suiteName)}" name="${xml(run.scenario_code)}" time="${seconds(run)}">`,
    `${pad(3)}<properties>`, ...props, `${pad(3)}</properties>`,
    ...(outcome ? [pad(3) + outcome] : []),
    ...(out.length ? [`${pad(3)}<system-out>${xml(out.join('\n'))}</system-out>`] : []),
    `${pad(2)}</testcase>`,
  ];
}

const isError = r => r.verdict === 'not_a_result';
const isSkipped = r => !r.verdict || r.verdict === 'cancelled';

/** The JUnit XML of a test request's results (the API's results answer). */
function junitOf(results) {
  const providers = results.providers || [];
  const all = providers.flatMap(p => p.runs || []);
  const suites = providers.flatMap((p) => {
    const runs = p.runs || [];
    const name = p.name || p.id;
    return [
      `${pad(1)}<testsuite name="${xml(name)}" id="${xml(p.id)}" tests="${runs.length}" failures="${runs.filter(r => r.verdict === 'failed').length}"`
        + ` errors="${runs.filter(isError).length}" skipped="${runs.filter(isSkipped).length}">`,
      ...runs.flatMap(r => caseLines(r, name)),
      `${pad(1)}</testsuite>`,
    ];
  });
  const reference = results.reference ? ' (' + results.reference + ')' : '';
  const title = `OSCAR test request ${results.id}${reference}`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${xml(title)}" tests="${all.length}" failures="${all.filter(r => r.verdict === 'failed').length}"`
      + ` errors="${all.filter(isError).length}" skipped="${all.filter(isSkipped).length}">`,
    ...suites,
    '</testsuites>',
  ].join('\n') + '\n';
}

module.exports = { junitOf, xml };
