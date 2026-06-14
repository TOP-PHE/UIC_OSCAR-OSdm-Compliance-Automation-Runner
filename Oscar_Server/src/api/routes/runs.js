// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * runs.js — Run management routes
 *
 * POST /v1/runs                         — submit a new run
 * GET  /v1/runs                         — list runs for authenticated company
 * POST /v1/runs/bulk-delete             — tester soft-delete (→ DELETION_REQUESTED)
 * POST /v1/runs/bulk-admin-action       — admin batch actions (soft_delete / confirm_delete / purge / restore)
 * GET  /v1/runs/:id                     — run detail + status
 * GET  /v1/runs/:id/logs                — log events for a run
 * GET  /v1/runs/:id/artifacts           — list artifacts
 * GET  /v1/runs/:id/artifacts/:aid      — download an artifact
 * POST /v1/runs/:id/share               — test_manager: share THIS run with certifiers (v1.10.0, issue #60)
 * DELETE /v1/runs/:id/share             — test_manager: revoke certifier access to THIS run
 * DELETE /v1/runs/:id/cancel            — cancel a queued run (not yet started)
 * DELETE /v1/runs/:id                   — tester soft-delete (→ DELETION_REQUESTED)
 *                                         admin soft-delete  (→ DELETED_BY_ADMIN)
 *
 * Deletion status lifecycle:
 *   terminal state  ──[tester delete]──►  DELETION_REQUESTED  (hidden from tester, visible to admin)
 *   terminal state  ──[admin delete]───►  DELETED_BY_ADMIN    (shown to tester flagged, full admin access)
 *   DELETION_REQUESTED ──[admin confirm/purge]──► DELETED     (permanent, hidden everywhere)
 *   DELETED_BY_ADMIN   ──[admin purge]──────────► DELETED     (permanent)
 *   DELETION_REQUESTED | DELETED_BY_ADMIN ──[admin restore]──► previous_status
 */

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { randomUUID: uuidv4 } = require('node:crypto');
const { get, all, run: dbRun, transaction, colDecrypt } = require('../../db/db');
const { requireAuth, isPlatformRole } = require('../middleware/auth');
const { enforceTenant } = require('../middleware/tenant');
const { auditLog } = require('../helpers/shared');
const queue = require('../../worker/queue');
const runner = require('../../worker/runner');

const router = express.Router();
router.use(requireAuth, enforceTenant);

// ── Rate limit on run submission — prevents queue/disk exhaustion ────────────
// 30 batch submissions per hour per authenticated user. A batch may contain
// many scenarios, so this is generous for legitimate use but blocks abuse.
const runSubmitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  // Key by user ID (from JWT) so different users don't share the limit.
  // Fallback to ipKeyGenerator() which handles IPv6 properly per express-rate-limit docs.
  keyGenerator: (req, res) => (req.user && req.user.id) || ipKeyGenerator(req, res),
  message: { status: 429, title: 'Too Many Requests', detail: 'Rate limit: max 30 run submissions per hour. Wait or contact admin.' }
});

// ── Constants ─────────────────────────────────────────────────────────────────
const DELETION_STATUSES = ['DELETION_REQUESTED', 'DELETED_BY_ADMIN'];
const STALE_RUN_MS = 15 * 60 * 1000; // 15 minutes

