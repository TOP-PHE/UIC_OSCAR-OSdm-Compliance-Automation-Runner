// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * runDetail.js — where a run failed and where it warned, for the API's test
 * requests (#1342 PR 5; decision D4: results only).
 *
 *   failures:   each failed check: step, check, message, expected, actual,
 *               HTTP status and, for an error answer, the OSDM problem code
 *   warnings:   each [WARNING] line of the run's log, with its step
 *   deviations: each known deviation the run applied (a finding baselined in
 *               the run, #398): step, status, note
 *
 * Nothing else of a run is read out: no body, no other log line, no header.
 * The problem code is read from an error answer's body and only the code
 * leaves. Texts are one line of at most 500 characters; 50 failures and 50
 * warnings a run at most (`truncated` says when more were left out).
 *
 * A finished run's detail never changes (the runner stores everything before
 * the final status): it is kept, 5,000 runs, least recently used first, so a
 * client polling a test request costs the log's decryption once per run.
 */

const { all, colDecrypt } = require('../../db/db');
const { warningRowsOf } = require('./runWarnings');
const { flushRunLogs } = require('../../worker/runLog');
const { problemOf } = require('../../utils/findingSuggestions');
const { isWarningLine } = require('../../utils/aiAnalysis');
const { knownDeviationOf } = require('../../utils/coveragePoints');

const MAX_FAILURES = 50;
const MAX_WARNINGS = 50;
const MAX_TEXT = 500;
const MAX_EVENTS = 2000;
const MAX_KEPT = 5000;
const FINISHED = new Set(['COMPLETED', 'FAILED']);

const kept = new Map();

/** One line of at most 500 characters, or null. */
function oneLine(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).split(/\s+/).filter(Boolean).join(' ');
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

function failuresOf(runId) {
  const rows = all(`SELECT a.assertion_name, a.error_msg, a.expected_value, a.actual_value, q.request_name, q.http_status, q.id AS request_id
                      FROM run_assertions a JOIN run_requests q ON q.id = a.request_id
                     WHERE a.run_id = ? AND a.passed = 0 ORDER BY a.id ASC LIMIT ?`, [runId, MAX_FAILURES + 1]);
  const codes = new Map();
  const errorRequests = [...new Set(rows.filter(r => Number(r.http_status) >= 400).map(r => r.request_id))];
  for (const id of errorRequests) {
    const [row] = all('SELECT response_body FROM run_requests WHERE id = ?', [id]);
    let body = null;
    try { body = row?.response_body ? colDecrypt(row.response_body) : null; } catch { body = null; }
    const code = problemOf(body)?.code;
    if (code) codes.set(id, oneLine(code));
  }
  return {
    list: rows.slice(0, MAX_FAILURES).map(r => ({
      step: oneLine(r.request_name),
      check: oneLine(r.assertion_name),
      message: oneLine(r.error_msg),
      expected: oneLine(r.expected_value),
      actual: oneLine(r.actual_value),
      http_status: r.http_status ?? null,
      problem_code: codes.get(r.request_id) || null,
    })),
    truncated: rows.length > MAX_FAILURES,
  };
}

// The collection echoes every failed check in the log as "[WARNING] ❌ <check>"
// (bruTest() in library-bruno/testCapture.js, on purpose). That check is
// already among the failures: listed as a warning too, one problem read twice.
const FAILURE_ECHO = /\[WARNING\]\s*❌/u;

// The [WARNING] lines of one log row (its text is encrypted at rest), failure
// echoes left out (#1355).
function warningLinesOf(row) {
  let text = '';
  try { text = colDecrypt(row.message) || ''; } catch { text = ''; }
  return String(text).split('\n').filter(line => isWarningLine(line) && !FAILURE_ECHO.test(line));
}

// One warning line: a known deviation (said once, among the deviations), else a
// warning while there is room.
function addWarning(found, step, line) {
  const deviation = knownDeviationOf(line);
  if (deviation) {
    found.deviations.push({ step: oneLine(deviation.step), status: deviation.status, note: oneLine(deviation.note) || null });
  } else if (found.warnings.length < MAX_WARNINGS) {
    found.warnings.push({ step: oneLine(step), message: oneLine(line.trim()) });
  } else {
    found.more = true;
  }
}

function warningsOf(runId) {
  const rows = warningRowsOf([runId], MAX_EVENTS);
  const found = { warnings: [], deviations: [], more: false };
  for (const row of rows) {
    for (const line of warningLinesOf(row)) addWarning(found, row.request_name, line);
  }
  return { warnings: found.warnings, deviations: found.deviations, truncated: found.more || rows.length >= MAX_EVENTS };
}

/**
 * The detail of a run (`run`: { id, status }): { failures, warnings,
 * deviations, truncated: { failures, warnings } }. Kept once the run is finished.
 */
function detailOf(run) {
  const finished = FINISHED.has(run.status);
  if (finished && kept.has(run.id)) {
    const detail = kept.get(run.id);
    kept.delete(run.id);
    kept.set(run.id, detail);
    return detail;
  }
  // A run still going writes its log in batches: write what waits first.
  if (!finished) flushRunLogs();
  const f = failuresOf(run.id);
  const w = warningsOf(run.id);
  const detail = { failures: f.list, warnings: w.warnings, deviations: w.deviations, truncated: { failures: f.truncated, warnings: w.truncated } };
  if (finished) {
    kept.set(run.id, detail);
    while (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value);
  }
  return detail;
}

/** Forgets every kept detail (tests). */
function forgetDetails() {
  kept.clear();
}

module.exports = { detailOf, forgetDetails, oneLine, MAX_FAILURES, MAX_WARNINGS, MAX_TEXT };
