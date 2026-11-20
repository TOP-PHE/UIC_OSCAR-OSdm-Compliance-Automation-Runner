// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * company-test-suites.js — a company's named suites (#1342 PR 4).
 *
 *   GET    /v1/company/test-suites       — the suites of the company
 *   POST   /v1/company/test-suites       — save one: { name, selection, codes }
 *   PATCH  /v1/company/test-suites/:id   — change it (any of the three)
 *   DELETE /v1/company/test-suites/:id   — delete it
 *
 * A suite belongs to the distributor (the request's company, or the
 * distributor of the provider it names) and is asked by its name in
 * POST /v1/api/test-requests. Test Managers make and change suites; testers
 * read them, administrators and certifiers get 403. The rules are
 * utils/testSuites.js.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { randomUUID } = require('node:crypto');
const { get, all, run } = require('../../db/db');
const { requireAuth } = require('../middleware/auth');
const { enforceTenant } = require('../middleware/tenant');
const { auditLog, denyAdminAndCertifier } = require('../helpers/shared');
const S = require('../../utils/testSuites');

const router = express.Router();

const limiter = rateLimit({
  windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many requests in a short window — please wait a moment.' },
});

router.use(limiter, requireAuth, enforceTenant, (req, res, next) => {
  if (denyAdminAndCertifier(req, res)) return undefined;
  if (req.method !== 'GET' && req.user.role !== 'test_manager') {
    return res.status(403).json({ status: 403, title: 'Forbidden', detail: 'Only Test Managers make and change suites.' });
  }
  return next();
});

const NOT_FOUND = Object.freeze({ status: 404, title: 'Not Found', detail: 'No such suite here.' });

function distributorOf(req) {
  const row = get('SELECT id, name, parent_id FROM companies WHERE id = ?', [req.companyId]);
  if (!row) return null;
  return row.parent_id ? get('SELECT id, name, parent_id FROM companies WHERE id = ?', [row.parent_id]) : row;
}

const suiteView = (row) => ({
  id: row.id,
  name: row.name,
  selection: row.selection ? JSON.parse(row.selection) : null,
  codes: row.codes ? JSON.parse(row.codes) : null,
  created_by: row.created_by_email || null,
  created_at: row.created_at,
  updated_at: row.updated_at || null,
});

const FIELDS = 's.id, s.name, s.selection, s.codes, s.created_at, s.updated_at, u.email AS created_by_email';
const suitesOf = (companyId) => all(`SELECT ${FIELDS} FROM test_suite s LEFT JOIN users u ON u.id = s.created_by
  WHERE s.company_id = ? ORDER BY lower(s.name)`, [companyId]).map(suiteView);
const suiteRow = (id, companyId) => get(`SELECT ${FIELDS} FROM test_suite s LEFT JOIN users u ON u.id = s.created_by
  WHERE s.id = ? AND s.company_id = ?`, [String(id), companyId]);
const nameTaken = (name, companyId, exceptId = '') => !!get(
  'SELECT 1 AS ok FROM test_suite WHERE company_id = ? AND lower(name) = lower(?) AND id != ?', [companyId, name, exceptId]);
const TAKEN = { status: 409, title: 'Conflict', detail: 'Another suite of your company has this name.' };

router.get('/', (req, res) => {
  const distributor = distributorOf(req);
  if (!distributor) return res.status(404).json(NOT_FOUND);
  return res.json({ company: { id: distributor.id, name: distributor.name }, suites: suitesOf(distributor.id) });
});

router.post('/', (req, res) => {
  const distributor = distributorOf(req);
  if (!distributor) return res.status(404).json(NOT_FOUND);
  const suite = S.suiteOf(req.body);
  if (suite.error) return res.status(400).json({ status: 400, title: 'Bad Request', detail: suite.error });
  if (nameTaken(suite.name, distributor.id)) return res.status(409).json(TAKEN);
  if (get('SELECT COUNT(*) AS n FROM test_suite WHERE company_id = ?', [distributor.id]).n >= S.MAX_PER_COMPANY) {
    return res.status(409).json({ status: 409, title: 'Conflict', detail: `A company has at most ${S.MAX_PER_COMPANY} suites: delete one first.` });
  }
  const id = randomUUID();
  run('INSERT INTO test_suite (id, company_id, name, selection, codes, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    [id, distributor.id, suite.name, suite.selection ? JSON.stringify(suite.selection) : null,
      suite.codes ? JSON.stringify(suite.codes) : null, req.user.id]);
  auditLog(req.user.id, distributor.id, req.user.email, `test_suite_created:${id}`);
  return res.status(201).json(suiteView(suiteRow(id, distributor.id)));
});

router.patch('/:id', (req, res) => {
  const distributor = distributorOf(req);
  const row = distributor && suiteRow(req.params.id, distributor.id);
  if (!row) return res.status(404).json(NOT_FOUND);
  // A change is the suite as it would be, checked whole.
  const current = suiteView(row);
  const body = req.body || {};
  const next = S.suiteOf({
    name: body.name === undefined ? current.name : body.name,
    selection: body.selection === undefined ? current.selection : body.selection,
    codes: body.codes === undefined ? current.codes : body.codes,
  });
  if (next.error) return res.status(400).json({ status: 400, title: 'Bad Request', detail: next.error });
  if (nameTaken(next.name, distributor.id, row.id)) return res.status(409).json(TAKEN);
  run("UPDATE test_suite SET name = ?, selection = ?, codes = ?, updated_at = datetime('now') WHERE id = ?",
    [next.name, next.selection ? JSON.stringify(next.selection) : null, next.codes ? JSON.stringify(next.codes) : null, row.id]);
  auditLog(req.user.id, distributor.id, req.user.email, `test_suite_updated:${row.id}`);
  return res.json(suiteView(suiteRow(row.id, distributor.id)));
});

router.delete('/:id', (req, res) => {
  const distributor = distributorOf(req);
  const row = distributor && suiteRow(req.params.id, distributor.id);
  if (!row) return res.status(404).json(NOT_FOUND);
  run('DELETE FROM test_suite WHERE id = ?', [row.id]);
  auditLog(req.user.id, distributor.id, req.user.email, `test_suite_deleted:${row.id}`);
  return res.json({ deleted: true, id: row.id });
});

module.exports = router;
