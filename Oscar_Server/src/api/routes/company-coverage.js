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
 *                                    the open findings, the summary, the
 *                                    scenarios testing what is not declared,
 *                                    and (part 3) the same by flow and element
 *                                    tested (`matrix`) and by scenario, and
 *                                    (#972) by capability (`byCapability`).
 *   GET /v1/company/coverage/download?days=   the same as an .xlsx workbook.
 *
 * Read only. Like the data file and the findings it reads, the company's
 * members only: a tester sees the scenarios of their view (viewForTester) and
 * the runs of the company, administrators and certifiers get 403.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { all, get, colDecrypt } = require('../../db/db');
const { requireAuth } = require('../middleware/auth');
const { enforceTenant } = require('../middleware/tenant');
const { resolveCompanyScope } = require('../helpers/shared');
const { readDatafile, readCatalogue, Refusal } = require('../helpers/catalogueSource');
const { frameworkConfigOf } = require('../helpers/configurationStore');
const { viewForTester } = require('../../utils/datafileOwnership');
const { getRunSelection } = require('../../utils/runSelections');
const { currentCollectionVersion } = require('../../utils/versionInfo');
const { coverageOf, latestRunsOf, failureOf } = require('../../utils/frameworkCoverage');
const { coverageMatrixOf } = require('../../utils/coverageMatrix');
const { capabilityCoverageOf } = require('../../utils/capabilityCoverage');
const { coverageWorkbook } = require('../../utils/coverageWorkbook');
const { problemOf } = require('../../utils/findingSuggestions');
const { toApiFinding } = require('../helpers/findings');
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
const MAX_WARNING_EVENTS = 20000;
const MAX_FAILED_CHECKS = 50000;
const MAX_STEPS = 200000;
const MAX_PROBLEM_BODIES = 5000;

// The window of runs read, in days: a whole number from 1 to 3650.
function daysOf(raw) {
  if (raw === undefined) return DEFAULT_DAYS;
  const n = typeof raw === 'string' && /^\d{1,4}$/.test(raw) ? Number(raw) : Number.NaN;
  return Number.isInteger(n) && n >= 1 && n <= MAX_DAYS ? n : null;
}

// The failed checks of the runs, by run, in order, with their step, its HTTP
// status and, for an error answer, its problem code (#972 R6: the #735 key).
function failedChecksOf(ids) {
  const byRun = new Map();
  const rows = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    rows.push(...all(`SELECT a.run_id, a.assertion_name, a.category, a.severity, q.request_name, q.http_status, q.id AS request_id
                        FROM run_assertions a JOIN run_requests q ON q.id = a.request_id
                       WHERE a.passed = 0 AND a.run_id IN (${chunk.map(() => '?').join(',')})
                       ORDER BY a.id ASC LIMIT ${MAX_FAILED_CHECKS}`, chunk));
  }
  const problems = problemCodesOf([...new Set(rows.filter((r) => Number(r.http_status) >= 400).map((r) => r.request_id))]);
  for (const { request_id: requestId, ...row } of rows) {
    row.problem_code = problems.get(requestId) || null;
    if (!byRun.has(row.run_id)) byRun.set(row.run_id, []);
    byRun.get(row.run_id).push(row);
  }
  return byRun;
}

// The problem code of each error answer, by request id: one decryption per
// request, at most MAX_PROBLEM_BODIES (the others group without a code).
function problemCodesOf(requestIds) {
  const codes = new Map();
  const ids = requestIds.slice(0, MAX_PROBLEM_BODIES);
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const row of all(`SELECT id, response_body FROM run_requests WHERE id IN (${chunk.map(() => '?').join(',')})`, chunk)) {
      let body = null;
      try { body = row.response_body ? colDecrypt(row.response_body) : null; } catch { body = null; }
      const code = problemOf(body)?.code;
      if (code) codes.set(row.id, code);
    }
  }
  return codes;
}

// The steps of the runs (#972), by run, in order: { request_name, http_status }.
function stepsOfRuns(ids) {
  const byRun = new Map();
  let read = 0;
  for (let i = 0; i < ids.length && read < MAX_STEPS; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = all(`SELECT run_id, request_name, http_status FROM run_requests
                       WHERE run_id IN (${chunk.map(() => '?').join(',')}) ORDER BY id ASC LIMIT ?`, [...chunk, MAX_STEPS - read]);
    read += rows.length;
    for (const row of rows) {
      if (!byRun.has(row.run_id)) byRun.set(row.run_id, []);
      byRun.get(row.run_id).push({ request_name: row.request_name, http_status: row.http_status });
    }
  }
  return byRun;
}

// The latest finished run of each scenario of the company within the window,
// with its check counts, its steps and its failed checks.
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
  const failures = failedChecksOf(ids);
  const steps = stepsOfRuns(ids);
  for (const run of Object.values(latest)) {
    run.failure = failureOf(failures.get(run.id));
    run.checks = failures.get(run.id) || [];
    run.steps = steps.get(run.id) || [];
  }
  return latest;
}

