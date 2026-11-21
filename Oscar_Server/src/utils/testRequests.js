// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * testRequests.js — the rules of a test request (#1342 PR 3): what a Company
 * API account may ask, and what each run and the whole request read as.
 *
 * A test request is one call of POST /v1/api/test-requests: one batch per
 * provider it names, of the scenarios it names (`scenarios`), that a
 * selection keeps (`selection`, the Run page's object, utils/runFilters.js)
 * or that a named suite holds (`suite`, utils/testSuites.js, PR 4).
 *
 * Pure: no database, no clock.
 */

const crypto = require('node:crypto');
const RF = require('./runFilters');

const MAX_PROVIDERS = 20;
const MAX_SCENARIOS = 500;
const MAX_REFERENCE = 100;
const MAX_WAIT_S = 60;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// What a run that ended without a result was stopped by (runner.js sentinels).
const NOT_A_RESULT = new Set(['NO_CHECKS', 'RUN_PROCESS_ERROR', 'RUN_NOT_FINISHED']);

function printable(text) {
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return true;
}

/**
 * A request's body, checked: { providers, scenarios | selection, reference }
 * or { error }. Exactly one of `scenarios` and `selection`.
 */
function requestOf(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const providers = b.providers;
  if (!Array.isArray(providers) || providers.length === 0 || providers.length > MAX_PROVIDERS
      || providers.some(p => typeof p !== 'string' || !UUID.test(p))) {
    return { error: `providers must be a list of 1 to ${MAX_PROVIDERS} company or provider ids.` };
  }
  const has = ['scenarios', 'selection', 'suite'].filter(k => b[k] !== undefined);
  if (has.length !== 1) return { error: 'Send exactly one of scenarios (a list of codes), selection (as the Run page makes it) and suite (the name of a suite).' };
  const out = { providers: [...new Set(providers)], reference: null };
  if (b.reference !== undefined && b.reference !== null) {
    if (typeof b.reference !== 'string' || b.reference.length > MAX_REFERENCE || !printable(b.reference)) {
      return { error: `reference must be a text of at most ${MAX_REFERENCE} characters.` };
    }
    out.reference = b.reference;
  }
  if (b.suite !== undefined) {
    if (typeof b.suite !== 'string' || b.suite.trim() === '' || b.suite.length > 60) return { error: 'suite must be the name of a suite of your company.' };
    out.suite = b.suite.trim();
    return out;
  }
  if (b.scenarios !== undefined) {
    const codes = b.scenarios;
    if (!Array.isArray(codes) || codes.length === 0 || codes.length > MAX_SCENARIOS
        || codes.some(c => typeof c !== 'string' || c === '' || c.length > 200)) {
      return { error: `scenarios must be a list of 1 to ${MAX_SCENARIOS} scenario codes.` };
    }
    out.scenarios = [...new Set(codes)];
    return out;
  }
  const problem = RF.selectionProblem(b.selection);
  if (problem) return { error: problem };
  // Its base is kept (#1353): `list` is each provider's run list at the launch.
  out.selection = RF.withDefaults(b.selection);
  return out;
}

// Text order, by code unit: the same for every locale.
const byText = (a, b) => {
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

/** The same request asked again (Idempotency-Key): a hash of what it asks. */
function hashOf(request) {
  const canonical = JSON.stringify({
    providers: [...request.providers].sort(byText),
    scenarios: request.scenarios ? [...request.scenarios].sort(byText) : null,
    selection: request.selection || null,
    suite: request.suite ? request.suite.toLowerCase() : null,
    reference: request.reference,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/** An Idempotency-Key header: { key } (null when absent), or { error }. */
function idempotencyKeyOf(value) {
  if (value === undefined) return { key: null };
  if (typeof value !== 'string' || value.length < 8 || value.length > 100 || !/^[\w.:-]+$/.test(value)) {
    return { error: 'Idempotency-Key must be 8 to 100 letters, digits or . _ : -' };
  }
  return { key: value };
}

/**
 * What one run reads as: { state, verdict, reason }.
 *   state:   queued | running | finished
 *   verdict: null until finished; passed | passed_with_deviation | failed |
 *            not_a_result | cancelled. passed_with_deviation: no check failed
 *            and the run applied a known deviation (a finding baselined, #398).
 */
function verdictOf(run, failedChecks, totalChecks, deviations = 0) {
  if (run.status === 'QUEUED') return { state: 'queued', verdict: null, reason: null };
  if (run.status === 'RUNNING') return { state: 'running', verdict: null, reason: null };
  if (run.status === 'CANCELLED') return { state: 'finished', verdict: 'cancelled', reason: null };
  if (NOT_A_RESULT.has(run.error_message)) return { state: 'finished', verdict: 'not_a_result', reason: run.error_message };
  if (failedChecks > 0) return { state: 'finished', verdict: 'failed', reason: null };
  if (run.status === 'FAILED' || totalChecks === 0) {
    return { state: 'finished', verdict: 'not_a_result', reason: run.error_message || 'NO_CHECKS' };
  }
  if (deviations > 0) return { state: 'finished', verdict: 'passed_with_deviation', reason: null };
  return { state: 'finished', verdict: 'passed', reason: null };
}

/**
 * The request as a whole: { state, verdict, counts }. Finished when every run
 * is; then failed when any run failed, incomplete when any gave no result or
 * was cancelled, else passed (a known deviation is accepted: it counts as
 * passed_with_deviation, and the request still passes). A pipeline is green
 * on passed only.
 */
function summaryOf(verdicts) {
  const counts = { queued: 0, running: 0, passed: 0, passed_with_deviation: 0, failed: 0, not_a_result: 0, cancelled: 0 };
  for (const v of verdicts) counts[v.verdict || v.state] += 1;
  let state = 'finished';
  if (counts.running > 0) state = 'running';
  else if (counts.queued > 0) state = 'queued';
  if (state !== 'finished') return { state, verdict: null, counts };
  let verdict = 'passed';
  if (counts.failed > 0) verdict = 'failed';
  else if (counts.not_a_result > 0 || counts.cancelled > 0 || verdicts.length === 0) verdict = 'incomplete';
  return { state, verdict, counts };
}

/** The ?wait= of a status read: seconds, 0 when absent, or null when not one. */
function waitOf(value) {
  if (value === undefined || value === '') return 0;
  if (typeof value !== 'string' || !/^\d{1,3}$/.test(value)) return null;
  const n = Number(value);
  return n <= MAX_WAIT_S ? n : null;
}

module.exports = {
  MAX_PROVIDERS, MAX_SCENARIOS, MAX_REFERENCE, MAX_WAIT_S, NOT_A_RESULT,
  requestOf, hashOf, idempotencyKeyOf, verdictOf, summaryOf, waitOf,
};
