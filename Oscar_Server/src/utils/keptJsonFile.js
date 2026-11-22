// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * keptJsonFile.js — a JSON file of the collection, parsed once per version of
 * the file (#1236).
 *
 * The collection is refreshed on the server without a restart, so a file is
 * looked at each time it is asked for; it is read and parsed again only when
 * its version moved (size, times and inode: runDatafile.fileVersion()). What
 * is kept is frozen: every reader gets the same object, and one that writes
 * into it throws instead of changing what the others read.
 *
 * While the file is the same, the same object comes back: a reader may keep
 * what it computed from it under that object (referenceStore.js does).
 *
 * It was part of api/helpers/catalogueSource.js until the reference
 * configurations needed it too.
 */

const fs = require('node:fs');
const { fileVersion, deepFreeze } = require('./runDatafile');

// The catalogue, the simulator's data file, one reference per simulator, and
// room for the two places a file may be read from.
const MAX_KEPT_FILES = 24;
const keptFiles = new Map();

/**
 * The file's content, parsed and frozen. It throws when the file cannot be
 * read or is not JSON.
 *
 * The file is opened once and its version and text read from what was
 * opened, so a file replaced in between is never kept under the other's
 * version.
 */
function keptJson(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const version = fileVersion(fs.fstatSync(fd, { bigint: true }));
    const kept = keptFiles.get(file);
    if (kept?.version === version) return kept.value;
    const value = deepFreeze(JSON.parse(fs.readFileSync(fd, 'utf8')));
    keptFiles.delete(file);
    keptFiles.set(file, { version, value });
    while (keptFiles.size > MAX_KEPT_FILES) keptFiles.delete(keptFiles.keys().next().value);
    return value;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { keptJson, MAX_KEPT_FILES };
