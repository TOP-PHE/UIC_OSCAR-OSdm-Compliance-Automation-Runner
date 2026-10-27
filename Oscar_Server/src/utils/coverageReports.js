// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * coverageReports.js — published coverage reports (#972 part 4, decision 4).
 * Pure.
 *
 * A Test Manager publishes the coverage report of the day: it is numbered and
 * frozen. Sharing it with the certifier shares its runs. Each report says what
 * changed since the previous report shared with the certifier, compared when
 * it is published:
 *   still        a point of the previous report seen again (one of its #735
 *                keys met again, whatever the step or capability);
 *   new          a point the previous report did not have;
 *   fixed        a point of the previous report not seen again, whose tests
 *                were run again;
 *   notRetested  a point of the previous report not seen again, whose tests
 *                were not run again: nothing can be said of it.
 * and the capabilities whose result moved.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const arr = (v) => (Array.isArray(v) ? v : []);
const isRunId = (v) => typeof v === 'string' && UUID.test(v);

// Every form of every test and expected refusal of a coverage by capability.
function formsOf(byCapability) {
  const c = byCapability || {};
  return [...arr(c.capabilities).flatMap((x) => arr(x.tests)), ...arr(c.expectedRefusals)].flatMap((t) => arr(t.forms));
}

/** The runs a report reads (each scenario's latest run), each once. */
function runIdsOf(report) {
  const ids = new Set();
  for (const form of formsOf(report?.byCapability)) if (isRunId(form.runId)) ids.add(form.runId);
  for (const point of arr(report?.byCapability?.points)) {
    for (const run of arr(point.runs)) if (isRunId(run.runId)) ids.add(run.runId);
  }
  return [...ids];
}

/** The counts a list of reports shows: no text, no name. */
function summaryOf(report) {
  const s = report?.byCapability?.summary || {};
  const r = s.expectedRefusals || {};
  const p = s.pointsToLookAt || {};
  const n = (v) => (Number.isInteger(v) ? v : 0);
  return {
    tested: n(s.tested), passed: n(s.passed), deviation: n(s.deviation), points: n(s.points), blocked: n(s.blocked),
    notSupported: n(s.notSupported), notTested: n(s.notTested), outOfScope: n(s.outOfScope),
    expectedRefusals: { total: n(r.total), refused: n(r.refused), notRefused: n(r.notRefused) },
    pointsToLookAt: { total: n(p.total), provider: n(p.provider), accepted: n(p.accepted), questions: n(p.questions), oscar: n(p.oscar) },
  };
}

const keysOf = (point) => new Set(arr(point.keys).length ? arr(point.keys) : [point.key].filter(Boolean));
const meets = (a, b) => [...a.keys].some((k) => b.keys.has(k));

// What a point is, in a comparison: enough to read it without the other report.
function describe(point) {
  return {
    kind: point.kind, capability: point.capability, capabilityLabel: point.capabilityLabel,
    steps: arr(point.steps).length ? arr(point.steps) : [point.step].filter(Boolean), check: point.check,
  };
}

function pointChanges(now, before) {
  const current = arr(now.points).map((p) => ({ p, keys: keysOf(p) }));
  const previous = arr(before.points).map((p) => ({ p, keys: keysOf(p) }));
  const ran = new Set(formsOf(now).filter((f) => isRunId(f.runId)).map((f) => f.code));
  const out = { still: [], new: [], fixed: [], notRetested: [] };
  for (const c of current) {
    const was = previous.find((b) => meets(c, b));
    if (was) out.still.push({ number: c.p.number, previousNumber: was.p.number, previousKind: was.p.kind, ...describe(c.p) });
    else out.new.push({ number: c.p.number, ...describe(c.p) });
  }
  for (const b of previous) {
    if (current.some((c) => meets(c, b))) continue;
    const retested = arr(b.p.tests).flatMap((t) => arr(t.codes)).some((code) => ran.has(code));
    out[retested ? 'fixed' : 'notRetested'].push({ previousNumber: b.p.number, ...describe(b.p) });
  }
  return out;
}

function capabilityChanges(now, before) {
  const was = new Map(arr(before.capabilities).map((c) => [c.id, c]));
  const is = new Map(arr(now.capabilities).map((c) => [c.id, c]));
  const changes = [];
  for (const id of new Set([...was.keys(), ...is.keys()])) {
    const b = was.get(id);
    const n = is.get(id);
    const from = b ? b.result : null;
    const to = n ? n.result : null;
    if (from !== to) changes.push({ id, label: (n || b).label, group: (n || b).group, before: from, now: to });
  }
  return changes;
}

/**
 * What changed since the previous shared report, or null when there is none.
 *   current   the report being published (the coverage route's answer)
 *   previous  { id, number, sharedAt, report } of the last report shared
 *             with the certifier and not withdrawn
 */
function comparisonOf(current, previous) {
  if (!previous?.report) return null;
  const now = current?.byCapability || {};
  const before = previous.report.byCapability || {};
  const points = pointChanges(now, before);
  return {
    previous: { id: previous.id, number: previous.number, sharedAt: previous.sharedAt || null },
    points,
    capabilities: capabilityChanges(now, before),
    counts: { still: points.still.length, new: points.new.length, fixed: points.fixed.length, notRetested: points.notRetested.length },
  };
}

/**
 * The report as it is frozen for the certifier (#994): a provider's position
 * keeps what it is, the role of who took it and when, never their e-mail nor
 * the comment (both stay in the finding's thread, for the members); and no
 * position can be taken from it.
 */
function frozenPoint(p) {
  const position = p?.finding?.position;
  if (!position) return p;
  return { ...p, finding: { ...p.finding, position: { value: position.value, label: position.label, role: position.role, at: position.at } } };
}

function forPublication(report) {
  const c = report?.byCapability;
  if (!c) return report;
  const frozen = { ...c, points: arr(c.points).map(frozenPoint) };
  delete frozen.positions;
  return { ...report, byCapability: frozen };
}

module.exports = { runIdsOf, summaryOf, comparisonOf, isRunId, forPublication };