// v1.11.13 — parse started_at as UTC. SQLite's datetime('now') returns a
// TZ-less UTC string ("2026-05-16 08:44:24"). Since #67 the oscar container
// runs TZ=Europe/Paris, so new Date("2026-05-16 08:44:24") was interpreted as
// Paris-local — making a run that started minutes ago look 1–2h old and
// wrongly flagging it stale (auto-cancelled on delete). Append 'Z' when the
// string carries no TZ marker so it parses as UTC regardless of container TZ.
function parseUtcTs(s) {
  if (!s) return NaN;
  if (/[Z]$/.test(s) || /[+-]\d\d:?\d\d$/.test(s)) return new Date(s).getTime();
  return new Date(String(s).replace(' ', 'T') + 'Z').getTime();
}
function isRunStale(runRow) {
  const startedAt = runRow.started_at ? parseUtcTs(runRow.started_at) : 0;
  return !runRow.started_at || (Date.now() - startedAt > STALE_RUN_MS);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Return the run row if it exists and is not permanently deleted.
 * companyId = null means platform-role caller (admin/certifier) — no tenant filter.
 *
 * v1.10.0 (issue #60): delegates to canUserSeeRun() — the consolidated
 * visibility helper that enforces:
 *   - tenant isolation (tester / test_manager scoped to own company)
 *   - administrator strict-mode (no read access to test data)
 *   - certifier per-run share gate (shared_with_certifier_at must be set
 *     AND the company-wide kill switch must not be flipped)
 * Returning null means "treat as not-found" — never disclose existence to
 * a user who shouldn't see the run.
 */
const { canUserSeeRun } = require('../helpers/run-access');
function validateRunOwnership(runId, _companyId, req) {
  if (!req || !req.user) return null;
  return canUserSeeRun(runId, req.user);
}

/**
 * Determine what status to restore a run to, using its stored previous_status
 * or falling back to exit_code inference.
 */
function inferRestoreStatus(run) {
  if (run.previous_status) return run.previous_status;
  if (run.exit_code === 0)  return 'COMPLETED';
  if (run.exit_code != null) return 'FAILED';
  return 'CANCELLED';
}

// ── POST /v1/runs ─────────────────────────────────────────────────────────────
router.post('/', runSubmitLimiter, (req, res) => {
  if (req.user.role === 'certification_user') {
    return res.status(403).json({ status: 403, title: 'Forbidden', detail: 'certification_user cannot start runs.' });
  }

  const targetCompanyId = isPlatformRole(req.user.role)
    ? (req.body && req.body.company_id ? req.body.company_id : req.companyId)
    : req.companyId;

  if (!targetCompanyId) {
    return res.status(400).json({
      status: 400,
      title: 'Bad Request',
      detail: 'company_id is required for platform users when creating runs.'
    });
  }

  const company = get('SELECT * FROM companies WHERE id = ?', [targetCompanyId]);
  if (!company) return res.status(404).json({ status: 404, title: 'Company not found.' });

  // Per-tester credentials (since v12) live on the requesting user's row.
  // The runner will read the same row when the job is dequeued; checking
  // here gives the operator an immediate field-level error instead of a
  // delayed run-failure.
  const user = get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!user) return res.status(404).json({ status: 404, title: 'User not found.' });

  const missing = [];
  if (!company.api_base) missing.push('OSDM API endpoint (set on the Company tab)');
  if (user.auth_mode === 'bearer' && !user.access_token_enc) {
    missing.push('Bearer token (your credentials)');
  }
  if (user.auth_mode === 'oauth2') {
    if (!user.token_url)         missing.push('OAuth2 token URL (your credentials)');
    if (!user.client_id_enc)     missing.push('OAuth2 client_id (your credentials)');
    if (!user.client_secret_enc) missing.push('OAuth2 client_secret (your credentials)');
    if (user.oauth_profile === 'sqills_extension' && !user.oauth_extra_enc) {
      missing.push('OAuth2 extra credential (your Sqills Basic auth value)');
    }
    if (user.oauth_profile === 'custom' && !user.oauth_custom_template) {
      missing.push('OAuth2 custom request template (your credentials)');
    }
  }
  if (!company.datafile_path || !fs.existsSync(company.datafile_path)) {
    missing.push('data file');
  }
  if (missing.length > 0) {
    return res.status(400).json({
      status: 400,
      title: 'Bad Request',
      detail: `Cannot start run — missing: ${missing.join(', ')}.`,
      missing
    });
  }

  // Read concurrent session limit from test framework config.
  // The config column is encrypted at rest (Phase 2 of issue #60) — it MUST be
  // colDecrypt()'d before JSON.parse, or parsing the ciphertext throws and the
  // limit silently falls back to 1, serialising every company's runs (the
  // concurrency bug). colDecrypt() passes legacy plaintext through unchanged.
  const tfRow = get('SELECT config FROM test_frameworks WHERE company_id = ?', [targetCompanyId]);
  let fwConfig = tfRow ? (() => { try { return JSON.parse(colDecrypt(tfRow.config)); } catch (_) { return {}; } })() : {};
  // Handle double-nested config (legacy: { config: { concurrentSessionLimit: N } })
  if (fwConfig.config && typeof fwConfig.config === 'object' && !Array.isArray(fwConfig.config)) {
    fwConfig = fwConfig.config;
  }
  const concurrentLimit = fwConfig.concurrentSessionLimit || 1;

  // ── Parallel mode: one run per scenario ──────────────────────────────────
  //
  // v1.11.5 fix: since v1.11.0 (Phase 2 of issue #60) the datafile on disk
  // is AES-256-GCM encrypted (OSCAR1 envelope). Reading it directly with
  // fs.readFileSync + JSON.parse returns the ciphertext and chokes on the
  // magic header ("Unexpected token 'O', \"OSCAR1...\""). Use the
  // decryptFromFile helper which handles both new (encrypted) and legacy
  // plaintext files transparently via the OSCAR1 magic-header check.
  let datafile;
  try {
    const { decryptFromFile } = require('../../utils/at-rest');
    datafile = JSON.parse(decryptFromFile(company.datafile_path).toString('utf8'));
  } catch (err) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'Could not parse data file: ' + err.message });
  }

  // Resolve scenariosToRun list
  const allCodes = (datafile.scenarios || []).map(s => s.code);
  let scenarioList;
  if (datafile.scenariosToRun === 'ALL') {
    scenarioList = allCodes;
  } else if (Array.isArray(datafile.scenariosToRun)) {
    scenarioList = datafile.scenariosToRun.filter(c => allCodes.includes(c));
  } else {
    scenarioList = allCodes;
  }

  if (scenarioList.length === 0) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'No scenarios to run. Check scenariosToRun in your data file.' });
  }

  const batchId = uuidv4();
  const runs = [];

  transaction(() => {
    for (const code of scenarioList) {
      const runId = uuidv4();
      dbRun(
        `INSERT INTO runs (id, company_id, user_id, status, auth_mode_used, api_base_used, datafile_hash_used, env_name_used, batch_id, scenario_code)
         VALUES (?, ?, ?, 'QUEUED', ?, ?, ?, ?, ?, ?)`,
        [runId, targetCompanyId, req.user.id, user.auth_mode, company.api_base, company.datafile_hash || null,
         `OTST_${company.slug}_Env`, batchId, code]
      );
      runs.push({ runId, code });
    }
  });

  // Enqueue all jobs (queue will respect concurrentLimit)
  for (const { runId, code } of runs) {
    queue.enqueue({
      runId,
      companyId:        targetCompanyId,
      scenarioOverride: code,
      concurrentLimit,
      batchId,
      scenarioCode:     code,
      userId:           req.user.id
    });
  }

  const createdRuns = all(
    `SELECT id, status, scenario_code, batch_id, queued_at FROM runs WHERE batch_id = ? ORDER BY queued_at ASC`,
    [batchId]
  );
  return res.status(202).json({ batch_id: batchId, parallel: true, concurrent_limit: concurrentLimit, runs: createdRuns });
});

