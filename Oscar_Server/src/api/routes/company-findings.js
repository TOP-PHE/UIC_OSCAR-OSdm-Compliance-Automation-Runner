// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * company-findings.js — "Test Findings & Open Points" routes
 *
 * A per-test-system, threaded conformance dialogue. OSCAR's analysis opens a
 * finding (observation + its reading of the spec); the test team replies on the
 * thread and settles a category/severity. Deliberately soft-worded — a finding
 * may be the provider's deviation OR OSCAR's own bug, decided by the dialogue.
 *
 *   GET    /v1/company/findings              — list findings (+ comment counts)
 *   GET    /v1/company/findings/:id          — one finding + its thread
 *   POST   /v1/company/findings              — open a finding            (test_manager)
 *   PATCH  /v1/company/findings/:id          — edit / classify / baseline (test_manager)
 *   DELETE /v1/company/findings/:id          — remove a finding          (test_manager)
 *   POST   /v1/company/findings/:id/comments — reply on the thread       (test_manager)
 *
 * Access mirrors the datafile (test data): administrators + certifiers have no
 * access; the vendor's own test_manager + testers read; only test_manager
 * writes. A baselined finding feeds the run engine via knownDeviationProjection.
 */

const express = require('express');
const crypto  = require('crypto');
const { get, all, run } = require('../../db/db');
const { requireAuth }   = require('../middleware/auth');
const { enforceTenant } = require('../middleware/tenant');
const { resolveCompanyScope } = require('../helpers/shared');
const { reprojectDatafile }   = require('../../utils/knownDeviationProjection');
const log = require('../../utils/logger').child({ module: 'company-findings' });

const router = express.Router();
router.use(requireAuth, enforceTenant);

// ── Whitelists (anything else is coerced to a safe default) ───────────────────
const CATEGORIES = ['open', 'provider_deviation', 'oscar_issue', 'not_supported', 'spec_question'];
const SEVERITIES = ['major', 'minor', 'not_supported'];
const STATUSES   = ['open', 'discussing', 'resolved'];

// ── Scope + role guards ───────────────────────────────────────────────────────
// Findings are vendor test data. Like GET /v1/company/datafile, administrators
// and certifiers get no access; the vendor's own test_manager + testers do.
function resolveFindingScope(req, res) {
  if (req.user.role === 'administrator' || req.user.role === 'certification_user') {
    res.status(403).json({ status: 403, title: 'Forbidden',
      detail: 'Administrators and certifiers do not have access to a vendor\'s test findings.' });
    return null;
  }
  return resolveCompanyScope(req, res);   // returns companyId, or null (and sends the response)
}

// Writes are test_manager-only — mirrors the datafile gating in company.js.
function requireTestManager(req, res) {
  if (req.user.role !== 'test_manager') {
    res.status(403).json({ status: 403, title: 'Forbidden',
      detail: 'Only Test Managers can create or update findings.' });
    return false;
  }
  return true;
}

// ── Serialisers (snake_case row → camelCase API) ──────────────────────────────
function toApiFinding(f) {
  return {
    id:             f.id,
    title:          f.title,
    step:           f.step || null,
    scenarioCode:   f.scenario_code || null,
    expectedStatus: (f.expected_status === null || f.expected_status === undefined) ? null : f.expected_status,
    observed:       f.observed || '',
    interpretation: f.interpretation || '',
    category:       f.category,
    severity:       f.severity || null,
    status:         f.status,
    baselineInRun:  !!f.baseline_in_run,
    raiseToOsdm:    !!f.raise_to_osdm,
    evidence:       f.evidence || '',
    createdBy:      f.created_by || null,
    createdAt:      f.created_at,
    updatedAt:      f.updated_at
  };
}
function toApiComment(c) {
  return { id: c.id, findingId: c.finding_id, author: c.author, role: c.role || null, body: c.body, createdAt: c.created_at };
}

