// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * runWarnings.js — the warning lines of runs, without walking their logs.
 *
 * A run's log is some 1,500 lines of which a few dozen are warnings. The log
 * table's one index is by run, so every reader of the warnings (the coverage
 * report, the AI analysis, a run's detail through the API) read each run's
 * whole log to keep those few: 763 ms for 300 runs in a trial.
 *
 * Since 1.11.571 the writer of the log (worker/runLog.js) also keeps each
 * warning line in run_warning_lines, under the id its log line has, and the
 * runner marks the run when it starts (runs.warn_lines_kept). A marked run is
 * read from there; a run of before, or one that never started, is read from
 * its log as it always was. Both give the same rows in the same order: the
 * rows of both are merged by the log line's id, which is what the readers
 * sorted by.
 *
 * Nothing is copied for the runs of before: an index on the log table would
 * have meant reading it whole with the server unable to write meanwhile, and
 * they are read less and less.
 */

const { all } = require('../../db/db');

// The most run ids one call may name: each becomes a parameter of a statement.
const MAX_RUNS = 500;

const marks = n => Array.from({ length: n }, () => '?').join(',');

/** Of these runs, those whose warning lines are kept on their own. */
function keptAmong(runIds) {
  if (runIds.length === 0) return new Set();
  const rows = all(`SELECT id FROM runs WHERE warn_lines_kept = 1 AND id IN (${marks(runIds.length)})`, runIds);
  return new Set(rows.map(row => row.id));
}

/** Two lists each sorted by `before`, as one sorted list of `limit` rows at most. */
function merged(a, b, before, limit) {
  const out = [];
  let i = 0;
  let j = 0;
  while (out.length < limit && (i < a.length || j < b.length)) {
    if (j >= b.length || (i < a.length && before(a[i], b[j]))) out.push(a[i++]);
    else out.push(b[j++]);
  }
  return out;
}

/**
 * The warning rows of these runs, oldest first, `limit` at most:
 * [{ id, run_id, request_name, message }], `message` as stored (encrypted).
 * What `SELECT … FROM run_events WHERE level = 'warn' AND run_id IN (…)
 * ORDER BY id LIMIT ?` gave.
 */
function warningRowsOf(runIds, limit) {
  const ids = [...new Set(runIds)];
  if (ids.length > MAX_RUNS) throw new Error(`warningRowsOf: ${ids.length} runs in one call, ${MAX_RUNS} at most`);
  if (ids.length === 0 || !(limit > 0)) return [];
  const kept = keptAmong(ids);
  const own = ids.filter(id => kept.has(id));
  const other = ids.filter(id => !kept.has(id));
  const fromOwn = own.length === 0 ? [] : all(
    `SELECT event_id AS id, run_id, request_name, message FROM run_warning_lines
      WHERE run_id IN (${marks(own.length)}) ORDER BY event_id ASC LIMIT ?`, [...own, limit]);
  const fromLog = other.length === 0 ? [] : all(
    `SELECT id, run_id, request_name, message FROM run_events
      WHERE level = 'warn' AND run_id IN (${marks(other.length)}) ORDER BY id ASC LIMIT ?`, [...other, limit]);
  return merged(fromOwn, fromLog, (x, y) => x.id < y.id, limit);
}

const text = value => (value === null || value === undefined ? '' : String(value));
const earlierInBatch = (x, y) => text(x.queued_at) < text(y.queued_at)
  || (text(x.queued_at) === text(y.queued_at) && x.id < y.id);

/**
 * The warning rows of a batch's runs in one of `statuses` (an array or a
 * Set), in the order the runs were queued, then oldest first, `limit` at most:
 * [{ id, run_id, request_name, message, scenario_code, queued_at }].
 */
function warningRowsOfBatch(companyId, batchId, statuses, limit) {
  const wanted = [...statuses];   // an array or a Set
  if (!(limit > 0) || wanted.length === 0) return [];
  const runsOfBatch = `r.company_id = ? AND r.batch_id = ? AND r.status IN (${marks(wanted.length)})`;
  const params = [companyId, batchId, ...wanted, limit];
  const fromOwn = all(
    `SELECT w.event_id AS id, w.run_id, w.request_name, w.message, r.scenario_code, r.queued_at
       FROM runs r
       JOIN run_warning_lines w ON w.run_id = r.id
      WHERE ${runsOfBatch} AND r.warn_lines_kept = 1
      ORDER BY r.queued_at ASC, w.event_id ASC
      LIMIT ?`, params);
  const fromLog = all(
    `SELECT e.id, e.run_id, e.request_name, e.message, r.scenario_code, r.queued_at
       FROM runs r
       JOIN run_events e ON e.run_id = r.id
      WHERE ${runsOfBatch} AND r.warn_lines_kept = 0 AND e.level = 'warn'
      ORDER BY r.queued_at ASC, e.id ASC
      LIMIT ?`, params);
  return merged(fromOwn, fromLog, earlierInBatch, limit);
}

module.exports = { warningRowsOf, warningRowsOfBatch, keptAmong, merged, MAX_RUNS };
