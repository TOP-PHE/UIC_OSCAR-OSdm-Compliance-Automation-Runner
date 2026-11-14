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
 * - every `intervalMs` a passive checkpoint copies what the write-ahead log
 *   holds into the database file. A passive checkpoint never blocks a reader
 *   or a writer. Its time and the log's size go back to the server's thread
 *   for the metrics;
 * - with `optimize` on, `optimizeDelayMs` after the start and then every
 *   `optimizeEveryMs`, the tables SQLite says would benefit are analyzed
 *   (below), and the server's thread is told which.
 * An error of a checkpoint ends the thread, and the server's connection then
 * checkpoints by itself again; an error of the statistics is only reported.
 * Only node: modules: nothing of the server runs here.
 */

const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');

// The busy timeout: an ANALYZE waits for a write of the server's connection to
// end, instead of failing.
const db = new DatabaseSync(workerData.dbPath, { timeout: workerData.busyMs ?? 5000 });
const checkpoint = db.prepare('PRAGMA wal_checkpoint(PASSIVE)');
let timer = null;
let optimizeTimer = null;

function tick() {
  const started = process.hrtime.bigint();
  const { busy, log, checkpointed } = checkpoint.get();
  parentPort.postMessage({
    type: 'checkpoint',
    seconds: Number(process.hrtime.bigint() - started) / 1e9,
    busy,
    log,
    checkpointed,
  });
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