function asStr(v) { return (v === null || v === undefined) ? null : String(v); }
function asStatus(v) {
  // Accept '', null, a number, or a numeric string. Empty → null (not status-level).
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

// ── GET /findings — list for the current test-system ──────────────────────────
router.get('/findings', (req, res) => {
  const companyId = resolveFindingScope(req, res);
  if (companyId === null) return;

  const rows   = all('SELECT * FROM finding WHERE company_id = ? ORDER BY created_at ASC', [companyId]);
  const counts = all(
    `SELECT finding_id, COUNT(*) AS n
       FROM finding_comment
      WHERE finding_id IN (SELECT id FROM finding WHERE company_id = ?)
      GROUP BY finding_id`,
    [companyId]
  );
  const countMap = Object.create(null);
  counts.forEach(c => { countMap[c.finding_id] = c.n; });

  const findings = rows.map(f => ({ ...toApiFinding(f), commentCount: countMap[f.id] || 0 }));
  res.json({ findings });
});

// ── GET /findings/:id — one finding + its thread ──────────────────────────────
router.get('/findings/:id', (req, res) => {
  const companyId = resolveFindingScope(req, res);
  if (companyId === null) return;

  const f = get('SELECT * FROM finding WHERE id = ? AND company_id = ?', [req.params.id, companyId]);
  if (!f) return res.status(404).json({ status: 404, title: 'Not Found', detail: 'Finding not found.' });

  const comments = all('SELECT * FROM finding_comment WHERE finding_id = ? ORDER BY created_at ASC', [f.id]);
  res.json({ finding: toApiFinding(f), comments: comments.map(toApiComment) });
});

// ── POST /findings — open a finding ───────────────────────────────────────────
router.post('/findings', async (req, res) => {
  if (!requireTestManager(req, res)) return;
  const companyId = resolveFindingScope(req, res);
  if (companyId === null) return;

  const b = req.body || {};
  const title = String(b.title || '').trim();
  if (!title) return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'A finding needs a title.' });

  const id             = crypto.randomUUID();
  const category       = CATEGORIES.includes(b.category) ? b.category : 'open';
  const severity       = SEVERITIES.includes(b.severity) ? b.severity : null;
  const expectedStatus = asStatus(b.expectedStatus);
  const step           = b.step ? String(b.step).trim() : null;
  const scenarioCode   = b.scenarioCode ? String(b.scenarioCode).trim() : null;
  const baselineInRun  = (b.baselineInRun && expectedStatus !== null && step) ? 1 : 0;
  const createdBy      = (typeof b.createdBy === 'string' && b.createdBy.trim()) ? b.createdBy.trim() : req.user.email;

  run(
    `INSERT INTO finding
       (id, company_id, title, step, scenario_code, expected_status, observed, interpretation,
        category, severity, status, baseline_in_run, raise_to_osdm, evidence, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, companyId, title, step, scenarioCode, expectedStatus, asStr(b.observed), asStr(b.interpretation),
     category, severity, 'open', baselineInRun, b.raiseToOsdm ? 1 : 0, asStr(b.evidence), createdBy]
  );

  if (baselineInRun) {
    try { await reprojectDatafile(companyId); }
    catch (err) { log.warn({ err: err.message, companyId }, 'create: reproject failed'); }
  }

  const f = get('SELECT * FROM finding WHERE id = ?', [id]);
  res.status(201).json({ finding: toApiFinding(f) });
});

// ── PATCH /findings/:id — edit / classify / baseline ──────────────────────────
router.patch('/findings/:id', async (req, res) => {
  if (!requireTestManager(req, res)) return;
  const companyId = resolveFindingScope(req, res);
  if (companyId === null) return;

  const f = get('SELECT * FROM finding WHERE id = ? AND company_id = ?', [req.params.id, companyId]);
  if (!f) return res.status(404).json({ status: 404, title: 'Not Found', detail: 'Finding not found.' });

  const b = req.body || {};
  const sets = [], vals = [];
  const setCol = (col, val) => { sets.push(`${col} = ?`); vals.push(val); };

  if (typeof b.title === 'string' && b.title.trim()) setCol('title', b.title.trim());
  if ('step' in b)            setCol('step', b.step ? String(b.step).trim() : null);
  if ('scenarioCode' in b)    setCol('scenario_code', b.scenarioCode ? String(b.scenarioCode).trim() : null);
  if ('expectedStatus' in b)  setCol('expected_status', asStatus(b.expectedStatus));
  if ('observed' in b)        setCol('observed', asStr(b.observed));
  if ('interpretation' in b)  setCol('interpretation', asStr(b.interpretation));
  if (CATEGORIES.includes(b.category)) setCol('category', b.category);
  if ('severity' in b)        setCol('severity', SEVERITIES.includes(b.severity) ? b.severity : null);
  if (STATUSES.includes(b.status))     setCol('status', b.status);
  if ('baselineInRun' in b)   setCol('baseline_in_run', b.baselineInRun ? 1 : 0);
  if ('raiseToOsdm' in b)     setCol('raise_to_osdm', b.raiseToOsdm ? 1 : 0);
  if ('evidence' in b)        setCol('evidence', asStr(b.evidence));

  if (sets.length === 0) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'No recognised fields to update.' });
  }

  // Guard the engine contract: baseline_in_run only enforces with a numeric
  // expected_status + step. Recompute the effective baseline from the merged row.
  sets.push("updated_at = datetime('now')");
  vals.push(f.id);
  run(`UPDATE finding SET ${sets.join(', ')} WHERE id = ?`, vals);

  let updated = get('SELECT * FROM finding WHERE id = ?', [f.id]);
  if (updated.baseline_in_run && (updated.expected_status === null || !updated.step || !String(updated.step).trim())) {
    run("UPDATE finding SET baseline_in_run = 0, updated_at = datetime('now') WHERE id = ?", [f.id]);
    updated = get('SELECT * FROM finding WHERE id = ?', [f.id]);
  }

  // Any edit may change the baselined set (or its step/status) — reproject.
  try { await reprojectDatafile(companyId); }
  catch (err) { log.warn({ err: err.message, companyId }, 'patch: reproject failed'); }

  res.json({ finding: toApiFinding(updated) });
});

// ── DELETE /findings/:id ──────────────────────────────────────────────────────
router.delete('/findings/:id', async (req, res) => {
  if (!requireTestManager(req, res)) return;
  const companyId = resolveFindingScope(req, res);
  if (companyId === null) return;

  const f = get('SELECT id, baseline_in_run FROM finding WHERE id = ? AND company_id = ?', [req.params.id, companyId]);
  if (!f) return res.status(404).json({ status: 404, title: 'Not Found', detail: 'Finding not found.' });

  run('DELETE FROM finding WHERE id = ?', [f.id]);   // finding_comment rows cascade

  if (f.baseline_in_run) {
    try { await reprojectDatafile(companyId); }
    catch (err) { log.warn({ err: err.message, companyId }, 'delete: reproject failed'); }
  }
  res.json({ deleted: true });
});

// ── POST /findings/:id/comments — reply on the thread ─────────────────────────
router.post('/findings/:id/comments', (req, res) => {
  if (!requireTestManager(req, res)) return;
  const companyId = resolveFindingScope(req, res);
  if (companyId === null) return;

  const f = get('SELECT id, status FROM finding WHERE id = ? AND company_id = ?', [req.params.id, companyId]);
  if (!f) return res.status(404).json({ status: 404, title: 'Not Found', detail: 'Finding not found.' });

  const body = String((req.body || {}).body || '').trim();
  if (!body) return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'A reply needs a body.' });

  const id = crypto.randomUUID();
  run('INSERT INTO finding_comment (id, finding_id, author, role, body) VALUES (?,?,?,?,?)',
    [id, f.id, req.user.email, req.user.role, body]);

  // A first reply moves the finding from 'open' into 'discussing'.
  if (f.status === 'open') {
    run("UPDATE finding SET status = 'discussing', updated_at = datetime('now') WHERE id = ?", [f.id]);
  }

  const c = get('SELECT * FROM finding_comment WHERE id = ?', [id]);
  res.status(201).json({ comment: toApiComment(c) });
});

module.exports = router;
