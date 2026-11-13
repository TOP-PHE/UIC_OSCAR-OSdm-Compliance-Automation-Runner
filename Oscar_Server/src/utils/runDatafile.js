// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * runDatafile.js — the data file as the runs read it, read once per version
 * (#1235).
 *
 * At each run's start the data file was decrypted and parsed up to seven
 * times on the server's thread: four times by the runner's checks, then by
 * GET /data/:filename, which made the run's copy (framework warnings, trip
 * calendars, template check). On the simulator's data file (1.7 MB) that is
 * about 150 ms a run, and every run of a batch reads the same file.
 *
 * - forChecks(path): the parsed file, frozen, for the runner's checks (they
 *   only read it). One read per version of the file; runs starting together
 *   share it.
 * - runCopy(companyId, version, make): the run's copy, made once per version
 *   of the data file, the Test Framework and the Test Data, which the caller
 *   puts in `version`.
 *
 * Kept per path and per company, at most MAX_ENTRIES of each, the least
 * recently used dropped first. Never across companies: the copy is kept under
 * the company the run's secret was issued for.
 */

const fs = require('node:fs');
const { decryptFromFileAsync } = require('./at-rest');

const MAX_ENTRIES = 32;
const forChecksByPath = new Map();
const runCopyByCompany = new Map();

function remember(map, key, entry) {
  map.delete(key);
  map.set(key, entry);
  while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value);
}

/**
 * The version of a file on disk, from a `{ bigint: true }` stat: OSCAR writes
 * a data file as a new file renamed over the old one (a new inode), and any
 * write in place changes its times to the nanosecond.
 */
function fileVersion(stat) {
  return `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}`;
}

/** Freezes a parsed value and everything in it, without recursion. */
function deepFreeze(value) {
  const stack = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (v === null || typeof v !== 'object' || Object.isFrozen(v)) continue;
    Object.freeze(v);
    for (const key of Object.keys(v)) stack.push(v[key]);
  }
  return value;
}

/**
 * The data file at `path`, parsed and frozen: { value, from } where `from`
 * is 'file' when it was read now, 'memory' when it was kept. Rejects as the
 * read or the parse would.
 */
async function forChecks(path) {
  const version = fileVersion(await fs.promises.stat(path, { bigint: true }));
  const kept = forChecksByPath.get(path);
  if (kept?.version === version) {
    remember(forChecksByPath, path, kept);
    return { value: await kept.promise, from: 'memory' };
  }
  const promise = decryptFromFileAsync(path).then((buf) => deepFreeze(JSON.parse(buf.toString('utf8'))));
  const entry = { version, promise };
  remember(forChecksByPath, path, entry);
  try {
    return { value: await promise, from: 'file' };
  } catch (err) {
    if (forChecksByPath.get(path) === entry) forChecksByPath.delete(path);
    throw err;
  }
}

/**
 * The run's copy of a company's data file: { copy, from }. `make()` makes it
 * (synchronously) when none is kept for `version`; what it throws is thrown.
 */
function runCopy(companyId, version, make) {
  const kept = runCopyByCompany.get(companyId);
  if (kept?.version === version) {
    remember(runCopyByCompany, companyId, kept);
    return { copy: kept.copy, from: 'memory' };
  }
  const copy = make();
  remember(runCopyByCompany, companyId, { version, copy });
  return { copy, from: 'file' };
}

/** Forgets everything kept (tests). */
function forgetAll() {
  forChecksByPath.clear();
  runCopyByCompany.clear();
}

module.exports = { forChecks, runCopy, fileVersion, deepFreeze, forgetAll, MAX_ENTRIES };
