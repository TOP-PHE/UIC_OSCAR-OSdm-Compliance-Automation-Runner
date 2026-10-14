// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * company-finding-suggestions.js — findings suggested from a batch's
 * failures (#735). Test Manager only: a draft is never shown to testers or
 * certifiers, and nothing reaches a finding without the Test Manager's click.
 *
 *   GET  /v1/company/findings/suggestions/batches      — recent batches to analyse
 *   POST /v1/company/findings/suggestions/analyse      — { batchId } → drafts, still seen, not seen
 *   GET  /v1/company/findings/suggestions              — the drafts waiting, and those marked OSCAR's
 *   POST /v1/company/findings/suggestions/:id/accept   — becomes a finding (fields may be edited)
 *   POST /v1/company/findings/suggestions/:id/reject   — not suggested again
 *   POST /v1/company/findings/suggestions/:id/oscar-issue — OSCAR's own; kept here, never a finding
 *
 * Mounted before company-findings.js: its GET /findings/:id would take
 * "suggestions" for an id.
 */

const express = require('express');
const crypto  = require('node:crypto');
const rateLimit = require('express-rate-limit');
const { get, all, run, colEncrypt, colDecrypt } = require('../../db/db');
const { requireAuth }   = require('../middleware/auth');
const { enforceTenant } = require('../middleware/tenant');
const { resolveCompanyScope } = require('../helpers/shared');
const { toApiFinding, createFinding } = require('../helpers/findings');
const { reprojectDatafile } = require('../../utils/knownDeviationProjection');
const S = require('../../utils/findingSuggestions');
const log = require('../../utils/logger').child({ module: 'company-finding-suggestions' });

const router = express.Router();
router.use(requireAuth, enforceTenant);

// An analysis reads every failed check of a batch: a few a minute is plenty.
const analyseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many analyses in a short window — please wait a moment.' }
});

// The most failed checks one analysis reads: a batch of a hundred scenarios
// failing everywhere stays well under it.
const MAX_FAILURES = 5000;
const FINISHED = new Set(['COMPLETED', 'FAILED']);

function scopeForTestManager(req, res) {
  if (req.user.role !== 'test_manager') {
    res.status(403).json({ status: 403, title: 'Forbidden',
      detail: 'Only Test Managers see and decide suggested findings.' });
    return null;
  }
  return resolveCompanyScope(req, res);
}

// How each check fared on the simulator (#735, part 3), generated from a
// replay by scripts/generate-simulator-checks.js. Read once; without it a
// draft simply carries no hint.
let simulatorChecks;
function simulatorTable() {
  if (simulatorChecks === undefined) {
    try { simulatorChecks = require('../../utils/simulator-checks.json'); }
    catch { simulatorChecks = null; }
  }
  return simulatorChecks;
}

const parseJson = (text, fallback) => {
  try { return JSON.parse(text); } catch { return fallback; }
};