// ── GET /v1/runs ──────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit  || '50',  10), 200);
  const offset = parseInt(req.query.offset || '0',  10);

  // Issue #60 (v1.10.0) — administrator role no longer reads test data, with
  // ONE narrow exception: the operational data-lifecycle queue. Admins must
  // be able to see the LIST of runs awaiting their decision (DELETION_REQUESTED
  // from testers, DELETED_BY_ADMIN flagged) so they can confirm purges or
  // restore. The list returns metadata only — when the admin tries to drill
  // into any single run, /v1/runs/:id returns 404 (canUserSeeRun blocks the
  // role). Aggregate counts live in /v1/admin/activity.
  if (req.user.role === 'administrator') {
    const adminRows = all(
      `SELECT r.id, r.company_id, c.name AS company_name, r.status,
              r.queued_at, r.started_at, r.completed_at, r.exit_code,
              r.deleted_by, r.previous_status, r.batch_id, r.scenario_code,
              u.email AS submitted_by
       FROM runs r
       JOIN users u ON u.id = r.user_id
       JOIN companies c ON c.id = r.company_id
       WHERE r.status IN ('DELETION_REQUESTED', 'DELETED_BY_ADMIN')
       ORDER BY r.queued_at DESC
       LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    const adminTotal = get(
      "SELECT COUNT(*) AS n FROM runs WHERE status IN ('DELETION_REQUESTED', 'DELETED_BY_ADMIN')"
    );
    return res.json({
      total: adminTotal.n, limit, offset, runs: adminRows,
      notice: 'Administrators see the data-lifecycle queue only (pending deletions, admin-flagged runs). Per-run content access was removed in v1.10.0 (issue #60). Use the Server Activity tab for aggregate counts.'
    });
  }

  const isPlatform = isPlatformRole(req.user.role);
  let rows, total;

  // Aggregate subquery fragments reused by both branches below.
  // LEFT JOINs avoid N+1 correlated subqueries (one scan per run row).
  const agg = `
       LEFT JOIN (
         SELECT run_id, COUNT(*) AS artifact_count
         FROM   run_artifacts
         GROUP  BY run_id
       ) ra ON ra.run_id = r.id
       LEFT JOIN (
         SELECT run_id,
                COUNT(*)                              AS scenario_count,
                GROUP_CONCAT(DISTINCT scenario_name)  AS scenario_names
         FROM   run_suites
         WHERE  scenario_name IS NOT NULL
         GROUP  BY run_id
       ) rs ON rs.run_id = r.id`;

  if (isPlatform && !req.companyId) {
    // Certifier list: per-run share gate (v1.10.0, issue #60). The
    // certifier sees ONLY runs the test_manager has explicitly shared.
    // v1.11.15: the company-wide kill-switch was removed — per-report
    // sharing (shared_with_certifier_at) is now the sole gate.
    // Administrators are short-circuited above.
    const certifierFilter = req.user.role === 'certification_user'
      ? 'AND r.shared_with_certifier_at IS NOT NULL'
      : '';
    rows = all(
      `SELECT r.id, r.company_id, c.name AS company_name, r.status,
              r.auth_mode_used, r.api_base_used, r.env_name_used,
              r.queued_at, r.started_at, r.completed_at, r.exit_code,
              r.deleted_by, r.previous_status, r.batch_id, r.scenario_code,
              u.email AS submitted_by,
              COALESCE(ra.artifact_count, 0) AS artifact_count,
              COALESCE(rs.scenario_count,  0) AS scenario_count,
              rs.scenario_names
       FROM runs r
       JOIN users u ON u.id = r.user_id
       JOIN companies c ON c.id = r.company_id${agg}
       WHERE r.status != 'DELETED' ${certifierFilter}
       ORDER BY r.queued_at DESC
       LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    total = get(
      `SELECT COUNT(*) AS n FROM runs r JOIN companies c ON c.id = r.company_id
       WHERE r.status != 'DELETED' ${certifierFilter}`
    );
  } else {
    // Company-scoped list. Visibility within a company depends on role:
    //   - test_manager → all runs in the company (they triage/own the
    //     company's test data and can delete any run; see bulk-delete).
    //   - plain tester (company_user) → ONLY their own runs (v1.11.13).
    //     A tester previously saw teammates' runs (company-scoped) but
    //     could only delete their own, which surfaced as a confusing
    //     "Not the run owner" toast and leaked who-ran-what across the
    //     team. Testers now see strictly what they submitted.
    // (administrator is short-circuited above into the lifecycle queue;
    //  certifier is handled in the platform-role branch.)
    const isElevatedViewer = req.user.role === 'test_manager' || req.user.role === 'administrator';
    const ownScope = isElevatedViewer ? '' : ' AND r.user_id = ?';
    const ownScopeCount = isElevatedViewer ? '' : ' AND user_id = ?';
    // Tester: hide DELETION_REQUESTED (they already "deleted" it) and permanently DELETED,
    // but show DELETED_BY_ADMIN (flagged) so they know admin has marked it
    rows = all(
      `SELECT r.id, r.company_id, c.name AS company_name, r.status,
              r.auth_mode_used, r.api_base_used, r.env_name_used,
              r.queued_at, r.started_at, r.completed_at, r.exit_code,
              r.user_id, r.deleted_by, r.batch_id, r.scenario_code,
              r.shared_with_certifier_at, r.shared_with_certifier_by,
              u.email AS submitted_by,
              COALESCE(ra.artifact_count, 0) AS artifact_count,
              COALESCE(rs.scenario_count,  0) AS scenario_count,
              rs.scenario_names
       FROM runs r
       JOIN users u ON u.id = r.user_id
       JOIN companies c ON c.id = r.company_id${agg}
       WHERE r.company_id = ?${ownScope} AND r.status NOT IN ('DELETION_REQUESTED', 'DELETED')
       ORDER BY r.queued_at DESC
       LIMIT ? OFFSET ?`,
      isElevatedViewer ? [req.companyId, limit, offset] : [req.companyId, req.user.id, limit, offset]
    );
    total = get(
      `SELECT COUNT(*) AS n FROM runs WHERE company_id = ?${ownScopeCount} AND status NOT IN ('DELETION_REQUESTED', 'DELETED')`,
      isElevatedViewer ? [req.companyId] : [req.companyId, req.user.id]
    );
  }

  return res.json({ total: total.n, limit, offset, runs: rows });
});

// ── POST /v1/runs/bulk-delete — tester soft-delete (→ DELETION_REQUESTED) ────
// NOTE: must be defined BEFORE /:id routes to avoid Express swallowing it
router.post('/bulk-delete', (req, res) => {
  if (req.user.role === 'certification_user') {
    return res.status(403).json({ status: 403, title: 'Forbidden', detail: 'Certifiers cannot delete runs.' });
  }

  const { run_ids } = req.body || {};
  if (!Array.isArray(run_ids) || run_ids.length === 0) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'run_ids must be a non-empty array.' });
  }
  if (run_ids.length > 50) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'Maximum 50 runs per bulk delete.' });
  }

  const isAdmin  = req.user.role === 'administrator';
  const isTestManager = req.user.role === 'test_manager';
  // test_manager has elevated privileges within their company (mirrors the
  // privilege they already have over /v1/company/users): can delete any run
  // in their own company, not only runs they personally started. Tenant
  // middleware has already constrained req.companyId to the test_manager's
  // company, so this check cannot reach across companies. Closes #34.
  const isElevated = isAdmin || isTestManager;
  // Since issue #60 Phase 1, the administrator role no longer reads
  // vendor test data — confirming deletes of content they cannot see is
  // a nonsensical step. Test_manager is the data owner for their
  // company, so their delete is now permanent (status='DELETED'), not
  // soft-deletion-requested. Testers keep the soft-delete safety net
  // (DELETION_REQUESTED) since they may delete by accident; their
  // test_manager will pick up the pending queue and confirm or restore.
  const newStatus = isAdmin
    ? 'DELETED_BY_ADMIN'
    : isTestManager
      ? 'DELETED'
      : 'DELETION_REQUESTED';

  const deleted  = [];
  const skipped  = [];
  const notFound = [];

  // Batch-fetch all requested runs in one query (avoids N+1)
  const placeholders = run_ids.map(() => '?').join(',');
  const allRuns = all(`SELECT * FROM runs WHERE id IN (${placeholders}) AND status != 'DELETED'`, run_ids);
  const runMap = new Map(allRuns.map(r => [r.id, r]));

  for (const id of run_ids) {
    let runRow = runMap.get(id);
    if (runRow && req.companyId && runRow.company_id !== req.companyId) runRow = null;
    if (!runRow) { notFound.push(id); continue; }

    if (runRow.status === 'QUEUED' || runRow.status === 'RUNNING') {
      // Auto-cancel stale runs (started more than 15 minutes ago, or never started)
      if (isRunStale(runRow)) {
        // Force-cancel the zombie run so it can be deleted
        dbRun(`UPDATE runs SET status = 'CANCELLED', completed_at = datetime('now') WHERE id = ?`, [id]);
        // Continue to delete it below
      } else {
        skipped.push({ id, reason: `Run is ${runRow.status} — cancel it first` });
        continue;
      }
    }
    if (DELETION_STATUSES.includes(runRow.status)) {
      skipped.push({ id, reason: `Run is already in deletion state (${runRow.status})` });
      continue;
    }
    if (!isElevated && runRow.user_id !== req.user.id) {
      skipped.push({ id, reason: 'Not the run owner' });
      continue;
    }
    deleted.push({ id, previousStatus: runRow.status });
  }

  if (deleted.length > 0) {
    transaction(() => {
      for (const { id, previousStatus } of deleted) {
        dbRun(
          `UPDATE runs SET status = ?, deleted_by = ?, previous_status = ? WHERE id = ?`,
          [newStatus, req.user.email, previousStatus, id]
        );
      }
    });
  }

  return res.json({ deleted: deleted.map(d => d.id), skipped, not_found: notFound, new_status: newStatus });
});

