// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * company-test-resources.js — Test resource management routes (Wizard Step 2)
 *
 * GET    /v1/company/test-resources      — list test resources
 * POST   /v1/company/test-resources      — create a test resource
 * PUT    /v1/company/test-resources/:id   — update a test resource
 * DELETE /v1/company/test-resources/:id   — delete a test resource
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { get, all, run } = require('../../db/db');
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

// ── GET /v1/company/test-resources ────────────────────────────────────────────
router.get('/test-resources', (req, res) => {
  const targetCompanyId = resolveCompanyScope(req, res);
  if (targetCompanyId === null) return;

  const rows = all(
    'SELECT * FROM test_resources WHERE company_id = ? ORDER BY created_at ASC',
    [targetCompanyId]
  );
  const resources = rows.map(r => {
    let data = {};
    try { data = JSON.parse(r.data); } catch (_) {}
    return { id: r.id, resource_type: r.resource_type, label: r.label, data, created_at: r.created_at, updated_at: r.updated_at };
  });
  return res.json(resources);
});

// ── POST /v1/company/test-resources ───────────────────────────────────────────
router.post('/test-resources', (req, res) => {
  if (!requireTestManager(req, res)) return;
  const targetCompanyId = resolveCompanyScope(req, res);
  if (targetCompanyId === null) return;

  const { resource_type, label, data } = req.body || {};
  if (!resource_type || !['TRAIN', 'MULTIMODAL'].includes(resource_type)) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'resource_type must be TRAIN or MULTIMODAL.' });
  }
  if (!label || !label.trim()) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'label is required.' });
  }

  const id = uuidv4();
  run(
    `INSERT INTO test_resources (id, company_id, resource_type, label, data) VALUES (?, ?, ?, ?, ?)`,
    [id, targetCompanyId, resource_type, label.trim(), JSON.stringify(data || {})]
  );
  const saved = get('SELECT * FROM test_resources WHERE id = ?', [id]);
  let parsedData = {};
  try { parsedData = JSON.parse(saved.data); } catch (_) {}
  return res.status(201).json({
    id: saved.id, resource_type: saved.resource_type, label: saved.label,
    data: parsedData, created_at: saved.created_at, updated_at: saved.updated_at
  });
});

// ── PUT /v1/company/test-resources/:id ────────────────────────────────────────
router.put('/test-resources/:id', (req, res) => {
  if (!requireTestManager(req, res)) return;
  const targetCompanyId = resolveCompanyScope(req, res);
  if (targetCompanyId === null) return;

  const { label, data } = req.body || {};
  const row = get('SELECT id FROM test_resources WHERE id = ? AND company_id = ?',
                  [req.params.id, targetCompanyId]);
  if (!row) return res.status(404).json({ status: 404, title: 'Not Found' });

  run(
    `UPDATE test_resources SET label = ?, data = ?, updated_at = datetime('now') WHERE id = ?`,
    [label ? label.trim() : row.label, JSON.stringify(data || {}), req.params.id]
  );
  const updated = get('SELECT * FROM test_resources WHERE id = ?', [req.params.id]);
  let parsedData = {};
  try { parsedData = JSON.parse(updated.data); } catch (_) {}
  return res.json({
    id: updated.id, resource_type: updated.resource_type, label: updated.label,
    data: parsedData, created_at: updated.created_at, updated_at: updated.updated_at
  });
});

// ── DELETE /v1/company/test-resources/:id ─────────────────────────────────────
router.delete('/test-resources/:id', (req, res) => {
  if (!requireTestManager(req, res)) return;
  const targetCompanyId = resolveCompanyScope(req, res);
  if (targetCompanyId === null) return;

  const row = get('SELECT id FROM test_resources WHERE id = ? AND company_id = ?',
                  [req.params.id, targetCompanyId]);
  if (!row) return res.status(404).json({ status: 404, title: 'Not Found' });

  run('DELETE FROM test_resources WHERE id = ?', [req.params.id]);
  return res.json({ deleted: true });
});

module.exports = router;
