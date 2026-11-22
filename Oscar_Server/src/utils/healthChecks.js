// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * healthChecks.js — the two checks of GET /health that touch the disk.
 *
 * /health has no session: the probes, the monitoring and each page's version
 * line read it. At every call it wrote and removed a file in the data folder
 * and asked the file system for its free space, on the server's one thread.
 * Both answers are now kept for KEEP_MS: a probe every 15 or 30 seconds still
 * reads the disk each time, a burst of calls reads it once.
 *
 * What a failed check says is a code (EACCES, ENOSPC…), never the error's own
 * words: those can hold a path of the machine, and anyone can read /health.
 * The words go to the server's log (the caller's `warn`).
 */

const fs = require('node:fs');
const path = require('node:path');

const KEEP_MS = 10_000;
const MIN_FREE_MB = 100;

const SERVER_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(SERVER_ROOT, 'data');

/** An error's code when it is a plain word, else `error`. */
function errorCode(err) {
  const code = err?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(code) ? code : 'error';
}

function dataFolderCheck(dataDir, files, warn) {
  try {
    const testFile = path.join(dataDir, '.health-check');
    files.writeFileSync(testFile, 'ok');
    files.unlinkSync(testFile);
    return { ok: true, status: 'writable' };
  } catch (err) {
    warn('health: the data folder is not writable', err);
    return { ok: false, status: 'error', error: errorCode(err) };
  }
}

function freeSpaceCheck(root, files) {
  try {
    const stats = files.statfsSync ? files.statfsSync(root) : null;
    if (!stats) return { ok: true, status: 'not_checked' };
    const freeMb = Math.floor((stats.bavail * stats.bsize) / (1024 * 1024));
    return { ok: freeMb > MIN_FREE_MB, free_mb: freeMb };
  } catch {
    // A free-space reading that fails is reported, and fails nothing.
    return { ok: true, status: 'check_failed_non_critical' };
  }
}

let kept = null;   // { at, value }

/**
 * { data_dir, disk, ok }: read from the disk when nothing is kept, or what is
 * kept is KEEP_MS old (or from a clock that has gone back).
 */
function diskChecks({ now = Date.now(), dataDir = DATA_DIR, root = SERVER_ROOT, files = fs, warn = () => {} } = {}) {
  if (kept && now >= kept.at && now - kept.at < KEEP_MS) return kept.value;
  const data_dir = dataFolderCheck(dataDir, files, warn);
  const disk = freeSpaceCheck(root, files);
  kept = { at: now, value: { data_dir, disk, ok: data_dir.ok && disk.ok } };
  return kept.value;
}

/** Tests: the next call reads the disk. */
function forgetDiskChecks() { kept = null; }

module.exports = { diskChecks, forgetDiskChecks, errorCode, KEEP_MS, MIN_FREE_MB };
