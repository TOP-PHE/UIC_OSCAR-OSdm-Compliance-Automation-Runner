// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * replay-lib.js — the pure part of the replay (#611): what a run of the
 * collection records, made comparable from one run to the next, and the
 * comparison of two recordings.
 *
 * A recording holds, per scenario, the ordered list of the checks (request,
 * name, pass or fail) and of the WARNING lines. What changes on every run on
 * its own (ids, instants, durations, amounts of time waited) is replaced by a
 * placeholder, so that two runs of the same commit give the same recording,
 * and a change of a verdict shows.
 */

// The provider of a scenario: its code ends in its OSDM version.
// 310: OSDM 3.10, in development (#920); three digits, as _31 would read 3.1.
const PROVIDER_OF_VERSION = { 36: 'alpha', 37: 'beta', 38: 'gamma', 39: 'delta', 310: 'epsilon', 312: 'zeta' };

function providerOf(code) {
  const match = /_(\d{2,3})$/.exec(String(code));
  return match ? PROVIDER_OF_VERSION[match[1]] || null : null;
}

// Each pattern stands for a value that differs between two runs.
const VOLATILE = [
  [/\b[A-Z]{2,12}-[A-Z]{2,4}-[0-9a-f]{12,32}\b/g, '<id>'],
  [/\b(?:alpha|beta|gamma|delta|epsilon|zeta)\.[a-z0-9.]+\b/g, '<client>'],
  [/\b[A-Z]{2,12}[0-9A-F]{6}\b/g, '<code>'],
  [/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[\d:.]*(?:Z|[+-]\d{2}:\d{2})?/g, '<instant>'],
  [/\b\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:,\d{3})?\b/g, '<instant>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  [/\b\d+(?:\.\d+)?\s?(?:ms|s|min)\b/g, '<duration>'],
  [/\b\d{10}\b/g, '<number>'],
];

/** A text with what changes between runs replaced. */
function normalize(text) {
  let out = String(text);
  for (const [pattern, placeholder] of VOLATILE) out = out.replace(pattern, placeholder);
  return out;
}

const resultsOf = (report) => (Array.isArray(report) ? report[0] : report)?.results || [];

/**
 * What one run of one scenario records: from the JSON reporter of `bru run`
 * and its console output.
 */
function recordOf(report, consoleText) {
  const checks = [];
  for (const entry of resultsOf(report)) {
    if (entry.skipped) continue;
    const all = [...(entry.preRequestTestResults || []), ...(entry.postResponseTestResults || []), ...(entry.testResults || [])];
    for (const t of all) checks.push([entry.name, normalize(t.description), t.status === 'pass' ? 'pass' : 'fail']);
  }
  const warnings = String(consoleText || '').split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('[WARNING]'))
    .map(normalize);
  const failed = checks.filter((c) => c[2] === 'fail').length;
  return { checks: checks.length, failed, list: checks, warnings };
}

// The differences of one scenario recorded twice: totals, the first check
// that differs, and warnings gone or added.
function compareScenario(code, a, b) {
  const out = [];
  if (a.checks !== b.checks || a.failed !== b.failed) out.push(`${code}: ${a.checks} checks, ${a.failed} failed → ${b.checks} checks, ${b.failed} failed`);
  const n = Math.max(a.list.length, b.list.length);
  const i = Array.from({ length: n }, (_, k) => k).find((k) => JSON.stringify(a.list[k]) !== JSON.stringify(b.list[k]));
  if (i !== undefined) out.push(`${code}: check ${i + 1} differs:\n    - ${JSON.stringify(a.list[i] ?? null)}\n    + ${JSON.stringify(b.list[i] ?? null)}`);
  for (const w of a.warnings.filter((x) => !b.warnings.includes(x))) out.push(`${code}: warning gone: ${w}`);
  for (const w of b.warnings.filter((x) => !a.warnings.includes(x))) out.push(`${code}: warning added: ${w}`);
  return out;
}

/**
 * The differences between two recordings, as lines of text; none when they
 * are the same. A scenario present in one only is a difference too.
 */
