// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * company-coverage-reports.js — published coverage reports (#972 part 4).
 *
 *   POST /v1/company/coverage/reports             publish today's report (body { days })
 *   GET  /v1/company/coverage/reports             the company's or provider's reports
 *   GET  /v1/company/coverage/reports/:id         one report, frozen, and its comparison
 *   GET  /v1/company/coverage/reports/:id/download   the same as an .xlsx workbook
 *   POST /v1/company/coverage/reports/:id/share   share it with the certifier, and its runs
 *   POST /v1/company/coverage/reports/:id/withdraw   the certifier no longer sees it
 *
 * Test Managers only, for the company or provider of the request
 * (req.companyId): a report holds every scenario, testers' private ones
 * included, so testers do not read it. A report is frozen when published;
 * correcting it means publishing a new one (decision 4). Withdrawing a shared
 * report hides it from the certifier and leaves its runs shared (maintainer,
 * 2026-10-26): a Test Manager unshares runs one by one, as before.
 */

const express = require('express');
const crypto = require('node:crypto');
const rateLimit = require('express-rate-limit');
const { all, get, run, transaction, colEncrypt, colDecrypt } = require('../../db/db');
const { requireAuth } = require('../middleware/auth');
const { enforceTenant } = require('../middleware/tenant');
const { auditLog } = require('../helpers/shared');
const { buildCoverage, daysOf, MAX_DAYS } = require('./company-coverage');
const { runIdsOf, summaryOf, comparisonOf, isRunId, forPublication } = require('../../utils/coverageReports');
const { coverageWorkbook } = require('../../utils/coverageWorkbook');
const { fileNameFor } = require('../../utils/fileNames');
const log = require('../../utils/logger').child({ module: 'company-coverage-reports' });

const router = express.Router();
router.use(requireAuth, enforceTenant);

const publishLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many reports published. Wait a minute.' },
});
// Sharing and withdrawing write a row and an audit event, nothing more.
const changeLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many changes to published reports. Wait a minute.' },
});
const readLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many requests for published reports. Wait a minute.' },
});

const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];
const NOT_FOUND = { status: 404, title: 'Not Found', detail: 'Published report not found.' };

// The company or provider of the request, for a Test Manager; else answered.
function testManagerScope(req, res) {
  if (req.user.role !== 'test_manager') {
    res.status(403).json({ status: 403, title: 'Forbidden', detail: 'Only a Test Manager publishes and reads published coverage reports.' });
    return null;
  }
  return req.companyId || null;
}

const parse = (text) => {
  if (!text) return null;
  try { return JSON.parse(colDecrypt(text)); } catch { return null; }
};

// The report of the company named by the route, or null.
function reportRow(companyId, id) {
  return isRunId(id) ? get('SELECT * FROM coverage_report WHERE id = ? AND company_id = ?', [id, companyId]) : null;
}

function listItem(row) {
  let summary = null;
  try { summary = row.summary ? JSON.parse(row.summary) : null; } catch { summary = null; }
  return {
    id: row.id, number: row.number, days: row.days, createdAt: row.created_at, createdBy: row.created_by,
    sharedAt: row.shared_at, sharedBy: row.shared_by, withdrawnAt: row.withdrawn_at, withdrawnBy: row.withdrawn_by,
    comparedWith: row.compared_with || null, summary,
  };
}

// The last report of the company shared with the certifier and not withdrawn.
function previousShared(companyId) {
  const row = get(`SELECT * FROM coverage_report WHERE company_id = ? AND shared_at IS NOT NULL AND withdrawn_at IS NULL
                    ORDER BY number DESC LIMIT 1`, [companyId]);
  if (!row) return null;
  return { id: row.id, number: row.number, sharedAt: row.shared_at, report: parse(row.content) };
}

