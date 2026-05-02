// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * diff.js — Report comparison / diff engine
 *
 * Implements the Section 5.5 comparison model from the architecture document.
 *
 * Input:  two run IDs (must belong to same company)
 * Source: .bru_results.json stored in data/artifacts/{runId}/
 * Output: structured diff with five categories:
 *   FAILED_TO_PASSED  — was failing in A, now passing in B (regression fixed)
 *   PASSED_TO_FAILED  — was passing in A, now failing in B (regression introduced)
 *   ADDED             — scenario/assertion exists in B but not in A
 *   REMOVED           — scenario/assertion exists in A but not in B
 *   UNCHANGED_PASS    — same result (pass) in both
 *   UNCHANGED_FAIL    — same result (fail) in both
 */

const fs   = require('fs');
const path = require('path');

const ARTIFACTS_DIR = path.resolve(__dirname, '../../data/artifacts');

// ── Parse .bru_results.json into a flat map of assertion outcomes ─────────────
// Key format: "{suiteName}|{requestName}|{assertionName}"
// Value: { passed: bool, error: string|null }
function parseResults(runId) {
  const jsonPath = path.join(ARTIFACTS_DIR, runId, '.bru_results.json');
  if (!fs.existsSync(jsonPath)) return null;

  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

  // Handle Bruno CLI v1 / v2 output format variations
  const results = Array.isArray(raw)             ? raw
                : Array.isArray(raw.results)     ? raw.results
                : Array.isArray(raw.testResults) ? raw.testResults
                : [];

  const map = {};

  results.forEach(entry => {
    const suite = (entry.suiteName || '').trim();
    const file  = (entry.filename  || '').replace(/\.yml$|\.bru$/i, '').trim();
    const reqKey = `${suite}|${file}`;

    // Skip auth/token requests
    const url  = ((entry.request && entry.request.url) || '').toLowerCase();
    const name = reqKey.toLowerCase();
    if (/\/(token|login|auth|logon|oauth)/.test(url) || /access.?token/i.test(name)) return;

    // Collect test() results
    const tests = entry.tests || entry.testResults || [];
    tests.forEach(t => {
      const key = `${reqKey}|${(t.name || t.description || '').trim()}`;
      map[key] = {
        passed: t.status === 'passed' || t.passed === true,
        error:  t.error || t.message || null,
        type:   'test'
      };
    });

    // Collect assertion results
    const assertions = entry.assertions || [];
    assertions.forEach(a => {
      const label = a.name || `${a.lhsExpr} ${a.rhsExpr}` || 'assertion';
      const key   = `${reqKey}|${label.trim()}`;
      map[key] = {
        passed: a.status === 'passed' || a.passed === true,
        error:  a.error || null,
        type:   'assertion'
      };
    });
  });

  return map;
}

// ── Compute diff ──────────────────────────────────────────────────────────────
function computeDiff(mapA, mapB) {
  const allKeys = new Set([...Object.keys(mapA), ...Object.keys(mapB)]);
  const diff = {
    summary: {
      failed_to_passed:  0,
      passed_to_failed:  0,
      added:             0,
      removed:           0,
      unchanged_pass:    0,
      unchanged_fail:    0,
      total:             0
    },
    items: []
  };

  allKeys.forEach(key => {
    const inA = mapA[key];
    const inB = mapB[key];
    const [suite, request, assertion] = key.split('|');

    let category;
    if (!inA && inB) {
      category = 'ADDED';
      diff.summary.added++;
    } else if (inA && !inB) {
      category = 'REMOVED';
      diff.summary.removed++;
    } else if (!inA.passed && inB.passed) {
      category = 'FAILED_TO_PASSED';
      diff.summary.failed_to_passed++;
    } else if (inA.passed && !inB.passed) {
      category = 'PASSED_TO_FAILED';
      diff.summary.passed_to_failed++;
    } else if (inA.passed && inB.passed) {
      category = 'UNCHANGED_PASS';
      diff.summary.unchanged_pass++;
    } else {
      category = 'UNCHANGED_FAIL';
      diff.summary.unchanged_fail++;
    }

    diff.summary.total++;
    diff.items.push({
      key,
      suite,
      request,
      assertion,
      category,
      run_a: inA ? { passed: inA.passed, error: inA.error } : null,
      run_b: inB ? { passed: inB.passed, error: inB.error } : null
    });
  });

  // Sort: regressions first, then fixes, then added/removed, then unchanged
  const ORDER = {
    PASSED_TO_FAILED: 0,
    FAILED_TO_PASSED: 1,
    ADDED:            2,
    REMOVED:          3,
    UNCHANGED_FAIL:   4,
    UNCHANGED_PASS:   5
  };
  diff.items.sort((a, b) => (ORDER[a.category] ?? 9) - (ORDER[b.category] ?? 9));

  return diff;
}

// ── Public: compare two runs ──────────────────────────────────────────────────
function compareRuns(runIdA, runIdB) {
  const mapA = parseResults(runIdA);
  const mapB = parseResults(runIdB);

  if (!mapA) throw new Error(`No results found for run A (${runIdA}). Run must be COMPLETED.`);
  if (!mapB) throw new Error(`No results found for run B (${runIdB}). Run must be COMPLETED.`);

  return computeDiff(mapA, mapB);
}

module.exports = { compareRuns };