function compareRecordings(before, after) {
  const codes = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort((x, y) => x.localeCompare(y));
  return codes.flatMap((code) => {
    const a = before[code];
    const b = after[code];
    if (!a || !b) return [`${code}: only in the ${a ? 'first' : 'second'} recording`];
    return compareScenario(code, a, b);
  });
}

// Whether the character at `offset` ran in one of the runs: the innermost
// range holding it decides.
function ranAt(offset, runs) {
  return runs.some((functions) => {
    let best = null;
    for (const range of functions.flatMap((fn) => fn.ranges)) {
      const holds = offset >= range.startOffset && offset < range.endOffset;
      if (holds && (!best || range.endOffset - range.startOffset <= best.endOffset - best.startOffset)) best = range;
    }
    return Boolean(best && best.count > 0);
  });
}

const isCode = (content) => content !== '' && !content.startsWith('//') && !content.startsWith('*') && !content.startsWith('/*');

// Lines counted and lines that ran, in one file's text.
function fileCoverage(text, runs) {
  let lines = 0;
  let covered = 0;
  let start = 0;
  for (const line of text.split('\n')) {
    if (isCode(line.trim())) {
      lines += 1;
      if (ranAt(start + line.search(/\S/), runs)) covered += 1;
    }
    start += line.length + 1;
  }
  return { lines, covered };
}

/**
 * Line coverage of the files under `include` from V8 coverage results
 * (NODE_V8_COVERAGE): a line counts when its first character is in a range
 * that ran, the innermost range deciding. Blank and comment-only lines are
 * not counted. `read(path)` gives a file's text.
 */
function lineCoverage(v8Results, include, read) {
  const byFile = new Map();
  for (const script of v8Results) {
    let path;
    try { path = decodeURIComponent(new URL(script.url).pathname); } catch { continue; }
    if (!path.includes(include)) continue;
    if (!byFile.has(path)) byFile.set(path, []);
    byFile.get(path).push(script.functions);
  }
  const files = {};
  for (const [path, runs] of byFile) files[path] = fileCoverage(read(path), runs);
  const total = Object.values(files).reduce((t, f) => ({ lines: t.lines + f.lines, covered: t.covered + f.covered }), { lines: 0, covered: 0 });
  return { files, total };
}

/**
 * Where the scenario catalogue (#612) and a recording disagree: an entry
 * whose source was not recorded, could not run, failed a check, or gave
 * another number of checks than the catalogue says. None when they agree.
 */
function catalogueDrift(catalogue, recording) {
  const out = [];
  for (const entry of catalogue?.entries || []) {
    const r = recording[entry.source];
    if (!r) out.push(`${entry.code}: ${entry.source} is not in the recording`);
    else if (r.error) out.push(`${entry.code}: ${entry.source} did not run: ${r.error}`);
    else {
      if (r.failed > 0) out.push(`${entry.code}: ${entry.source} failed ${r.failed} check(s)`);
      if (r.checks !== entry.checks) out.push(`${entry.code}: the catalogue says ${entry.checks} checks, ${entry.source} gave ${r.checks}`);
    }
  }
  return out;
}

// A check names the values one run met (an amount, a count, a code); they are
// left out when checks are listed, so that the same check reads the same in
// every scenario.
const VALUE = [
  [/"[^"\n]{0,80}"/g, '"…"'],
  [/'[^'\n]{0,80}'/g, "'…'"],
  [/=\[[^\]\n]{0,200}\]/g, '=[…]'],
  [/([:=—] ?)(?:[A-Z][A-Z0-9_]*|true|false|null)\b/g, '$1…'],
  [/\b\d+(?:\.\d+)*\b/g, 'N'],
];

function checkText(description) {
  let out = String(description);
  for (const [pattern, placeholder] of VALUE) out = out.replace(pattern, placeholder);
  return out;
}

// Every step a recording ran, in the order first met, with each check text
// and the scenarios that made it.
function stepsOf(recording) {
  const steps = new Map();
  for (const [code, record] of Object.entries(recording)) {
    for (const [step, description] of record.list || []) {
      if (!steps.has(step)) steps.set(step, new Map());
      const checks = steps.get(step);
      const text = checkText(description);
      if (!checks.has(text)) checks.set(text, new Set());
      checks.get(text).add(code);
    }
  }
  return steps;
}

