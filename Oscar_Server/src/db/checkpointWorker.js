// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * checkpointWorker.js — the database's checkpoints and statistics, off the
 * server's thread (#1230, #1238). Started by db.js startCheckpointThread()
 * with a connection of its own:
 * - every `intervalMs` it looks at the write-ahead log, and a passive
 *   checkpoint copies what the log holds into the database file when the log
 *   file is larger than `limitBytes`, when the last checkpoint is older than
 *   `maxWaitMs`, or when the last one could not copy everything (#1294). Not
 *   at every look: the server's first write after a complete checkpoint
 *   starts the log again and waits for the disk. A passive checkpoint never
 *   blocks a reader or a writer. Its time and the log's size go back to the
 *   server's thread for the metrics, and each look says the log file's size;
 * - with `optimize` on, `optimizeDelayMs` after the start and then every
 *   `optimizeEveryMs`, the tables SQLite says would benefit are analyzed
 *   (below), and the server's thread is told which, and before each table
 *   that it is analyzing one (#1269).
 * An error of a checkpoint ends the thread, and the server's connection then
 * checkpoints by itself again; an error of the statistics is only reported.
 * Only node: modules: nothing of the server runs here.
 */

const fs = require('node:fs');
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');

// The busy timeout: an ANALYZE waits for a write of the server's connection to
// end, instead of failing.
const db = new DatabaseSync(workerData.dbPath, { timeout: workerData.busyMs ?? 5000 });
const checkpoint = db.prepare('PRAGMA wal_checkpoint(PASSIVE)');
const WAL_PATH = `${workerData.dbPath}-wal`;
const LIMIT_BYTES = workerData.limitBytes ?? 0;
const MAX_WAIT_MS = workerData.maxWaitMs ?? 0;
let timer = null;
let optimizeTimer = null;
// When the last checkpoint ended, whether it left frames it could not copy (a
// reader still used them: tried again at the next look), and the log file as
// it was then.
let lastAt = 0;
let leftSome = false;
let seenAtLast = '';

// The log file: its size, and a mark that changes with every write to it. The
// server's connection cuts the file back to the limit when the log starts
// again (journal_size_limit), so a file larger than the limit holds more than
// the limit, unless nothing was written since it was last copied.
function walFile() {
  try {
    const stat = fs.statSync(WAL_PATH, { bigint: true });
    return { bytes: Number(stat.size), mark: `${stat.size}:${stat.mtimeNs}` };
  } catch {
    return { bytes: 0, mark: '' };   // no log yet
  }
}

function checkpointNow(file) {
  const started = process.hrtime.bigint();
  const { busy, log, checkpointed } = checkpoint.get();
  lastAt = Date.now();
  leftSome = Number(log) > Number(checkpointed);
  seenAtLast = file.mark;
  parentPort.postMessage({
    type: 'checkpoint',
    seconds: Number(process.hrtime.bigint() - started) / 1e9,
    busy,
    log,
    checkpointed,
    walBytes: file.bytes,
  });
}

// Whether this look copies the log: what the last checkpoint left, a log
// written since then and past its size, or a last checkpoint that is old.
function isDue(file) {
  if (leftSome) return true;
  if (file.bytes > LIMIT_BYTES && file.mark !== seenAtLast) return true;
  return Date.now() - lastAt >= MAX_WAIT_MS;
}

function tick() {
  const file = walFile();
  if (isDue(file)) checkpointNow(file);
  else parentPort.postMessage({ type: 'waiting', walBytes: file.bytes });
  timer = setTimeout(tick, workerData.intervalMs);
}

// ── The statistics (#1238) ───────────────────────────────────────────────────
// SQLite's advice for a long-lived connection: PRAGMA optimize=0x10002 when it
// opens, then PRAGMA optimize from time to time (sqlite.org/pragma.html). This
// connection runs no query of its own, so each run checks every table
// (0x10000). Mask 0x00001 makes SQLite list the ANALYZE statements it would
// run, without running them: each is then run alone, with an analysis limit,
// and a pause after it, so that the write lock ANALYZE takes is held for one
// table at a time and a write of the server's connection gets in between.
// The limit bounds the sample only: each index is still read in full to count
// its entries (#1269, measured: a limited ANALYZE took as long as a walk of
// the index). On a large database not yet in memory one table takes minutes,
// all of it under the write lock, which is why OSCAR_DB_OPTIMIZE is off by
// default.
const ANALYZE_STATEMENT = /^ANALYZE "main"\."((?:[^"]|"")+)"$/;
const ANALYSIS_LIMIT = 1000;

function tablesToAnalyze() {
  return db.prepare('PRAGMA optimize(0x10003)').all()
    .map((row) => ANALYZE_STATEMENT.exec(String(row.optimize)))
    .filter(Boolean)
    .map((match) => ({ statement: match[0], name: match[1].replaceAll('""', '"') }));
}

// One run: the tables listed, then each analyzed in a timer of its own, the
// pause after it being the wait for the next timer. Then the server's thread
// is told, and the next run is set.
function optimize() {
  const run = { started: process.hrtime.bigint(), tables: [], planned: [] };
  try {
    db.exec(`PRAGMA analysis_limit = ${ANALYSIS_LIMIT}`);
    run.planned = tablesToAnalyze();
  } catch (e) {
    report(run, e.message);
    return;
  }
  analyzeNext(run, 0);
}

function analyzeNext(run, i) {
  if (i >= run.planned.length) {
    report(run, null);
    return;
  }
  const table = run.planned[i];
  // Said first (#1269): an ANALYZE reads each index of its table in full,
  // whatever the analysis limit, and nothing else is posted until it ends.
  // The server's watchdog would otherwise take that silence for a dead thread.
  parentPort.postMessage({ type: 'analyzing', table: table.name });
  try {
    const t0 = process.hrtime.bigint();
    db.exec(table.statement);
    run.tables.push({ name: table.name, seconds: Number(process.hrtime.bigint() - t0) / 1e9 });
  } catch (e) {
    report(run, e.message);
    return;
  }
  optimizeTimer = setTimeout(() => analyzeNext(run, i + 1), workerData.optimizePauseMs ?? 250);
}

function report(run, error) {
  parentPort.postMessage({
    type: 'optimized',
    seconds: Number(process.hrtime.bigint() - run.started) / 1e9,
    tables: run.tables,
    error,
  });
  optimizeTimer = setTimeout(optimize, workerData.optimizeEveryMs);
}

// Asked to stop: the connection is closed, and with nothing left to do the
// thread ends. A run of the statistics between two tables waits on
// `optimizeTimer`, which is cleared here: it never touches the connection
// again.
parentPort.on('message', (msg) => {
  if (msg?.type !== 'stop') return;
  clearTimeout(timer);
  clearTimeout(optimizeTimer);
  db.close();
  parentPort.close();
});

parentPort.postMessage({ type: 'ready' });
timer = setTimeout(tick, workerData.intervalMs);
if (workerData.optimize) optimizeTimer = setTimeout(optimize, workerData.optimizeDelayMs);
