// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * runCandidates.js — what a launch chooses from (#1029): the scenarios of the
 * data file with their facets (utils/runFilters.js), read for one company or
 * provider.
 */

const { all } = require('../../db/db');
const { latestRunsOf } = require('../../utils/frameworkCoverage');
const { currentCollectionVersion } = require('../../utils/versionInfo');
const RF = require('../../utils/runFilters');
const { runScopeSql } = require('./run-access');

// #1246: the latest finished run of each scenario asked, one seek of
// idx_runs_company_scenario per code (the codes are passed as one JSON list),
// in the order the runs list uses: queued first, then id. Until 1.11.515 the
// company's newest 20,000 finished runs were read to keep the first of each
// code, at every preview of the Run page and every launch. INDEXED BY: left
// to itself, the planner walks idx_runs_company_queued, which gives the order
// but not the code, through every run of the company for a code never run.
function latestRunsSql(scopeSql) {
  return `SELECT c.value AS scenario_code, r.id, r.status, r.collection_version, r.scenario_hash
            FROM json_each(?) AS c
            JOIN runs AS r ON r.id = (
              SELECT x.id FROM runs AS x INDEXED BY idx_runs_company_scenario
               WHERE x.company_id = ? AND x.scenario_code = c.value
                 AND x.status IN ('COMPLETED', 'FAILED')${scopeSql}
               ORDER BY x.queued_at DESC, x.id DESC
               LIMIT 1)`;
}

// #1246: the failed checks of a finished run never change (the runner stores
// them before it writes the run's final status, and nothing else writes
// run_assertions), so they are counted once per run and kept.
const MAX_KEPT_COUNTS = 50000;
const failedByRun = new Map();

// #1256: both reads go in slices, the thread free between them. After a
// restart, the first preview or launch of a company counted up to 500 runs in
// one statement: 1.1 to 1.6 s of disk reads on the k3s test machine, during
// which the server answered nothing. The total is the same; each slice is
// short, and other requests are answered between two.
const RUNS_PER_SLICE = 50;
const CODES_PER_SLICE = 100;
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

async function failedChecksOf(ids) {
  // This call's own counts: another request may evict the kept ones while
  // this one waits between two slices.
  const counts = new Map();
  for (const id of ids) {
    if (failedByRun.has(id)) counts.set(id, failedByRun.get(id));
  }
  const missing = [...new Set(ids.filter((id) => !counts.has(id)))];
  for (let i = 0; i < missing.length; i += RUNS_PER_SLICE) {
    if (i > 0) await nextTurn();
    const chunk = missing.slice(i, i + RUNS_PER_SLICE);
    const marks = chunk.map(() => '?').join(',');
    const counted = new Map();
    for (const c of all(`SELECT run_id, SUM(CASE WHEN passed = 1 THEN 0 ELSE 1 END) AS failed
                           FROM run_assertions WHERE run_id IN (${marks}) GROUP BY run_id`, chunk)) {
      counted.set(c.run_id, Number(c.failed) || 0);
    }
    for (const id of chunk) {
      const failed = counted.get(id) || 0;
      counts.set(id, failed);
      failedByRun.set(id, failed);
    }
  }
  while (failedByRun.size > MAX_KEPT_COUNTS) failedByRun.delete(failedByRun.keys().next().value);
  return counts;
}

async function latestRunsOfCodes(companyId, user, asked) {
  // Among the runs `user` may read: a tester's own (1.11.477).
  const scope = runScopeSql(user, 'x');
  const rows = [];
  for (let i = 0; i < asked.length; i += CODES_PER_SLICE) {
    if (i > 0) await nextTurn();
    rows.push(...all(latestRunsSql(scope.sql), [JSON.stringify(asked.slice(i, i + CODES_PER_SLICE)), companyId, ...scope.params]));
  }
  return latestRunsOf(rows);
}

/**
 * The latest finished run of each of `codes` in the company, with the number
 * of its failed checks: { code: { status, failed, collection_version,
 * scenario_hash } }. A code is looked up as text, as an object key reads it.
 */
async function latestRunStates(companyId, user, codes) {
  const asked = [...new Set((Array.isArray(codes) ? codes : []).map(String))];
  if (asked.length === 0) return {};
  const latest = await latestRunsOfCodes(companyId, user, asked);
  const failed = await failedChecksOf(Object.values(latest).map((r) => r.id));
  const out = {};
  for (const [code, run] of Object.entries(latest)) {
    out[code] = { status: run.status, failed: failed.get(run.id), collection_version: run.collection_version, scenario_hash: run.scenario_hash };
  }
  return out;
}

/** The facets of `codes` in the data file, for the company's runs. */
async function facetsFor(companyId, datafile, codes, user) {
  let entries = [];
  try {
    // The catalogue alone, kept while its file is the same (#1236).
    entries = require('./catalogueSource').catalogueEntries();
  } catch {
    // Without the catalogue, a scenario's capability is derived from its fields.
  }
  return RF.facetsOf(codes, { datafile, entries, runs: await latestRunStates(companyId, user, codes), collectionVersion: currentCollectionVersion() });
}

module.exports = { latestRunStates, facetsFor, latestRunsSql, MAX_KEPT_COUNTS, RUNS_PER_SLICE, CODES_PER_SLICE };
