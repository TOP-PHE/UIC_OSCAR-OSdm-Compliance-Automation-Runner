// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * capabilityCoverage.js — the coverage report by capability (#972). Pure.
 *
 * Rules (the issue's R1–R5, R7 and its decision 1):
 *   R1  A failed check counts against the scenario's own (main) capability,
 *       never against what every scenario of the flow shares. A failure at an
 *       optional operation's step is that operation's (R7).
 *   R2  The steps a run went through prove their capabilities, whatever
 *       happened later; so do the traits of a stage that went through (a
 *       return, a card…). A step proves only what it did.
 *   R3  A catalogue entry is one test, whatever its forms (_SPEC, _TRIPID)
 *       and copies (_2). A scenario neither in the run list nor run is set
 *       apart, not counted.
 *   R4  Expected refusals (NHF_, refusal probes) are rows of their own; their
 *       result never changes the capability they probe. The steps they went
 *       through still prove what they did.
 *   R5  Results: passed, deviation (passed with an accepted deviation,
 *       decision 3), points (passed, with failed checks), blocked (no run
 *       reached it), not-supported (the provider answered 501, or an optional
 *       read "not implemented" as #488 reads it), not-tested (declared, not
 *       run), out-of-scope (not declared, or declared not supported).
 *   R6  The points to look at, each once (coveragePoints.js). A failed check
 *       of an accepted deviation is not a point of its capability: it reads
 *       "Passed with deviation". One of OSCAR's points does not count against
 *       the provider at all (maintainer, 2026-10-26). Nor does one the
 *       provider says it does not support (#994): its capability reads "Not
 *       supported by the provider" when nothing else failed.
 *   R7  An optional operation is its own row: masterData, the seat map, the
 *       fulfilment read, the refund receipt, a withdrawal, Idempotency-Key.
 */

const K = require('./capabilities');
const P = require('./coveragePoints');
const { stepKey } = require('./findingSuggestions');
const { catalogueEntryForScenario } = require('./scenarioCatalogue');
const { declarationOf } = require('./coverageMatrix');
const {
  declaredFunctions, frameworkOf, isBlockingCheck: isBlocking, scenarioHash, toRunAgain,
} = require('./frameworkCoverage');

const arr = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const NOT_IMPLEMENTED_READ = new Set([403, 404, 405, 500, 501]);
const MAX_CHECK_TEXT = 300;
const MAX_PROVEN_CODES = 10;
const RESULT_TEXT = Object.freeze({
  passed: 'Passed', deviation: 'Passed with deviation', points: 'Passed with points', blocked: 'Blocked', 'not-supported': 'Not supported by the provider',
  'not-tested': 'Not tested', 'out-of-scope': 'Out of scope', refused: 'Refused as expected', 'not-refused': 'Not refused',
  'not-run': 'Not run',
});

// What the framework says of a capability: the function ids it stands for
// (any declared makes it declared), or a flag that says "not supported".
const CAPABILITY_FUNCTIONS = Object.freeze({
  'offers.search': ['offerRequestForm:SEARCH'], 'offers.specification': ['offerRequestForm:SPECIFICATION'],
  'offers.tripIds': ['offerRequestForm:TRIP_IDS'], 'return.separate': ['returnModel:SEPARATE'], 'return.combined': ['returnModel:COMBINED'],
  'refund.full': ['salesFlow:REFUND_FULL'], 'refund.technical': ['salesFlow:REFUND_IROPS'],
  'refund.partial.fulfillment': ['partialRefund:FULFILLMENT'], 'refund.partial.passenger': ['partialRefund:PASSENGER'],
  'refund.partial.leg': ['partialRefund:LEG'], 'exchange.full': ['salesFlow:EXCHANGE_FULL'], sale: ['distribution:PRODUCT'],
  'fares.offers': ['distribution:FARE'], 'fares.sale': ['distribution:FARE'], 'fares.refund': ['distribution:FARE'],
  'fares.reservation': ['distribution:FARE'], 'reservation.preferences': ['placeSelection:AUTOMATIC_PLACE_SELECTION_PREFERENCES'],
  'reservation.nearby': ['placeSelection:AUTOMATIC_PLACE_SELECTION_NEARBY'],
  'reservation.namedPlace': ['placeSelection:MANUAL_PLACE_SELECTION_WITHOUT_FEE', 'placeSelection:MANUAL_PLACE_SELECTION_WITH_FEE'],
});
const DECLARED_NOT_SUPPORTED = Object.freeze({ 'passengers.update': 'passengerUpdate', purchaser: 'purchaserAfterBooking' });

// ── One run ─────────────────────────────────────────────────────────────────

const isProbe = (check) => String(check.assertion_name ?? '').trimStart().startsWith('🧪');

// A step answered "not implemented": 501 anywhere, or what #488 reads as
// "not implemented" on an optional read.
function stepNotSupported(name, statuses) {
  if (statuses.length === 0) return false;
  if (statuses.every((s) => s === 501)) return true;
  return K.isOptionalRead(name) && statuses.every((s) => NOT_IMPLEMENTED_READ.has(s));
}

/**
 * The steps of a run, in order, each once: { name, state (passed / failed /
 * not-supported), failures (its failed checks, probes apart), accepted (those
 * of an accepted deviation), unsupported (those of what the provider does not
 * support, #994), oscar (those of OSCAR's points), deviation (an accepted
 * deviation or a known deviation was met there), blocking }. `accepted`,
 * `unsupported` and `oscar` are sets of the run's check objects.
 */
function stepsOf(run, { accepted, unsupported, oscar, deviations } = {}) {
  const steps = stepsByName(run?.steps);
  for (const check of arr(run?.checks)) {
    const step = isObj(check) ? steps.get(check.request_name) : undefined;
    if (step) bucketOf(step, check, { accepted, unsupported, oscar }).push(check);
  }
  const deviated = new Set(arr(deviations).map((d) => stepKey(d.step)));
  return [...steps.values()].map((s) => withState(s, deviated));
}

function bucketOf(step, check, { accepted, unsupported, oscar }) {
  if (accepted?.has(check)) return step.accepted;
  if (unsupported?.has(check)) return step.unsupported;
  if (oscar?.has(check)) return step.oscar;
  return isProbe(check) ? step.probes : step.failures;
}

// A run's step rows, one entry per request name in order, with its HTTP statuses.
function stepsByName(rows) {
  const steps = new Map();
  for (const row of arr(rows)) {
    if (!isObj(row) || typeof row.request_name !== 'string') continue;
    if (!steps.has(row.request_name)) steps.set(row.request_name, { name: row.request_name, statuses: [], failures: [], probes: [], accepted: [], unsupported: [], oscar: [] });
    const status = Number(row.http_status);
    if (Number.isInteger(status) && status > 0) steps.get(row.request_name).statuses.push(status);
  }
  return steps;
}

// A step's state, once its statuses and failed checks are known.
function withState(step, deviated = new Set()) {
  const failed = step.failures.length > 0;
  const notSupported = stepNotSupported(step.name, step.statuses);
  let state = failed ? 'failed' : 'passed';
  if (notSupported) state = 'not-supported';
  return {
    ...step, notSupported, state, deviation: step.accepted.length > 0 || deviated.has(stepKey(step.name)),
    blocking: step.failures.some(isBlocking) || (failed && step.statuses.some((s) => s >= 500)),
  };
}

const capabilitiesOfStep = (step, traits) => K.stepCapabilities(step.name, traits);
const goalStepsOf = (def) => (def.goal === 'masterData' ? K.SYSTEM_INFO_STEPS : arr(def.goal));

// The steps a capability's result is read from, and whether it was reached.
function stepsFor(capability, steps, traits) {
  const def = K.CAPABILITY.get(capability) || { stage: 'sale' };
  if (def.goal) {
    const own = steps.filter((s) => capabilitiesOfStep(s, traits).includes(capability));
    const goals = new Set(goalStepsOf(def));
    return { def, own, reached: steps.some((s) => goals.has(s.name)), goals: steps.filter((s) => goals.has(s.name)) };
  }
  const roles = K.STAGE_ROLES[def.stage] || K.STAGE_ROLES.sale;
  const own = steps.filter((s) => roles.has(K.roleOf(s.name)));
  const goal = K.STAGE_GOAL[def.stage] || K.SALE_GOAL;
  return { def, own, reached: steps.some((s) => s.name === goal), goals: steps.filter((s) => s.name === goal) };
}

// A step whose failures are not the main capability's (R7): an optional
// operation's step other than the main capability's own, or one the provider
// does not support.
function chargedTo(step, main, traits) {
  if (step.notSupported) return false;
  const caps = capabilitiesOfStep(step, traits);
  if (caps.includes(main)) return true;
  return !caps.some((c) => K.CAPABILITY.get(c)?.optional);
}

const failureText = (check) => (check ? String(check.assertion_name ?? '').slice(0, MAX_CHECK_TEXT) : null);

// A run that went through: points when a check failed, else passed, with an
// accepted deviation or without (decision 3).
function passedResult(failures, deviation) {
  if (failures.length > 0) return 'points';
  return deviation ? 'deviation' : 'passed';
}

// An expected refusal (R4): not refused when a check failed, else refused,
// or not refused as an accepted deviation.
function refusalOutcome(failures, deviation) {
  if (failures.length > 0) return 'not-refused';
  return deviation ? 'deviation' : 'refused';
}

// Nothing failed but what the provider says it does not support (#994), even
// when the run stopped on it: "not supported", at its first such step; else null.
function declinedResult(charged, failures) {
  const declined = failures.length === 0 ? charged.find((s) => s.unsupported.length > 0) : null;
  return declined ? { result: 'not-supported', step: declined.name, check: failureText(declined.unsupported[0]) } : null;
}

/**
 * The result of a run for its main capability (R1, R5): passed, deviation,
 * points, blocked or not-supported; for a refusal test, refused, deviation or
 * not-refused. With the step and check to look at first.
 */
function mainResult(steps, main, traits, refusal) {
  const charged = steps.filter((s) => chargedTo(s, main, traits));
  const failures = charged.flatMap((s) => [...s.failures, ...s.probes].map((c) => ({ step: s.name, check: c, blocking: s.blocking || isBlocking(c) })));
  const deviation = charged.some((s) => s.deviation);
  const first = failures.find((f) => f.blocking) || failures[0] || null;
  const at = first ? { step: first.step, check: failureText(first.check) } : { step: null, check: null };
  if (refusal) return { result: refusalOutcome(failures, deviation), ...at };
  const { own, reached, goals } = stepsFor(main, steps, traits);
  if (reached && goals.length > 0 && goals.every((s) => s.notSupported)) {
    return { result: 'not-supported', step: goals[0].name, check: `answered HTTP ${goals[0].statuses.at(-1)}` };
  }
  const declined = declinedResult(charged, failures);
  if (declined) return declined;
  if (!reached) return { result: 'blocked', step: at.step, check: at.check || 'the run stopped before this capability was reached' };
  if (own.some((s) => s.state === 'failed' && s.blocking && chargedTo(s, main, traits))) return { result: 'blocked', ...at };
  return { result: passedResult(failures, deviation), ...at };
}

// What a run proves of a capability other than its main one (R1, R2, R7):
// passed, not-supported, or an optional operation's own points or deviation;
// else nothing (null). A failure or deviation at a step every flow shares is
// the main capability's, as its point is.
function sideResult(capability, steps, traits) {
  const { def, own, reached } = stepsFor(capability, steps, traits);
  if (!reached || own.length === 0) return null;
  if (own.every((s) => s.notSupported)) return 'not-supported';
  const ownRow = Boolean(def.optional && def.goal);
  if (own.some((s) => s.state === 'failed')) return ownRow ? 'points' : null;
  if (ownRow && own.some((s) => s.unsupported.length > 0)) return 'not-supported';
  return ownRow && own.some((s) => s.deviation) ? 'deviation' : 'passed';
}

/**
 * Everything one run says: its main result, what it proves of the other
 * capabilities ({ capability: passed | deviation | not-supported | points }),
 * and its steps. `accepted`, `unsupported` and `oscar` hold the failed checks
 * of accepted deviations, of what the provider does not support and of
 * OSCAR's points, `deviations` the known deviations the run applied.
 */
function runEvidence(run, { main, traits, refusal, accepted, unsupported, oscar, deviations }) {
  const steps = stepsOf(run, { accepted, unsupported, oscar, deviations });
  const side = new Set(steps.flatMap((s) => capabilitiesOfStep(s, traits)));
  for (const f of arr(traits?.features)) side.add(f);
  // A refusal's result is a row of its own (R4): the capability it probes
  // still gets what its steps proved.
  if (!refusal) side.delete(main);
  const proven = {};
  for (const capability of side) {
    const result = sideResult(capability, steps, traits);
    if (result) proven[capability] = result;
  }
  return { main: mainResult(steps, main, traits, refusal), proven, steps };
}

// ── The report ──────────────────────────────────────────────────────────────

const WENT_THROUGH = new Set(['passed', 'deviation']);

/** The combined result of several results (R5): null when there is none. */
function combine(results) {
  const list = results.filter(Boolean);
  if (list.length === 0) return null;
  if (list.every((r) => r === 'not-supported')) return 'not-supported';
  const problems = list.filter((r) => r === 'points' || r === 'blocked');
  if (problems.length === 0) return list.includes('deviation') ? 'deviation' : 'passed';
  return list.some((r) => WENT_THROUGH.has(r)) || problems.includes('points') ? 'points' : 'blocked';
}

function refusalResult(forms) {
  const run = forms.filter((f) => f.result !== 'not-run');
  if (run.length === 0) return 'not-run';
  if (run.some((f) => f.result === 'not-refused')) return 'not-refused';
  return run.some((f) => f.result === 'deviation') ? 'deviation' : 'refused';
}

/** What the framework says of a capability: declared, not-declared, every-value, declared-not-supported, or null. */
function capabilityDeclaration(capability, fw, declaredIds) {
  const flag = DECLARED_NOT_SUPPORTED[capability];
  if (flag && fw[flag] === false) return 'declared-not-supported';
  const ids = CAPABILITY_FUNCTIONS[capability];
  if (!ids) return null;
  const answers = ids.map((id) => declarationOf(id, fw, declaredIds));
  if (answers.includes('declared')) return 'declared';
  return answers.every((a) => a === 'not-declared') ? 'not-declared' : 'every-value';
}

// The scenarios that count (R3): in the run list, or run in the window. A
// run list of null is "ALL", as POST /v1/runs reads it.
function inScope(code, runList, runs) {
  return runList === null || runList.has(code) || Boolean(runs[code]);
}

// The data file's run list as a set of codes, or null for every scenario.
function runListOf(datafile) {
  const list = datafile?.scenariosToRun;
  return list == null || list === 'ALL' ? null : new Set(arr(list).filter((c) => typeof c === 'string'));
}

// One form of a test: a scenario, its run and its result.
function formOf(item, collectionVersion) {
  const { scenario, run, evidence } = item;
  const form = {
    code: scenario.code, form: item.traits.form, result: evidence ? evidence.main.result : 'not-run',
    toRunAgain: toRunAgain(run, { collectionVersion, hash: scenarioHash(scenario) }),
  };
  if (run) Object.assign(form, { runId: run.id, at: run.completed_at || run.queued_at || null, step: evidence.main.step, check: evidence.main.check });
  return form;
}

// Each scenario of the report: its test, main capability, traits and run.
function scenarioItems({ datafile, catalogue, runs, runList }) {
  const items = [];
  const apart = [];
  for (const scenario of arr(datafile?.scenarios)) {
    if (!isObj(scenario) || typeof scenario.code !== 'string' || scenario.code === '') continue;
    const entry = catalogueEntryForScenario(scenario.code, catalogue);
    if (!inScope(scenario.code, runList, runs)) {
      apart.push({ code: scenario.code, entry: entry?.code || null });
      continue;
    }
    items.push({
      scenario, entry, testKey: entry?.code || scenario.code, run: runs[scenario.code] || null,
      main: K.CAPABILITY.has(entry?.capability) ? entry.capability : K.derivedCapability(scenario, datafile),
      refusal: K.isRefusalTest(scenario), traits: K.traitsOf(scenario, datafile),
    });
  }
  return { items, apart };
}

// The failed checks of the items' runs, as linkFailures() reads them.
function failuresOf(items) {
  return items.filter((item) => item.run).flatMap((item) => arr(item.run.checks).filter(isObj)
    .map((check) => ({ check, run: item.run, code: item.scenario.code })));
}

// Each item's evidence and form, once the accepted deviations and OSCAR's
// points are known.
function withEvidence(items, { accepted, unsupported, oscar, collectionVersion }) {
  for (const item of items) {
    item.evidence = item.run
      ? runEvidence(item.run, { main: item.main, traits: item.traits, refusal: item.refusal, accepted, unsupported, oscar, deviations: item.deviations })
      : null;
    item.form = formOf(item, collectionVersion);
  }
}

// The capability a step's problems are read under (R1, R7): the main one when
// they count against it, else the optional operation the step is.
function capabilityOfStep(step, item) {
  if (chargedTo(step, item.main, item.traits)) return item.main;
  const caps = capabilitiesOfStep(step, item.traits);
  return caps.find((c) => K.CAPABILITY.get(c)?.optional) || caps[0] || item.main;
}

// One problem seen in a run, as pointsOf() reads it.
function seenAt(item, step, extra) {
  const capability = step ? capabilityOfStep(step, item) : item.main;
  return {
    ...extra, capability, refusal: item.refusal && capability === item.main,
    test: { key: item.testKey, entry: item.entry?.code || null }, code: item.scenario.code, run: item.run,
  };
}

// Every failed check and known deviation of the items' runs.
function seenOf(items) {
  const seen = [];
  for (const item of items) {
    const steps = item.run ? stepsOf(item.run) : [];
    for (const step of steps) {
      const severe = step.statuses.some((s) => s >= 500);
      for (const check of [...step.failures, ...step.probes]) {
        seen.push(seenAt(item, step, { check, blocking: severe || isBlocking(check) }));
      }
    }
    for (const deviation of arr(item.deviations)) {
      seen.push(seenAt(item, steps.find((s) => stepKey(s.name) === stepKey(deviation.step)), { deviation, blocking: false }));
    }
  }
  return seen;
}

// The tests (R3): one per catalogue entry, else per scenario, with their forms.
function testsOf(items) {
  const tests = new Map();
  for (const item of items) {
    if (!tests.has(item.testKey)) {
      tests.set(item.testKey, {
        key: item.testKey, entry: item.entry?.code || null, capability: item.main, refusal: item.refusal,
        purpose: item.entry?.purpose || (typeof item.scenario.description === 'string' ? item.scenario.description : ''), forms: [],
      });
    }
    tests.get(item.testKey).forms.push(item.form);
  }
  for (const test of tests.values()) {
    test.result = test.refusal ? refusalResult(test.forms) : (combine(test.forms.map((f) => (f.result === 'not-run' ? null : f.result))) || 'not-run');
  }
  return [...tests.values()];
}

// What every run proves of each capability, by capability: [{ code, result }].
function sideEvidenceOf(items) {
  const out = new Map();
  for (const item of items) {
    for (const [capability, result] of Object.entries(item.evidence?.proven || {})) {
      if (!out.has(capability)) out.set(capability, []);
      out.get(capability).push({ code: item.scenario.code, result });
    }
  }
  return out;
}

function capabilityRow(def, tests, side, { declaration, points }) {
  const formResults = tests.flatMap((t) => t.forms.map((f) => (f.result === 'not-run' ? null : f.result)));
  let result = combine([...formResults, ...side.map((s) => s.result)]) || 'not-tested';
  if (declaration === 'not-declared' || declaration === 'declared-not-supported') result = 'out-of-scope';
  const proven = side.filter((s) => WENT_THROUGH.has(s.result)).map((s) => s.code);
  return {
    id: def.id, group: def.group, label: def.label, optional: Boolean(def.optional), result, declaration,
    tests: tests.map(({ key, entry, purpose, result: r, forms }) => ({ key, entry, purpose, result: r, forms })),
    provenBy: { count: proven.length, codes: proven.slice(0, MAX_PROVEN_CODES) },
    sideProblems: side.filter((s) => !WENT_THROUGH.has(s.result)),
    points,
  };
}

const COUNTED = new Set(['passed', 'deviation', 'points', 'blocked', 'not-supported']);
const numbersOf = (points) => points.map((p) => p.number);

function summaryOf({ capabilities, expectedRefusals, notTested, apart, points, truncated }) {
  const count = (r) => capabilities.filter((c) => c.result === r).length;
  const kinds = (k) => points.filter((p) => p.kind === k).length;
  return {
    tested: capabilities.filter((c) => COUNTED.has(c.result)).length,
    passed: count('passed'), deviation: count('deviation'), points: count('points'), blocked: count('blocked'),
    notSupported: count('not-supported'), notTested: count('not-tested'), outOfScope: count('out-of-scope'),
    expectedRefusals: {
      total: expectedRefusals.length, refused: expectedRefusals.filter((r) => r.result === 'refused').length,
      deviation: expectedRefusals.filter((r) => r.result === 'deviation').length,
      notRefused: expectedRefusals.filter((r) => r.result === 'not-refused').length, notRun: expectedRefusals.filter((r) => r.result === 'not-run').length,
    },
    pointsToLookAt: {
      total: points.length, provider: kinds('provider'), accepted: kinds('accepted'), unsupported: kinds('unsupported'), questions: kinds('question'),
      oscar: kinds('oscar'),
      truncated,
    },
    declaredWithoutScenario: notTested.length, apart: apart.length,
  };
}

/**
 * The coverage by capability.
 *   framework, datafile   as coverageOf() (the data file as the reader sees it)
 *   catalogue             the catalogue's entries
 *   runs                  { code: latest finished run } with `steps` (its
 *                         run_requests: request_name, http_status) and
 *                         `checks` (its failed checks: request_name,
 *                         assertion_name, category, severity, http_status,
 *                         problem_code), in run order
 *   warnings              { code: [the latest run's [WARNING] lines] }, for
 *                         the known deviations it applied
 *   findings              the company's findings, resolved ones included
 *   suggestions           the #735 drafts: { accepted: { key: findingId },
 *                         oscarIssues: [key] }
 *   functions             coverageOf()'s functions, for the declared ones
 *                         without a scenario
 * -> { capabilities, expectedRefusals, points, apart, notTested, summary }
 */
function capabilityCoverageOf({
  framework, datafile, catalogue = [], runs = {}, warnings = {}, findings = [], suggestions = {}, functions = [], collectionVersion = null,
}) {
  const fw = frameworkOf(framework);
  const declaredIds = new Set(declaredFunctions(fw).map((f) => f.id));
  const { items, apart } = scenarioItems({ datafile, catalogue: arr(catalogue), runs: runs || {}, runList: runListOf(datafile) });
  for (const item of items) item.deviations = item.run ? P.knownDeviationsOf(warnings?.[item.scenario.code]) : [];
  const links = P.linkFailures(failuresOf(items), { findings, suggestions });
  const { points, truncated, accepted, unsupported, oscar } = P.pointsOf(seenOf(items), {
    links, findings, capabilities: K.CAPABILITIES.map((c) => c.id), label: (id) => K.CAPABILITY.get(id)?.label || id,
  });
  withEvidence(items, { accepted, unsupported, oscar, collectionVersion });
  const tests = testsOf(items);
  const side = sideEvidenceOf(items);
  const capabilities = [];
  for (const def of K.CAPABILITIES) {
    const own = tests.filter((t) => !t.refusal && t.capability === def.id);
    const evidence = side.get(def.id) || [];
    const declaration = capabilityDeclaration(def.id, fw, declaredIds);
    if (own.length === 0 && evidence.length === 0 && declaration !== 'declared') continue;
    const rowPoints = numbersOf(points.filter((p) => p.capability === def.id && !p.expectedRefusal));
    capabilities.push(capabilityRow(def, own, evidence, { declaration, points: rowPoints }));
  }
  const expectedRefusals = tests.filter((t) => t.refusal).map(({ key, entry, purpose, capability, result, forms }) => ({
    key, entry, purpose, capability, capabilityLabel: K.CAPABILITY.get(capability)?.label || capability, result, forms,
    points: numbersOf(points.filter((p) => p.expectedRefusal && p.tests.some((t) => t.key === key))),
  }));
  const notTested = arr(functions).filter((f) => f.state === 'not-covered' || f.state === 'never-run')
    .map((f) => ({ id: f.id, group: f.group, label: f.label, state: f.state }));
  return {
    capabilities, expectedRefusals, points, apart, notTested,
    summary: summaryOf({ capabilities, expectedRefusals, notTested, apart, points, truncated }),
  };
}

module.exports = {
  capabilityCoverageOf, runEvidence, stepsOf, combine, capabilityDeclaration, RESULT_TEXT, CAPABILITY_FUNCTIONS,
};
