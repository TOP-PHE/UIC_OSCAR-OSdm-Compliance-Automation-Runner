// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * version-info.test.js — unit tests for utils/versionInfo.js.
 *
 * versionInfo does all its work at MODULE LOAD (reads package.json, the
 * COLLECTION_PATH/VERSION file, and compatibility.json, then computes the
 * matched release). So each case sets env + temp files first, then re-requires
 * the module fresh via jest.isolateModules and inspects getVersionInfo().
 */

const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

// serverVersion is read from the REAL package.json — craft the compat matrix to
// match it when we want a "tested" result.
const SERVER_VERSION = require('../../package.json').version;

let tmpDir;
let saved;

function loadFresh() {
  let info;
  jest.isolateModules(() => { info = require('../../src/utils/versionInfo').getVersionInfo(); });
  return info;
}

function writeCompat(obj) {
  const p = path.join(tmpDir, 'compatibility.json');
  fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
  process.env.COMPATIBILITY_FILE = p;
}

function writeCollectionVersion(v) {
  fs.writeFileSync(path.join(tmpDir, 'VERSION'), v + '\n');
  process.env.COLLECTION_PATH = tmpDir;
}

beforeEach(() => {
  saved = { CP: process.env.COLLECTION_PATH, CF: process.env.COMPATIBILITY_FILE };
  // Private (0700) temp dir — never write straight into os.tmpdir().
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verinfo-'));
  delete process.env.COLLECTION_PATH;
  delete process.env.COMPATIBILITY_FILE;
});

afterEach(() => {
  if (saved.CP === undefined) delete process.env.COLLECTION_PATH; else process.env.COLLECTION_PATH = saved.CP;
  if (saved.CF === undefined) delete process.env.COMPATIBILITY_FILE; else process.env.COMPATIBILITY_FILE = saved.CF;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('versionInfo — compatibility matrix resolution', () => {
  test('matrix_missing when compatibility.json cannot be read', () => {
    process.env.COMPATIBILITY_FILE = path.join(tmpDir, 'does-not-exist.json');
    const info = loadFresh();
    expect(info.compatibility_status).toBe('matrix_missing');
    expect(info.release_label).toBeNull();
    expect(info.server_version).toBe(SERVER_VERSION);
  });

  test('matrix_missing when compatibility.json is malformed JSON', () => {
    writeCompat('{ not valid json');
    expect(loadFresh().compatibility_status).toBe('matrix_missing');
  });

  test('untested_combination when the matrix has no matching release', () => {
    writeCollectionVersion('OTST_TEST_1');
    writeCompat({ releases: [{ server: '0.0.0-nope', collection: 'OTST_TEST_1', release: 'r0' }] });
    const info = loadFresh();
    expect(info.compatibility_status).toBe('untested_combination');
    expect(info.release_label).toBeNull();
    expect(info.collection_version).toBe('OTST_TEST_1');
  });

  test('untested_combination when releases is not an array', () => {
    writeCompat({ releases: 'not-an-array' });
    expect(loadFresh().compatibility_status).toBe('untested_combination');
  });

  test('tested on an exact server+collection match', () => {
    writeCollectionVersion('OTST_TEST_EXACT');
    writeCompat({ releases: [{ server: SERVER_VERSION, collection: 'OTST_TEST_EXACT', release: 'rel-exact' }] });
    const info = loadFresh();
    expect(info.compatibility_status).toBe('tested');
    expect(info.release_label).toBe('rel-exact');
  });

  test('tested via a ".x" wildcard on max_collection', () => {
    writeCollectionVersion('OTST_V9.0.5');
    writeCompat({ releases: [{ server: SERVER_VERSION, collection: 'OTST_V9.0.0', max_collection: 'OTST_V9.0.x', release: 'rel-wild' }] });
    const info = loadFresh();
    expect(info.compatibility_status).toBe('tested');
    expect(info.release_label).toBe('rel-wild');
  });

  test('collection_version is "unknown" when COLLECTION_PATH is not set', () => {
    // no writeCollectionVersion → COLLECTION_PATH unset
    writeCompat({ releases: [{ server: SERVER_VERSION, collection: 'x', release: 'r' }] });
    const info = loadFresh();
    expect(info.collection_version).toBe('unknown');
    expect(info.compatibility_status).toBe('untested_combination'); // unknown != 'x'
  });

  test('getVersionInfo exposes the resolved compatibility_file path', () => {
    writeCompat({ releases: [] });
    expect(loadFresh().compatibility_file).toContain('compatibility.json');
  });
});
