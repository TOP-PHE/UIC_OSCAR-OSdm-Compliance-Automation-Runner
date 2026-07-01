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
const fs = require('node:fs');
const rateLimit = require('express-rate-limit');
const { randomUUID: uuidv4 } = require('node:crypto');
const { get, run, colEncrypt, colDecrypt } = require('../../db/db');
const { requireAuth } = require('../middleware/auth');
const { enforceTenant } = require('../middleware/tenant');
const { resolveCompanyScope, denyAdminAndCertifier, requireTestManager } = require('../helpers/shared');
const { decryptFromFileAsync } = require('../../utils/at-rest');
const { applyFrameworkMigration } = require('../../utils/frameworkGating');
const log = require('../../utils/logger');

const router = express.Router();
router.use(requireAuth, enforceTenant);

// Rate limiter for GET /test-framework (CodeQL js/missing-rate-limiting).
// The lazy migration introduced in v1.11.105 reads + decrypts the company's
// datafile from disk; even though the endpoint is auth-gated, a leaked
// session token shouldn't be usable to mass-poll this route in a tight
// loop. Same window / cap as the datafile read limiter for consistency.
const frameworkReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests',
             detail: 'Too many test-framework reads in a short window.' }
});

// Role guards (issue #60): test framework is test data — administrators and
// certifiers have no access, only Test Managers may write. Shared helpers now
// live in helpers/shared.js (denyAdminAndCertifier / requireTestManager).

// ── GET /v1/company/test-framework ────────────────────────────────────────────
router.get('/test-framework', frameworkReadLimiter, async (req, res) => {
  if (denyAdminAndCertifier(req, res)) return;
  const targetCompanyId = resolveCompanyScope(req, res);
  if (targetCompanyId === null) return;

  const row = get('SELECT * FROM test_frameworks WHERE company_id = ?', [targetCompanyId]);
  if (!row) return res.status(404).json({ status: 404, title: 'Not Found', detail: 'No test framework configured yet.' });

  // Phase 2 of issue #60 (v1.11.0): config is encrypted at rest. Decrypt
  // before parsing. Legacy plaintext rows pass through colDecrypt() as-is.
  let config = {};
  try { config = JSON.parse(colDecrypt(row.config)); } catch (_) {}

  // ── #218 follow-up: framework-gating lazy migration ────────────────────
  // The "golden rule" introduced in v1.11.105: a scenario may not arm a
  // feature the framework hasn't declared. Pre-existing frameworks were
  // never asked to declare partial refund, so we derive the missing
  // declarations from the company's own scenarios — conservative migration
  // that ADDS to salesFlows[] (never removes), so the running configuration
  // is preserved exactly. Runs once per framework (stamped with
  // _salesFlowsMigratedAt) and is silent when nothing needs to change.
  if (!config._salesFlowsMigratedAt) {
    let scenarios = [];
    try {
      const company = get('SELECT datafile_path FROM companies WHERE id = ?', [targetCompanyId]);
      if (company && company.datafile_path && fs.existsSync(company.datafile_path)) {
        const buf = await decryptFromFileAsync(company.datafile_path);
        const df  = JSON.parse(buf.toString('utf8'));
        scenarios = Array.isArray(df.scenarios) ? df.scenarios : [];
      }
    } catch (err) {
      // Datafile missing / unreadable / unparsable is not a fatal error
      // here — the migration just runs against zero scenarios and stamps.
      log.warn({ err, companyId: targetCompanyId }, 'framework-gating migration: datafile unreadable, stamping with empty scenarios');
    }
    const { migrated, additions } = applyFrameworkMigration(config, scenarios, new Date().toISOString());
    if (migrated) {
      try {
        const reEncrypted = colEncrypt(JSON.stringify(config));
        run(`UPDATE test_frameworks SET config = ?, updated_at = datetime('now') WHERE company_id = ?`,
            [reEncrypted, targetCompanyId]);
        if (additions.length > 0) {
          log.info({ companyId: targetCompanyId, additions }, 'framework-gating: salesFlows additions derived from scenarios');
        }
      } catch (err) {
        // Persistence failure shouldn't block the GET — we already have
        // the migrated object in memory and return it. Next GET will retry.
        log.warn({ err, companyId: targetCompanyId }, 'framework-gating migration: persistence failed, returning in-memory result');
      }
    }
  }

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

  // Accept either { config: {...} } (from wizard) or a bare config object.
  // Phase 2 of issue #60: encrypt the config JSON at rest.
  const configPayload = (body.config && typeof body.config === 'object') ? body.config : body;
  const configJson = colEncrypt(JSON.stringify(configPayload));
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
