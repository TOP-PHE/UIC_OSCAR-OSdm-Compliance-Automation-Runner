// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * api.js — the read-only API, by API key (#503).
 *
 *   GET /v1/api/key                     — the key's own name, company, scopes and expiry
 *   GET /v1/api/runs                    — the company's runs, newest first (#503 PR 2)
 *   GET /v1/api/runs/:id                — one run and its check counts
 *   GET /v1/api/runs/:id/assertions     — its checks: suites → requests → checks
 *   GET /v1/api/batches/:batchId        — the runs of one batch
 *   GET /v1/api/queue                   — the company's queued and running runs
 *
 * Default-deny: a key opens the GET routes this router lists and nothing
 * else (any other method or path is a 404 here, and every other OSCAR route
 * refuses a key in requireAuth). Each key has its own rate limit.
 *
 * Every run answered goes through canUserSeeRun() (a key sees the runs of
 * its own company or provider, not its providers'), and a run it may not
 * see is the same 404 as one that does not exist. Answers are built field by
 * field, never from a row: statuses, times, counts and check results only.
 * No request or response body, header, URL, log, endpoint, credential or
 * person (who started a run) is answered; bodies wait for a scope of their
 * own (`bodies:read`).
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { get, all } = require('../../db/db');
const { requireApiKey } = require('../middleware/apiKey');
const { canUserSeeRun } = require('../helpers/run-access');

const router = express.Router();

// Before the key is checked, by address: guessing keys is slowed down too.
const guessLimiter = rateLimit({
  windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many requests from this address — please wait a moment.' },
});
const perKeyLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => `api-key:${req.apiKey.id}`,
  message: { status: 429, title: 'Too Many Requests', detail: 'This API key made too many requests in a short window — please wait a moment.' },
});

router.use(guessLimiter, requireApiKey, perKeyLimiter);

router.get('/key', (req, res) => {
  const row = get(`SELECT k.name, k.prefix, k.scopes, k.created_at, k.expires_at, c.id AS company_id, c.name AS company_name
                   FROM api_key k JOIN companies c ON c.id = k.company_id WHERE k.id = ?`, [req.apiKey.id]);
  if (!row) return res.status(401).json({ status: 401, title: 'Unauthorized', detail: 'Missing, invalid, expired or revoked API key.' });
  res.json({
    name: row.name,
    hint: `oscar_${row.prefix}_…`,
    company: { id: row.company_id, name: row.company_name },
    scopes: String(row.scopes || '').split(' ').filter(Boolean),
    created_at: row.created_at,
    expires_at: row.expires_at,
  });
});

// ── Runs (#503 PR 2) ─────────────────────────────────────────────────────────

