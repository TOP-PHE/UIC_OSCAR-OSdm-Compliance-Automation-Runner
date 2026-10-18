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
 * code); the [WARNING] lines of the runs' logs, grouped by step and text
 * the same way and sent apart from the failures (#823); the scenario codes
 * they concern with their description, OSDM version and what the Test
 * Framework does not declare; the Test Framework's declarations; the
 * company's findings (title, category, step, scenario). Never a token, a credential, the endpoint, a response body or a
 * passenger's name or contact: a check's text and its error go through
 * checkText(), which replaces quoted values, ids, instants and numbers.
 *
 * The comparison is worked out here, by the groups' keys, not by the model:
 * fixed (in the first batch only), still failing (in both), new (in the
 * second only). The model explains; OSCAR counts.
 */

const crypto = require('node:crypto');
const S = require('./findingSuggestions');
const OR = require('./osdmReferences');

const LANGUAGES = Object.freeze(['English', 'French', 'German', 'Italian', 'Spanish', 'Dutch', 'Czech', 'Polish', 'Portuguese', 'Swedish']);
const OWNERS = Object.freeze(['provider', 'oscar', 'configuration', 'unclear']);

// About 50,000 tokens of input. Above it, groups are summarised by step.
const MAX_INPUT_CHARS = 200_000;
const MAX_SCENARIOS_PER_GROUP = 20;
const MAX_TEXT = 300;
const MAX_ANSWER_TOKENS = 16_000;
const MAX_SAMPLES = 15;
const MAX_WARNING_GROUPS = 300;

const short = (text, max = MAX_TEXT) => {
  const t = String(text ?? '').replaceAll(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
};

/**
 * A batch's failure records as compact groups, the most frequent first. With
 * an OSDM version (#827), each group names the OSDM operation of its sample
 * request, from its method and URL; the URL itself is never kept.
 */
function groupsOf(records, osdmVersion = null) {
  return S.groupFailures(records)
    .map((g) => ({
      key: g.key,
      step: short(g.step, 120),
      ...(osdmVersion ? { operation: OR.operationOf(g.sample?.method, g.sample?.url, osdmVersion) } : {}),
      requestId: g.sample?.requestId ?? null,
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

// The level tags the collection writes ([DEBUG], [INFO], [WARNING]…).
const LEVEL_TAG = /\[(DEBUG|INFO|WARN|WARNING|ERROR)\]/;

/**
 * Whether a run log line is a warning: its first level tag is [WARNING].
 * Another line may name the tag in its text ("[DEBUG] … that test will skip
 * with a [WARNING] too."): it is not one.
 */
function isWarningLine(line) {
  return LEVEL_TAG.exec(String(line ?? ''))?.[1] === 'WARNING';
}

/**
 * The text of a [WARNING] log line as grouped (#823): the tag and the marks
 * the collection puts before it left out, the run's values replaced.
 */
function warningText(line) {
  const all = String(line ?? '');
  const at = all.indexOf('[WARNING]');
  const t = (at < 0 ? all : all.slice(at + '[WARNING]'.length)).replace(/^[\s\u2190-\u2BFF\uFE0F\u{1F300}-\u{1FAFF}]+/u, '');
  return S.checkText(t);
}

/**
 * A batch's warning lines ({ runId, scenarioCode, step, message }) as compact
 * groups, the most frequent first, at most MAX_WARNING_GROUPS. A warning is
 * not a failure: the collection logs it for what OSDM allows but is worth
 * knowing (an optional member left out, a value outside an extensible list,
 * a feature the Test Framework does not declare…).
 */
function warningGroupsOf(records) {
  const shaped = (records || []).map((r) => ({ runId: r.runId, scenarioCode: r.scenarioCode, step: r.step || '', check: warningText(r.message), status: null }));
  return S.groupFailures(shaped)
    .map((g) => ({
      key: g.key,
      step: g.step ? short(g.step, 120) : null,
      warning: short(g.check),
      count: g.count,
      scenarios: g.scenarios.slice(0, MAX_SCENARIOS_PER_GROUP),
      moreScenarios: Math.max(0, g.scenarios.length - MAX_SCENARIOS_PER_GROUP),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_WARNING_GROUPS);
}

/** Warning groups summarised by step, when they do not fit. */
function warningsByStep(groups) {
  const steps = new Map();
  for (const g of groups) {
    const key = g.step || '';
    if (!steps.has(key)) steps.set(key, { step: g.step, warnings: 0, distinctWarnings: 0, examples: [], scenarios: [] });
    const s = steps.get(key);
    s.warnings += g.count;
    s.distinctWarnings += 1;
    if (s.examples.length < 3) s.examples.push(short(g.warning, 160));
    for (const code of g.scenarios) if (s.scenarios.length < 10 && !s.scenarios.includes(code)) s.scenarios.push(code);
  }
  return [...steps.values()].sort((a, b) => b.warnings - a.warnings);
}

const shownWarnings = (groups, summarise) => (summarise ? warningsByStep(groups) : groups.map(({ key: _key, ...g }) => g));

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
    if (!steps.has(key)) steps.set(key, { step: g.step, operation: g.operation ?? null, status: g.status, failures: 0, distinctChecks: 0, problemCodes: [], scenarios: [] });
    const s = steps.get(key);
    s.failures += g.failures;
    s.distinctChecks += 1;
    if (g.problemCode && !s.problemCodes.includes(g.problemCode)) s.problemCodes.push(g.problemCode);
    for (const code of g.scenarios) if (s.scenarios.length < 10 && !s.scenarios.includes(code)) s.scenarios.push(code);
  }
  return [...steps.values()].sort((a, b) => b.failures - a.failures);
}

// The groups without their internal key and request id, each with its masked
// sample when it has one (#827 PR C); summarised by step when asked.
const shown = (groups, summarise, samples = new Map()) => (summarise ? byStep(groups)
  : groups.map(({ key, requestId: _requestId, ...g }) => (samples.has(key) ? { ...g, sample: samples.get(key) } : g)));

/**
 * The masked request and answer of one failing request per group (#827 PR C),
 * for the MAX_SAMPLES most failing groups, by group key. `sampleOf(requestId)`
 * gives { request, response } already masked (utils/aiMask.js), or null.
 */
function samplesFor(groups, sampleOf) {
  const samples = new Map();
  if (typeof sampleOf !== 'function') return samples;
  for (const g of [...groups].sort((a, b) => b.failures - a.failures)) {
    if (samples.size >= MAX_SAMPLES) break;
    if (samples.has(g.key) || g.requestId == null) continue;
    const sample = sampleOf(g.requestId);
    if (sample) samples.set(g.key, sample);
  }
  return samples;
}

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

/**
 * The reference scenario a code was copied from (#827): the catalogue entry
 * of the same code, else the longest one it extends with "_…" (a copy per
 * request form or currency: OTST_SALE_ONE_WAY_1ADT_SPEC, …_CURRENCY_EUR).
 */
function catalogueEntryOf(code, entries) {
  let best = null;
  for (const e of entries || []) {
    if (typeof e?.code !== 'string') continue;
    if (e.code === code) return e;
    if (code.startsWith(e.code + '_') && (!best || e.code.length > best.code.length)) best = e;
  }
  return best;
}

/**
 * The scenarios the groups name, with the data file's description, the OSDM
 * version the scenario names, what the Test Framework does not declare of it
 * (#823: the golden rule's warnings, `__featureNotDeclaredWarnings` of the
 * annotated data file) and the catalogue's purpose.
 */
function scenariosNamed(groups, scenarios, catalogue) {
  const named = new Set();
  for (const g of groups) for (const code of g.scenarios) named.add(code);
  const byCode = new Map((scenarios || []).filter((s) => s?.code).map((s) => [s.code, s]));
  return [...named].sort((a, b) => a.localeCompare(b)).map((code) => {
    const entry = catalogueEntryOf(code, catalogue);
    const scenario = byCode.get(code);
    const out = { code, description: scenario ? short(scenario.description, 200) : null };
    if (typeof scenario?.osdmVersion === 'string' && scenario.osdmVersion.trim()) out.osdmVersion = short(scenario.osdmVersion, 20);
    const notDeclared = Array.isArray(scenario?.__featureNotDeclaredWarnings)
      ? scenario.__featureNotDeclaredWarnings.filter((w) => typeof w === 'string').slice(0, 20).map((w) => short(w, 80)) : [];
    if (notDeclared.length) out.notDeclaredInTestFramework = notDeclared;
    if (entry?.purpose) out.purpose = short(entry.purpose, 400);
    return out;
  });
}

/** What the input says of the provider: its declared OSDM version and its checklist answers. */
function providerContext({ osdmVersion, checklist }) {
  const out = { declaredOsdmVersion: typeof osdmVersion === 'string' && osdmVersion.trim() ? osdmVersion.trim() : null };
  if (checklist && typeof checklist === 'object') {
    out.checklist = checklist.answers || {};
    if (checklist.cut) out.checklistAnswersLeftOut = checklist.cut;
  } else {
    out.checklist = null;
  }
  return out;
}

function batchHeader(b) {
  return { batchId: b.batchId, runs: b.runs, finishedRuns: b.finishedRuns, failedChecks: b.records.length, truncated: !!b.truncated,
    warnings: (b.warnings || []).length, warningsTruncated: !!b.warningsTruncated };
}

/**
 * Build what is sent. `batches` is one or two { batchId, runs, finishedRuns,
 * records, truncated, warnings, warningsTruncated } (two: the earlier first;
 * `warnings` are warningGroupsOf() records). Returns { input, text, chars,
 * estimatedTokens, summarisedByStep, warningsSummarisedByStep, counts }.
 *
 * When the input is too large, the warnings are summarised by step first,
 * then the failures too.
 */
function buildInput({ batches, framework, findings, scenarios, catalogue, checklist, sampleOf }) {
  const compare = batches.length === 2;
  const reference = OR.versionFor(framework?.osdmVersion);
  const groups = batches.map((b) => groupsOf(b.records, reference?.version));
  const warnings = batches.map((b) => warningGroupsOf(b.warnings));
  const all = groups.flat();
  // The operations the failures concern, the most failing first (#827 PR B).
  const failuresByOperation = new Map();
  for (const g of all) if (g.operation) failuresByOperation.set(g.operation, (failuresByOperation.get(g.operation) || 0) + g.failures);
  const operations = [...failuresByOperation.entries()].sort((a, b) => b[1] - a[1]).map(([op]) => op);
  const samples = samplesFor(all, sampleOf);

  const make = (summarise, summariseWarnings) => {
    const input = {
      mode: compare ? 'compare' : 'one',
      batches: batches.map(batchHeader),
      provider: providerContext({ osdmVersion: framework?.osdmVersion, checklist }),
      testFramework: frameworkDeclarations(framework),
      findings: (findings || []).map(findingAsSent),
      scenarios: scenariosNamed([...all, ...warnings.flat()], scenarios, catalogue),
      osdmReference: OR.referencesFor(operations, framework?.osdmVersion),
      summarisedByStep: summarise,
      warningsSummarisedByStep: summariseWarnings,
    };
    if (compare) {
      const c = compareGroups(groups[0], groups[1]);
      input.comparison = { fixed: shown(c.fixed, summarise, samples), stillFailing: shown(c.stillFailing, summarise, samples), new: shown(c.new, summarise, samples) };
      const w = compareGroups(warnings[0], warnings[1]);
      input.warningComparison = { gone: shownWarnings(w.fixed, summariseWarnings), stillWarned: shownWarnings(w.stillFailing, summariseWarnings), new: shownWarnings(w.new, summariseWarnings) };
    } else {
      input.failures = shown(groups[0], summarise, samples);
      input.warnings = shownWarnings(warnings[0], summariseWarnings);
    }
    return input;
  };

  let input = make(false, false);
  let text = JSON.stringify(input);
  for (const [summarise, summariseWarnings] of [[false, true], [true, true]]) {
    if (text.length <= MAX_INPUT_CHARS) break;
    input = make(summarise, summariseWarnings);
    text = JSON.stringify(input);
  }
  const counts = compare
    ? { fixed: input.comparison.fixed.length, stillFailing: input.comparison.stillFailing.length, new: input.comparison.new.length,
      warningGroups: warnings[1].length }
    : { groups: input.failures.length, warningGroups: warnings[0].length };
  return { input, text, chars: text.length, estimatedTokens: estimateTokens(text), summarisedByStep: input.summarisedByStep,
    warningsSummarisedByStep: input.warningsSummarisedByStep, counts, tooLarge: text.length > MAX_INPUT_CHARS };
}

/** A rough token count: four characters a token, the usual rule for English and JSON. */
function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

const ANSWER_SHAPE = `{
  "summary": "a few sentences",
  "groups": [
    { "title": "short name of the problem", "cause": "the probable cause, in a few sentences",
      "owner": "provider | oscar | configuration | unclear", "why": "what in the input points to that owner",
      "action": "what to do next, and who does it, in one or two sentences",
      "steps": ["step names"], "scenarios": ["scenario codes"] }
  ],
  "comparison": { "fixed": ["…"], "stillFailing": ["…"], "new": ["…"] }
}`;

/** The instructions: what OSCAR is, what to answer, and in what shape. */
function systemPrompt({ language = 'English', instruction = null, compare = false, osdmVersion = null } = {}) {
  const lang = LANGUAGES.includes(language) ? language : 'English';
  const version = typeof osdmVersion === 'string' && osdmVersion.trim() ? osdmVersion.trim() : null;
  const lines = [
    'You read the results of OSCAR, a conformance test runner for OSDM (the UIC Open Sales and Distribution Model, a rail ticketing API).',
    'OSCAR runs scenarios (a sale, a refund, an exchange…) against a provider\'s OSDM API and checks each answer. The input lists the checks that failed, grouped by step, check text, HTTP status and OSDM problem code. Values a run met are replaced: N for a number, <id>, <instant>, "…" for a quoted value.',
    compare
      ? 'warningComparison lists the warnings the runs logged, apart from the failures and sorted the same way (gone, stillWarned, new). A warning is not a failure and never makes a scenario fail: it is something OSDM allows but worth knowing (an optional member left out, a value outside an extensible list, a feature the Test Framework does not declare). Use the warnings to explain failures; never report a warning as a failure.'
      : 'warnings lists the warnings the runs logged, grouped by step and text, apart from the failures. A warning is not a failure and never makes a scenario fail: it is something OSDM allows but worth knowing (an optional member left out, a value outside an extensible list, a feature the Test Framework does not declare). Use the warnings to explain failures; never report a warning as a failure.',
    'scenarios[] gives each scenario its own OSDM version (osdmVersion) and what the Test Framework does not declare of it (notDeclaredInTestFramework). A scenario written for another OSDM version than the provider declares, or arming a feature the Test Framework does not declare, should not be run on this provider as it is: its failures are the configuration\'s first, even when the request it sends does not fit the declared version.',
    'A failure can be the provider\'s (its answer does not follow OSDM, or a function is missing), OSCAR\'s (its request or its check is wrong), the configuration\'s (the Test Framework declares something the provider does not do, the Test Data names a train, date or tariff the provider does not have, or the scenario should not be run on this provider), or unclear. The Test Framework says what the provider declares it supports; the findings are what people already recorded.',
    'You may question a check itself: when the request OSCAR sent, or what the check expects, does not follow the OSDM extract, the owner is oscar; say which member or rule, quoting the extract. Each group\'s sample, when given, is the request OSCAR sent and the answer it received for one failure of the group, personal and connection data shown as <masked>, addresses of the web as <url>, long lists cut.',
    version
      ? `The provider declares OSDM ${version}: judge every request and answer against OSDM ${version}, never against a later version.`
      : 'The provider declares no OSDM version: say which version you judged against.',
    'osdmReference is an extract of the OSDM specification for the operations the failures concern (groups name their operation): each schema with its required members and the type of each member, member descriptions left out. It is of the version the provider declares; when osdmReference.exact is false, OSCAR has no file of that version and the extract is of the nearest one, so say so where it matters. Quote it when you say what OSDM requires or allows.',
    'provider.checklist, when given, is what the provider said of its own system in OSCAR\'s set-up checklist (answer names: info.* its behaviour, data.* its test data and options, fw.*.comment its remarks on what it supports). A failure on something the provider says it does not do is expected: say so, and say whether the scenario should be left out or the Test Framework changed. scenarios[].purpose says what a reference scenario tests.',
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
    action: short(g.action, 600),
    steps: strings(g.steps),
    scenarios: strings(g.scenarios),
  }));
  const result = { summary: short(json.summary, 4000), groups };
  if (compare && json.comparison && typeof json.comparison === 'object') {
    result.comparison = { fixed: strings(json.comparison.fixed, 100), stillFailing: strings(json.comparison.stillFailing, 100), new: strings(json.comparison.new, 100) };
  }
  return { ok: true, result };
}

// ── A group of an analysis as a finding draft (#823 PR 2) ─────────────────────

const OWNER_TEXT = Object.freeze({ provider: 'the provider', oscar: 'OSCAR', configuration: 'the configuration', unclear: 'unclear' });

/** The key of a group's draft in finding_suggestion: one draft per group of an analysis. */
function draftKeyOf(analysisId, index) {
  return `ai:${analysisId}:${index}`;
}

/**
 * A finding draft (the fields of the #735 suggestions) from group `index` of
 * a stored analysis. It says that it comes from an AI analysis, which one and
 * with which model; the AI's owner is shown, never copied into the category,
 * which stays "open" for the Test Manager to choose. Null when the analysis
 * has no such group.
 */
function draftOfAnalysisGroup(analysis, index) {
  const group = analysis?.result?.groups?.[index];
  if (!group || typeof group !== 'object') return null;
  const owner = OWNERS.includes(group.owner) ? group.owner : 'unclear';
  const steps = Array.isArray(group.steps) ? group.steps : [];
  const scenarios = Array.isArray(group.scenarios) ? group.scenarios : [];
  const batches = (analysis.batches || []).join(' and ');
  const evidence = [
    `From an AI analysis (id ${analysis.id}, model ${analysis.model}, ${analysis.createdAt}) of batch${(analysis.batches || []).length > 1 ? 'es' : ''} ${batches}.`,
    'An AI opinion, to be checked against the runs before it is kept.',
    `The AI names as the one to act: ${OWNER_TEXT[owner]}.`,
    group.why ? `Why: ${group.why}` : null,
    group.action ? `Next (AI): ${group.action}` : null,
    steps.length ? `Steps: ${steps.join(', ')}` : null,
    scenarios.length ? `Scenarios: ${scenarios.join(', ')}` : null,
  ].filter(Boolean).join('\n');
  return {
    title: short(group.title, 200) || 'Untitled',
    step: steps.length === 1 ? steps[0] : null,
    scenarioCode: scenarios.length === 1 ? scenarios[0] : null,
    expectedStatus: null,
    observed: short(group.cause, 2000),
    interpretation: '',
    evidence,
    category: 'open',
    reason: `From an AI analysis, which names ${OWNER_TEXT[owner]}. The category is yours to choose.`,
    simulatorHint: null,
    source: { kind: 'ai_analysis', analysisId: analysis.id, model: analysis.model, createdAt: analysis.createdAt, owner, group: index },
  };
}

/**
 * sha256 of exactly what is sent: the instructions and the input, and the
 * model when one is named (#831: the preview confirms the model too). Without
 * a model it is the content alone, the same for two models asked the same.
 */
function inputHash(system, text, model = null) {
  const hash = crypto.createHash('sha256').update(system, 'utf8').update('\n\n', 'utf8').update(text, 'utf8');
  if (model) hash.update('\n\nmodel: ', 'utf8').update(String(model), 'utf8');
  return hash.digest('hex');
}

module.exports = {
  LANGUAGES, OWNERS, MAX_INPUT_CHARS, MAX_ANSWER_TOKENS,
  groupsOf, compareGroups, byStep, buildInput, isWarningLine, warningText, warningGroupsOf, warningsByStep, MAX_WARNING_GROUPS, estimateTokens, systemPrompt, readResult, inputHash, frameworkDeclarations,
  catalogueEntryOf, providerContext, draftKeyOf, draftOfAnalysisGroup,
};
