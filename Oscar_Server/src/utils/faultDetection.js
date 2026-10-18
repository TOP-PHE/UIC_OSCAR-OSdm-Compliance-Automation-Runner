// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * faultDetection.js — did OSCAR, and the AI analysis, see the faults the
 * OSDM simulator was asked to make (#833 PR D)? Pure.
 *
 * A scenario names its faults in `simulatorFaults`; the simulator's catalogue
 * (`simulator-faults.json`, generated from OSDM_Simulator/src/osdm/faults.js)
 * says for each what OSCAR must report: a step, a stable part of the check's
 * text, FAIL or WARNING. A fault is **detected** when a run of its scenario
 * reported at least one of them, **as expected** when it reported all.
 *
 * The AI analysis is read on the faults OSCAR failed (a WARNING never reaches
 * it: the analysis is sent failed checks only). A fault is **explained** when
 * a group the model made names its scenario (or names no scenario) and an
 * expected step, with the provider as owner; a group that covers it with
 * another owner is **misattributed**; none is **missed**. The cause's wording
 * is not judged: owner, step and scenario are what can be compared without a
 * model.
 */

const CATALOGUE = require('./simulator-faults.json');
const { stepKey } = require('./findingSuggestions');

const lower = (s) => String(s == null ? '' : s).toLowerCase();
const list = (v) => (Array.isArray(v) ? v : []);

/** The faults a scenario asks for: its `simulatorFaults`, a list or "a, b". */
function faultsOfScenario(scenario) {
  const raw = scenario?.simulatorFaults;
  const codes = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\s,]+/);
  return [...new Set(codes.map((c) => String(c).trim()).filter(Boolean))];
}

const sameStep = (expected, step) => expected === '*' || stepKey(expected) === stepKey(step);

// The reports of one run that meet one expectation.
function matchesOf(expect, failures, warnings) {
  const check = lower(expect.check);
  const failed = failures
    .filter((f) => sameStep(expect.step, f.step) && lower(f.check).includes(check))
    .map((f) => ({ step: f.step, check: f.check, level: 'FAIL' }));
  if (expect.level === 'FAIL') return failed;
  // A WARNING is a run log line, which names no step; a failure meets it too.
  const warned = warnings.filter((w) => lower(w).includes(check)).map((w) => ({ step: null, check: w, level: 'WARNING' }));
  return [...failed, ...warned];
}

/**
 * The detection report of a batch.
 *   runs:      [{ runId, scenarioCode }]
 *   scenarios: the data file's scenarios (for their simulatorFaults)
 *   failures:  [{ runId, step, check }] (failed checks)
 *   warnings:  [{ runId, message }] (run log lines holding [WARNING])
 * Returns { faults: [...], summary } — one entry per (run, fault code).
 */
function detect({ runs, scenarios, failures, warnings, catalogue = CATALOGUE }) {
  const byCode = new Map(list(catalogue).map((f) => [f.code, f]));
  const scenarioByCode = new Map(list(scenarios).filter((s) => s && typeof s.code === 'string').map((s) => [s.code, s]));
  const faults = [];
  for (const run of list(runs)) {
    const codes = faultsOfScenario(scenarioByCode.get(run.scenarioCode));
    if (!codes.length) continue;
    const runFailures = list(failures).filter((f) => f.runId === run.runId);
    const runWarnings = list(warnings).filter((w) => w.runId === run.runId).map((w) => w.message);
    for (const code of codes) {
      const fault = byCode.get(code);
      if (!fault) {
        faults.push({ runId: run.runId, scenarioCode: run.scenarioCode, code, title: null, known: false, expectations: [], detected: false, asExpected: false });
        continue;
      }
      const expectations = fault.expect.map((e) => ({ ...e, found: matchesOf(e, runFailures, runWarnings) }));
      const met = expectations.filter((e) => e.found.length > 0).length;
      faults.push({
        runId: run.runId, scenarioCode: run.scenarioCode, code, title: fault.title, feature: fault.feature, known: true,
        expectations, detected: met > 0, asExpected: met === expectations.length,
        failedChecks: runFailures.length,
      });
    }
  }
  const known = faults.filter((f) => f.known);
  return {
    faults,
    summary: {
      injected: faults.length,
      unknown: faults.length - known.length,
      detected: known.filter((f) => f.detected).length,
      asExpected: known.filter((f) => f.asExpected).length,
    },
  };
}

// The steps a fault was failed at, as OSCAR reported them.
const failedSteps = (fault) => fault.expectations.flatMap((e) => e.found.filter((m) => m.level === 'FAIL').map((m) => m.step));

/**
 * The AI analysis read against a detection report: for each fault OSCAR
 * failed, explained / misattributed / missed, and the group that says it.
 * `result` is a stored analysis result ({ groups: [{ title, owner, steps, scenarios }] }).
 */
function scoreAnalysis(report, result) {
  const groups = list(result?.groups);
  const judged = report.faults.filter((f) => f.known && failedSteps(f).length > 0).map((fault) => {
    const steps = failedSteps(fault);
    const covering = groups
      .map((g, index) => ({ g, index }))
      .filter(({ g }) => {
        const names = list(g.scenarios);
        const sameScenario = names.length === 0 || names.some((n) => lower(n).includes(lower(fault.scenarioCode)));
        return sameScenario && list(g.steps).some((s) => steps.some((st) => sameStep(st, s)));
      });
    const right = covering.find(({ g }) => g.owner === 'provider');
    const any = right || covering[0];
    let verdict = 'missed';
    if (right) verdict = 'explained';
    else if (any) verdict = 'misattributed';
    return {
      runId: fault.runId, scenarioCode: fault.scenarioCode, code: fault.code, verdict,
      group: any ? { index: any.index, title: any.g.title, owner: any.g.owner } : null,
    };
  });
  const count = (v) => judged.filter((j) => j.verdict === v).length;
  return {
    judged,
    summary: {
      judged: judged.length, explained: count('explained'), misattributed: count('misattributed'), missed: count('missed'),
      score: judged.length ? Math.round((count('explained') / judged.length) * 100) / 100 : null,
    },
  };
}

module.exports = { CATALOGUE, faultsOfScenario, detect, scoreAnalysis };
