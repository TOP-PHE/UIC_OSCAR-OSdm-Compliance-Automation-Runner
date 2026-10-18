// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * batchFailures.js — a batch's failed checks and the list of a company's
 * batches, as the finding suggestions (#735) and the AI analysis (#801) read
 * them, and the warnings the AI analysis sends too (#823). The caller has
 * chosen the company (req.companyId): every query is held to it.
 */

const { all, colDecrypt } = require('../../db/db');
const S = require('../../utils/findingSuggestions');

const MAX_FAILURES = 5000;
const MAX_WARNING_EVENTS = 20000;
const FINISHED = new Set(['COMPLETED', 'FAILED']);

/**
 * The failed checks of a finished batch's runs, oldest first, at most
 * MAX_FAILURES: { runId, at, scenarioCode, step, check, error, status,
 * problemCode, problemTitle, problemDetail, method, url, requestId }. The URL is for
 * finding the OSDM operation (#827): the AI analysis never sends it.
 */
function failuresOfBatch(companyId, batchId) {
  const rows = all(
    `SELECT a.assertion_name, a.error_msg, rq.id AS request_id, rq.request_name, rq.http_status, rq.http_method, rq.http_url,
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
      method: r.http_method || null, url: r.http_url || null, requestId: r.request_id,
    };
  });
}

/**
 * The [WARNING] lines the runs of a finished batch logged (#823), oldest
 * first: { runId, scenarioCode, step, message }, the step being the request
 * the line was logged under. At most MAX_WARNING_EVENTS log rows are read;
 * `truncated` says when that limit was met.
 */
function warningsOfBatch(companyId, batchId) {
  const rows = all(
    `SELECT e.run_id, e.request_name, e.message, r.scenario_code
       FROM run_events e
       JOIN runs r ON r.id = e.run_id
      WHERE r.company_id = ? AND r.batch_id = ? AND r.status IN (?, ?) AND e.level = 'warn'
      ORDER BY r.queued_at ASC, e.id ASC
      LIMIT ?`,
    [companyId, batchId, ...FINISHED, MAX_WARNING_EVENTS]
  );
  const warnings = [];
  for (const row of rows) {
    let text = '';
    try { text = colDecrypt(row.message) || ''; } catch { text = ''; }
    for (const line of String(text).split('\n')) {
      if (line.includes('[WARNING]')) warnings.push({ runId: row.run_id, scenarioCode: row.scenario_code || null, step: row.request_name || null, message: line.trim() });
    }
  }
  return { warnings, truncated: rows.length >= MAX_WARNING_EVENTS };
}

/** The company's 30 latest batches: { batchId, runs, finishedRuns, started, finished }. */
function batchesOf(companyId) {
  return all(
    `SELECT batch_id, COUNT(*) AS runs, MIN(queued_at) AS started, MAX(completed_at) AS finished,
            SUM(CASE WHEN status IN (?, ?) THEN 1 ELSE 0 END) AS finished_runs
       FROM runs
      WHERE company_id = ? AND batch_id IS NOT NULL
      GROUP BY batch_id
      ORDER BY MIN(queued_at) DESC
      LIMIT 30`,
    [...FINISHED, companyId]
  ).map((b) => ({ batchId: b.batch_id, runs: b.runs, finishedRuns: b.finished_runs, started: b.started, finished: b.finished }));
}

/** The runs of one batch of the company: [{ id, scenario_code, status }]. */
function runsOfBatch(companyId, batchId) {
  return all('SELECT id, scenario_code, status FROM runs WHERE company_id = ? AND batch_id = ?', [companyId, batchId]);
}

module.exports = { failuresOfBatch, warningsOfBatch, batchesOf, runsOfBatch, MAX_FAILURES, MAX_WARNING_EVENTS, FINISHED };
