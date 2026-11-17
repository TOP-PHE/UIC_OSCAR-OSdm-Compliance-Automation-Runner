// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1237: the server's connection runs with a page cache of 64 MB, a memory
// map of 256 MB and temporary storage in memory, where SQLite's defaults are
// 2 MB, no map and files. OSCAR_DB_CACHE_MB, OSCAR_DB_MMAP_MB and
// OSCAR_DB_TEMP_STORE change them; a wrong value stops the start before the
// database is opened.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const dbModule = require('../../src/db/db');

const { cacheSetting, mmapSetting, tempStoreSetting, memorySettings } = dbModule;
const MB = 1024 * 1024;
const SETTINGS = ['OSCAR_DB_CACHE_MB', 'OSCAR_DB_MMAP_MB', 'OSCAR_DB_TEMP_STORE'];

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oscar-memory-'));
afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// db.js opened afresh against a database of its own with `settings` (unset
// when absent); gives memorySettings() of that connection and the start-up
// line, then closes it (Windows cannot remove an open file, #583). The
// environment is put back after.
function bootWith(settings, name) {
  const saved = Object.fromEntries(['OSCAR_DB_PATH', ...SETTINGS].map((key) => [key, process.env[key]]));
  const lines = [];
  const spy = jest.spyOn(console, 'log').mockImplementation((line) => { lines.push(String(line)); });
  let read;
  try {
    process.env.OSCAR_DB_PATH = path.join(tempDir, `${name}.db`);
    for (const key of SETTINGS) {
      if (settings[key] === undefined) delete process.env[key];
      else process.env[key] = settings[key];
    }
    jest.isolateModules(() => {
      const fresh = require('../../src/db/db');
      try {
        read = fresh.memorySettings();
      } finally {
        fresh.db.close();
      }
    });
  } finally {
    spy.mockRestore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return { ...read, ready: lines.find((line) => line.startsWith('[db] SQLite ready')) };
}

describe('the server\'s connection (#1237)', () => {
  test('a cache of 64 MB, a map of 256 MB, temporary storage in memory', () => {
    expect(memorySettings()).toEqual({ cacheBytes: 64 * MB, mmapBytes: 256 * MB, tempStore: 2 });
  });

  test('without the settings, the same, and the start-up line says so', () => {
    const read = bootWith({}, 'unset');
    expect(read).toMatchObject({ cacheBytes: 64 * MB, mmapBytes: 256 * MB, tempStore: 2 });
    expect(read.ready).toContain('cache 64 MB, memory map 256 MB, temporary storage memory');
  });

  test('each setting changes its own', () => {
    const read = bootWith({ OSCAR_DB_CACHE_MB: '16', OSCAR_DB_MMAP_MB: ' 0 ', OSCAR_DB_TEMP_STORE: 'file' }, 'set');
    expect(read).toMatchObject({ cacheBytes: 16 * MB, mmapBytes: 0, tempStore: 1 });
    expect(read.ready).toContain('cache 16 MB, memory map 0 MB, temporary storage files');
    expect(bootWith({ OSCAR_DB_MMAP_MB: '2047' }, 'largest')).toMatchObject({ mmapBytes: 2047 * MB });
  });

  test.each([
    ['OSCAR_DB_CACHE_MB', '1', 'OSCAR_DB_CACHE_MB must be a whole number of megabytes from 2 to 1024, not "1"'],
    ['OSCAR_DB_MMAP_MB', '4096', 'OSCAR_DB_MMAP_MB must be a whole number of megabytes from 0 to 2047, not "4096"'],
    ['OSCAR_DB_TEMP_STORE', 'DEFAULT', 'OSCAR_DB_TEMP_STORE must be MEMORY or FILE, not "DEFAULT"'],
  ])('a wrong %s stops the start, before the database is opened', (key, value, message) => {
    const name = `wrong-${key}`;
    expect(() => bootWith({ [key]: value }, name)).toThrow(message);
    expect(fs.existsSync(path.join(tempDir, `${name}.db`))).toBe(false);
  });
});

describe('the settings', () => {
  test('cache: 64 unset or empty, else a whole number from 2 to 1024', () => {
    expect(cacheSetting(undefined)).toBe(64);
    expect(cacheSetting('')).toBe(64);
    expect(cacheSetting('2')).toBe(2);
    expect(cacheSetting(' 1024 ')).toBe(1024);
  });

  test('memory map: 256 unset or empty, else a whole number from 0 to 2047', () => {
    expect(mmapSetting(undefined)).toBe(256);
    expect(mmapSetting('')).toBe(256);
    expect(mmapSetting('0')).toBe(0);
    expect(mmapSetting('2047')).toBe(2047);
  });

  test('temporary storage: MEMORY unset or empty, else MEMORY or FILE whatever the case', () => {
    expect(tempStoreSetting(undefined)).toBe('MEMORY');
    expect(tempStoreSetting('')).toBe('MEMORY');
    expect(tempStoreSetting(' file ')).toBe('FILE');
    expect(tempStoreSetting('Memory')).toBe('MEMORY');
  });

  test.each(['1', '1025', '-64', '64.5', '1e2', '0x40', '64;', '64 MB', '12345'])('cache refuses %p', (value) => {
    expect(() => cacheSetting(value)).toThrow('OSCAR_DB_CACHE_MB must be a whole number of megabytes');
  });

  test.each(['2048', '-1', '256.0', '256; PRAGMA x', 'none'])('memory map refuses %p', (value) => {
    expect(() => mmapSetting(value)).toThrow('OSCAR_DB_MMAP_MB must be a whole number of megabytes');
  });

  test.each(['DEFAULT', '0', '2', 'MEMORY;', 'FILE --'])('temporary storage refuses %p', (value) => {
    expect(() => tempStoreSetting(value)).toThrow('OSCAR_DB_TEMP_STORE must be MEMORY or FILE');
  });

  test('the PRAGMAs hold checked numbers or one of two fixed texts, never a setting\'s text', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/db/db.js'), 'utf8');
    expect(src).toContain('db.exec(`PRAGMA cache_size = -${Number(CACHE_MB) * 1024}`);');
    expect(src).toContain('db.exec(`PRAGMA mmap_size = ${Number(MMAP_MB) * 1024 * 1024}`);');
    expect(src).toContain("db.exec(TEMP_STORE === 'FILE' ? 'PRAGMA temp_store = FILE' : 'PRAGMA temp_store = MEMORY');");
    // #1294: the size the log file is cut back to, a whole number that
    // startCheckpointThread() makes from a checked setting.
    expect(src).toContain('db.exec(`PRAGMA journal_size_limit = ${Number(state.limitBytes)}`);');
    expect(src).toContain('const limit = Math.max(Math.floor(Number(limitBytes)) || 0, 0);');
    // Those three are the only PRAGMAs of db.js built from a value.
    expect(src.match(/PRAGMA [a-z_]+ = -?\$\{/g)).toHaveLength(3);
  });
});

describe('memorySettings()', () => {
  test('reads a cache given in pages, and a database in memory has no map', () => {
    const other = new DatabaseSync(':memory:');
    try {
      other.exec('PRAGMA cache_size = 100');
      const pageSize = other.prepare('PRAGMA page_size').get().page_size;
      expect(memorySettings(other)).toEqual({ cacheBytes: 100 * pageSize, mmapBytes: 0, tempStore: 0 });
    } finally {
      other.close();
    }
  });
});
