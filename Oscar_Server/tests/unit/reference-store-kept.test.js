// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * reference-store-kept.test.js — the reference configurations are read and
 * parsed once per version of their files.
 *
 * The Run page and Test Config ask for the list of references at each load.
 * Each name used to read and parse the simulator's data file (1.9 MB) and
 * compute the reference's version again: six times a call. A file is now
 * parsed once while it stays the same (utils/keptJsonFile.js), and a version
 * computed once for the two files it comes from.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const R = require('../../src/utils/referenceConfiguration');
const referenceStore = require('../../src/utils/referenceStore');
const { keptJson, MAX_KEPT_FILES } = require('../../src/utils/keptJsonFile');
const { collectionJson } = require('../../src/api/helpers/catalogueSource');

const REPO_DATA = path.join(__dirname, '..', '..', '..', 'Bruno_Collection', 'data_base');
let collection;
let before;
let versionOf;

// A collection of its own, as COLLECTION_PATH names it on a server.
beforeAll(() => {
  collection = fs.mkdtempSync(path.join(os.tmpdir(), 'oscar-references-'));
  fs.mkdirSync(path.join(collection, 'data_base', 'reference'), { recursive: true });
  fs.copyFileSync(path.join(REPO_DATA, R.DATAFILE_NAME), path.join(collection, 'data_base', R.DATAFILE_NAME));
  for (const name of referenceStore.NAMES) {
    fs.copyFileSync(path.join(REPO_DATA, 'reference', `${name}.json`), path.join(collection, 'data_base', 'reference', `${name}.json`));
  }
  before = process.env.COLLECTION_PATH;
  process.env.COLLECTION_PATH = collection;
});

afterAll(() => {
  if (before === undefined) delete process.env.COLLECTION_PATH; else process.env.COLLECTION_PATH = before;
  fs.rmSync(collection, { recursive: true, force: true });
});

beforeEach(() => { versionOf = jest.spyOn(R, 'versionOf'); });
afterEach(() => { versionOf.mockRestore(); });

// A file written again with the same content: another version of the file.
function writeAgain(file) {
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, `${text}\n`);
}

test('there are references to read, and every one names its simulator', () => {
  expect(referenceStore.NAMES.length).toBeGreaterThanOrEqual(6);
  const available = referenceStore.availableReferences();
  expect(available.map(a => a.name)).toEqual([...referenceStore.NAMES]);
  for (const one of available) {
    expect(one.provider).toBeTruthy();
    expect(one.osdmVersion).toMatch(/^\d+[.]\d+[.]\d+$/);
  }
});

test('asked again and again, each file is parsed once and each version computed once', () => {
  referenceStore.availableReferences();
  versionOf.mockClear();
  const parse = jest.spyOn(JSON, 'parse');
  try {
    for (let i = 0; i < 5; i++) {
      referenceStore.availableReferences();
      for (const name of referenceStore.NAMES) referenceStore.loadReference(name);
    }
    expect(parse).not.toHaveBeenCalled();
    expect(versionOf).not.toHaveBeenCalled();
  } finally {
    parse.mockRestore();
  }
});

test('the same objects come back, frozen, with the version the files give', () => {
  const name = referenceStore.NAMES[0];
  const first = referenceStore.loadReference(name);
  const second = referenceStore.loadReference(name);
  expect(second.reference).toBe(first.reference);
  expect(second.datafile).toBe(first.datafile);
  expect(second.version).toBe(first.version);
  expect(Object.isFrozen(first.datafile)).toBe(true);
  expect(Object.isFrozen(first.reference)).toBe(true);
  expect(() => { first.datafile.scenarios.push({}); }).toThrow(TypeError);
  // The version is the one a fresh read of the two files gives.
  versionOf.mockRestore();
  const reference = JSON.parse(fs.readFileSync(path.join(collection, 'data_base', 'reference', `${name}.json`), 'utf8'));
  const datafile = JSON.parse(fs.readFileSync(path.join(collection, 'data_base', R.DATAFILE_NAME), 'utf8'));
  expect(first.version).toBe(R.versionOf(reference, datafile));
});

test('every reference shares one parsed data file, the catalogue\'s own', () => {
  const datafiles = new Set(referenceStore.NAMES.map(name => referenceStore.loadReference(name).datafile));
  expect(datafiles.size).toBe(1);
  expect([...datafiles][0]).toBe(collectionJson('data_base', R.DATAFILE_NAME));
});

test('a reference file that changed is read again, and only its version computed again', () => {
  const [changed, ...others] = referenceStore.NAMES;
  const was = Object.fromEntries(referenceStore.NAMES.map(name => [name, referenceStore.loadReference(name)]));
  versionOf.mockClear();
  writeAgain(path.join(collection, 'data_base', 'reference', `${changed}.json`));
  const now = referenceStore.loadReference(changed);
  expect(now.reference).not.toBe(was[changed].reference);
  expect(now.datafile).toBe(was[changed].datafile);
  expect(now.version).toBe(was[changed].version);   // the same content: the same version
  expect(versionOf).toHaveBeenCalledTimes(1);
  for (const name of others) expect(referenceStore.loadReference(name).reference).toBe(was[name].reference);
  expect(versionOf).toHaveBeenCalledTimes(1);
});

test('the data file changed: every version is computed again, once', () => {
  referenceStore.availableReferences();
  versionOf.mockClear();
  writeAgain(path.join(collection, 'data_base', R.DATAFILE_NAME));
  referenceStore.availableReferences();
  referenceStore.availableReferences();
  expect(versionOf).toHaveBeenCalledTimes(referenceStore.NAMES.length);
});

test('a name that is not of the list is not read; without a collection, the repository\'s copy is', () => {
  expect(referenceStore.loadReference('../../etc/passwd')).toBeNull();
  expect(referenceStore.loadReference('simulator-nobody')).toBeNull();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'oscar-no-collection-'));
  process.env.COLLECTION_PATH = empty;
  try {
    const loaded = referenceStore.loadReference(referenceStore.NAMES[0]);
    expect(loaded.reference).toBe(keptJson(path.join(REPO_DATA, 'reference', `${referenceStore.NAMES[0]}.json`)));
  } finally {
    process.env.COLLECTION_PATH = collection;
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('room is kept for every file: the catalogue, the data file and the references, in both places', () => {
  expect(MAX_KEPT_FILES).toBeGreaterThanOrEqual(2 * (referenceStore.NAMES.length + 2));
});

test('a file that cannot be read or is not JSON is not kept as something else', () => {
  const broken = path.join(collection, 'broken.json');
  fs.writeFileSync(broken, '{ not json');
  expect(() => keptJson(broken)).toThrow();
  expect(() => keptJson(path.join(collection, 'absent.json'))).toThrow();
  fs.writeFileSync(broken, '{"ok":true}');
  expect(keptJson(broken)).toEqual({ ok: true });
});