// ── Admin action handlers for bulk-admin-action ─────────────────────────────
const ADMIN_ACTION_HANDLERS = {
  soft_delete: (runRow, id) => {
    if (runRow.status === 'QUEUED' || runRow.status === 'RUNNING') {
      if (!isRunStale(runRow)) return { skip: true, reason: `Run is ${runRow.status} — cancel it first` };
      dbRun(`UPDATE runs SET status = 'CANCELLED', completed_at = datetime('now') WHERE id = ?`, [id]);
    }
    if (runRow.status === 'DELETED_BY_ADMIN') return { skip: true, reason: 'Already flagged as deleted by admin' };
    return { newStatus: 'DELETED_BY_ADMIN', previousStatus: runRow.status };
  },
  confirm_delete: (runRow, _id) => {
    if (runRow.status !== 'DELETION_REQUESTED') return { skip: true, reason: `Expected DELETION_REQUESTED, got ${runRow.status}` };
    return { newStatus: 'DELETED', previousStatus: runRow.status };
  },
  purge: (runRow, id) => {
    if (runRow.status === 'QUEUED' || runRow.status === 'RUNNING') {
      if (!isRunStale(runRow)) return { skip: true, reason: `Run is ${runRow.status} — cancel it first` };
      dbRun(`UPDATE runs SET status = 'CANCELLED', completed_at = datetime('now') WHERE id = ?`, [id]);
    }
    return { newStatus: 'DELETED', previousStatus: runRow.status };
  },
  restore: (runRow) => {
    if (!DELETION_STATUSES.includes(runRow.status)) return { skip: true, reason: `Run is ${runRow.status} — only DELETION_REQUESTED or DELETED_BY_ADMIN can be restored` };
    return { newStatus: inferRestoreStatus(runRow), previousStatus: runRow.status };
  },
};

// ── POST /v1/runs/bulk-admin-action — admin batch operations ─────────────────
router.post('/bulk-admin-action', (req, res) => {
  if (req.user.role !== 'administrator') {
    return res.status(403).json({ status: 403, title: 'Forbidden', detail: 'Only administrators can perform bulk admin actions.' });
  }

  const { action, run_ids } = req.body || {};
  const VALID_ACTIONS = ['soft_delete', 'confirm_delete', 'purge', 'restore'];
  if (!VALID_ACTIONS.includes(action)) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: `action must be one of: ${VALID_ACTIONS.join(', ')}` });
  }
  if (!Array.isArray(run_ids) || run_ids.length === 0) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'run_ids must be a non-empty array.' });
  }
  if (run_ids.length > 50) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'Maximum 50 runs per bulk action.' });
  }

  const processed = [];
  const skipped   = [];
  const notFound  = [];

  for (const id of run_ids) {
    const runRow = get("SELECT * FROM runs WHERE id = ? AND status != 'DELETED'", [id]);
    if (!runRow) { notFound.push(id); continue; }

    const result = ADMIN_ACTION_HANDLERS[action](runRow, id);
    if (result.skip) {
      skipped.push({ id, reason: result.reason });
      continue;
    }
    processed.push({ id, newStatus: result.newStatus, previousStatus: result.previousStatus });
  }

  if (processed.length > 0) {
    transaction(() => {
      for (const { id, newStatus, previousStatus } of processed) {
        if (newStatus === 'DELETED') {
          // Permanent — also clean up comparisons
          dbRun('DELETE FROM report_comparisons WHERE run_a_id = ? OR run_b_id = ?', [id, id]);
          dbRun(`UPDATE runs SET status = 'DELETED' WHERE id = ?`, [id]);
        } else if (DELETION_STATUSES.includes(previousStatus)) {
          // Restore: clear deletion tracking fields
          dbRun(
            `UPDATE runs SET status = ?, deleted_by = NULL, previous_status = NULL WHERE id = ?`,
            [newStatus, id]
          );
        } else {
          // soft_delete: record who flagged it
          dbRun(
            `UPDATE runs SET status = ?, deleted_by = ?, previous_status = ? WHERE id = ?`,
            [newStatus, req.user.email, previousStatus, id]
          );
        }
      }
    });
  }

  return res.json({
    action,
    processed: processed.map(p => ({ id: p.id, new_status: p.newStatus })),
    skipped,
    not_found: notFound
  });
});

// ── GET /v1/runs/queue-status ─────────────────────────────────────────────────
// Returns the current queue state for the authenticated user's company.
// Must be registered BEFORE /:id to avoid Express treating "queue-status" as an ID.
router.get('/queue-status', (req, res) => {
  const companyId = req.companyId || req.user.companyId;

  // Get concurrent limit from test framework config
  const tfRow = get('SELECT config FROM test_frameworks WHERE company_id = ?', [companyId]);
  let concurrentLimit = 1;
  if (tfRow) {
    // config is encrypted at rest — decrypt before parsing (see POST / above).
    try { concurrentLimit = JSON.parse(colDecrypt(tfRow.config)).concurrentSessionLimit || 1; } catch (_) {}
  }

  // Get all QUEUED + RUNNING runs for this company
  const runs = all(`
    SELECT r.id, r.status, r.scenario_code, r.batch_id, r.queued_at, r.started_at,
           u.email AS user_email
    FROM runs r
    JOIN users u ON u.id = r.user_id
    WHERE r.company_id = ? AND r.status IN ('QUEUED', 'RUNNING')
    ORDER BY r.queued_at ASC
  `, [companyId]);

  const running = runs.filter(r => r.status === 'RUNNING');
  const queued  = runs.filter(r => r.status === 'QUEUED');

  return res.json({
    company_id:       companyId,
    concurrent_limit: concurrentLimit,
    slots_used:       running.length,
    slots_available:  Math.max(0, concurrentLimit - running.length),
    runs: runs.map(r => ({
      id:              r.id,
      status:          r.status,
      scenario_code:   r.scenario_code,
      batch_id:        r.batch_id,
      user_email:      r.user_email,
      is_current_user: r.user_email === req.user.email,
      position:        r.status === 'QUEUED' ? queued.indexOf(r) + 1 : null,
      queued_at:       r.queued_at,
      started_at:      r.started_at
    }))
  });
});

