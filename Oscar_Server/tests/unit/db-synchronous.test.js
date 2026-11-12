// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1224: the server's connection runs with synchronous = NORMAL. With
// SQLite's default, FULL, every COMMIT waited for the disk: 7 ms a COMMIT and
// 10 to 24 % of the server's thread during a batch on the k3s test machine
// (#1221). OSCAR_DB_SYNCHRONOUS=FULL keeps the old behaviour.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const dbModule = require('../../src/db/db');

const { get, synchronousSetting } = dbModule;
const NORMAL = 1;
const FULL = 2;

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oscar-sync-'));
afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// db.js opened afresh against a database of its own, with OSCAR_DB_SYNCHRONOUS
// set to `setting`; gives what the connection reads, then closes it (Windows
// cannot remove an open file, #583). The environment is put back after.
function bootWith(setting, name) {
  const saved = { path: process.env.OSCAR_DB_PATH, sync: process.env.OSCAR_DB_SYNCHRONOUS };
  const dbFile = path.join(tempDir, `${name}.db`);
  let read;
  try {
    process.env.OSCAR_DB_PATH = dbFile;
    if (setting === undefined) delete process.env.OSCAR_DB_SYNCHRONOUS;
    else process.env.OSCAR_DB_SYNCHRONOUS = setting;
    jest.isolateModules(() => {
      const fresh = require('../../src/db/db').db;
      try {
        read = {
          synchronous: fresh.prepare('PRAGMA synchronous').get().synchronous,
          journalMode: fresh.prepare('PRAGMA journal_mode').get().journal_mode,
        };
      } finally {
        fresh.close();
      }
    });
  } finally {
    for (const [key, value] of [['OSCAR_DB_PATH', saved.path], ['OSCAR_DB_SYNCHRONOUS', saved.sync]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return read;
}

describe('the server\'s connection (#1224)', () => {
  test('runs in WAL mode with synchronous NORMAL', () => {
    expect(get('PRAGMA journal_mode').journal_mode).toBe('wal');
    expect(get('PRAGMA synchronous').synchronous).toBe(NORMAL);
  });

  test('without the setting, NORMAL; with FULL, FULL', () => {
    expect(bootWith(undefined, 'unset')).toEqual({ synchronous: NORMAL, journalMode: 'wal' });
    expect(bootWith('FULL', 'full')).toEqual({ synchronous: FULL, journalMode: 'wal' });
    expect(bootWith(' normal ', 'normal')).toEqual({ synchronous: NORMAL, journalMode: 'wal' });
  });

  test('a value other than NORMAL or FULL stops the start, before the database is opened', () => {
    expect(() => bootWith('OFF', 'off')).toThrow('OSCAR_DB_SYNCHRONOUS must be NORMAL or FULL, not "OFF"');
    expect(fs.existsSync(path.join(tempDir, 'off.db'))).toBe(false);
  });

  test('a database in another journal mode keeps SQLite\'s default', () => {
    const dbFile = path.join(tempDir, 'rollback.db');
    const before = new DatabaseSync(dbFile);
    before.exec('PRAGMA journal_mode = DELETE');
    before.close();
    // schema.sql asks for WAL, so a file of OSCAR's is always in WAL: this
    // reads the rule on a connection whose mode another program set.
    const other = new DatabaseSync(dbFile);
    try {
      expect(other.prepare('PRAGMA journal_mode').get().journal_mode).toBe('delete');
      expect(other.prepare('PRAGMA synchronous').get().synchronous).toBe(FULL);
    } finally {
      other.close();
    }
  });
});

describe('synchronousSetting()', () => {
  test('NORMAL when unset or empty, else NORMAL or FULL whatever the case', () => {
    expect(synchronousSetting(undefined)).toBe('NORMAL');
    expect(synchronousSetting('')).toBe('NORMAL');
    expect(synchronousSetting('normal')).toBe('NORMAL');
    expect(synchronousSetting('Full')).toBe('FULL');
    expect(synchronousSetting(' FULL ')).toBe('FULL');
  });

  test.each(['OFF', 'EXTRA', '0', '1', '2', 'NORMAL;', 'FULL --'])('refuses %p', (value) => {
    expect(() => synchronousSetting(value)).toThrow('OSCAR_DB_SYNCHRONOUS must be NORMAL or FULL');
  });

  test('the PRAGMA is one of two fixed texts, never built from the setting', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/db/db.js'), 'utf8');
    expect(src).toContain("db.exec(SYNCHRONOUS === 'FULL' ? 'PRAGMA synchronous = FULL' : 'PRAGMA synchronous = NORMAL');");
    expect(src).not.toMatch(/PRAGMA synchronous = \$\{/);
  });
});
