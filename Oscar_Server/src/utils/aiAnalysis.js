// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * aiAnalysis.js — what the AI analysis of results sends, and how its answer
 * is read (#801, PR 3). Pure: no database, no clock, no network.
 *
 * What is sent, and only that: the failed checks of one batch, or of two
 * batches compared, grouped as the finding suggestions group them (#735:
 * step, check text with the run's values replaced, HTTP status, problem
 * code); the scenario codes and descriptions they concern; the Test
 * Framework's declarations; the company's findings (title, category, step,
 * scenario). Never a token, a credential, the endpoint, a response body or a
 * passenger's name or contact: a check's text and its error go through
 * checkText(), which replaces quoted values, ids, instants and numbers.
 *
 * The comparison is worked out here, by the groups' keys, not by the model:
 * fixed (in the first batch only), still failing (in both), new (in the
 * second only). The model explains; OSCAR counts.
 */

const crypto = require('node:crypto');
const S = require('./findingSuggestions');

const LANGUAGES = Object.freeze(['English', 'French', 'German', 'Italian', 'Spanish', 'Dutch', 'Czech', 'Polish', 'Portuguese', 'Swedish']);
const OWNERS = Object.freeze(['provider', 'oscar', 'unclear']);

// About 50,000 tokens of input. Above it, groups are summarised by step.
const MAX_INPUT_CHARS = 200_000;
const MAX_SCENARIOS_PER_GROUP = 20;
const MAX_TEXT = 300;
const MAX_ANSWER_TOKENS = 16_000;

const short = (text, max = MAX_TEXT) => {
  const t = String(text ?? '').replaceAll(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
};

/** A batch's failure records as compact groups, the most frequent first. */
function groupsOf(records) {
  return S.groupFailures(records)
    .map((g) => ({
      key: g.key,
      step: short(g.step, 120),
      check: short(g.check),
      error: g.sample?.error ? short(S.checkText(g.sample.error)) : null,
      status: g.status,
      problemCode: g.problemCode || g.warningCode || null,
      failures: g.count,
      scenarios: g.scenarios.slice(0, MAX_SCENARIOS_PER_GROUP),
      moreScenarios: Math.max(0, g.scenarios.length - MAX_SCENARIOS_PER_GROUP),
    }))
    .sort((a, b) => b.failures - a.failures);
}

/** Fixed, still failing and new, by group key: `earlier` and `later` are groupsOf() lists. */
function compareGroups(earlier, later) {
  const keysOf = (list) => new Set(list.map((g) => g.key));
  const before = keysOf(earlier);
  const after = keysOf(later);
  return {
    fixed: earlier.filter((g) => !after.has(g.key)),
    stillFailing: later.filter((g) => before.has(g.key)),
    new: later.filter((g) => !before.has(g.key)),
  };
}

/** Groups summarised by step and status, when the groups do not fit. */
function byStep(groups) {
  const steps = new Map();
  for (const g of groups) {
    const key = `${g.step}|${g.status}`;
    if (!steps.has(key)) steps.set(key, { step: g.step, status: g.status, failures: 0, distinctChecks: 0, problemCodes: [], scenarios: [] });
    const s = steps.get(key);
    s.failures += g.failures;
    s.distinctChecks += 1;
    if (g.problemCode && !s.problemCodes.includes(g.problemCode)) s.problemCodes.push(g.problemCode);
    for (const code of g.scenarios) if (s.scenarios.length < 10 && !s.scenarios.includes(code)) s.scenarios.push(code);
  }
  return [...steps.values()].sort((a, b) => b.failures - a.failures);
}

// The groups without their internal key; summarised by step when asked.
const shown = (groups, summarise) => (summarise ? byStep(groups) : groups.map(({ key: _key, ...g }) => g));

/** The Test Framework as sent: its declarations, without OSCAR's own `_` keys. */
function frameworkDeclarations(framework) {
  if (!framework || typeof framework !== 'object') return null;
  return Object.fromEntries(Object.entries(framework).filter(([k]) => !k.startsWith('_')));
}

/** A finding as sent: title, category, severity, status, step, scenario. */
function findingAsSent(f) {
  return { title: short(f.title, 200), category: f.category, severity: f.severity || null, status: f.status,
    step: f.step || null, scenario: f.scenarioCode || null };
}

/** The scenarios the groups name, with the data file's description. */
function scenariosNamed(groups, scenarios) {
  const named = new Set();
  for (const g of groups) for (const code of g.scenarios) named.add(code);
  const byCode = new Map((scenarios || []).filter((s) => s?.code).map((s) => [s.code, s]));
  return [...named].sort().map((code) => ({ code, description: byCode.has(code) ? short(byCode.get(code).description, 200) : null }));
}

function batchHeader(b) {
  return { batchId: b.batchId, runs: b.runs, finishedRuns: b.finishedRuns, failedChecks: b.records.length, truncated: !!b.truncated };
}

/**
 * Build what is sent. `batches` is one or two { batchId, runs, finishedRuns,
 * records, truncated } (two: the earlier first). Returns { input, text,
 * chars, estimatedTokens, summarisedByStep, counts }.
 */
function buildInput({ batches, framework, findings, scenarios }) {
  const compare = batches.length === 2;
  const groups = batches.map((b) => groupsOf(b.records));
  const all = groups.flat();

  const make = (summarise) => {
    const input = {
      mode: compare ? 'compare' : 'one',
      batches: batches.map(batchHeader),
      testFramework: frameworkDeclarations(framework),
      findings: (findings || []).map(findingAsSent),
      scenarios: scenariosNamed(all, scenarios),
      summarisedByStep: summarise,
    };
    if (compare) {
      const c = compareGroups(groups[0], groups[1]);
      input.comparison = { fixed: shown(c.fixed, summarise), stillFailing: shown(c.stillFailing, summarise), new: shown(c.new, summarise) };
    } else {
      input.failures = shown(groups[0], summarise);
    }
    return input;
  };

  let input = make(false);
  let text = JSON.stringify(input);
  if (text.length > MAX_INPUT_CHARS) {
    input = make(true);
    text = JSON.stringify(input);
  }
  const counts = compare
    ? { fixed: input.comparison.fixed.length, stillFailing: input.comparison.stillFailing.length, new: input.comparison.new.length }
    : { groups: input.failures.length };
  return { input, text, chars: text.length, estimatedTokens: estimateTokens(text), summarisedByStep: input.summarisedByStep, counts, tooLarge: text.length > MAX_INPUT_CHARS };
}

/** A rough token count: four characters a token, the usual rule for English and JSON. */
function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

const ANSWER_SHAPE = `{
  "summary": "a few sentences",
  "groups": [
    { "title": "short name of the problem", "cause": "the probable cause, in a few sentences",
      "owner": "provider | oscar | unclear", "why": "what in the input points to that owner",
      "steps": ["step names"], "scenarios": ["scenario codes"] }
  ],
  "comparison": { "fixed": ["…"], "stillFailing": ["…"], "new": ["…"] }
}`;

/** The instructions: what OSCAR is, what to answer, and in what shape. */
function systemPrompt({ language = 'English', instruction = null, compare = false } = {}) {
  const lang = LANGUAGES.includes(language) ? language : 'English';
  const lines = [
    'You read the results of OSCAR, a conformance test runner for OSDM (the UIC Open Sales and Distribution Model, a rail ticketing API).',
    'OSCAR runs scenarios (a sale, a refund, an exchange…) against a provider\'s OSDM API and checks each answer. The input lists the checks that failed, grouped by step, check text, HTTP status and OSDM problem code. Values a run met are replaced: N for a number, <id>, <instant>, "…" for a quoted value.',
    'A failure can be the provider\'s (its answer does not follow OSDM, or a function is missing), OSCAR\'s (its request or its check is wrong), or unclear. The Test Framework says what the provider declares it supports; the findings are what people already recorded.',
    compare
      ? 'Two batches are compared. OSCAR has already sorted the groups into fixed (failing in the first batch only), stillFailing (in both) and new (in the second only): explain them, do not recount them.'
      : 'One batch is read: group the failures by probable cause.',
    'Say "unclear" rather than guess. Name a finding when a group matches it. Do not invent checks, steps or scenarios that are not in the input.',
    `Answer in ${lang}, as one JSON object and nothing else, of this shape${compare ? '' : ' (leave "comparison" out)'}:`,
    ANSWER_SHAPE,
  ];
  if (instruction) lines.push('The company adds this instruction:', short(instruction, 2000));
  return lines.join('\n');
}

/** The text after the first `{` and up to the last `}`: models sometimes wrap JSON in prose or a code fence. */
function jsonPart(text) {
  const t = String(text || '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

const strings = (v, max = 50) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, max).map((x) => short(x, 200)) : []);

/**
 * The model's answer as stored and shown: { ok: true, result } or
 * { ok: false, reason }. Every text is cut to size; nothing else is kept.
 */
function readResult(text, { compare = false } = {}) {
  const json = jsonPart(text);
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, reason: 'The answer is not a JSON object.' };
  if (typeof json.summary !== 'string' || !json.summary.trim()) return { ok: false, reason: 'The answer has no summary.' };
  const groups = (Array.isArray(json.groups) ? json.groups : []).filter((g) => g && typeof g === 'object').slice(0, 100).map((g) => ({
    title: short(g.title, 200) || 'Untitled',
    cause: short(g.cause, 2000),
    owner: OWNERS.includes(g.owner) ? g.owner : 'unclear',
    why: short(g.why, 1000),
    steps: strings(g.steps),
    scenarios: strings(g.scenarios),
  }));
  const result = { summary: short(json.summary, 4000), groups };
  if (compare && json.comparison && typeof json.comparison === 'object') {
    result.comparison = { fixed: strings(json.comparison.fixed, 100), stillFailing: strings(json.comparison.stillFailing, 100), new: strings(json.comparison.new, 100) };
  }
  return { ok: true, result };
}

/** sha256 of exactly what is sent: the instructions and the input. */
function inputHash(system, text) {
  return crypto.createHash('sha256').update(system, 'utf8').update('\n\n', 'utf8').update(text, 'utf8').digest('hex');
}

module.exports = {
  LANGUAGES, OWNERS, MAX_INPUT_CHARS, MAX_ANSWER_TOKENS,
  groupsOf, compareGroups, byStep, buildInput, estimateTokens, systemPrompt, readResult, inputHash, frameworkDeclarations,
};