const DISTINCTIVE = 4;

// Text shown as text in Markdown: placeholders such as <id> are not tags, and
// a | does not end a table cell.
const md = (text) => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', String.raw`\|`);
const tick = (text) => `\`${text}\``;

// One scenario: provider, catalogue codes, steps with their number of checks,
// failed checks, and its distinctive checks (made by at most four scenarios).
function describeScenario(code, record, steps, catalogueOf) {
  const lines = [`### \`${code}\``, ''];
  const facts = [`provider \`${providerOf(code) || '?'}\``, `${record.checks} checks`, `${record.failed} failed`];
  if (catalogueOf.has(code)) facts.push(`catalogue: ${catalogueOf.get(code).map(tick).join(', ')}`);
  lines.push(`${facts.join(' · ')}`, '');
  if (record.error) return [...lines, `Did not run: ${record.error}`, ''];
  const perStep = new Map();
  for (const [step] of record.list) perStep.set(step, (perStep.get(step) || 0) + 1);
  const stepList = [...perStep].map(([step, n]) => `${step} (${n})`).join(' → ');
  lines.push(`Steps: ${stepList}`, '');
  const failed = record.list.filter((c) => c[2] === 'fail');
  if (failed.length) {
    lines.push('Failed checks:', '');
    for (const [step, description] of failed) lines.push(`- ${step}: ${md(description)}`);
    lines.push('');
  }
  const distinctive = [];
  const seen = new Set();
  for (const [step, description] of record.list) {
    const text = checkText(description);
    const key = `${step}\u0000${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (steps.get(step).get(text).size <= DISTINCTIVE) distinctive.push(`- ${step}: ${md(text)}`);
  }
  if (distinctive.length) lines.push(`Distinctive checks (made by at most ${DISTINCTIVE} scenarios):`, '', ...distinctive, '');
  return lines;
}

/**
 * The checks of a recording as a Markdown document: every step with every
 * check it makes and how many scenarios make it, then every scenario with the
 * steps it runs and what only it (or few others) checks. `about` says what the
 * recording was made from.
 */
function describeRecording(recording, catalogue, about) {
  const steps = stepsOf(recording);
  const catalogueOf = new Map();
  for (const entry of catalogue?.entries || []) {
    if (!catalogueOf.has(entry.source)) catalogueOf.set(entry.source, []);
    catalogueOf.get(entry.source).push(entry.code);
  }
  const codes = Object.keys(recording);
  const lines = [
    '# OSCAR — Checks by scenario',
    '',
    `Generated by \`node scripts/replay.js describe\` (in \`OSDM_Simulator/\`) from a recording of ${codes.length} scenarios: ${about}. Do not edit by hand: record again and regenerate. What the scenarios are for, and how to read this, is in [OSCAR - What is tested](OSCAR%20-%20What%20is%20tested.md).`,
    '',
    'Values a run met (amounts, counts, codes, quoted text, code-list values) are shown as `N` and `…`, so a check reads the same in every scenario.',
    '',
    '## Steps and their checks',
    '',
  ];
  for (const [step, checks] of steps) {
    const scenarios = new Set([...checks.values()].flatMap((set) => [...set]));
    lines.push(`### ${step}`, '', `Run by ${scenarios.size} of ${codes.length} scenarios; ${checks.size} different checks.`, '', '| Check | Scenarios |', '|---|---|');
    for (const [text, made] of checks) lines.push(`| ${md(text)} | ${made.size} |`);
    lines.push('');
  }
  lines.push('## Scenarios', '');
  for (const code of codes) lines.push(...describeScenario(code, recording[code], steps, catalogueOf));
  while (lines.at(-1) === '') lines.pop();
  return `${lines.join('\n')}\n`;
}

module.exports = { providerOf, normalize, recordOf, compareRecordings, lineCoverage, catalogueDrift, checkText, describeRecording };
