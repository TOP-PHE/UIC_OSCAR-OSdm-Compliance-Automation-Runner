// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * checkpointWorker.js — the database's checkpoints, off the server's thread
 * (#1230). Started by db.js startCheckpointThread() with a connection of its
 * own: every `intervalMs` a passive checkpoint copies what the write-ahead log
 * holds into the database file. A passive checkpoint never blocks a reader or
 * a writer. Its time and the log's size go back to the server's thread for the
 * metrics. An error here ends the thread, and the server's connection then
 * checkpoints by itself again. Only node: modules: nothing of the server runs
 * here.
 */

const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(workerData.dbPath);
const checkpoint = db.prepare('PRAGMA wal_checkpoint(PASSIVE)');
let timer = null;

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

// Asked to stop: the connection is closed, and with nothing left to do the
// thread ends.
parentPort.on('message', (msg) => {
  if (msg?.type !== 'stop') return;
  clearTimeout(timer);
  db.close();
  parentPort.close();
});

parentPort.postMessage({ type: 'ready' });
timer = setTimeout(tick, workerData.intervalMs);
