// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// Run log lines, written together (#1210).
//
// Each line used to be its own INSERT, so its own SQLite transaction, which
// waits for the disk: about 2 ms of the server's one thread a line. With 15
// runs going, the log lines took half of that thread and up to 85 % (#1205),
// and a run printing hundreds of lines at once held every page for seconds.
// The lines are kept here and written in one transaction every FLUSH_MS.
//
// Every reader that needs a run's whole log gets it: the runner writes the
// waiting lines before it writes a run's status and when executeRun() ends,
// and the live log route (GET /v1/runs/:id/logs) writes them before it reads.
// A server stopped between two writes loses at most FLUSH_MS of lines; its
// running runs are marked failed at the next start anyway (reconcile.js).

const metrics = require('../utils/metrics');

const FLUSH_MS = 200;

const INSERT_SQL = `INSERT INTO run_events (run_id, ts, level, message,
   category, phase, suite_name, request_name, http_status,
   event_kind, attempt_index, attempt_total, scenario_name)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

let waiting = [];
let timer = null;

// The database is read at each write, so a test that closes and opens it
// again is not left with a closed handle.
function database() {
  return require('../db/db').db;
}

// One line: the thirteen values of INSERT_SQL, in its order. Never undefined:
// node:sqlite refuses it.
function queueRunLogLine(values) {
  waiting.push(values.map((v) => (v === undefined ? null : v)));
  if (!timer) {
    timer = setTimeout(flushRunLogs, FLUSH_MS);
    timer.unref?.();
  }
}

// All the waiting lines in one transaction, through transaction(), which
// times its COMMIT (#1221). Its BEGIN is outside the try: when it fails (a
// caller already inside a transaction), nothing of the caller's is rolled
// back, and the lines are written one by one inside it, as before.
function writeTogether(rows) {
  const store = require('../db/db');
  const insert = store.db.prepare(INSERT_SQL);
  store.transaction(() => {
    for (const row of rows) insert.run(...row);
  });
}

// One line at a time, each on its own: a line that cannot be written (its run
// deleted meanwhile) costs only itself. A log line never stops a run.
function writeOneByOne(rows) {
  let insert;
  try { insert = database().prepare(INSERT_SQL); } catch { return; }
  for (const row of rows) {
    try { insert.run(...row); } catch { /* never block a run on its log */ }
  }
}

// Writes every waiting line now. Returns how many were waiting.
function flushRunLogs() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (waiting.length === 0) return 0;
  const rows = waiting;
  waiting = [];
  const started = process.hrtime.bigint();
  try {
    writeTogether(rows);
  } catch {
    writeOneByOne(rows);
  }
  try {
    metrics.runLogSeconds.inc(Number(process.hrtime.bigint() - started) / 1e9);
  } catch { /* a metric never stops a log line */ }
  return rows.length;
}

function waitingRunLogLines() {
  return waiting.length;
}

module.exports = { queueRunLogLine, flushRunLogs, waitingRunLogLines, FLUSH_MS, INSERT_SQL };
