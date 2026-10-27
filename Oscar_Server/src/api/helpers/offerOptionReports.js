// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * offerOptionReports.js — the offer request options report of each run that
 * ran the discovery (#227 part 3), read back from its log: the runner files
 * those lines under category 'offer_options'. Read by the Report Builder's
 * configured report and by the coverage by capability (#995).
 */

const { all, colDecrypt } = require('../../db/db');
const { reportOf, countsOf } = require('../../utils/offerOptionReport');

/** [{ run_id, scenario_code, counts, report }] of the runs that hold a report. */
function offerOptionReportsOf(runIds) {
  const ids = Array.isArray(runIds) ? runIds : [];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const optionRows = all(
    `SELECT run_id, message FROM run_events
     WHERE run_id IN (${placeholders}) AND category = 'offer_options'
     ORDER BY id ASC LIMIT 5000`,
    [...ids]
  );
  const linesByRun = new Map();
  for (const row of optionRows) {
    if (!linesByRun.has(row.run_id)) linesByRun.set(row.run_id, []);
    linesByRun.get(row.run_id).push(colDecrypt(row.message));
  }
  if (linesByRun.size === 0) return [];
  const scenarioOf = new Map(all(`SELECT id, scenario_code FROM runs WHERE id IN (${placeholders})`, [...ids]).map(r => [r.id, r.scenario_code]));
  const reports = [];
  for (const [runId, lines] of linesByRun) {
    const report = reportOf(lines);
    if (report) reports.push({ run_id: runId, scenario_code: scenarioOf.get(runId) || null, counts: countsOf(report), report });
  }
  return reports;
}

module.exports = { offerOptionReportsOf };
