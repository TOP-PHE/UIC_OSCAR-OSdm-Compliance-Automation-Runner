// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * company-coverage.js — how far what the Test Framework declares is tested,
 * for the company or provider of the request (#956).
 *
 *   GET /v1/company/coverage?days=   the functions declared, the scenarios
 *                                    exercising each with their latest run,
 *                                    the open findings, the summary, and the
 *                                    scenarios testing what is not declared.
 *
 * Read only. Like the data file and the findings it reads, the company's
 * members only: a tester sees the scenarios of their view (viewForTester) and
 * the runs of the company, administrators and certifiers get 403.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { all } = require('../../db/db');
const { requireAuth } = require('../middleware/auth');
const { enforceTenant } = require('../middleware/tenant');
const { resolveCompanyScope } = require('../helpers/shared');
const { readDatafile, Refusal } = require('../helpers/catalogueSource');
const { frameworkConfigOf } = require('../helpers/configurationStore');
const { viewForTester } = require('../../utils/datafileOwnership');
const { getRunSelection } = require('../../utils/runSelections');
const { currentCollectionVersion } = require('../../utils/versionInfo');
const { coverageOf, latestRunsOf } = require('../../utils/frameworkCoverage');
const log = require('../../utils/logger').child({ module: 'company-coverage' });

const router = express.Router();
router.use(requireAuth, enforceTenant);

const coverageLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many coverage reports asked. Wait a minute.' },
});

const DEFAULT_DAYS = 365;
const MAX_DAYS = 3650;
const MAX_RUNS = 20000;

// The window of runs read, in days: a whole number from 1 to 3650.
function daysOf(raw) {
  if (raw === undefined) return DEFAULT_DAYS;
  const n = typeof raw === 'string' && /^\d{1,4}$/.test(raw) ? Number(raw) : Number.NaN;
  return Number.isInteger(n) && n >= 1 && n <= MAX_DAYS ? n : null;
}

// The latest finished run of each scenario of the company within the window,
// with its check counts.
function latestRuns(companyId, days) {
  const rows = all(
    `SELECT id, scenario_code, status, queued_at, completed_at, server_version, collection_version, scenario_hash
       FROM runs
      WHERE company_id = ? AND scenario_code IS NOT NULL AND status IN ('COMPLETED', 'FAILED')
        AND queued_at >= datetime('now', ?)
      ORDER BY queued_at DESC, id DESC
      LIMIT ${MAX_RUNS}`,
    [companyId, `-${days} days`]
  );
  const latest = latestRunsOf(rows);
  const ids = Object.values(latest).map((r) => r.id);
  const counts = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const marks = chunk.map(() => '?').join(',');
    for (const c of all(`SELECT run_id, COUNT(*) AS total, SUM(CASE WHEN passed = 1 THEN 0 ELSE 1 END) AS failed
                           FROM run_assertions WHERE run_id IN (${marks}) GROUP BY run_id`, chunk)) {
      counts.set(c.run_id, c);
    }
  }
  for (const run of Object.values(latest)) {
    const c = counts.get(run.id);
    run.total = c ? Number(c.total) : 0;
    run.failed = c ? Number(c.failed) : 0;
  }
  return latest;
}

router.get('/coverage', coverageLimiter, async (req, res) => {
  if (req.user.role === 'administrator' || req.user.role === 'certification_user') {
    return res.status(403).json({ status: 403, title: 'Forbidden',
      detail: 'Administrators and certifiers do not have access to a vendor\'s test coverage.' });
  }
  const companyId = resolveCompanyScope(req, res);
  if (companyId === null) return undefined;
  const days = daysOf(req.query.days);
  if (days === null) return res.status(400).json({ status: 400, title: 'Bad Request', detail: `days must be a whole number from 1 to ${MAX_DAYS}.` });
  try {
    let datafile = await readDatafile(companyId);
    if (datafile && req.user.role !== 'test_manager') {
      datafile = viewForTester(datafile, req.user.email, getRunSelection(companyId, req.user.id));
    }
    const framework = frameworkConfigOf(companyId);
    const findings = all("SELECT id, title, category, status, scenario_code FROM finding WHERE company_id = ? AND status != 'resolved'", [companyId]);
    const coverage = coverageOf({
      framework: framework || {}, datafile: datafile || { scenarios: [] },
      runs: latestRuns(companyId, days), findings, collectionVersion: currentCollectionVersion(),
    });
    return res.json({ days, framework: Boolean(framework), datafile: Boolean(datafile), collectionVersion: currentCollectionVersion(), ...coverage });
  } catch (err) {
    if (err instanceof Refusal) return res.status(err.status).json({ status: err.status, title: 'Conflict', detail: err.message });
    log.error({ err, companyId }, 'coverage report failed');
    return res.status(500).json({ status: 500, title: 'Internal Server Error', detail: 'The coverage report could not be built.' });
  }
});

module.exports = router;
module.exports.daysOf = daysOf;
