// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * coveragePoints.js — the points to look at of the coverage by capability
 * (#972 R6 and decision 3). Pure.
 *
 * A point is one distinct problem, across forms, runs and steps (maintainer,
 * 2026-10-26): the same check text failing under the same capability, with
 * the same problem code, is one point listing its steps; a generic HTTP status
 * check keeps its step. Each failed check still has its #735 key
 * (`groupKeyOf()`), kept in the point's `keys` for the comparison of reports
 * (#972 part 4). A documented known deviation a run applied (its "[WARNING]
 * Known deviation (documented)" log line) is a point too.
 *
 * A point takes the finding of the first of its keys that #735 links to one
 * (`matchFinding()`, a sure match only). Its kind:
 *   oscar     the finding is an OSCAR issue, a #735 draft was marked as one,
 *             or the check is OSCAR's own request (#736): listed apart, and
 *             not counted against the provider (maintainer, 2026-10-26);
 *   accepted  an accepted deviation: a finding classified provider_deviation
 *             and resolved (maintainer, 2026-10-26), or a known deviation the
 *             run applied. Its capability reads "Passed with deviation";
 *   question  the finding is a question on the specification;
 *   provider  any other.
 */

const S = require('./findingSuggestions');

const MARK = '[WARNING] Known deviation (documented): ';
const RETURNED = ' returned HTTP ';
const NOTE_END = '. Not counted as a failure';
const MAX_NOTE = 300;
const MAX_POINTS = 500;
const MAX_POINT_RUNS = 10;
const MAX_POINT_CODES = 20;
const KIND_ORDER = Object.freeze(['provider', 'accepted', 'question', 'oscar']);

const arr = (v) => (Array.isArray(v) ? v : []);
const atOf = (run) => run?.completed_at || run?.queued_at || null;

// ── Known deviations ────────────────────────────────────────────────────────

/**
 * The known deviation a log line reports (loopback.js noteKnownDeviation()):
 * { step, status, note }, or null. Read by position, not by a pattern.
 */
function knownDeviationOf(line) {
  const text = String(line ?? '');
  const at = text.indexOf(MARK);
  if (at < 0) return null;
  const rest = text.slice(at + MARK.length);
  const cut = rest.indexOf(RETURNED);
  if (cut <= 0) return null;
  const from = cut + RETURNED.length;
  const digits = rest.slice(from, from + 3);
  if (!/^\d{3}$/.test(digits)) return null;
  const tail = rest.slice(from + 3);
  const found = tail.indexOf(NOTE_END);
  const end = found < 0 ? tail.length : found;
  const note = tail.startsWith(' — ') ? tail.slice(3, end).trim() : '';
  return { step: rest.slice(0, cut).trim(), status: Number(digits), note: note.slice(0, MAX_NOTE) };
}

const deviationKey = (dev) => `kd:${S.stepKey(dev.step)}#${dev.status}`;

/** The known deviations of a run's warning lines, each once. */
function knownDeviationsOf(lines) {
  const out = new Map();
  for (const line of arr(lines)) {
    const dev = knownDeviationOf(line);
    if (dev && !out.has(deviationKey(dev))) out.set(deviationKey(dev), dev);
  }
  return [...out.values()];
}

// ── Findings ────────────────────────────────────────────────────────────────

const isAcceptedFinding = (f) => f?.category === 'provider_deviation' && f.status === 'resolved';
const findingView = (f) => (f ? { id: f.id, title: f.title, category: f.category, status: f.status } : null);
const baselined = (f) => Boolean(f?.baselineInRun ?? f?.baseline_in_run);

// The finding that put a known deviation in the runs: baselined, same step and status.
function deviationFinding(dev, findings) {
  return arr(findings).find((f) => baselined(f) && f.step && S.stepKey(f.step) === S.stepKey(dev.step)
    && Number(f.expectedStatus ?? f.expected_status) === dev.status) || null;
}

/** The #735 record of a failed check of a run. */
function recordOf(check, run, code) {
  return {
    step: check.request_name, check: check.assertion_name, status: check.http_status ?? null,
    problemCode: check.problem_code ?? null, runId: run?.id ?? null, at: atOf(run), scenarioCode: code,
  };
}

/** The key of a failed check: the #735 key. */
const keyOfCheck = (check) => S.groupKeyOf(recordOf(check, null, null));

/**
 * Every #735 failure group of the runs, linked: Map key → { group, finding,
 * possible, oscar }. `failures` are [{ check, run, code }]; `suggestions`
 * { accepted: { key: findingId }, oscarIssues: [key] } come from the #735
 * drafts. `oscar`: the draft was marked as OSCAR's, or the check is OSCAR's
 * own request (#736).
 */
function linkFailures(failures, { findings = [], suggestions = {} } = {}) {
  const groups = S.groupFailures(arr(failures).map((f) => recordOf(f.check, f.run, f.code)));
  const oscarKeys = new Set(arr(suggestions.oscarIssues));
  const links = new Map();
  for (const group of groups) {
    const m = S.matchFinding(group, arr(findings), suggestions.accepted || {});
    links.set(group.key, {
      group, finding: m?.strength === 'same' ? m.finding : null, possible: m?.strength === 'maybe' ? m.finding : null,
      oscar: oscarKeys.has(group.key) || String(group.check).startsWith('[OSCAR request]'),
    });
  }
  return links;
}

function kindOf(finding, oscar) {
  if (oscar || finding?.category === 'oscar_issue') return 'oscar';
  if (isAcceptedFinding(finding)) return 'accepted';
  if (finding?.category === 'spec_question') return 'question';
  return 'provider';
}

// ── Points ──────────────────────────────────────────────────────────────────

const capabilityPart = (seen) => [seen.capability, seen.refusal ? 'refusal' : ''];

// Where a failed check or known deviation goes: { id, key, step, group }.
// One problem (maintainer, 2026-10-26) = the capability it counts against, an
// expected refusal or not, the check text without the run's values and the
// problem code of an error answer, whatever the step. A generic HTTP status
// check says nothing without its step, so it keeps it.
function placeOf(seen, links) {
  if (seen.deviation) {
    const key = deviationKey(seen.deviation);
    return { id: ['deviation', ...capabilityPart(seen), key].join('␟'), key, step: seen.deviation.step, group: null };
  }
  const key = keyOfCheck(seen.check);
  const group = links.get(key)?.group || null;
  const check = group ? group.check : S.checkText(seen.check.assertion_name);
  const step = group ? group.step : String(seen.check.request_name ?? '');
  const own = S.STATUS_CHECK.test(check) ? S.stepKey(step) : '';
  return { id: ['check', ...capabilityPart(seen), own, check, group?.problemCode || ''].join('␟'), key, step, group };
}

function newPoint(base) {
  return {
    ...base, keys: [], steps: [], blocking: false, occurrences: 0, tests: [], runs: [], firstSeen: null, lastSeen: null,
  };
}

// The point a failed check opens: kind and finding come once all its keys are known.
function checkPoint(seen, place, label) {
  return newPoint({
    kind: 'provider', source: 'check', capability: seen.capability, capabilityLabel: label(seen.capability),
    step: place.step, check: place.group ? place.group.check : S.checkText(seen.check.assertion_name),
    status: place.group?.status ?? null, problemCode: place.group?.problemCode ?? null,
    finding: null, possibleFinding: null, expectedRefusal: Boolean(seen.refusal),
  });
}

// The point a known deviation opens.
function deviationPoint(seen, findings, label) {
  return newPoint({
    kind: 'accepted', source: 'known-deviation', capability: seen.capability, capabilityLabel: label(seen.capability),
    step: seen.deviation.step, check: `Known deviation: answered HTTP ${seen.deviation.status}`, status: seen.deviation.status,
    problemCode: null, note: seen.deviation.note, finding: findingView(deviationFinding(seen.deviation, findings)), possibleFinding: null,
    expectedRefusal: Boolean(seen.refusal),
  });
}

function addOccurrence(point, seen, place) {
  point.occurrences += 1;
  if (!point.keys.includes(place.key)) point.keys.push(place.key);
  if (!point.steps.includes(place.step)) point.steps.push(place.step);
  if (seen.blocking) point.blocking = true;
  let test = point.tests.find((t) => t.key === seen.test.key);
  if (!test) {
    test = { key: seen.test.key, entry: seen.test.entry, codes: [] };
    point.tests.push(test);
  }
  if (!test.codes.includes(seen.code) && test.codes.length < MAX_POINT_CODES) test.codes.push(seen.code);
  if (seen.run && !point.runs.some((r) => r.runId === seen.run.id) && point.runs.length < MAX_POINT_RUNS) {
    point.runs.push({ runId: seen.run.id, at: atOf(seen.run), code: seen.code });
  }
  const at = atOf(seen.run);
  if (at && (!point.firstSeen || at < point.firstSeen)) point.firstSeen = at;
  if (at && (!point.lastSeen || at > point.lastSeen)) point.lastSeen = at;
}

// A point of failed checks takes the first finding its keys name, in the
// order met, and is OSCAR's when any of them is.
function settle(point, links) {
  if (point.source !== 'check') return;
  const parts = point.keys.map((k) => links.get(k)).filter(Boolean);
  const linked = parts.find((l) => l.finding);
  point.finding = findingView(linked?.finding);
  point.possibleFinding = linked ? null : findingView(parts.find((l) => l.possible)?.possible);
  point.kind = kindOf(linked?.finding, parts.some((l) => l.oscar));
}

function order(capabilities) {
  const index = new Map(arr(capabilities).map((id, i) => [id, i]));
  const rank = (p) => (index.has(p.capability) ? index.get(p.capability) : index.size);
  return (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
    || rank(a) - rank(b)
    || Number(b.blocking) - Number(a.blocking)
    || String(a.step).localeCompare(String(b.step))
    || String(a.check).localeCompare(String(b.check));
}

/**
 * The points to look at, numbered from 1 in the order they are read: the
 * provider's, the accepted deviations, the questions, then OSCAR's; within a
 * kind by capability (the order of `capabilities`), the blocking ones first.
 *   seen   [{ check | deviation, capability, refusal, blocking, test: { key,
 *            entry }, code, run }], one per failed check or known deviation of
 *            a run; `refusal` when it counts against an expected refusal (R4)
 *   links  linkFailures()'s map
 * -> { points, truncated, accepted, oscar }: `accepted` and `oscar` hold the
 *    failed checks (the objects of `seen`) of the accepted deviations and of
 *    OSCAR's points, which no longer count as points of their capability.
 */
function pointsOf(seen, { links = new Map(), findings = [], capabilities = [], label = (id) => id } = {}) {
  const points = new Map();
  const members = new Map();
  for (const s of arr(seen)) {
    const place = placeOf(s, links);
    if (!points.has(place.id)) {
      points.set(place.id, s.deviation ? deviationPoint(s, findings, label) : checkPoint(s, place, label));
      members.set(place.id, []);
    }
    addOccurrence(points.get(place.id), s, place);
    members.get(place.id).push(s);
  }
  for (const p of points.values()) settle(p, links);
  const checksOf = (kind) => new Set([...points].filter(([, p]) => p.kind === kind && p.source === 'check')
    .flatMap(([id]) => members.get(id).map((s) => s.check)));
  const list = [...points.values()].sort(order(capabilities));
  const kept = list.slice(0, MAX_POINTS);
  kept.forEach((p, i) => { p.number = i + 1; });
  return { points: kept, truncated: list.length > MAX_POINTS, accepted: checksOf('accepted'), oscar: checksOf('oscar') };
}

module.exports = {
  knownDeviationOf, knownDeviationsOf, deviationKey, isAcceptedFinding, keyOfCheck, linkFailures, pointsOf,
  KIND_ORDER, MAX_POINTS,
};
