// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * simulatedErrors.js — the simulator's deliberate errors, kept apart from the
 * provider's coverage (#1029 PR 2). Pure.
 *
 * A simulated error is a scenario whose category is `simulated`
 * (`runFilters.categoryOf()`): a `SIM_WRONG_` code, which fails on purpose, or
 * a `SIM_FAULT_` code or `simulatorFaults`, which asks the simulator for
 * faults. Their failures say how well OSCAR sees an error, not how the
 * provider conforms: they are left out of every coverage view and of a
 * published report, and listed on their own, each one
 *  - **detected**: a wrong scenario whose latest finished run failed a check;
 *    a fault scenario whose every fault OSCAR reported as its catalogue
 *    expects (`faultDetection.detect()`, the fault detection report's rule);
 *  - **missed**: it ran, and that did not happen;
 *  - **not run**: no finished run.
 */

const { categoryOf } = require('./runFilters');
const { faultsOfScenario, detect } = require('./faultDetection');

const arr = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const RESULTS = Object.freeze(['detected', 'missed', 'not-run']);
const RESULT_TEXT = Object.freeze({ detected: 'Detected', missed: 'Missed', 'not-run': 'Not run' });
const KIND_TEXT = Object.freeze({ wrong: 'Wrong answer', fault: 'Fault' });

/**
 * A data file without its simulated errors, and those scenarios:
 * { datafile, simulated }. The run list loses them too.
 */
function splitSimulated(datafile) {
  const scenarios = arr(datafile?.scenarios);
  const simulated = scenarios.filter((s) => isObj(s) && categoryOf(s) === 'simulated');
  if (simulated.length === 0) return { datafile, simulated };
  const codes = new Set(simulated.map((s) => s.code));
  const out = { ...datafile, scenarios: scenarios.filter((s) => !simulated.includes(s)) };
  if (Array.isArray(datafile.scenariosToRun)) out.scenariosToRun = datafile.scenariosToRun.filter((c) => !codes.has(c));
  return { datafile: out, simulated };
}

const firstFailure = (run) => {
  const check = arr(run?.checks).find(isObj);
  return check ? { step: check.request_name || null, check: String(check.assertion_name ?? '').slice(0, 300) } : { step: null, check: null };
};

// A wrong-answer scenario: detected when a check failed.
function wrongEntry(scenario, run) {
  const failed = Number(run.failed) > 0 || arr(run.checks).length > 0;
  return { result: failed ? 'detected' : 'missed', ...(failed ? firstFailure(run) : { step: null, check: 'The run passed every check: OSCAR did not see the error.' }) };
}

// A fault scenario: detected when every fault was reported as expected.
function faultEntry(scenario, run, warnings) {
  const report = detect({
    runs: [{ runId: run.id, scenarioCode: scenario.code }], scenarios: [scenario],
    failures: arr(run.checks).filter(isObj).map((c) => ({ runId: run.id, step: c.request_name, check: c.assertion_name })),
    warnings: arr(warnings).map((message) => ({ runId: run.id, message })),
  });
  const faults = report.faults.map((f) => ({ code: f.code, title: f.title, known: f.known, detected: f.detected }));
  const missed = faults.filter((f) => !f.detected);
  return {
    result: faults.length > 0 && missed.length === 0 ? 'detected' : 'missed',
    faults,
    step: null,
    check: missed.length === 0 ? null : `Not reported: ${missed.map((f) => f.code).join(', ')}`,
  };
}

/**
 * The simulated errors of a coverage report: { summary, entries }. `runs`
 * maps a code to its latest finished run (with `checks`, its failed checks),
 * `warnings` a code to its run's [WARNING] lines.
 */
function simulatedErrorsOf(simulated, runs = {}, warnings = {}) {
  const entries = arr(simulated).filter(isObj).map((scenario) => {
    const faults = faultsOfScenario(scenario);
    const kind = faults.length > 0 ? 'fault' : 'wrong';
    const run = runs?.[scenario.code];
    const base = { code: scenario.code, kind, description: typeof scenario.description === 'string' ? scenario.description : '' };
    if (!isObj(run)) return { ...base, result: 'not-run', faults: faults.map((code) => ({ code })), step: null, check: null, runId: null, at: null };
    const seen = kind === 'fault' ? faultEntry(scenario, run, warnings?.[scenario.code]) : { ...wrongEntry(scenario, run), faults: [] };
    return { ...base, ...seen, runId: run.id ?? null, at: run.completed_at || run.queued_at || null };
  });
  const count = (r) => entries.filter((e) => e.result === r).length;
  return { summary: { total: entries.length, detected: count('detected'), missed: count('missed'), notRun: count('not-run') }, entries };
}

module.exports = { RESULTS, RESULT_TEXT, KIND_TEXT, splitSimulated, simulatedErrorsOf };
