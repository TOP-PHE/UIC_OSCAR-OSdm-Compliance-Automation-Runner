// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * checkTrends.js — a company's checks across its latest finished runs (#1295):
 * the checks that fail most, and the last results of one check.
 *
 * Both start from the runs: the company's latest finished runs the person may
 * read, RUNS_READ at most, then those runs' checks by run
 * (idx_run_assertions_run_passed), a few runs at a time, the thread given back
 * between two slices. What an answer reads is bounded, whatever the company
 * has stored.
 *
 * Until 1.11.537 both read the company's checks by key, through an index of
 * their own (company_id, assertion_key). The summary walked every check the
 * company ever stored, and that index, sorted by the text of the check, cost
 * each stored run several hundred pages: it is gone.
 */

const { all } = require('../../db/db');
const { runScopeSql } = require('./run-access');

// The most finished runs one answer reads, and how many are read together.
const RUNS_READ = 500;
const RUNS_PER_SLICE = 10;
// The summary's period.
const SUMMARY_DAYS = 30;
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

/** A whole number from 1 to `max`, else `fallback`: a limit read from a query. */
function limitOf(value, fallback, max) {
  const asked = Number.parseInt(value, 10);
  if (!Number.isInteger(asked) || asked < 1) return fallback;
  return Math.min(asked, max);
}

/**
 * The company's latest finished runs the person may read, newest first, at
 * most RUNS_READ; `more` when the company has others, older, that are not
 * read. With `days`, only the runs queued in that many last days.
 */
function latestFinishedRuns(companyId, user, { days } = {}) {
  const scope = runScopeSql(user, 'r');
  const period = days ? " AND r.queued_at >= datetime('now', ?)" : '';
  const rows = all(`
    SELECT r.id, r.scenario_code, r.completed_at
    FROM runs r
    WHERE r.company_id = ? AND r.status IN ('COMPLETED', 'FAILED')${period}
      ${scope.sql}
    ORDER BY r.queued_at DESC, r.id DESC
    LIMIT ?
  `, [companyId, ...(days ? [`-${days} days`] : []), ...scope.params, RUNS_READ + 1]);
  return { runs: rows.slice(0, RUNS_READ), more: rows.length > RUNS_READ };
}

const idsOf = (runs) => JSON.stringify(runs.map((run) => run.id));

// One slice of the summary: the checks of a few runs, counted by key.
const COUNTS_BY_KEY = `
  SELECT ra.assertion_key, ra.assertion_name, ra.category, ra.domain, ra.severity,
         COUNT(*) AS checks,
         SUM(CASE WHEN ra.passed = 0 THEN 1 ELSE 0 END) AS failed,
         SUM(ra.passed) AS passed
  FROM run_assertions ra
  WHERE ra.run_id IN (SELECT value FROM json_each(?))
  GROUP BY ra.assertion_key`;

// One slice of a check's history: its results in a few runs.
const RESULTS_OF_KEY = `
  SELECT ra.run_id, ra.passed, ra.error_msg, ra.category, ra.severity
  FROM run_assertions ra
  WHERE ra.run_id IN (SELECT value FROM json_each(?)) AND ra.assertion_key = ?
  ORDER BY ra.id`;

function addCounts(byKey, row) {
  const seen = byKey.get(row.assertion_key);
  if (seen) {
    seen.run_count += row.checks;
    seen.fail_count += row.failed;
    seen.passed += row.passed;
    return;
  }
  // The name, category, domain and severity are those of the newest runs.
  byKey.set(row.assertion_key, {
    assertion_key: row.assertion_key,
    assertion_name: row.assertion_name,
    category: row.category,
    domain: row.domain,
    severity: row.severity,
    run_count: row.checks,
    fail_count: row.failed,
    passed: row.passed,
  });
}

// Most failures first, then the lowest pass rate, then the key: one order
// whatever the order the rows were read in.
function byFailures(a, b) {
  return b.fail_count - a.fail_count || a.pass_rate - b.pass_rate
    || a.assertion_key.localeCompare(b.assertion_key);
}

/**
 * The checks that failed most in the company's finished runs of the last 30
 * days, among the latest RUNS_READ of them.
 * @returns {Promise<{ top_failures: object[], runs_read: number, more_runs: boolean }>}
 */
async function topFailures(companyId, user, limit) {
  const { runs, more } = latestFinishedRuns(companyId, user, { days: SUMMARY_DAYS });
  const byKey = new Map();
  for (let i = 0; i < runs.length; i += RUNS_PER_SLICE) {
    if (i > 0) await nextTurn();
    for (const row of all(COUNTS_BY_KEY, [idsOf(runs.slice(i, i + RUNS_PER_SLICE))])) addCounts(byKey, row);
  }
  const failing = [];
  for (const { passed, ...check } of byKey.values()) {
    if (check.fail_count > 0) failing.push({ ...check, pass_rate: Math.round(1000 * passed / check.run_count) / 10 });
  }
  failing.sort(byFailures);
  return { top_failures: failing.slice(0, limit), runs_read: runs.length, more_runs: more };
}

/**
 * The last results of one check, newest run first, read from the company's
 * latest RUNS_READ finished runs: it stops at `limit` results.
 * @returns {Promise<{ points: object[], runs_read: number, more_runs: boolean }>}
 */
async function resultsOfCheck(companyId, user, assertionKey, limit) {
  const { runs, more } = latestFinishedRuns(companyId, user);
  const points = [];
  let read = 0;
  while (read < runs.length && points.length < limit) {
    if (read > 0) await nextTurn();
    const slice = runs.slice(read, read + RUNS_PER_SLICE);
    read += slice.length;
    const byRun = new Map();
    for (const row of all(RESULTS_OF_KEY, [idsOf(slice), assertionKey])) {
      if (!byRun.has(row.run_id)) byRun.set(row.run_id, []);
      byRun.get(row.run_id).push(row);
    }
    for (const run of slice) {
      for (const row of byRun.get(run.id) || []) {
        points.push({
          run_id: run.id,
          passed: !!row.passed,
          error: row.error_msg,
          category: row.category,
          severity: row.severity,
          scenario_code: run.scenario_code,
          completed_at: run.completed_at,
        });
      }
    }
  }
  return { points: points.slice(0, limit), runs_read: read, more_runs: more || read < runs.length };
}

module.exports = {
  topFailures, resultsOfCheck, latestFinishedRuns, limitOf,
  RUNS_READ, RUNS_PER_SLICE, SUMMARY_DAYS, COUNTS_BY_KEY, RESULTS_OF_KEY,
};