// The warning lines of each run, by scenario code: { code: [line] }. Only
// those holding a "not supported" mark are kept by coverageMatrixOf().
function warningLinesOf(latest) {
  const codeOf = new Map(Object.values(latest).map((r) => [r.id, r.scenario_code]));
  const ids = [...codeOf.keys()];
  const out = {};
  let read = 0;
  for (let i = 0; i < ids.length && read < MAX_WARNING_EVENTS; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = all(`SELECT run_id, message FROM run_events WHERE level = 'warn' AND run_id IN (${chunk.map(() => '?').join(',')}) ORDER BY id ASC LIMIT ?`,
      [...chunk, MAX_WARNING_EVENTS - read]);
    read += rows.length;
    for (const row of rows) {
      let text = '';
      try { text = colDecrypt(row.message) || ''; } catch { text = ''; }
      const code = codeOf.get(row.run_id);
      if (!out[code]) out[code] = [];
      out[code].push(...String(text).split('\n').filter((l) => l.includes('[WARNING]')));
    }
  }
  return out;
}

// What the Test Manager decided of the #735 drafts: the finding each accepted
// draft became, by group key, and the keys marked as OSCAR's issue.
function suggestionsOf(companyId) {
  const accepted = Object.create(null);
  const oscarIssues = [];
  for (const r of all("SELECT group_key, finding_id, state FROM finding_suggestion WHERE company_id = ? AND state IN ('accepted', 'oscar_issue')", [companyId])) {
    if (r.state === 'oscar_issue') oscarIssues.push(r.group_key);
    else if (r.finding_id) accepted[r.group_key] = r.finding_id;
  }
  return { accepted, oscarIssues };
}

// The catalogue's entries (#972: each names its capability). A catalogue that
// cannot be read leaves every scenario to derivedCapability().
function catalogueEntries() {
  try {
    const entries = readCatalogue().catalogue?.entries;
    return Array.isArray(entries) ? entries : [];
  } catch (err) {
    log.warn({ err: err.message }, 'scenario catalogue not readable for the coverage report');
    return [];
  }
}

// Refuses (res answered, null returned) or builds the report of the request.
async function reportOf(req, res) {
  if (req.user.role === 'administrator' || req.user.role === 'certification_user') {
    res.status(403).json({ status: 403, title: 'Forbidden',
      detail: 'Administrators and certifiers do not have access to a vendor\'s test coverage.' });
    return null;
  }
  const companyId = resolveCompanyScope(req, res);
  if (companyId === null) return null;
  const days = daysOf(req.query.days);
  if (days === null) {
    res.status(400).json({ status: 400, title: 'Bad Request', detail: `days must be a whole number from 1 to ${MAX_DAYS}.` });
    return null;
  }
  return { companyId, report: await buildCoverage(companyId, days, req.user) };
}

/**
 * The coverage report of a company or provider over the last `days` days, as
 * `user` reads it: a tester sees the scenarios of their view only. Shared with
 * the published reports (#972 part 4), which a Test Manager makes.
 */
async function buildCoverage(companyId, days, user) {
  let datafile = await readDatafile(companyId);
  if (datafile && user.role !== 'test_manager') {
    datafile = viewForTester(datafile, user.email, getRunSelection(companyId, user.id));
  }
  const framework = frameworkConfigOf(companyId);
  const allFindings = all('SELECT * FROM finding WHERE company_id = ?', [companyId]);
  // The function and matrix views list open findings by these fields only.
  const findings = allFindings.filter((f) => f.status !== 'resolved')
    .map(({ id, title, category, status, scenario_code: code }) => ({ id, title, category, status, scenario_code: code }));
  const runs = latestRuns(companyId, days);
  const warnings = warningLinesOf(runs);
  const input = {
    framework: framework || {}, datafile: datafile || { scenarios: [] }, runs, findings, collectionVersion: currentCollectionVersion(),
    catalogue: catalogueEntries(),
  };
  const coverage = coverageOf(input);
  const { matrix, scenarios } = coverageMatrixOf({ ...input, refusals: warnings });
  const byCapability = capabilityCoverageOf({
    ...input, functions: coverage.functions, warnings, findings: allFindings.map(toApiFinding), suggestions: suggestionsOf(companyId),
  });
  return { days, framework: Boolean(framework), datafile: Boolean(datafile), collectionVersion: input.collectionVersion, ...coverage, matrix, scenarios, byCapability };
}

function failed(res, err, companyId) {
  if (err instanceof Refusal) return res.status(err.status).json({ status: err.status, title: 'Conflict', detail: err.message });
  log.error({ err, companyId }, 'coverage report failed');
  return res.status(500).json({ status: 500, title: 'Internal Server Error', detail: 'The coverage report could not be built.' });
}

router.get('/coverage', coverageLimiter, async (req, res) => {
  try {
    const built = await reportOf(req, res);
    return built ? res.json(built.report) : undefined;
  } catch (err) {
    return failed(res, err, req.companyId);
  }
});

router.get('/coverage/download', coverageLimiter, async (req, res) => {
  try {
    const built = await reportOf(req, res);
    if (!built) return undefined;
    const company = get('SELECT name FROM companies WHERE id = ?', [built.companyId]);
    const now = new Date().toISOString();
    const file = coverageWorkbook(built.report, { title: company?.name || '', generatedAt: now.replace('T', ' ').slice(0, 19) + ' UTC' });
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="oscar-coverage-${now.slice(0, 10)}.xlsx"`);
    return res.send(file);
  } catch (err) {
    return failed(res, err, req.companyId);
  }
});

module.exports = router;
module.exports.daysOf = daysOf;
module.exports.buildCoverage = buildCoverage;
module.exports.MAX_DAYS = MAX_DAYS;