router.post('/coverage/reports', publishLimiter, async (req, res) => {
  const companyId = testManagerScope(req, res);
  if (!companyId) return res.headersSent ? undefined : res.status(404).json(NOT_FOUND);
  const raw = req.body?.days;
  const days = daysOf(raw === undefined ? undefined : String(raw));
  if (days === null) return res.status(400).json({ status: 400, title: 'Bad Request', detail: `days must be a whole number from 1 to ${MAX_DAYS}.` });
  try {
    const report = forPublication(await buildCoverage(companyId, days, req.user));
    const previous = previousShared(companyId);
    const comparison = comparisonOf(report, previous);
    const id = crypto.randomUUID();
    let number = 0;
    // Synchronous from here: the number and the row go in together.
    transaction(() => {
      number = Number(get('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM coverage_report WHERE company_id = ?', [companyId]).n);
      run(`INSERT INTO coverage_report (id, company_id, number, days, content, comparison, compared_with, run_ids, summary, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, companyId, number, days, colEncrypt(JSON.stringify(report)), comparison ? colEncrypt(JSON.stringify(comparison)) : null,
        previous ? previous.id : null, JSON.stringify(runIdsOf(report)), JSON.stringify(summaryOf(report)), req.user.email]);
    });
    auditLog(req.user.id, companyId, req.user.email, `coverage_report_published:${id}`);
    return res.status(201).json(listItem(get('SELECT * FROM coverage_report WHERE id = ?', [id])));
  } catch (err) {
    log.error({ err, companyId }, 'coverage report not published');
    return res.status(500).json({ status: 500, title: 'Internal Server Error', detail: 'The report could not be published.' });
  }
});

router.get('/coverage/reports', readLimiter, (req, res) => {
  const companyId = testManagerScope(req, res);
  if (!companyId) return res.headersSent ? undefined : res.status(404).json(NOT_FOUND);
  const rows = all(`SELECT id, number, days, created_at, created_by, shared_at, shared_by, withdrawn_at, withdrawn_by, compared_with, summary
                      FROM coverage_report WHERE company_id = ? ORDER BY number DESC LIMIT 200`, [companyId]);
  return res.json({ reports: rows.map(listItem) });
});

router.get('/coverage/reports/:id', readLimiter, (req, res) => {
  const companyId = testManagerScope(req, res);
  if (!companyId) return res.headersSent ? undefined : res.status(404).json(NOT_FOUND);
  const row = reportRow(companyId, req.params.id);
  if (!row) return res.status(404).json(NOT_FOUND);
  return res.json({ ...listItem(row), report: parse(row.content), comparison: parse(row.comparison) });
});

router.get('/coverage/reports/:id/download', readLimiter, (req, res) => {
  const companyId = testManagerScope(req, res);
  if (!companyId) return res.headersSent ? undefined : res.status(404).json(NOT_FOUND);
  const row = reportRow(companyId, req.params.id);
  if (!row) return res.status(404).json(NOT_FOUND);
  const company = get('SELECT name FROM companies WHERE id = ?', [companyId]);
  return sendWorkbook(res, row, company?.name || '');
});

/**
 * The workbook of a published report: its own date and number, its comparison.
 * Its file name starts with the company or provider it is about (#1002).
 */
function sendWorkbook(res, row, companyName, owner = companyName) {
  const file = coverageWorkbook(parse(row.content) || {}, {
    title: `${companyName} — published report ${row.number}`, generatedAt: `${row.created_at} UTC`, comparison: parse(row.comparison),
  });
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const name = fileNameFor(owner, `oscar-coverage-report-${row.number}.xlsx`);
  res.set('Content-Disposition', `attachment; filename="${name}"`);
  return res.send(file);
}

router.post('/coverage/reports/:id/share', changeLimiter, (req, res) => {
  const companyId = testManagerScope(req, res);
  if (!companyId) return res.headersSent ? undefined : res.status(404).json(NOT_FOUND);
  const row = reportRow(companyId, req.params.id);
  if (!row) return res.status(404).json(NOT_FOUND);
  if (row.withdrawn_at) return res.status(409).json({ status: 409, title: 'Conflict', detail: 'This report was withdrawn: publish a new one.' });
  if (row.shared_at) return res.status(409).json({ status: 409, title: 'Conflict', detail: 'This report is already shared with the certifier.' });
  let ids = [];
  try { ids = JSON.parse(row.run_ids).filter(isRunId); } catch { ids = []; }
  let runsShared = 0;
  transaction(() => {
    run("UPDATE coverage_report SET shared_at = datetime('now'), shared_by = ? WHERE id = ?", [req.user.email, row.id]);
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      // The report's runs, of this company, finished, not shared yet.
      const changed = run(`UPDATE runs SET shared_with_certifier_at = datetime('now'), shared_with_certifier_by = ?
                            WHERE company_id = ? AND shared_with_certifier_at IS NULL AND status IN (${TERMINAL.map(() => '?').join(',')})
                              AND id IN (${chunk.map(() => '?').join(',')})`, [req.user.email, companyId, ...TERMINAL, ...chunk]);
      runsShared += Number(changed?.changes || 0);
    }
  });
  auditLog(req.user.id, companyId, req.user.email, `coverage_report_shared:${row.id}:${runsShared}_runs`);
  return res.json({ ...listItem(get('SELECT * FROM coverage_report WHERE id = ?', [row.id])), runsShared });
});

router.post('/coverage/reports/:id/withdraw', changeLimiter, (req, res) => {
  const companyId = testManagerScope(req, res);
  if (!companyId) return res.headersSent ? undefined : res.status(404).json(NOT_FOUND);
  const row = reportRow(companyId, req.params.id);
  if (!row) return res.status(404).json(NOT_FOUND);
  if (!row.shared_at) return res.status(409).json({ status: 409, title: 'Conflict', detail: 'This report is not shared with the certifier.' });
  if (row.withdrawn_at) return res.status(409).json({ status: 409, title: 'Conflict', detail: 'This report is already withdrawn.' });
  run("UPDATE coverage_report SET withdrawn_at = datetime('now'), withdrawn_by = ? WHERE id = ?", [req.user.email, row.id]);
  auditLog(req.user.id, companyId, req.user.email, `coverage_report_withdrawn:${row.id}`);
  return res.json(listItem(get('SELECT * FROM coverage_report WHERE id = ?', [row.id])));
});

module.exports = router;
module.exports.sendWorkbook = sendWorkbook;
module.exports.parseStored = parse;
