// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * findingSuggestions.js — failures of a batch, grouped into candidate
 * findings (#735). Pure: no database, no clock.
 *
 * A failed check is a record { runId, at, scenarioCode, step, check, error,
 * status, problemCode, problemTitle, problemDetail }. Records are grouped by
 * step + check text (values a run met left out) + HTTP status + the problem
 * code of an error answer; each group is a candidate, matched against the
 * company's findings, with a category proposed by fixed rules. Nothing here
 * decides: a Test Manager accepts, edits, rejects or marks each draft.
 *
 * Rules, not a model, on purpose. Texts are built from what the run report
 * already shows (step, check, status, problem code and title); no request
 * body, no header.
 */

const crypto = require('node:crypto');

// ── Normalisation ──────────────────────────────────────────────────────────────

// What changes from one run to the next in a check's text: identifiers,
// instants, quoted values, numbers. The order matters: an identifier holds
// digits that the last rule would otherwise cut.
const always = (text) => () => text;
const VALUE = [
  { pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, to: always('<id>') },
  { pattern: /\b\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?/g, to: always('<instant>') },
  { pattern: /\b\d{4}-\d{2}-\d{2}\b/g, to: always('<instant>') },
  // A long token mixing letters and digits (a provider's id, a scenario code).
  { pattern: /\b[A-Za-z0-9_-]{12,}\b/g, to: (t) => (/\d/.test(t) && /[A-Za-z]/.test(t) ? '<id>' : t) },
  { pattern: /"[^"\n]{0,80}"/g, to: always('"…"') },
  { pattern: /'[^'\n]{0,80}'/g, to: always("'…'") },
  { pattern: /\b\d+(?:[.,]\d+)?\b/g, to: always('N') },
];

/** A check's text with the values one run met replaced. */
function checkText(name) {
  let out = String(name == null ? '' : name).trim();
  for (const { pattern, to } of VALUE) out = out.replace(pattern, to);
  return out;
}

/** A step label as the known-deviation engine reads it (loopback.js). */
function stepKey(step) {
  return String(step == null ? '' : step).trim().toLowerCase()
    .replace(/^.*\//, '')
    .replace(/^\d+[a-z]?\.\s*/, '')
    .trim();
}

/** The last segment of an OSDM problem type: urn:uic:problem:X → X. */
function problemCodeOf(code) {
  if (code == null || code === '') return null;
  const s = String(code).trim();
  return s.slice(s.lastIndexOf(':') + 1) || s;
}

/**
 * The problem an answer carries: an RFC 9457 body (code / type), else the
 * first of `problems[]`. Returns { code, title, detail } or null.
 */
function problemOf(body) {
  let b = body;
  if (typeof b === 'string') {
    try { b = JSON.parse(b); } catch { return null; }
  }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  const first = Array.isArray(b.problems) && b.problems.length && b.problems[0] && typeof b.problems[0] === 'object'
    ? b.problems[0] : null;
  const source = (b.code || b.type) ? b : first;
  if (!source) return null;
  const text = (v) => (typeof v === 'string' ? v.slice(0, 300) : null);
  return { code: problemCodeOf(source.code || source.type), title: text(source.title), detail: text(source.detail) };
}

// ── Grouping ──────────────────────────────────────────────────────────────────

const isError = (status) => Number(status) >= 400;

/** The key of a failure: what makes two failures the same problem. */
function groupKeyOf(record) {
  const parts = [
    stepKey(record.step),
    checkText(record.check),
    record.status == null ? '' : String(record.status),
    isError(record.status) ? (problemCodeOf(record.problemCode) || '') : '',
  ];
  return crypto.createHash('sha256').update(parts.join('␟')).digest('hex').slice(0, 32);
}

/**
 * Failures grouped by key, in the order first met. A group keeps its step
 * and check as first seen, the scenarios and runs that showed it, and the
 * first record as its sample.
 */
function newGroup(key, r) {
  const error = isError(r.status);
  return {
    key,
    step: String(r.step || ''),
    check: checkText(r.check),
    status: r.status == null ? null : Number(r.status),
    problemCode: error ? problemCodeOf(r.problemCode) : null,
    problemTitle: error ? (r.problemTitle || null) : null,
    warningCode: error ? null : problemCodeOf(r.problemCode),
    scenarios: [],
    runs: [],
    count: 0,
    sample: r,
  };
}

function addToGroup(g, r) {
  g.count++;
  if (r.scenarioCode && !g.scenarios.includes(r.scenarioCode)) g.scenarios.push(r.scenarioCode);
  if (r.runId && !g.runs.some((x) => x.runId === r.runId)) {
    g.runs.push({ runId: r.runId, at: r.at || null, scenarioCode: r.scenarioCode || null });
  }
}

function groupFailures(records) {
  const groups = new Map();
  for (const r of records || []) {
    if (!r?.check) continue;
    const key = groupKeyOf(r);
    if (!groups.has(key)) groups.set(key, newGroup(key, r));
    addToGroup(groups.get(key), r);
  }
  return [...groups.values()];
}

// ── Category ──────────────────────────────────────────────────────────────────

const NOT_SUPPORTED_CODES = /(?:^|_)(?:OPERATION_NOT_PERMITTED|NOT_IMPLEMENTED|OPERATION_NOT_SUPPORTED|ENDPOINT_NOT_SUPPORTED|FEATURE_NOT_SUPPORTED)$/;
const SPEC_QUESTION_CODES = /(?:PARAMETER_NOT_SUPPORTED|VALUE_NOT_SUPPORTED|NOT_MODIFIABLE|LIMIT|TOO_MANY|MAXIMUM)/;
const EXPECTS_REFUSAL = /\brejects?\b|\brefus|\bclient error\b|\(4xx\)|expected (?:a )?4\d\d\b/i;

/**
 * The category a group's draft starts with, and why: a proposal, the Test
 * Manager decides.
 */
function proposeCategory(group) {
  const status = group.status;
  const code = group.problemCode || '';
  const ok2xx = status >= 200 && status < 300;
  if (String(group.check).startsWith('[OSCAR request]')) {
    return { category: 'oscar_issue', reason: 'OSCAR\'s own request did not conform to OSDM (#736).' };
  }
  if (status === 501 || NOT_SUPPORTED_CODES.test(code)) {
    return { category: 'not_supported', reason: status === 501 ? 'The provider answered 501 Not Implemented.' : `The provider's problem ${code} says the operation is not supported.` };
  }
  if (isError(status) && SPEC_QUESTION_CODES.test(code)) {
    return { category: 'spec_question', reason: `The provider's problem ${code} names a parameter, a value or a limit it does not accept.` };
  }
  const negative = /^NHF_/i.test(String(group.sample?.scenarioCode || ''));
  if (ok2xx && (EXPECTS_REFUSAL.test(String(group.check)) || negative)) {
    return { category: 'provider_deviation', reason: 'A refusal was expected and the provider answered with success.' };
  }
  return { category: 'open', reason: 'No rule applies; to be read.' };
}

// ── Matching ──────────────────────────────────────────────────────────────────

function textOfFinding(f) {
  return [f.title, f.observed, f.evidence, f.interpretation].filter(Boolean).join('\n').toLowerCase();
}

/**
 * The finding a group is already recorded as, or null. `strength` is
 * 'same' when the match is sure enough to show "still seen" instead of a
 * draft, 'maybe' when it only shares the step and a scenario: the draft is
 * still made, naming the finding, because one step of one scenario can fail
 * in several ways and a wrong "still seen" would hide a new problem.
 *
 * `acceptedByKey` maps a group key to the finding a past draft became: the
 * surest match. Otherwise the step must match, then the error status, the
 * problem code or the check text must be in the finding. A 2xx status says
 * nothing: many different checks fail on a 200.
 */
function matchFinding(group, findings, acceptedByKey) {
  const known = acceptedByKey?.[group.key];
  if (known) {
    const f = (findings || []).find((x) => x.id === known);
    if (f) return { finding: f, why: 'accepted from the same failure before', strength: 'same' };
  }
  const step = stepKey(group.step);
  const sameStep = (findings || []).filter((f) => f.step && stepKey(f.step) === step);
  for (const f of sameStep) {
    const text = textOfFinding(f);
    if (isError(group.status) && Number(f.expectedStatus ?? f.expected_status) === group.status) {
      return { finding: f, why: 'same step and HTTP status', strength: 'same' };
    }
    if (group.problemCode && text.includes(group.problemCode.toLowerCase())) {
      return { finding: f, why: 'same step and problem code', strength: 'same' };
    }
    if (text.includes(group.check.toLowerCase())) return { finding: f, why: 'same step and check', strength: 'same' };
  }
  const maybe = sameStep.find((f) => group.scenarios.includes(f.scenarioCode ?? f.scenario_code));
  return maybe ? { finding: maybe, why: 'same step and scenario', strength: 'maybe' } : null;
}

/**
 * Findings still open that a batch could have shown and did not: their
 * scenario ran, and no group matched them.
 */
function notSeen(findings, matchedIds, scenariosRun) {
  const ran = new Set(scenariosRun || []);
  const matched = new Set(matchedIds || []);
  return (findings || []).filter((f) => {
    const code = f.scenarioCode ?? f.scenario_code;
    return f.status !== 'resolved' && code && ran.has(code) && !matched.has(f.id);
  });
}

// ── Draft text ────────────────────────────────────────────────────────────────

const clip = (s, n) => {
  const t = String(s == null ? '' : s).replaceAll(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// A check that only says the HTTP status was not the expected one.
const STATUS_CHECK = /^(?:HTTP response status\b|Status code is\b)|→ N \(FAIL\)$/i;

function titleOf(group) {
  const answer = group.problemCode ? `${group.status} ${group.problemCode}` : String(group.status ?? '');
  if (STATUS_CHECK.test(group.check)) {
    return clip(`${group.step} answers ${answer}`, 160);
  }
  return clip(`${group.step}: ${group.check}`, 160);
}

// "Run <id> (<scenario>), <when>."
function runLine(r) {
  const scenario = r.scenarioCode ? ' (' + r.scenarioCode + ')' : '';
  const when = r.at ? ', ' + r.at : '';
  return 'Run ' + r.runId + scenario + when + '.';
}

/**
 * A draft finding from a group: the fields of POST /findings, filled from the
 * run's report. `expectedStatus` is the error status the provider answered,
 * so that accepting it can baseline that exact answer; none for a 2xx.
 */
function draftOf(group, { batchLabel } = {}) {
  const { category, reason } = proposeCategory(group);
  const s = group.sample || {};
  const answer = [
    group.status == null ? 'no HTTP status' : `HTTP ${group.status}`,
    group.problemCode,
    group.problemTitle ? `"${clip(group.problemTitle, 200)}"` : null,
  ].filter(Boolean).join(' ');
  const observed = [
    `"${group.step}" answered ${answer}; the check "${clip(s.check || group.check, 300)}" failed`
      + (group.scenarios.length ? ` in ${group.scenarios.length} scenario(s): ${group.scenarios.join(', ')}.` : '.'),
    s.error ? `First failure: ${clip(s.error, 400)}` : null,
    group.warningCode ? `The answer also carried the problem ${group.warningCode}.` : null,
  ].filter(Boolean).join('\n');
  const evidence = [
    batchLabel ? `Batch ${batchLabel}.` : null,
    ...group.runs.slice(0, 10).map(runLine),
    group.runs.length > 10 ? `And ${group.runs.length - 10} more run(s).` : null,
    s.problemDetail ? `Problem detail: ${clip(s.problemDetail, 300)}` : null,
  ].filter(Boolean).join('\n');
  return {
    title: titleOf(group),
    step: group.step || null,
    scenarioCode: group.scenarios.length === 1 ? group.scenarios[0] : null,
    expectedStatus: isError(group.status) ? group.status : null,
    observed,
    interpretation: '',
    evidence,
    category,
    reason,
  };
}

// ── From a Bruno report ───────────────────────────────────────────────────────

/**
 * The failed checks of one run's Bruno JSON report (the run artifact, or a
 * saved `bru run` report), as records. Token requests are left out.
 */
function failuresFromBruReport(report, { runId = null, at = null, scenarioCode = null } = {}) {
  const top = Array.isArray(report) ? report[0] : report;
  const results = (top && Array.isArray(top.results)) ? top.results : [];
  const out = [];
  for (const e of results) {
    if (!e || e.skipped) continue;
    const file = String(e.test?.filename || e.name || '');
    const step = file.replace(/\.(?:yml|bru)$/i, '').split('/').pop();
    if (/token/i.test(step)) continue;
    const status = e.response?.status ?? null;
    const problem = problemOf(e.response?.data);
    const tests = [...(e.preRequestTestResults || []), ...(e.testResults || []), ...(e.postResponseTestResults || [])];
    for (const t of tests) {
      if (t.status === 'pass') continue;
      out.push({
        runId, at, scenarioCode, step,
        check: t.description || t.name || '',
        error: t.error || null,
        status,
        problemCode: problem?.code || null,
        problemTitle: problem?.title || null,
        problemDetail: problem?.detail || null,
      });
    }
  }
  return out;
}

module.exports = {
  checkText,
  stepKey,
  problemCodeOf,
  problemOf,
  groupKeyOf,
  groupFailures,
  proposeCategory,
  matchFinding,
  notSeen,
  draftOf,
  failuresFromBruReport,
};
