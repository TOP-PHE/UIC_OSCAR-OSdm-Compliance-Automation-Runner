// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * temp-files.test.js — what a test run may remove from the temporary folder
 * (#583). The folder is shared with everything else on the machine, so the
 * rule that says "this is ours" is tested for what it refuses as much as for
 * what it takes.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isTestLeftover, isTestDbOfRun, removeTempEntries } = require('../helpers/temp-files');

const HOUR = 60 * 60 * 1000;

describe('which entries of the temporary folder are a test run\'s', () => {
  test.each([
    'oscar-test-1a2b3c4d-4242-1791490000000.db',
    'oscar-test-1a2b3c4d-4242-1791490000000.db-wal',
    'oscar-test-1a2b3c4d-4242-1791490000000.db-shm',
    'oscar-test-1a2b3c4d-4242-1791490000000.db-journal',
    'oscar-test-solo-4242-1791490000000.db',
    'oscar-test-4242-1791490000000.db',          // the name before #583
    'oscar-test-4242-1791490000000.db-wal',
    'oscar-mig-4242-1791490000000-k3j9x.db',
    'oscar-mig-4242-1791490000000-k3j9x.db-shm',
    'rv-mig-AbC123',
  ])('%s is', (name) => {
    expect(isTestLeftover(name)).toBe(true);
  });

  test.each([
    'oscar-test-collection',                     // the dummy collection folder every test file uses
    'oscar-test-1a2b3c4d-4242-1791490000000.db.bak',
    'oscar-test-1a2b3c4d.db',
    'oscar-test-.db',
    'my-oscar-test-4242-1791490000000.db',
    'oscar.db',
    'oscar-backup-20261008.tar.gz.gpg',
    'oscar-mig-notes.txt',
    'osdm-sim-AbC123',
    'rv-mig',
    'report.db',
    '',
  ])('%s is not', (name) => {
    expect(isTestLeftover(name)).toBe(false);
  });

  test('a database belongs to the run its name carries, and to no other', () => {
    expect(isTestDbOfRun('oscar-test-1a2b3c4d-4242-1791490000000.db', '1a2b3c4d')).toBe(true);
    expect(isTestDbOfRun('oscar-test-1a2b3c4d-4242-1791490000000.db-wal', '1a2b3c4d')).toBe(true);
    expect(isTestDbOfRun('oscar-test-9f8e7d6c-4242-1791490000000.db', '1a2b3c4d')).toBe(false);
    expect(isTestDbOfRun('oscar-test-1a2b3c4d5-4242-1791490000000.db', '1a2b3c4d')).toBe(false);
    expect(isTestDbOfRun('oscar-test-4242-1791490000000.db', '4242')).toBe(true);   // an old name is one "run"
    expect(isTestDbOfRun('oscar-mig-1a2b3c4d-4242.db', '1a2b3c4d')).toBe(false);
    expect(isTestDbOfRun('rv-mig-1a2b3c4d', '1a2b3c4d')).toBe(false);
  });
});

describe('removing them', () => {
  let dir;
  const now = Date.parse('2026-10-09T12:00:00Z');
  const put = (name, ageMs, asFolder = false) => {
    const full = path.join(dir, name);
    if (asFolder) {
      fs.mkdirSync(full);
      fs.writeFileSync(path.join(full, 'm0.db'), 'x');
    } else {
      fs.writeFileSync(full, 'x');
    }
    const when = new Date(now - ageMs);
    fs.utimesSync(full, when, when);
    return name;
  };
  const left = () => fs.readdirSync(dir).sort();

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-sweep-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('the sweep takes what is ours and old enough, and leaves everything else', () => {
    put('oscar-test-aaaaaaaa-1-1.db', 7 * HOUR);
    put('oscar-test-aaaaaaaa-1-1.db-wal', 7 * HOUR);
    put('oscar-test-11-22.db', 30 * 24 * HOUR);
    put('oscar-mig-1-2-abc.db', 7 * HOUR);
    put('rv-mig-AbC123', 7 * HOUR, true);
    const recent = put('oscar-test-bbbbbbbb-2-2.db', 1 * HOUR);          // another run, still going on
    const collection = put('oscar-test-collection', 30 * 24 * HOUR, true);
    const foreign = put('somebody-elses.db', 30 * 24 * HOUR);

    const result = removeTempEntries({ dir, matches: isTestLeftover, olderThanMs: 6 * HOUR, now });

    expect(result).toEqual({ removed: 5, kept: 0 });
    expect(left()).toEqual([recent, collection, foreign].sort());
    expect(fs.existsSync(path.join(dir, collection, 'm0.db'))).toBe(true);
  });

  test('the teardown takes the databases of its own run, whatever their age, and no other run\'s', () => {
    put('oscar-test-aaaaaaaa-1-1.db', 0);
    put('oscar-test-aaaaaaaa-1-1.db-shm', 0);
    put('oscar-test-aaaaaaaa-7-9.db', 0);
    const other = put('oscar-test-bbbbbbbb-2-2.db', 0);
    const migration = put('oscar-mig-1-2-abc.db', 0);

    const result = removeTempEntries({ dir, matches: (name) => isTestDbOfRun(name, 'aaaaaaaa'), now });

    expect(result).toEqual({ removed: 3, kept: 0 });
    expect(left()).toEqual([migration, other].sort());
  });

  test('an entry that cannot be removed is left and counted, and the rest still goes', () => {
    const locked = put('oscar-test-aaaaaaaa-1-1.db', 7 * HOUR);
    put('oscar-test-aaaaaaaa-2-2.db', 7 * HOUR);
    const realRm = fs.rmSync;
    const spy = jest.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (String(target).endsWith(locked)) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      return realRm(target, options);
    });
    try {
      expect(removeTempEntries({ dir, matches: isTestLeftover, olderThanMs: 6 * HOUR, now })).toEqual({ removed: 1, kept: 1 });
    } finally {
      spy.mockRestore();
    }
    expect(left()).toEqual([locked]);
  });

  test('a folder that is not there, or an entry that vanishes meanwhile, is not an error', () => {
    expect(removeTempEntries({ dir: path.join(dir, 'missing'), matches: isTestLeftover })).toEqual({ removed: 0, kept: 0 });
    put('oscar-test-aaaaaaaa-1-1.db', 7 * HOUR);
    const spy = jest.spyOn(fs, 'statSync').mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    try {
      expect(removeTempEntries({ dir, matches: isTestLeftover, olderThanMs: 6 * HOUR, now })).toEqual({ removed: 0, kept: 1 });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('how a run is wired', () => {
  const root = path.resolve(__dirname, '..', '..');

  test('Jest runs the global setup and teardown', () => {
    const { jest: config } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(config.globalSetup).toBe('<rootDir>/tests/global-setup.js');
    expect(config.globalTeardown).toBe('<rootDir>/tests/global-teardown.js');
  });

  test('this test file\'s own database carries the run\'s id, in the shape the teardown removes', () => {
    const name = path.basename(process.env.OSCAR_DB_PATH);
    expect(process.env.OSCAR_TEST_RUN).toMatch(/^[0-9a-f]{8}$/);
    expect(isTestDbOfRun(name, process.env.OSCAR_TEST_RUN)).toBe(true);
    expect(isTestLeftover(name)).toBe(true);
  });
});
