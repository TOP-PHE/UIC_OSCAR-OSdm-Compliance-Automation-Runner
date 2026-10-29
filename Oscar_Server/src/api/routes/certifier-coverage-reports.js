// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * certifier-coverage-reports.js — the coverage reports shared with the
 * certifier (#972 part 4).
 *
 *   GET /v1/certifier/coverage-reports                 shared and not withdrawn, every company
 *   GET /v1/certifier/coverage-reports/:id             one of them, frozen, and its comparison
 *   GET /v1/certifier/coverage-reports/:id/download    the same as an .xlsx workbook
 *   GET /v1/certifier/coverage                         the companies or providers that shared a report (#1043)
 *   GET /v1/certifier/coverage/:companyId?days=        the live coverage of one, from its shared runs
 *   GET /v1/certifier/coverage/:companyId/download     the same as an .xlsx workbook
 *
 * Certifiers only. A report is read exactly as it was published: the
 * certifier sees the whole report (decision 4), its runs were shared with it.
 * A report not shared, or withdrawn, answers 404, never 403. No e-mail of the
 * company's users is answered.
 *
 * #1043: once a company or provider has shared a report (not withdrawn), the
 * certifier may build its coverage at any time, from the runs shared with
 * certifiers only and the scenarios they ran, frozen as a published report
 * is (`forPublication()`: no positions, no simulated errors).
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { all, get } = require('../../db/db');
const { requireAuth } = require('../middleware/auth');
const { isRunId, forPublication } = require('../../utils/coverageReports');
const { sendWorkbook, parseStored } = require('./company-coverage-reports');
const { buildCoverage, daysOf, MAX_DAYS } = require('./company-coverage');
const { coverageWorkbook } = require('../../utils/coverageWorkbook');
const { fileNameFor } = require('../../utils/fileNames');
const log = require('../../utils/logger').child({ module: 'certifier-coverage' });

const router = express.Router();

// Before the sign-in check: the router has /v1/certifier to itself.
const readLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many requests for published reports. Wait a minute.' },
});
router.use(readLimiter, requireAuth);

// Building a coverage reads every latest run: fewer than the reads above.
const coverageLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many coverage reports asked. Wait a minute.' },
});

const NOT_FOUND = { status: 404, title: 'Not Found', detail: 'Published report not found.' };
const NO_COVERAGE = { status: 404, title: 'Not Found', detail: 'No report of this company or provider is shared with you.' };
const SHARED = 'r.shared_at IS NOT NULL AND r.withdrawn_at IS NULL';

function certifierOnly(req, res) {
  if (req.user.role === 'certification_user') return true;
  res.status(403).json({ status: 403, title: 'Forbidden', detail: 'Only a certifier reads the reports shared with certifiers.' });
  return false;
}

// A report shared with the certifier, with its company's and distributor's names.
function sharedRow(id) {
  if (!isRunId(id)) return null;
  return get(`SELECT r.*, c.name AS company_name, p.name AS distributor_name
                FROM coverage_report r JOIN companies c ON c.id = r.company_id LEFT JOIN companies p ON p.id = c.parent_id
               WHERE r.id = ? AND ${SHARED}`, [id]);
}

function listItem(row) {
  let summary = null;
  try { summary = row.summary ? JSON.parse(row.summary) : null; } catch { summary = null; }
  return {
    id: row.id, number: row.number, days: row.days, companyId: row.company_id, company: row.company_name, distributor: row.distributor_name || null,
    createdAt: row.created_at, sharedAt: row.shared_at, summary,
  };
}

router.get('/coverage-reports', (req, res) => {
  if (!certifierOnly(req, res)) return undefined;
  const rows = all(`SELECT r.id, r.number, r.days, r.company_id, r.created_at, r.shared_at, r.summary, c.name AS company_name, p.name AS distributor_name
                      FROM coverage_report r JOIN companies c ON c.id = r.company_id LEFT JOIN companies p ON p.id = c.parent_id
                     WHERE ${SHARED} ORDER BY r.shared_at DESC, r.number DESC LIMIT 200`);
  return res.json({ reports: rows.map(listItem) });
});

router.get('/coverage-reports/:id', (req, res) => {
  if (!certifierOnly(req, res)) return undefined;
  const row = sharedRow(req.params.id);
  if (!row) return res.status(404).json(NOT_FOUND);
  return res.json({ ...listItem(row), report: parseStored(row.content), comparison: parseStored(row.comparison) });
});

router.get('/coverage-reports/:id/download', (req, res) => {
  if (!certifierOnly(req, res)) return undefined;
  const row = sharedRow(req.params.id);
  if (!row) return res.status(404).json(NOT_FOUND);
  const name = row.distributor_name ? `${row.distributor_name} — ${row.company_name}` : row.company_name;
  return sendWorkbook(res, row, name || '', row.company_name || '');
});

// The companies or providers that shared a report with the certifier and did
// not withdraw it: the only ones whose coverage a certifier may build.
const SHARING = `SELECT c.id, c.name, p.name AS distributor_name
                   FROM companies c LEFT JOIN companies p ON p.id = c.parent_id
                  WHERE EXISTS (SELECT 1 FROM coverage_report r WHERE r.company_id = c.id AND ${SHARED})`;

function sharingCompany(id) {
  if (!isRunId(id)) return null;
  return get(`${SHARING} AND c.id = ?`, [id]);
}

router.get('/coverage', (req, res) => {
  if (!certifierOnly(req, res)) return undefined;
  const rows = all(`${SHARING} ORDER BY p.name, c.name LIMIT 200`);
  return res.json({ companies: rows.map((r) => ({ id: r.id, company: r.name, distributor: r.distributor_name || null })) });
});

// Refuses (res answered, null returned) or builds the coverage asked.
async function certifierCoverage(req, res) {
  if (!certifierOnly(req, res)) return null;
  const company = sharingCompany(req.params.companyId);
  if (!company) {
    res.status(404).json(NO_COVERAGE);
    return null;
  }
  const days = daysOf(req.query.days);
  if (days === null) {
    res.status(400).json({ status: 400, title: 'Bad Request', detail: `days must be a whole number from 1 to ${MAX_DAYS}.` });
    return null;
  }
  return { company, report: forPublication(await buildCoverage(company.id, days, req.user)) };
}

function failedCoverage(res, err, companyId) {
  log.error({ err, companyId }, 'certifier coverage failed');
  return res.status(500).json({ status: 500, title: 'Internal Server Error', detail: 'The coverage report could not be built.' });
}

router.get('/coverage/:companyId', coverageLimiter, async (req, res) => {
  try {
    const built = await certifierCoverage(req, res);
    return built ? res.json(built.report) : undefined;
  } catch (err) {
    return failedCoverage(res, err, req.params.companyId);
  }
});

router.get('/coverage/:companyId/download', coverageLimiter, async (req, res) => {
  try {
    const built = await certifierCoverage(req, res);
    if (!built) return undefined;
    const { company } = built;
    const now = new Date().toISOString();
    const title = company.distributor_name ? `${company.distributor_name} — ${company.name}` : company.name;
    const file = coverageWorkbook(built.report, { title: title || '', generatedAt: now.replace('T', ' ').slice(0, 19) + ' UTC' });
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const name = fileNameFor(company.name, `oscar-coverage-${now.slice(0, 10)}.xlsx`);
    res.set('Content-Disposition', `attachment; filename="${name}"`);
    return res.send(file);
  } catch (err) {
    return failedCoverage(res, err, req.params.companyId);
  }
});

module.exports = router;