function toApiSuggestion(row) {
  return {
    id: row.id,
    state: row.state,
    draft: parseJson(colDecrypt(row.draft), {}),
    scenarios: parseJson(row.scenarios, []),
    runs: parseJson(row.runs, []),
    occurrences: row.occurrences,
    maybeFindingId: row.maybe_finding_id || null,
    findingId: row.finding_id || null,
    lastBatchId: row.last_batch_id || null,
    decidedBy: row.decided_by || null,
    decidedAt: row.decided_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Reading a batch's failures ────────────────────────────────────────────────

function failuresOfBatch(companyId, batchId) {
  const rows = all(
    `SELECT a.assertion_name, a.error_msg, rq.id AS request_id, rq.request_name, rq.http_status,
            rq.response_body, r.id AS run_id, r.scenario_code, r.completed_at, s.scenario_name
       FROM run_assertions a
       JOIN run_requests rq ON rq.id = a.request_id
       JOIN run_suites   s  ON s.id  = a.suite_id
       JOIN runs         r  ON r.id  = a.run_id
      WHERE r.company_id = ? AND r.batch_id = ? AND r.status IN (?, ?) AND a.passed = 0
      ORDER BY r.queued_at ASC, rq.id ASC, a.id ASC
      LIMIT ?`,
    [companyId, batchId, ...FINISHED, MAX_FAILURES]
  );
  const problems = new Map();   // one decryption per request
  return rows.map((r) => {
    if (!problems.has(r.request_id)) {
      let body = null;
      try { body = r.response_body ? colDecrypt(r.response_body) : null; } catch { body = null; }
      problems.set(r.request_id, S.problemOf(body));
    }
    const p = problems.get(r.request_id);
    return {
      runId: r.run_id, at: r.completed_at || null, scenarioCode: r.scenario_code || r.scenario_name || null,
      step: r.request_name, check: r.assertion_name, error: r.error_msg || null, status: r.http_status,
      problemCode: p?.code || null, problemTitle: p?.title || null, problemDetail: p?.detail || null,
    };
  });
}

// ── GET /findings/suggestions/batches ─────────────────────────────────────────
router.get('/findings/suggestions/batches', (req, res) => {
  const companyId = scopeForTestManager(req, res);
  if (companyId === null) return;
  const batches = all(
    `SELECT batch_id, COUNT(*) AS runs, MIN(queued_at) AS started, MAX(completed_at) AS finished,
            SUM(CASE WHEN status IN (?, ?) THEN 1 ELSE 0 END) AS finished_runs
       FROM runs
      WHERE company_id = ? AND batch_id IS NOT NULL
      GROUP BY batch_id
      ORDER BY MIN(queued_at) DESC
      LIMIT 30`,
    [...FINISHED, companyId]
  );
  res.json({ batches: batches.map((b) => ({
    batchId: b.batch_id, runs: b.runs, finishedRuns: b.finished_runs, started: b.started, finished: b.finished,
  })) });
});

// ── POST /findings/suggestions/analyse ────────────────────────────────────────

// Store a group's draft: a new one, or the waiting draft of the same failure
// brought up to date. A decided one (rejected, OSCAR's) is left as it is.
function upsertDraft(companyId, group, draft, maybe, batchId) {
  const existing = get('SELECT id, state FROM finding_suggestion WHERE company_id = ? AND group_key = ?', [companyId, group.key]);
  if (existing && existing.state !== 'draft') return 'suppressed';
  const values = [colEncrypt(JSON.stringify(draft)), JSON.stringify(group.scenarios), JSON.stringify(group.runs.slice(0, 50)),
    group.count, maybe ? maybe.finding.id : null, batchId];
  if (existing) {
    run(`UPDATE finding_suggestion SET draft = ?, scenarios = ?, runs = ?, occurrences = ?, maybe_finding_id = ?,
           last_batch_id = ?, updated_at = datetime('now') WHERE id = ?`, [...values, existing.id]);
    return 'updated';
  }
  run(`INSERT INTO finding_suggestion (id, company_id, group_key, draft, scenarios, runs, occurrences, maybe_finding_id, last_batch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [crypto.randomUUID(), companyId, group.key, ...values]);
  return 'created';
}

router.post('/findings/suggestions/analyse', analyseLimiter, (req, res) => {
  const companyId = scopeForTestManager(req, res);
  if (companyId === null) return;
  const batchId = typeof req.body?.batchId === 'string' ? req.body.batchId.trim() : '';
  const batchRuns = batchId
    ? all('SELECT id, scenario_code, status FROM runs WHERE company_id = ? AND batch_id = ?', [companyId, batchId])
    : [];
  if (batchRuns.length === 0) {
    return res.status(404).json({ status: 404, title: 'Not Found', detail: 'No batch of this company with that id.' });
  }

  const records = failuresOfBatch(companyId, batchId);
  const groups = S.groupFailures(records);
  const findings = all('SELECT * FROM finding WHERE company_id = ?', [companyId]).map(toApiFinding);
  const acceptedByKey = Object.create(null);
  for (const r of all("SELECT group_key, finding_id FROM finding_suggestion WHERE company_id = ? AND state = 'accepted'", [companyId])) {
    acceptedByKey[r.group_key] = r.finding_id;
  }

  const tally = { created: 0, updated: 0, suppressed: 0 };
  const stillSeen = [];
  const matchedIds = [];
  for (const g of groups) {
    const m = S.matchFinding(g, findings, acceptedByKey);
    if (m) matchedIds.push(m.finding.id);
    if (m?.strength === 'same') {
      stillSeen.push({ findingId: m.finding.id, title: m.finding.title, why: m.why, check: g.check,
        scenarios: g.scenarios, runs: g.runs.slice(0, 10), occurrences: g.count });
      continue;
    }
    tally[upsertDraft(companyId, g, S.draftOf(g, { batchLabel: batchId, simulatorChecks: simulatorTable() }), m, batchId)]++;
  }
  const finished = batchRuns.filter((r) => FINISHED.has(r.status));
  const notSeen = S.notSeen(findings, matchedIds, finished.map((r) => r.scenario_code).filter(Boolean))
    .map((f) => ({ findingId: f.id, title: f.title, scenarioCode: f.scenarioCode }));

  log.info({ companyId, batchId, failures: records.length, groups: groups.length, ...tally }, 'suggestions analysed');
  res.json({
    batch: { batchId, runs: batchRuns.length, finishedRuns: finished.length, failures: records.length,
      truncated: records.length >= MAX_FAILURES },
    groups: groups.length, ...tally, stillSeen, notSeen,
  });
});

// ── GET /findings/suggestions ─────────────────────────────────────────────────
router.get('/findings/suggestions', (req, res) => {
  const companyId = scopeForTestManager(req, res);
  if (companyId === null) return;
  const rows = all(
    `SELECT * FROM finding_suggestion WHERE company_id = ? AND state IN ('draft', 'oscar_issue')
      ORDER BY occurrences DESC, created_at ASC`, [companyId]);
  const rejected = get("SELECT COUNT(*) AS n FROM finding_suggestion WHERE company_id = ? AND state = 'rejected'", [companyId]);
  const list = rows.map(toApiSuggestion);
  res.json({
    drafts: list.filter((s) => s.state === 'draft'),
    oscarIssues: list.filter((s) => s.state === 'oscar_issue'),
    rejected: rejected ? rejected.n : 0,
  });
});

// ── Deciding a draft ──────────────────────────────────────────────────────────

function waitingDraft(req, res, companyId) {
  const row = get('SELECT * FROM finding_suggestion WHERE id = ? AND company_id = ?', [req.params.id, companyId]);
  if (!row) {
    res.status(404).json({ status: 404, title: 'Not Found', detail: 'Suggestion not found.' });
    return null;
  }
  if (row.state !== 'draft') {
    res.status(409).json({ status: 409, title: 'Conflict', detail: `This suggestion was already decided (${row.state}).` });
    return null;
  }
  return row;
}

function decide(row, state, user, findingId) {
  run(`UPDATE finding_suggestion SET state = ?, finding_id = ?, decided_by = ?, decided_at = datetime('now'),
         updated_at = datetime('now') WHERE id = ?`, [state, findingId || null, user.email, row.id]);
  return get('SELECT * FROM finding_suggestion WHERE id = ?', [row.id]);
}

// The fields a Test Manager may change before accepting: those of a finding.
const EDITABLE = ['title', 'step', 'scenarioCode', 'expectedStatus', 'observed', 'interpretation', 'category', 'severity', 'evidence', 'baselineInRun', 'raiseToOsdm'];

router.post('/findings/suggestions/:id/accept', async (req, res) => {
  const companyId = scopeForTestManager(req, res);
  if (companyId === null) return;
  const row = waitingDraft(req, res, companyId);
  if (!row) return;
  const draft = parseJson(colDecrypt(row.draft), {});
  const fields = { ...draft };
  const b = req.body || {};
  for (const k of EDITABLE) if (k in b) fields[k] = b[k];
  const title = String(fields.title || '').trim();
  if (!title) return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'A finding needs a title.' });

  const f = createFinding(companyId, { ...fields, title }, req.user.email);
  const decided = decide(row, 'accepted', req.user, f.id);
  if (f.baseline_in_run) {
    try { await reprojectDatafile(companyId); }
    catch (err) { log.warn({ err: err.message, companyId }, 'accept: reproject failed'); }
  }
  res.status(201).json({ finding: toApiFinding(f), suggestion: toApiSuggestion(decided) });
});

router.post('/findings/suggestions/:id/reject', (req, res) => {
  const companyId = scopeForTestManager(req, res);
  if (companyId === null) return;
  const row = waitingDraft(req, res, companyId);
  if (!row) return;
  res.json({ suggestion: toApiSuggestion(decide(row, 'rejected', req.user)) });
});

router.post('/findings/suggestions/:id/oscar-issue', (req, res) => {
  const companyId = scopeForTestManager(req, res);
  if (companyId === null) return;
  const row = waitingDraft(req, res, companyId);
  if (!row) return;
  res.json({ suggestion: toApiSuggestion(decide(row, 'oscar_issue', req.user)) });
});

module.exports = router;
