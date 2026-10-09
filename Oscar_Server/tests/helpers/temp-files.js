// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * temp-files.js — what the test suites leave in the system's temporary folder,
 * and how it is removed (#583).
 *
 * Each test file gets a database of its own (tests/setup.js). On Linux the
 * file is removed when the process ends. On Windows it cannot be: the database
 * is still open at that moment, and an open file cannot be removed there. So
 * the files of a run are removed by Jest's global teardown, after the worker
 * processes have ended, and whatever is still left from earlier runs is swept
 * at the start of the next one.
 */

const fs = require('node:fs');
const path = require('node:path');

// The per-file test database and its SQLite companions:
// oscar-test-<run>-<pid>-<time>.db, or oscar-test-<pid>-<time>.db before #583.
const TEST_DB = /^oscar-test-[0-9a-z]+-\d+(?:-\d+)?\.db(?:-journal|-wal|-shm)?$/;
// What the two migration tests create, when a run was cut short.
const MIGRATION_LEFTOVER = /^(?:oscar-mig-.+\.db(?:-journal|-wal|-shm)?|rv-mig-.+)$/;

/** Is this entry of the temporary folder something a test run left behind? */
function isTestLeftover(name) {
  return TEST_DB.test(name) || MIGRATION_LEFTOVER.test(name);
}

/** Is this entry a test database of the run named `runId`? */
function isTestDbOfRun(name, runId) {
  return TEST_DB.test(name) && name.startsWith(`oscar-test-${runId}-`);
}

/**
 * Remove the entries of `dir` that `matches(name)` accepts and, when
 * `olderThanMs` is given, that were last changed longer ago than that.
 *
 * Best effort, and never throws: an entry that cannot be removed (still open
 * in another process on Windows) is left where it is and counted as kept.
 */
function removeTempEntries({ dir, matches, olderThanMs = 0, now = Date.now() }) {
  const result = { removed: 0, kept: 0 };
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return result;
  }
  for (const name of names) {
    if (!matches(name)) continue;
    const full = path.join(dir, name);
    try {
      if (olderThanMs > 0 && now - fs.statSync(full).mtimeMs < olderThanMs) continue;
      fs.rmSync(full, { recursive: true, force: true });
      result.removed += 1;
    } catch {
      result.kept += 1;
    }
  }
  return result;
}

module.exports = { isTestLeftover, isTestDbOfRun, removeTempEntries };
