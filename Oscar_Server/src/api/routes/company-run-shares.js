// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * company-run-shares.js — the side of the company a distributor's runs are
 * shared with (#901). Test Managers only.
 *
 *   GET  /v1/company/run-share-links                     the providers linked to this company, by whom
 *   POST /v1/company/run-share-links/:providerId/accept  accept a link: its shared runs become readable
 *   POST /v1/company/run-share-links/:providerId/refuse  refuse it, or stop an accepted one
 *   GET  /v1/company/shared-runs                         the runs shared with this company
 *
 * "This company" is the Test Manager's own company: a distributor links a
 * provider to it (company-providers.js), shares runs (runs.js), and these
 * routes let it accept and read them. Reading a shared run goes through
 * canUserReadRun() like every read, so a refused or removed link, a revoked
 * share, or a sharer who left the distributor hides it at once.
 */

const express   = require('express');
const rateLimit = require('express-rate-limit');
const { get, all, run } = require('../../db/db');
const { requireAuth } = require('../middleware/auth');
const { enforceTenant } = require('../middleware/tenant');
const { auditLog } = require('../helpers/shared');
const { sharedViewOf } = require('../helpers/run-shares');
const { sharedRunRow } = require('../../utils/sharedRunView');

const router = express.Router();

const limiter = rateLimit({
  windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many requests in a short window — please wait a moment.' },
});

router.use(['/run-share-links', '/shared-runs'], limiter, requireAuth, enforceTenant);

// The Test Manager's own company: the request's company, or the distributor
// of the provider it names. Null for anyone else.
function ownCompanyOf(req, res) {
  if (req.user.role !== 'test_manager') {
    res.status(403).json({ status: 403, title: 'Forbidden', detail: 'Only Test Managers manage shared runs.' });
    return null;
  }
  const row = get('SELECT id, parent_id FROM companies WHERE id = ?', [req.companyId]);
  if (!row) {
    res.status(404).json({ status: 404, title: 'Not Found', detail: 'Company not found.' });
    return null;
  }
  return row.parent_id || row.id;
}

function linkView(row) {
  return {
    provider_id: row.provider_id,
    provider_name: row.provider_name,
    distributor_name: row.distributor_name,
    status: row.status,
    requested_at: row.requested_at,
    decided_at: row.decided_at || null,
  };
}

const LINKS = `SELECT po.provider_id, po.status, po.requested_at, po.decided_at,
                      p.name AS provider_name, d.name AS distributor_name
                 FROM provider_operator po
                 JOIN companies p ON p.id = po.provider_id
                 JOIN companies d ON d.id = p.parent_id
                WHERE po.operator_id = ?`;

router.get('/run-share-links', (req, res) => {
  const companyId = ownCompanyOf(req, res);
  if (!companyId) return;
  return res.json({ links: all(`${LINKS} ORDER BY d.name, p.name`, [companyId]).map(linkView) });
});

function decide(status) {
  return (req, res) => {
    const companyId = ownCompanyOf(req, res);
    if (!companyId) return;
    const link = get(`${LINKS} AND po.provider_id = ?`, [companyId, req.params.providerId]);
    if (!link) return res.status(404).json({ status: 404, title: 'Not Found', detail: 'No such link to your company.' });
    run(`UPDATE provider_operator SET status = ?, decided_by = ?, decided_at = datetime('now')
          WHERE provider_id = ? AND operator_id = ?`, [status, req.user.id, link.provider_id, companyId]);
    auditLog(req.user.id, companyId, req.user.email, `run_share_link_${status}:${link.provider_id}`);
    return res.json({ link: linkView(get(`${LINKS} AND po.provider_id = ?`, [companyId, link.provider_id])) });
  };
}

router.post('/run-share-links/:providerId/accept', decide('accepted'));
router.post('/run-share-links/:providerId/refuse', decide('refused'));

router.get('/shared-runs', (req, res) => {
  const companyId = ownCompanyOf(req, res);
  if (!companyId) return;
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit || '100', 10) || 100, 1), 500);
  const candidates = all(
    `SELECT r.*, s.shared_at AS shared_at
       FROM run_share s JOIN runs r ON r.id = s.run_id
      WHERE s.company_id = ? AND s.revoked_at IS NULL
        AND r.status NOT IN ('DELETED', 'DELETION_REQUESTED', 'DELETED_BY_ADMIN')
      ORDER BY r.queued_at DESC
      LIMIT ?`, [companyId, limit]);
  // The same rule as every read of a shared run, row by row.
  const runs = [];
  for (const row of candidates) {
    const view = sharedViewOf(row, req.user);
    if (view) runs.push({ ...sharedRunRow(row, view), shared_at: row.shared_at });
  }
  return res.json({ total: runs.length, runs });
});

module.exports = router;