const RUN_STATUSES = Object.freeze(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED']);
// A run its company deleted, or asked to delete, is not answered.
const HIDDEN_STATUSES = new Set(['DELETED', 'DELETION_REQUESTED', 'DELETED_BY_ADMIN']);
const MAX_LIMIT = 200;
const MAX_TEXT = 200;
const NOT_FOUND = Object.freeze({ status: 404, title: 'Not Found', detail: 'No such run.' });

function badRequest(res, detail) {
  return res.status(400).json({ status: 400, title: 'Bad Request', detail });
}

/** A whole number from `min` to `max`, `fallback` when absent; null when unreadable. */
function wholeNumber(value, fallback, min, max) {
  if (value === undefined || value === '') return fallback;
  if (typeof value !== 'string' || !/^\d{1,9}$/.test(value)) return null;
  const n = Number(value);
  return n >= min && n <= max ? n : null;
}

/** A short text parameter, absent = null; { error } when not one plain string. */
function textParam(value, name) {
  if (value === undefined || value === '') return { value: null };
  if (typeof value !== 'string' || value.length > MAX_TEXT) return { error: `${name} must be one text of at most ${MAX_TEXT} characters.` };
  return { value };
}

/** The run a key may read, or null: canUserSeeRun() and not deleted. */
function visibleRun(id, req) {
  if (typeof id !== 'string' || id.length > MAX_TEXT) return null;
  const run = canUserSeeRun(id, req.user);
  return run && !HIDDEN_STATUSES.has(run.status) ? run : null;
}

function countsOf(row) {
  return { total: Number(row?.total) || 0, passed: Number(row?.passed) || 0, failed: Number(row?.failed) || 0 };
}

/** What the API answers of a run: named fields, never the row. */
function runView(run, counts) {
  return {
    id: run.id,
    status: run.status,
    scenario_code: run.scenario_code ?? null,
    batch_id: run.batch_id ?? null,
    queued_at: run.queued_at ?? null,
    started_at: run.started_at ?? null,
    completed_at: run.completed_at ?? null,
    exit_code: run.exit_code ?? null,
    checks: countsOf(counts),
  };
}

const COUNTS_SQL = `SELECT COUNT(*) AS total,
         SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) AS passed,
         SUM(CASE WHEN passed = 0 THEN 1 ELSE 0 END) AS failed
  FROM run_assertions WHERE run_id = ?`;

function countsFor(runId) {
  return get(COUNTS_SQL, [runId]);
}

router.get('/runs', (req, res) => {
  const limit = wholeNumber(req.query.limit, 50, 1, MAX_LIMIT);
  if (limit === null) return badRequest(res, `limit must be a whole number from 1 to ${MAX_LIMIT}.`);
  const offset = wholeNumber(req.query.offset, 0, 0, 1e9);
  if (offset === null) return badRequest(res, 'offset must be a whole number, 0 or more.');
  const status = textParam(req.query.status, 'status');
  if (status.error) return badRequest(res, status.error);
  if (status.value !== null && !RUN_STATUSES.includes(status.value)) {
    return badRequest(res, `status must be one of ${RUN_STATUSES.join(', ')}.`);
  }
  const batch = textParam(req.query.batch_id, 'batch_id');
  if (batch.error) return badRequest(res, batch.error);
  const scenario = textParam(req.query.scenario_code, 'scenario_code');
  if (scenario.error) return badRequest(res, scenario.error);

  const where = [`r.company_id = ?`, `r.status NOT IN (${[...HIDDEN_STATUSES].map(() => '?').join(', ')})`];
  const params = [req.user.keyCompanyId, ...HIDDEN_STATUSES];
  if (status.value !== null) { where.push('r.status = ?'); params.push(status.value); }
  if (batch.value !== null) { where.push('r.batch_id = ?'); params.push(batch.value); }
  if (scenario.value !== null) { where.push('r.scenario_code = ?'); params.push(scenario.value); }
  const clause = where.join(' AND ');

  const total = get(`SELECT COUNT(*) AS n FROM runs r WHERE ${clause}`, params);
  const rows = all(
    `SELECT r.id FROM runs r WHERE ${clause} ORDER BY r.queued_at DESC, r.id ASC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const runs = [];
  for (const { id } of rows) {
    const run = visibleRun(id, req);
    if (run) runs.push(runView(run, countsFor(run.id)));
  }
  return res.json({ total: total?.n || 0, limit, offset, runs });
});

router.get('/runs/:id', (req, res) => {
  const run = visibleRun(req.params.id, req);
  if (!run) return res.status(404).json(NOT_FOUND);
  return res.json(runView(run, countsFor(run.id)));
});

router.get('/runs/:id/assertions', (req, res) => {
  const run = visibleRun(req.params.id, req);
  if (!run) return res.status(404).json(NOT_FOUND);
  const result = textParam(req.query.result, 'result');
  if (result.error) return badRequest(res, result.error);
  if (result.value !== null && !['passed', 'failed'].includes(result.value)) {
    return badRequest(res, 'result must be passed or failed.');
  }
  const passedOnly = result.value === null ? '' : ' AND passed = ?';
  const checkParams = result.value === null ? [run.id] : [run.id, result.value === 'passed' ? 1 : 0];

  const suites = all(
    `SELECT id, scenario_name, suite_name, total, passed, failed, skipped, duration_ms
     FROM run_suites WHERE run_id = ? ORDER BY id ASC`, [run.id]);
  const requests = all(
    `SELECT id, suite_id, request_name, http_method, http_status, vendor_capability, result, total, passed, failed, duration_ms
     FROM run_requests WHERE run_id = ? ORDER BY id ASC`, [run.id]);
  const checks = all(
    `SELECT request_id, assertion_name, type, category, domain, offer_part, severity, passed, error_msg, expected_value, actual_value
     FROM run_assertions WHERE run_id = ?${passedOnly} ORDER BY id ASC`, checkParams);

  const checksOf = new Map();
  for (const c of checks) {
    if (!checksOf.has(c.request_id)) checksOf.set(c.request_id, []);
    checksOf.get(c.request_id).push({
      name: c.assertion_name,
      type: c.type,
      passed: c.passed === 1,
      category: c.category ?? null,
      domain: c.domain ?? null,
      offer_part: c.offer_part ?? null,
      severity: c.severity ?? null,
      error: c.error_msg ?? null,
      expected: c.expected_value ?? null,
      actual: c.actual_value ?? null,
    });
  }
  const requestsOf = new Map();
  for (const r of requests) {
    if (!requestsOf.has(r.suite_id)) requestsOf.set(r.suite_id, []);
    requestsOf.get(r.suite_id).push({
      name: r.request_name,
      method: r.http_method ?? null,
      http_status: r.http_status ?? null,
      result: r.result,
      capability: r.vendor_capability ?? null,
      duration_ms: r.duration_ms ?? 0,
      checks: { total: r.total, passed: r.passed, failed: r.failed },
      assertions: checksOf.get(r.id) || [],
    });
  }
  return res.json({
    run: runView(run, countsFor(run.id)),
    suites: suites.map(s => ({
      scenario: s.scenario_name ?? null,
      name: s.suite_name,
      duration_ms: s.duration_ms ?? 0,
      checks: { total: s.total, passed: s.passed, failed: s.failed, skipped: s.skipped },
      requests: requestsOf.get(s.id) || [],
    })),
  });
});

router.get('/batches/:batchId', (req, res) => {
  const batchId = req.params.batchId;
  if (batchId.length > MAX_TEXT) return res.status(404).json({ status: 404, title: 'Not Found', detail: 'No such batch.' });
  const rows = all(`SELECT id FROM runs WHERE batch_id = ? AND company_id = ? ORDER BY queued_at ASC, id ASC`,
    [batchId, req.user.keyCompanyId]);
  const runs = [];
  for (const { id } of rows) {
    const run = visibleRun(id, req);
    if (run) runs.push(runView(run, countsFor(run.id)));
  }
  if (runs.length === 0) return res.status(404).json({ status: 404, title: 'Not Found', detail: 'No such batch.' });
  const byStatus = Object.fromEntries(RUN_STATUSES.map(s => [s.toLowerCase(), runs.filter(r => r.status === s).length]));
  return res.json({ batch_id: batchId, total: runs.length, ...byStatus, runs });
});

router.get('/queue', (req, res) => {
  const rows = all(`SELECT id FROM runs WHERE company_id = ? AND status IN ('QUEUED', 'RUNNING') ORDER BY queued_at ASC, id ASC`,
    [req.user.keyCompanyId]);
  const runs = rows.map(({ id }) => visibleRun(id, req)).filter(Boolean);
  const queued = runs.filter(r => r.status === 'QUEUED');
  return res.json({
    running: runs.length - queued.length,
    queued: queued.length,
    runs: runs.map(r => ({
      id: r.id,
      status: r.status,
      scenario_code: r.scenario_code ?? null,
      batch_id: r.batch_id ?? null,
      position: r.status === 'QUEUED' ? queued.indexOf(r) + 1 : null,
      queued_at: r.queued_at ?? null,
      started_at: r.started_at ?? null,
    })),
  });
});

// Anything not listed above, whatever the method: the request ends here and
// never reaches another router or the page fallback.
router.use((req, res) => {
  res.status(404).json({ status: 404, title: 'Not Found', detail: 'The API has no such route.' });
});

module.exports = router;