// ── POST /v1/runs/stop-all ────────────────────────────────────────────────────
// Emergency stop: forcibly terminate active runs "hard but sure".
//   - QUEUED  → purged from the in-memory queue so they never start, then
//               marked CANCELLED.
//   - RUNNING → the Bruno child process is killed (SIGTERM → SIGKILL after a
//               grace period via runner.killRun), then marked CANCELLED.
// Scope (deliberately restrictive — only the platform admin can touch other
// users' runs):
//   - certification_user → 403 (cannot run or stop runs)
//   - company_user (tester) AND test_manager → only the runs THEY launched
//   - administrator → ALL active runs across EVERY company (platform-wide)
// There is no per-company "stop everyone's runs": the only cross-user power is
// the platform administrator's, and it spans the whole platform by design.
// Registered BEFORE /:id so Express doesn't treat "stop-all" as a run id.
router.post('/stop-all', (req, res) => {
  if (req.user.role === 'certification_user') {
    return res.status(403).json({ status: 403, title: 'Forbidden', detail: 'certification_user cannot stop runs.' });
  }

  const companyId = req.companyId || req.user.companyId;
  const isAdmin   = req.user.role === 'administrator';
  const scope     = isAdmin ? 'platform' : 'own';

  // Active = QUEUED or RUNNING. Admin → platform-wide (no company/user filter);
  // everyone else → only the runs they personally started. enforceTenant has
  // already hard-locked a non-admin's company_id to their own; we also pin
  // user_id, so a tester or test_manager can never reach a teammate's run.
  const activeRuns = isAdmin
    ? all(`SELECT id, status FROM runs WHERE status IN ('QUEUED','RUNNING')`)
    : all(`SELECT id, status FROM runs WHERE company_id = ? AND user_id = ? AND status IN ('QUEUED','RUNNING')`,
        [companyId, req.user.id]);

  if (activeRuns.length === 0) {
    return res.json({ stopped: 0, running_cancelled: 0, queued_cancelled: 0, processes_killed: 0, scope });
  }

  const ids = new Set(activeRuns.map(r => r.id));

  // 1. Drop matching QUEUED jobs from the in-memory queue so the next drain
  //    cannot launch a run we are about to cancel.
  queue.purge(job => ids.has(job.runId));

  // 2. Kill running processes + mark every targeted run CANCELLED. The DB write
  //    is guarded so a run that finished between the SELECT and now is left as
  //    its real terminal status.
  let processesKilled = 0;
  let queuedCancelled = 0;
  let runningCancelled = 0;
  transaction(() => {
    for (const r of activeRuns) {
      if (r.status === 'RUNNING') {
        if (runner.killRun(r.id)) processesKilled++;
        runningCancelled++;
      } else {
        queuedCancelled++;
      }
      dbRun(
        `UPDATE runs SET status = 'CANCELLED', completed_at = datetime('now'), error_message = ?
         WHERE id = ? AND status IN ('QUEUED','RUNNING')`,
        [`Emergency-stopped by ${req.user.email}`, r.id]
      );
    }
  });

  // Audit is best-effort — never let a logging hiccup block the stop.
  try {
    auditLog(req.user.id, companyId || null, req.user.email,
      `emergency_stop:${scope}:running=${runningCancelled},queued=${queuedCancelled}`);
  } catch (_) { /* ignore */ }

  return res.json({
    stopped:          activeRuns.length,
    running_cancelled: runningCancelled,
    queued_cancelled:  queuedCancelled,
    processes_killed:  processesKilled,
    scope
  });
});

// ── GET /v1/runs/batch/:batchId ──────────────────────────────────────────────
// Returns all runs in a batch with aggregated status.
router.get('/batch/:batchId', (req, res) => {
  const companyId = req.companyId || req.user.companyId;
  const batchFilter = companyId
    ? 'WHERE batch_id = ? AND company_id = ?'
    : 'WHERE batch_id = ?';
  const params = companyId ? [req.params.batchId, companyId] : [req.params.batchId];

  const runs = all(`
    SELECT id, status, scenario_code, queued_at, started_at, completed_at, exit_code
    FROM runs ${batchFilter}
    ORDER BY queued_at ASC
  `, params);

  if (runs.length === 0) {
    return res.status(404).json({ status: 404, title: 'Batch not found.' });
  }

  return res.json({
    batch_id:  req.params.batchId,
    total:     runs.length,
    completed: runs.filter(r => r.status === 'COMPLETED').length,
    running:   runs.filter(r => r.status === 'RUNNING').length,
    queued:    runs.filter(r => r.status === 'QUEUED').length,
    failed:    runs.filter(r => r.status === 'FAILED').length,
    cancelled: runs.filter(r => r.status === 'CANCELLED').length,
    runs
  });
});

// ── GET /v1/runs/batch/:batchId/reports.zip (#405) ───────────────────────────
// One-click bulk download: every run's artifacts in a batch, bundled into one
// ZIP named {sandbox}_{date}_batch-{shortid}.zip. Strictly company-scoped; each
// artifact is decrypted at-rest and added under a scenario-named entry.
const bulkDownloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many bulk downloads in a short window — please wait a moment.' }
});
router.get('/batch/:batchId/reports.zip', bulkDownloadLimiter, (req, res) => {
  const companyId = req.companyId || req.user.companyId;
  if (!companyId) {
    return res.status(403).json({ status: 403, title: 'Forbidden', detail: 'A company context is required to download batch reports.' });
  }

  const runs = all(
    `SELECT id, scenario_code, env_name_used, queued_at, started_at
       FROM runs WHERE batch_id = ? AND company_id = ? ORDER BY queued_at ASC`,
    [req.params.batchId, companyId]
  );
  if (!runs.length) return res.status(404).json({ status: 404, title: 'Batch not found.' });

  const { decryptFromFile } = require('../../utils/at-rest');
  const { buildZip }        = require('../../utils/zip');
  const SAFE_ARTIFACTS_DIR  = path.resolve(__dirname, '../../../data/artifacts');
  const sanitize = s => String(s || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '');

  const entries = [];
  const used = new Set();
  for (const r of runs) {
    const arts = all(`SELECT id, type, filename, path FROM run_artifacts WHERE run_id = ?`, [r.id]);
    for (const a of arts) {
      const safePath = path.resolve(a.path || '');
      if (!safePath.startsWith(SAFE_ARTIFACTS_DIR + path.sep) || !fs.existsSync(safePath)) continue;
      let plaintext;
      try { plaintext = decryptFromFile(safePath); } catch (_e) { continue; }   // skip an unreadable artifact, keep the rest
      const scenario = sanitize(r.scenario_code) || ('run-' + String(r.id).slice(0, 8));
      const ext = ((a.filename && a.filename.match(/\.([A-Za-z0-9]+)$/)) || [])[1] || (a.type === 'html_report' ? 'html' : 'json');
      let name = `${scenario}.${ext}`;
      if (used.has(name)) {
        const short = String(r.id).slice(0, 8);
        let n = 1;
        do { name = `${scenario}_${short}${n > 1 ? '_' + n : ''}.${ext}`; n++; } while (used.has(name));
      }
      used.add(name);
      entries.push({ name, data: plaintext });
    }
  }
  if (!entries.length) {
    return res.status(404).json({ status: 404, title: 'No reports', detail: 'No downloadable artifacts found for this batch yet.' });
  }

  const sandbox = sanitize((runs[0].env_name_used || 'sandbox').replace(/^OTST[_-]?/i, '').replace(/[_-]?Env$/i, '')) || 'sandbox';
  const date    = String(runs[0].started_at || runs[0].queued_at || '').slice(0, 10) || 'run';
  const zipName = `${sandbox}_${date}_batch-${String(req.params.batchId).slice(0, 8)}.zip`;

  let zip;
  try { zip = buildZip(entries); }
  catch (_e) { return res.status(500).json({ status: 500, title: 'Zip failed', detail: 'Could not build the report archive.' }); }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
  res.setHeader('Content-Length', String(zip.length));
  return res.end(zip);
});

