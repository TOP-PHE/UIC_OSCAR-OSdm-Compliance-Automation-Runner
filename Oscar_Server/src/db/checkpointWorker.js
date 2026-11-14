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
let stopping = false;

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

function pause(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function optimize() {
  const started = process.hrtime.bigint();
  const tables = [];
  let error = null;
  try {
    db.exec(`PRAGMA analysis_limit = ${ANALYSIS_LIMIT}`);
    for (const table of tablesToAnalyze()) {
      if (stopping) return;
      const t0 = process.hrtime.bigint();
      db.exec(table.statement);
      tables.push({ name: table.name, seconds: Number(process.hrtime.bigint() - t0) / 1e9 });
      await pause(workerData.optimizePauseMs ?? 250);
    }
  } catch (e) {
    error = e.message;
  }
  if (stopping) return;
  parentPort.postMessage({
    type: 'optimized',
    seconds: Number(process.hrtime.bigint() - started) / 1e9,
    tables,
    error,
  });
  optimizeTimer = setTimeout(optimize, workerData.optimizeEveryMs);
}

// Asked to stop: the connection is closed, and with nothing left to do the
// thread ends. A run of the statistics waiting between two tables sees
// `stopping` and never touches the connection again.
parentPort.on('message', (msg) => {
  if (msg?.type !== 'stop') return;
  stopping = true;
  clearTimeout(timer);
  clearTimeout(optimizeTimer);
  db.close();
  parentPort.close();
});

parentPort.postMessage({ type: 'ready' });
timer = setTimeout(tick, workerData.intervalMs);
if (workerData.optimize) optimizeTimer = setTimeout(optimize, workerData.optimizeDelayMs);
