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
 *
 * Certifiers only. A report is read exactly as it was published: the
 * certifier sees the whole report (decision 4), its runs were shared with it.
 * A report not shared, or withdrawn, answers 404, never 403. No e-mail of the
 * company's users is answered.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { all, get } = require('../../db/db');
const { requireAuth } = require('../middleware/auth');
const { isRunId } = require('../../utils/coverageReports');
const { sendWorkbook, parseStored } = require('./company-coverage-reports');

const router = express.Router();

// Before the sign-in check: the router has /v1/certifier to itself.
const readLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many requests for published reports. Wait a minute.' },
});
router.use(readLimiter, requireAuth);

const NOT_FOUND = { status: 404, title: 'Not Found', detail: 'Published report not found.' };
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
    id: row.id, number: row.number, days: row.days, company: row.company_name, distributor: row.distributor_name || null,
    createdAt: row.created_at, sharedAt: row.shared_at, summary,
  };
}

router.get('/coverage-reports', (req, res) => {
  if (!certifierOnly(req, res)) return undefined;
  const rows = all(`SELECT r.id, r.number, r.days, r.created_at, r.shared_at, r.summary, c.name AS company_name, p.name AS distributor_name
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
  return sendWorkbook(res, row, name || '');
});

module.exports = router;