// ── GET /v1/runs/:id ──────────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const runRow = validateRunOwnership(req.params.id, req.companyId, req);
  if (!runRow) return res.status(404).json({ status: 404, title: 'Run not found.' });
  return res.json(runRow);
});

// ── GET /v1/runs/:id/logs ─────────────────────────────────────────────────────
router.get('/:id/logs', (req, res) => {
  const runRow = validateRunOwnership(req.params.id, req.companyId, req);
  if (!runRow) return res.status(404).json({ status: 404, title: 'Run not found.' });

  const since  = req.query.since_id ? parseInt(req.query.since_id, 10) : 0;

  // Build query with optional filters (backward-compatible).
  // NOTE (Phase 2 of issue #60, v1.11.0): the `message` column is now
  // encrypted at rest. Server-side LIKE no longer matches encrypted
  // ciphertext, so when ?search= is present we fetch a wider window and
  // filter post-decrypt in Node. Metadata filters (category/phase/suite)
  // remain plaintext and continue to work in SQL — that's the whole point
  // of leaving structural columns unencrypted.
  let sql = `SELECT id, ts, level, message, category, phase, suite_name, request_name, http_status
             FROM run_events WHERE run_id = ? AND id > ?`;
  const params = [req.params.id, since];

  if (req.query.category) { sql += ' AND category = ?'; params.push(req.query.category); }
  if (req.query.phase)    { sql += ' AND phase = ?';    params.push(req.query.phase); }
  if (req.query.suite)    { sql += ' AND suite_name = ?'; params.push(req.query.suite); }

  // When searching, pull a wider window (5×) and post-filter in Node after
  // decrypting message. Caps the fetch at 5000 rows so a runaway log
  // doesn't blow up memory.
  const wantSearch = !!req.query.search;
  const sqlLimit = wantSearch ? 5000 : 500;
  sql += ` ORDER BY id ASC LIMIT ${sqlLimit}`;

  const rows = all(sql, params);
  // Transparent decrypt of the message column (handles legacy plaintext).
  const events = rows.map(r => ({ ...r, message: colDecrypt(r.message) }));

  let filtered = events;
  if (wantSearch) {
    const needle = String(req.query.search).toLowerCase();
    filtered = events.filter(e => String(e.message || '').toLowerCase().includes(needle)).slice(0, 500);
  }

  // #343 followup (v1.11.117): tell the client whether more rows are waiting
  // behind the cursor. The SQL fetch is capped (500 / 5000-when-searching);
  // a full page means the backlog probably continues. Without this flag the
  // dashboard stopped polling the moment the run reached a terminal status
  // and silently stranded everything past the first page — a FAILED run
  // opened after the fact showed only its first ~500 log lines ("log stops
  // before the offer request" symptom).
  const hasMore = rows.length === sqlLimit;

  return res.json({ run_id: req.params.id, status: runRow.status, events: filtered, has_more: hasMore });
});

