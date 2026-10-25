// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * offerOptionReport.js — the offer request options report (#227, part 3) read
 * back from a run's log. Pure.
 *
 * The scenario sends its requests from step 01's script, so they are not in
 * Bruno's results; what reaches OSCAR is the report the collection logs
 * (`reportLines()` in `library-bruno/offerOptions.js`), one line per option.
 * `reportOf(lines)` reads those lines back into the report's shape, for the
 * Report Builder. `offer-option-report.test.js` runs the collection's own
 * `reportLines()` and reads its output, so the two cannot drift apart.
 */

const MARK = '🧭';
// The results an option can have, longest first so that "ignored-silent" is
// not read as "ignored".
const RESULTS = ['not-implemented', 'ignored-silent', 'no-offer-silent', 'invalid-silent', 'ignored-said', 'no-offer-said',
  'invalid-said', 'not-reached', 'not-tested', 'honoured', 'accepted', 'refused', 'error'];
const DECLARED = [[' [declared not supported]', false], [' [declared]', true]];
const MAX_LINES = 400;

// The text after the report's mark, or null for another line.
function afterMark(line) {
  if (typeof line !== 'string') return null;
  const at = line.indexOf(MARK);
  return at === -1 ? null : line.slice(at + MARK.length).trim();
}

// "<text> — <message>": [text, message].
function splitMessage(text) {
  const at = text.indexOf(' — ');
  return at === -1 ? [text, null] : [text.slice(0, at), text.slice(at + 3)];
}

// "HTTP <status>, <result>": { status, result }.
function statusAndResult(text) {
  const t = text.trim();
  const comma = t.indexOf(', ');
  if (!t.startsWith('HTTP ') || comma === -1) return { status: null, result: t };
  const status = Number.parseInt(t.slice(5, comma), 10);
  return { status: Number.isInteger(status) ? status : null, result: t.slice(comma + 2) };
}

// Where the result of an option line starts: the earliest " <result>" right
// after the colon (or "HTTP n,") that ends the line or comes before " — ".
function resultAt(rest) {
  let best = -1;
  for (const result of RESULTS) {
    let from = 0;
    for (;;) {
      const at = rest.indexOf(` ${result}`, from);
      if (at === -1) break;
      const end = at + result.length + 1;
      const before = rest[at - 1];
      const ends = end === rest.length || rest.startsWith(' — ', end);
      if (ends && (before === ':' || before === ',') && (best === -1 || at < best)) best = at;
      from = at + 1;
    }
  }
  return best;
}

/** One option line ("  <option>[mark] = <value> (<source>): HTTP n, <result> — <message>"), or null. */
function optionOf(text) {
  const option = /^[A-Za-z][\w.]*/.exec(text)?.[0];
  if (!option) return null;
  let rest = text.slice(option.length);
  const row = { option };
  for (const [mark, declared] of DECLARED) {
    if (rest.startsWith(mark)) { row.declared = declared; rest = rest.slice(mark.length); break; }
  }
  const at = resultAt(rest);
  if (at === -1) return null;
  let left = rest.slice(0, at);
  const right = rest.slice(at + 1);
  const http = left.lastIndexOf(': HTTP ');
  if (http !== -1 && left.endsWith(',')) {
    row.status = Number.parseInt(left.slice(http + 7, -1), 10) || null;
    left = left.slice(0, http);
  } else if (left.endsWith(':')) {
    left = left.slice(0, -1);
  } else {
    return null;
  }
  if (left.startsWith(' = ') && left.endsWith(')')) {
    const open = left.lastIndexOf(' (');
    if (open > 3) {
      row.value = left.slice(3, open);
      row.source = left.slice(open + 2, -1);
    }
  }
  const [result, message] = splitMessage(right);
  row.result = result;
  if (message) row.message = message;
  return row;
}

// "Offer request options (#227) — OSDM v, budget b request(s), u used, seed s."
function headerOf(text, report) {
  const number = (label) => {
    const at = text.indexOf(label);
    return at === -1 ? null : Number.parseInt(text.slice(at + label.length), 10);
  };
  const osdm = text.indexOf('— OSDM ');
  if (osdm !== -1) report.version = text.slice(osdm + 7, text.indexOf(',', osdm)).trim();
  report.budget = number('budget ');
  report.seed = number('seed ');
  const used = text.indexOf(' used');
  if (used !== -1) report.used = Number.parseInt(text.slice(text.lastIndexOf(', ', used) + 2, used), 10);
}

// "Phase 3, a + b: HTTP s, result — message" / "Phase 4, every supported option (n): …".
function phaseRequestOf(text) {
  const colon = text.indexOf(': ');
  if (colon === -1) return null;
  const [answer, message] = splitMessage(text.slice(colon + 2));
  return { label: text.slice(0, colon), ...statusAndResult(answer), ...(message ? { message } : {}) };
}

const PHASE_1 = 'Phase 1, mandatory members only: ';
const SILENT = 'Offer request options taken without a word: ';
const withMessage = (message) => (message ? { message } : {});

// The lines after the report's first one: [prefix, how it goes into the report].
const LINE_READERS = [
  [PHASE_1, (text, report) => {
    const [answer, message] = splitMessage(text.slice(PHASE_1.length));
    report.mandatory = { ok: answer === 'answered', message };
  }],
  ['Phase 3, ', (text, report) => {
    const combo = phaseRequestOf(text.slice('Phase 3, '.length));
    if (combo) report.combinations.push({ options: combo.label.split(' + '), status: combo.status, result: combo.result, ...withMessage(combo.message) });
  }],
  ['Phase 4, every supported option', (text, report) => {
    const all = phaseRequestOf(text.slice('Phase 4, '.length));
    if (all) report.all = { count: Number.parseInt(all.label.slice(all.label.indexOf('(') + 1), 10) || null, status: all.status, result: all.result, ...withMessage(all.message) };
  }],
  [SILENT, (text, report) => { report.silent = splitMessage(text.slice(SILENT.length))[0].split(', '); }],
  ['Phase ', () => {}],
  ['Taken by ', () => {}],
  ['', (text, report) => {
    const row = optionOf(text);
    if (row) report.options.push(row);
  }],
];

const newReport = (text) => {
  const report = { version: null, budget: null, used: null, seed: null, mandatory: null, options: [], combinations: [], all: null, silent: [] };
  headerOf(text, report);
  return report;
};

/**
 * The report a run's log holds, or null when it holds none. `lines` are the
 * log lines in order (text). Only the last report of the log is kept: a run
 * holds one discovery.
 */
function reportOf(lines) {
  let report = null;
  for (const line of (Array.isArray(lines) ? lines : []).slice(-MAX_LINES * 10)) {
    const text = afterMark(line);
    if (text === null) continue;
    if (text.startsWith('Offer request options (#227) — OSDM')) report = newReport(text);
    else if (report && report.options.length < MAX_LINES) LINE_READERS.find(([prefix]) => text.startsWith(prefix))[1](text, report);
  }
  return report;
}

/** How many options got each result, in the report's order. */
function countsOf(report) {
  const counts = {};
  for (const row of report?.options || []) counts[row.result] = (counts[row.result] || 0) + 1;
  return counts;
}

module.exports = { RESULTS, reportOf, optionOf, countsOf };
