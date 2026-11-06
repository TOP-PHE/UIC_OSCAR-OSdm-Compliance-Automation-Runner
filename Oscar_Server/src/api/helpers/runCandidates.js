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

// The runs read for "last run": the newest of the company, whatever their age.
const MAX_RUNS = 20000;

/**
 * The latest finished run of each scenario code of the company, with the
 * number of its failed checks: { code: { status, failed, collection_version,
 * scenario_hash } }.
 */
function latestRunStates(companyId, user) {
  // Among the runs `user` may read: a tester's own (1.11.477).
  const scope = runScopeSql(user, '');
  const rows = all(
    `SELECT id, scenario_code, status, collection_version, scenario_hash
       FROM runs
      WHERE company_id = ? AND scenario_code IS NOT NULL AND status IN ('COMPLETED', 'FAILED')${scope.sql}
      ORDER BY queued_at DESC, id DESC
      LIMIT ${MAX_RUNS}`,
    [companyId, ...scope.params]
  );
  const latest = latestRunsOf(rows);
  const ids = Object.values(latest).map((r) => r.id);
  const failed = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const marks = chunk.map(() => '?').join(',');
    for (const c of all(`SELECT run_id, SUM(CASE WHEN passed = 1 THEN 0 ELSE 1 END) AS failed
                           FROM run_assertions WHERE run_id IN (${marks}) GROUP BY run_id`, chunk)) {
      failed.set(c.run_id, Number(c.failed) || 0);
    }
  }
  const out = {};
  for (const [code, run] of Object.entries(latest)) {
    out[code] = { status: run.status, failed: failed.get(run.id) || 0, collection_version: run.collection_version, scenario_hash: run.scenario_hash };
  }
  return out;
}

/** The facets of `codes` in the data file, for the company's runs. */
function facetsFor(companyId, datafile, codes, user) {
  let entries = [];
  try {
    entries = require('./catalogueSource').readCatalogue().catalogue?.entries || [];
  } catch {
    // Without the catalogue, a scenario's capability is derived from its fields.
  }
  return RF.facetsOf(codes, { datafile, entries, runs: latestRunStates(companyId, user), collectionVersion: currentCollectionVersion() });
}

module.exports = { latestRunStates, facetsFor };
