// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * company-test-framework.js — Test framework configuration routes (Wizard Step 1)
 *
 * GET    /v1/company/test-framework  — get company test framework config
 * PUT    /v1/company/test-framework  — create or update test framework config
 * DELETE /v1/company/test-framework  — delete test framework config
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { get, run } = require('../../db/db');
const { requireAuth, isPlatformRole, isTestManagerOrAbove } = require('../middleware/auth');
const { enforceTenant } = require('../middleware/tenant');
const { resolveCompanyScope } = require('../helpers/shared');

const router = express.Router();
router.use(requireAuth, enforceTenant);

// ── Role guard: test config write operations require test_manager or above ────
function requireTestManager(req, res) {
  if (!isTestManagerOrAbove(req.user.role) && !isPlatformRole(req.user.role)) {
    res.status(403).json({ status: 403, title: 'Forbidden', detail: 'Only Test Managers can modify test configuration.' });
    return false;
  }
  return true;
}

// ── GET /v1/company/test-framework ────────────────────────────────────────────
router.get('/test-framework', (req, res) => {
  const targetCompanyId = resolveCompanyScope(req, res);
  if (targetCompanyId === null) return;

  const row = get('SELECT * FROM test_frameworks WHERE company_id = ?', [targetCompanyId]);
  if (!row) return res.status(404).json({ status: 404, title: 'Not Found', detail: 'No test framework configured yet.' });

  let config = {};
  try { config = JSON.parse(row.config); } catch (_) {}
  return res.json({ id: row.id, config, created_at: row.created_at, updated_at: row.updated_at });
});

// ── PUT /v1/company/test-framework ────────────────────────────────────────────
router.put('/test-framework', (req, res) => {
  if (!requireTestManager(req, res)) return;
  const targetCompanyId = resolveCompanyScope(req, res);
  if (targetCompanyId === null) return;

  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'Body must be a JSON object.' });
  }

  // Accept either { config: {...} } (from wizard) or a bare config object
  const configPayload = (body.config && typeof body.config === 'object') ? body.config : body;
  const configJson = JSON.stringify(configPayload);
  const existing = get('SELECT id FROM test_frameworks WHERE company_id = ?', [targetCompanyId]);

  if (existing) {
    run(`UPDATE test_frameworks SET config = ?, updated_at = datetime('now') WHERE company_id = ?`,
        [configJson, targetCompanyId]);
  } else {
    run(`INSERT INTO test_frameworks (id, company_id, config) VALUES (?, ?, ?)`,
        [uuidv4(), targetCompanyId, configJson]);
  }

  const saved = get('SELECT * FROM test_frameworks WHERE company_id = ?', [targetCompanyId]);
  return res.json({ saved: true, updated_at: saved.updated_at });
});

// ── DELETE /v1/company/test-framework ─────────────────────────────────────────
router.delete('/test-framework', (req, res) => {
  if (!requireTestManager(req, res)) return;
  const targetCompanyId = resolveCompanyScope(req, res);
  if (targetCompanyId === null) return;
  run('DELETE FROM test_frameworks WHERE company_id = ?', [targetCompanyId]);
  res.json({ deleted: true });
});

module.exports = router;
