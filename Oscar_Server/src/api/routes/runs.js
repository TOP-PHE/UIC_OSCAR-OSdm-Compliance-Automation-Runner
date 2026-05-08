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
const { v4: uuidv4 } = require('uuid');
const { get, all, run: dbRun, transaction } = require('../../db/db');
const { requireAuth, isPlatformRole } = require('../middleware/auth');
const { enforceTenant } = require('../middleware/tenant');
const queue = require('../../worker/queue');

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

function isRunStale(runRow) {
  const startedAt = runRow.started_at ? new Date(runRow.started_at).getTime() : 0;
  return !runRow.started_at || (Date.now() - startedAt > STALE_RUN_MS);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Return the run row if it exists and is not permanently deleted.
 * companyId = null means platform-role caller (admin/certifier) — no tenant filter.
 *
 * Pass `req` (optional) to apply the v15 certifier privacy guard: a
 * certification_user accessing a run from a company that opted out of
 * sharing is treated as a 404 (we don't disclose existence to certifiers
 * who shouldn't see the company's data at all).
 */
function validateRunOwnership(runId, companyId, req) {
  let row;
  if (!companyId) {
    row = get("SELECT * FROM runs WHERE id = ? AND status != 'DELETED'", [runId]);
  } else {
    row = get("SELECT * FROM runs WHERE id = ? AND company_id = ? AND status != 'DELETED'", [runId, companyId]);
  }
  if (!row) return null;
  // v15 certifier privacy guard
  if (req && req.user && req.user.role === 'certification_user') {
    const c = get('SELECT share_reports_with_certifier FROM companies WHERE id = ?', [row.company_id]);
    // SQLite stores BOOLEAN as INTEGER (0/1); `=== false` was unreachable (Sonar S3403).
    if (c && c.share_reports_with_certifier === 0) {
      return null;   // hide existence — same shape as "not found"
    }
  }
  return row;
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

  // Read concurrent session limit from test framework config
  const tfRow = get('SELECT config FROM test_frameworks WHERE company_id = ?', [targetCompanyId]);
  let fwConfig = tfRow ? (() => { try { return JSON.parse(tfRow.config); } catch (_) { return {}; } })() : {};
  // Handle double-nested config (legacy: { config: { concurrentSessionLimit: N } })
  if (fwConfig.config && typeof fwConfig.config === 'object' && !Array.isArray(fwConfig.config)) {
    fwConfig = fwConfig.config;
  }
  const concurrentLimit = fwConfig.concurrentSessionLimit || 1;

  // ── Parallel mode: one run per scenario ──────────────────────────────────
  let datafile;
  try {
    datafile = JSON.parse(fs.readFileSync(company.datafile_path, 'utf8'));
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
    // Admin / certifier: see everything except permanently deleted.
    //
    // Certifier-only restriction (v15): exclude runs from companies that
    // have opted out of certifier sharing. Administrators are unaffected.
    const certifierFilter = req.user.role === 'certification_user'
      ? 'AND c.share_reports_with_certifier = 1'
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
    // Tester: hide DELETION_REQUESTED (they already "deleted" it) and permanently DELETED,
    // but show DELETED_BY_ADMIN (flagged) so they know admin has marked it
    rows = all(
      `SELECT r.id, r.company_id, c.name AS company_name, r.status,
              r.auth_mode_used, r.api_base_used, r.env_name_used,
              r.queued_at, r.started_at, r.completed_at, r.exit_code,
              r.user_id, r.deleted_by, r.batch_id, r.scenario_code,
              u.email AS submitted_by,
              COALESCE(ra.artifact_count, 0) AS artifact_count,
              COALESCE(rs.scenario_count,  0) AS scenario_count,
              rs.scenario_names
       FROM runs r
       JOIN users u ON u.id = r.user_id
       JOIN companies c ON c.id = r.company_id${agg}
       WHERE r.company_id = ? AND r.status NOT IN ('DELETION_REQUESTED', 'DELETED')
       ORDER BY r.queued_at DESC
       LIMIT ? OFFSET ?`,
      [req.companyId, limit, offset]
    );
    total = get(
      "SELECT COUNT(*) AS n FROM runs WHERE company_id = ? AND status NOT IN ('DELETION_REQUESTED', 'DELETED')",
      [req.companyId]
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
  const newStatus = isAdmin ? 'DELETED_BY_ADMIN' : 'DELETION_REQUESTED';

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
    if (!isAdmin && runRow.user_id !== req.user.id) {
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
    try { concurrentLimit = JSON.parse(tfRow.config).concurrentSessionLimit || 1; } catch (_) {}
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

  // Build query with optional filters (backward-compatible)
  let sql = `SELECT id, ts, level, message, category, phase, suite_name, request_name, http_status
             FROM run_events WHERE run_id = ? AND id > ?`;
  const params = [req.params.id, since];

  if (req.query.category) { sql += ' AND category = ?'; params.push(req.query.category); }
  if (req.query.phase)    { sql += ' AND phase = ?';    params.push(req.query.phase); }
  if (req.query.suite)    { sql += ' AND suite_name = ?'; params.push(req.query.suite); }
  if (req.query.search)   { sql += ' AND message LIKE ?'; params.push(`%${req.query.search}%`); }

  sql += ' ORDER BY id ASC LIMIT 500';
  const events = all(sql, params);
  return res.json({ run_id: req.params.id, status: runRow.status, events });
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

  // Build nested response
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
      return { ...r, assertions };
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

  const mime = artifact.type === 'html_report' ? 'text/html' : 'application/json';
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `inline; filename="${artifact.filename}"`);
  fs.createReadStream(safePath).pipe(res);
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
  const runRow  = validateRunOwnership(req.params.id, req.companyId, req);
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
  if (!isAdmin && runRow.user_id !== req.user.id) {
    return res.status(403).json({ status: 403, title: 'Forbidden', detail: 'Testers can only delete their own runs.' });
  }

  const newStatus = isAdmin ? 'DELETED_BY_ADMIN' : 'DELETION_REQUESTED';
  dbRun(
    `UPDATE runs SET status = ?, deleted_by = ?, previous_status = ? WHERE id = ?`,
    [newStatus, req.user.email, runRow.status, req.params.id]
  );

  return res.json({ id: req.params.id, status: newStatus });
});

module.exports = router;