// ── GET /v1/runs/:id/assertions ──────────────────────────────────────────────
// Returns structured assertion results in a 3-level hierarchy: suites → requests → assertions.
// Supports filtering by status, category, domain, and suite.
router.get('/:id/assertions', (req, res) => {
  const runRow = validateRunOwnership(req.params.id, req.companyId, req);
  if (!runRow) return res.status(404).json({ status: 404, title: 'Run not found.' });

  const { status: statusFilter, category, domain, suite } = req.query;

  // Get suites
  let suiteSql = 'SELECT * FROM run_suites WHERE run_id = ?';
  const suiteParams = [req.params.id];
  if (suite) { suiteSql += ' AND suite_name = ?'; suiteParams.push(suite); }
  suiteSql += ' ORDER BY id ASC';
  const suites = all(suiteSql, suiteParams);

  // Build nested response.
  // Phase 2 of issue #60 (v1.11.0): HTTP body + header columns are
  // encrypted at rest. colDecrypt() handles both new (encrypted) and
  // legacy plaintext rows transparently — we apply it to every output
  // request row so the UI/Report Builder gets readable content.
  const result = suites.map(s => {
    const requests = all('SELECT * FROM run_requests WHERE suite_id = ? ORDER BY id ASC', [s.id]);

    const enrichedRequests = requests.map(r => {
      let assertSql = 'SELECT * FROM run_assertions WHERE request_id = ?';
      const assertParams = [r.id];
      if (statusFilter === 'passed') { assertSql += ' AND passed = 1'; }
      else if (statusFilter === 'failed') { assertSql += ' AND passed = 0'; }
      if (category) { assertSql += ' AND category = ?'; assertParams.push(category); }
      if (domain) { assertSql += ' AND domain = ?'; assertParams.push(domain); }
      assertSql += ' ORDER BY id ASC';
      const assertions = all(assertSql, assertParams);
      return {
        ...r,
        request_body:     colDecrypt(r.request_body),
        request_headers:  colDecrypt(r.request_headers),
        response_body:    colDecrypt(r.response_body),
        response_headers: colDecrypt(r.response_headers),
        context:          colDecrypt(r.context),
        assertions
      };
    });

    return { ...s, requests: enrichedRequests };
  });

  // Summary
  const summary = get(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) as passed,
           SUM(CASE WHEN passed = 0 THEN 1 ELSE 0 END) as failed
    FROM run_assertions WHERE run_id = ?
  `, [req.params.id]) || { total: 0, passed: 0, failed: 0 };

  // Category breakdown
  const byCategory = all(`
    SELECT category, COUNT(*) as total,
           SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) as passed,
           SUM(CASE WHEN passed = 0 THEN 1 ELSE 0 END) as failed
    FROM run_assertions WHERE run_id = ?
    GROUP BY category ORDER BY failed DESC, total DESC
  `, [req.params.id]);

  // Domain breakdown
  const byDomain = all(`
    SELECT domain, COUNT(*) as total,
           SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) as passed,
           SUM(CASE WHEN passed = 0 THEN 1 ELSE 0 END) as failed
    FROM run_assertions WHERE run_id = ?
    GROUP BY domain ORDER BY failed DESC, total DESC
  `, [req.params.id]);

  return res.json({
    run_id: req.params.id,
    summary,
    by_category: byCategory,
    by_domain: byDomain,
    suites: result
  });
});

// ── GET /v1/runs/:id/requests ─────────────────────────────────────────────────
// HTTP traffic listing for a run. Returns one row per request_name with
// metadata only (no bodies) so the caller can render a navigable list.
// Bodies are loaded lazily via GET /v1/runs/:id/requests/:reqId.
//
// Query params:
//   ?status_filter=failed   — only requests that failed (4xx/5xx) or had
//                             at least one failed assertion
//   ?status_filter=non2xx   — only HTTP non-2xx (regardless of assertions)
//   ?status_filter=all      — everything (default)
//   ?scenario=CODE          — limit to one scenario (matches run_suites.scenario_name)
router.get('/:id/requests', (req, res) => {
  const runRow = validateRunOwnership(req.params.id, req.companyId, req);
  if (!runRow) return res.status(404).json({ status: 404, title: 'Run not found.' });

  const { status_filter: filter = 'all', scenario } = req.query;

  let sql = `
    SELECT rq.id,
           rq.suite_id,
           s.scenario_name,
           s.suite_name,
           rq.request_name,
           rq.http_method,
           rq.http_url,
           rq.http_status,
           rq.duration_ms,
           rq.parent_request_id,
           rq.passed,
           rq.failed,
           CASE WHEN rq.request_body  IS NOT NULL THEN 1 ELSE 0 END AS has_request_body,
           CASE WHEN rq.response_body IS NOT NULL THEN 1 ELSE 0 END AS has_response_body
      FROM run_requests rq
      JOIN run_suites s ON s.id = rq.suite_id
     WHERE rq.run_id = ?`;
  const params = [req.params.id];

  if (scenario) { sql += ' AND s.scenario_name = ?'; params.push(scenario); }
  if (filter === 'failed') {
    // Failed = HTTP non-2xx OR at least one failed assertion on this request
    sql += ' AND (rq.http_status IS NULL OR rq.http_status < 200 OR rq.http_status >= 300 OR rq.failed > 0)';
  } else if (filter === 'non2xx') {
    sql += ' AND (rq.http_status IS NULL OR rq.http_status < 200 OR rq.http_status >= 300)';
  }
  sql += ' ORDER BY rq.id ASC';

  const requests = all(sql, params);
  return res.json({
    run_id: req.params.id,
    total: requests.length,
    filter,
    scenario: scenario || null,
    requests
  });
});

// ── GET /v1/runs/:id/requests/:reqId ─────────────────────────────────────────
// Full HTTP traffic for a single request: bodies + headers + chain links.
// Bodies returned as strings exactly as stored (JSON or truncated marker);
// the UI parses them client-side so we don't fail if a vendor returns
// non-JSON. Parent and children are returned as compact summaries (no bodies)
// so the client can render "← parent" / "→ children" navigation.
router.get('/:id/requests/:reqId', (req, res) => {
  const runRow = validateRunOwnership(req.params.id, req.companyId, req);
  if (!runRow) return res.status(404).json({ status: 404, title: 'Run not found.' });

  // Tenant scope: the request row must belong to this run (which we just
  // validated belongs to the caller).
  const reqRow = get(
    `SELECT rq.*, s.scenario_name, s.suite_name
       FROM run_requests rq
       JOIN run_suites s ON s.id = rq.suite_id
      WHERE rq.id = ? AND rq.run_id = ?`,
    [req.params.reqId, req.params.id]
  );
  if (!reqRow) return res.status(404).json({ status: 404, title: 'Request not found.' });

  // Decrypt the at-rest-encrypted body + header + context columns before
  // shaping the response (Phase 2 of issue #60). Legacy plaintext rows
  // pass through colDecrypt() unchanged.
  reqRow.request_body     = colDecrypt(reqRow.request_body);
  reqRow.request_headers  = colDecrypt(reqRow.request_headers);
  reqRow.response_body    = colDecrypt(reqRow.response_body);
  reqRow.response_headers = colDecrypt(reqRow.response_headers);
  reqRow.context          = colDecrypt(reqRow.context);

  // Parent (if any) — compact summary
  let parent = null;
  if (reqRow.parent_request_id) {
    parent = get(
      `SELECT rq.id, rq.request_name, rq.http_method, rq.http_url, rq.http_status,
              s.scenario_name
         FROM run_requests rq
         JOIN run_suites s ON s.id = rq.suite_id
        WHERE rq.id = ? AND rq.run_id = ?`,
      [reqRow.parent_request_id, req.params.id]
    );
  }

  // Children — requests pointing to this one as their parent
  const children = all(
    `SELECT rq.id, rq.request_name, rq.http_method, rq.http_url, rq.http_status,
            s.scenario_name
       FROM run_requests rq
       JOIN run_suites s ON s.id = rq.suite_id
      WHERE rq.parent_request_id = ? AND rq.run_id = ?
      ORDER BY rq.id ASC`,
    [reqRow.id, req.params.id]
  );

  return res.json({
    request: reqRow,
    parent,
    children
  });
});

// ── GET /v1/runs/:id/artifacts ────────────────────────────────────────────────
router.get('/:id/artifacts', (req, res) => {
  const runRow = validateRunOwnership(req.params.id, req.companyId, req);
  if (!runRow) return res.status(404).json({ status: 404, title: 'Run not found.' });

  const artifacts = all(`SELECT id, type, filename FROM run_artifacts WHERE run_id = ?`, [req.params.id]);
  return res.json({ run_id: req.params.id, artifacts });
});

// ── GET /v1/runs/:id/artifacts/:aid ──────────────────────────────────────────
router.get('/:id/artifacts/:aid', (req, res) => {
  const runRow = validateRunOwnership(req.params.id, req.companyId, req);
  if (!runRow) return res.status(404).json({ status: 404, title: 'Run not found.' });

  const artifact = get(`SELECT * FROM run_artifacts WHERE id = ? AND run_id = ?`, [req.params.aid, req.params.id]);
  if (!artifact) return res.status(404).json({ status: 404, title: 'Artifact not found.' });

  // Security: verify artifact path is inside the artifacts directory (prevent path traversal)
  const SAFE_ARTIFACTS_DIR = path.resolve(__dirname, '../../../data/artifacts');
  const safePath = path.resolve(artifact.path);
  if (!safePath.startsWith(SAFE_ARTIFACTS_DIR + path.sep)) {
    return res.status(403).json({ status: 403, title: 'Forbidden', detail: 'Artifact path outside allowed directory.' });
  }
  if (!fs.existsSync(safePath)) return res.status(404).json({ status: 404, title: 'Artifact file missing on server.' });

  // Phase 2 of issue #60 (v1.11.0) — artifacts are encrypted at rest. The
  // helper handles both new (encrypted) and legacy plaintext files
  // transparently via the OSCAR1 magic-header check.
  const { decryptFromFile } = require('../../utils/at-rest');
  let plaintext;
  try { plaintext = decryptFromFile(safePath); }
  catch (err) {
    return res.status(500).json({ status: 500, title: 'Decryption failed', detail: err.message });
  }

  const mime = artifact.type === 'html_report' ? 'text/html' : 'application/json';
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `inline; filename="${artifact.filename}"`);
  res.setHeader('Content-Length', String(plaintext.length));
  return res.end(plaintext);
});

// ── POST /v1/runs/:id/share — share THIS run with certifiers (v1.10.0) ──────
// Test manager opt-in: mark a single completed run as visible to certifiers.
// As of v1.11.15 this is the SOLE certifier-visibility mechanism — the old
// company-wide share_reports_with_certifier toggle was removed, so a run is
// certifier-visible iff shared_with_certifier_at IS NOT NULL. Driven from the
// dashboard per-row share control (and still available on the run-detail page).
//
// Restrictions:
//   - Only test_manager role of the run's owning company can share.
//   - Run must be in a terminal status (COMPLETED / FAILED / CANCELLED).
//     Sharing in-progress runs is meaningless and would leak partial state.
//
// Audit-logged with the run id and the actor's email.
router.post('/:id/share', (req, res) => {
  if (req.user.role !== 'test_manager') {
    return res.status(403).json({ status: 403, title: 'Forbidden',
      detail: 'Only test_manager can share runs with certifiers.' });
  }
  const runRow = get('SELECT * FROM runs WHERE id = ?', [req.params.id]);
  if (!runRow || runRow.status === 'DELETED') {
    return res.status(404).json({ status: 404, title: 'Run not found.' });
  }
  // Tenant scope: a test_manager can only share their OWN company's runs.
  if (runRow.company_id !== req.user.companyId) {
    return res.status(404).json({ status: 404, title: 'Run not found.' });
  }
  if (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(runRow.status)) {
    return res.status(409).json({ status: 409, title: 'Conflict',
      detail: `Run is ${runRow.status} — sharing is only allowed once a run reaches a terminal status.` });
  }

  dbRun(
    `UPDATE runs
        SET shared_with_certifier_at = datetime('now'),
            shared_with_certifier_by = ?
      WHERE id = ?`,
    [req.user.email, req.params.id]
  );
  auditLog(req.user.id, runRow.company_id, req.user.email, `run_shared_with_certifier:${req.params.id}`);
  const updated = get('SELECT id, shared_with_certifier_at, shared_with_certifier_by FROM runs WHERE id = ?', [req.params.id]);
  return res.json({ ok: true, run: updated });
});

// ── DELETE /v1/runs/:id/share — revoke certifier access to THIS run ──────────
// Test manager unshare: certifiers immediately lose access. Audit-logged.
router.delete('/:id/share', (req, res) => {
  if (req.user.role !== 'test_manager') {
    return res.status(403).json({ status: 403, title: 'Forbidden',
      detail: 'Only test_manager can revoke certifier access.' });
  }
  const runRow = get('SELECT * FROM runs WHERE id = ?', [req.params.id]);
  if (!runRow || runRow.status === 'DELETED' || runRow.company_id !== req.user.companyId) {
    return res.status(404).json({ status: 404, title: 'Run not found.' });
  }
  dbRun(
    `UPDATE runs SET shared_with_certifier_at = NULL, shared_with_certifier_by = NULL WHERE id = ?`,
    [req.params.id]
  );
  auditLog(req.user.id, runRow.company_id, req.user.email, `run_unshared_with_certifier:${req.params.id}`);
  return res.json({ ok: true, run: { id: req.params.id, shared_with_certifier_at: null } });
});

// ── DELETE /v1/runs/:id/cancel ────────────────────────────────────────────────
router.delete('/:id/cancel', (req, res) => {
  if (req.user.role === 'certification_user') {
    return res.status(403).json({ status: 403, title: 'Forbidden', detail: 'certification_user cannot cancel runs.' });
  }

  const runRow = validateRunOwnership(req.params.id, req.companyId, req);
  if (!runRow) return res.status(404).json({ status: 404, title: 'Run not found.' });

  if (runRow.status !== 'QUEUED') {
    return res.status(409).json({ status: 409, title: 'Conflict', detail: `Cannot cancel a run with status ${runRow.status}.` });
  }

  dbRun(`UPDATE runs SET status = 'CANCELLED', completed_at = datetime('now') WHERE id = ?`, [req.params.id]);
  return res.json({ id: req.params.id, status: 'CANCELLED' });
});

// ── DELETE /v1/runs/:id — soft-delete ─────────────────────────────────────────
// company_user → DELETION_REQUESTED (pending admin confirmation)
// administrator → DELETED_BY_ADMIN  (flagged, still visible to tester)
router.delete('/:id', (req, res) => {
  if (req.user.role === 'certification_user') {
    return res.status(403).json({ status: 403, title: 'Forbidden', detail: 'Certifiers cannot delete runs.' });
  }

  const isAdmin = req.user.role === 'administrator';
  const isTestManager = req.user.role === 'test_manager';
  // See bulk-delete handler (#34): test_manager has elevated privileges
  // within their company. Tenant middleware constrains req.companyId so
  // cross-company deletion is impossible regardless of role.
  const isElevated = isAdmin || isTestManager;
  // Issue #60 (v1.10+): admin can no longer SEE run content (canUserSeeRun
  // returns null for admin), but admin still operates on the data lifecycle
  // — flagging runs as DELETED_BY_ADMIN, purging on confirmation, etc.
  // Look up the run directly for admin's lifecycle ops, bypassing the
  // content-access guard. The metadata exposure (status, company, user) is
  // narrower than what admin already sees on /v1/runs (lifecycle queue) so
  // no new information is disclosed.
  const runRow = isAdmin
    ? get("SELECT * FROM runs WHERE id = ? AND status != 'DELETED'", [req.params.id])
    : validateRunOwnership(req.params.id, req.companyId, req);
  if (!runRow) return res.status(404).json({ status: 404, title: 'Run not found.' });

  if (runRow.status === 'QUEUED' || runRow.status === 'RUNNING') {
    // Auto-cancel stale runs (>15 min old or never started)
    if (!isRunStale(runRow)) {
      return res.status(409).json({ status: 409, title: 'Conflict', detail: `Cannot delete an active run (${runRow.status}). Cancel it first.` });
    }
    dbRun(`UPDATE runs SET status = 'CANCELLED', completed_at = datetime('now') WHERE id = ?`, [req.params.id]);
  }
  if (DELETION_STATUSES.includes(runRow.status)) {
    return res.status(409).json({ status: 409, title: 'Conflict', detail: `Run is already in deletion state (${runRow.status}).` });
  }
  if (!isElevated && runRow.user_id !== req.user.id) {
    return res.status(403).json({ status: 403, title: 'Forbidden', detail: 'Testers can only delete their own runs.' });
  }

  // Since issue #60 Phase 1, admin doesn't read vendor data, so confirming
  // soft-deletes admin can't see is a stale workflow. Test_manager is the
  // data owner — their delete is permanent. Testers keep DELETION_REQUESTED
  // (their test_manager picks up the queue and confirms / restores).
  const newStatus = isAdmin
    ? 'DELETED_BY_ADMIN'
    : isTestManager
      ? 'DELETED'
      : 'DELETION_REQUESTED';
  dbRun(
    `UPDATE runs SET status = ?, deleted_by = ?, previous_status = ? WHERE id = ?`,
    [newStatus, req.user.email, runRow.status, req.params.id]
  );

  return res.json({ id: req.params.id, status: newStatus });
});

module.exports = router;
