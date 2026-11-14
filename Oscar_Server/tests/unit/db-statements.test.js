// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1241: all/get/run keep their statements, the 200 used last, instead of
// preparing their SQL at every call (45-70 µs against 9-13 µs for a read by
// id), and the encryption key is read from its hex text once, and again only
// when ENCRYPTION_KEY changes.

const D = require('../../src/db/db');

const { get, all, run, encrypt, decrypt, colEncrypt, colDecrypt, keepStatements, keptStatements, STATEMENT_CACHE_SIZE } = D;

afterEach(() => {
  keepStatements(true);
});

function preparesOf(fn) {
  const spy = jest.spyOn(D.db, 'prepare');
  try {
    fn();
    return spy.mock.calls.map(([sql]) => sql);
  } finally {
    spy.mockRestore();
  }
}

describe('statements prepared once (#1241)', () => {
  test('one SQL text is prepared once, whichever helper runs it', () => {
    keepStatements(true);
    const sql = 'SELECT ? AS x';
    const prepared = preparesOf(() => {
      expect(get(sql, [1])).toEqual({ x: 1 });
      expect(get(sql, [2])).toEqual({ x: 2 });
      expect(all(sql, [3])).toEqual([{ x: 3 }]);
    });
    expect(prepared).toEqual([sql]);
    expect(keptStatements()).toBe(1);
  });

  test('a kept statement is a new one: a parameter not given reads NULL, not the last one', () => {
    const sql = 'SELECT ? AS a, ? AS b';
    expect(get(sql, [1, 2])).toEqual({ a: 1, b: 2 });
    expect(get(sql, [3])).toEqual({ a: 3, b: null });
  });

  test('run keeps its statement too, and gives its changes', () => {
    run('CREATE TABLE IF NOT EXISTS kept_rows (x INTEGER)');
    const sql = 'INSERT INTO kept_rows (x) VALUES (?)';
    const prepared = preparesOf(() => {
      expect(run(sql, [1]).changes).toBe(1);
      expect(run(sql, [2]).changes).toBe(1);
    });
    expect(prepared).toEqual([sql]);
    expect(get('SELECT COUNT(*) AS n FROM kept_rows').n).toBe(2);
    run('DROP TABLE kept_rows');
  });

  test('a kept statement follows a change of the schema', () => {
    run('CREATE TABLE IF NOT EXISTS kept_schema (a INTEGER)');
    run('INSERT INTO kept_schema (a) VALUES (1)');
    expect(get('SELECT * FROM kept_schema')).toEqual({ a: 1 });
    run("ALTER TABLE kept_schema ADD COLUMN b TEXT DEFAULT 'x'");
    expect(get('SELECT * FROM kept_schema')).toEqual({ a: 1, b: 'x' });
    run('DROP TABLE kept_schema');
  });

  test(`at most ${STATEMENT_CACHE_SIZE}, the one used last kept, the one unused longest let go`, () => {
    keepStatements(true);
    const sqlOf = (i) => `SELECT ${i} AS n`;
    get(sqlOf(0));
    for (let i = 1; i < STATEMENT_CACHE_SIZE; i++) get(sqlOf(i));
    expect(keptStatements()).toBe(STATEMENT_CACHE_SIZE);
    get(sqlOf(0));                                   // used again: now the last used
    get(sqlOf(STATEMENT_CACHE_SIZE));                // one more: statement 1 goes
    expect(keptStatements()).toBe(STATEMENT_CACHE_SIZE);
    expect(preparesOf(() => { get(sqlOf(0)); get(sqlOf(1)); })).toEqual([sqlOf(1)]);
  });

  test('turned off, every call prepares, as before; on again, nothing kept from before', () => {
    keepStatements(false);
    const sql = 'SELECT 7 AS n';
    expect(preparesOf(() => { get(sql); get(sql); })).toEqual([sql, sql]);
    expect(keptStatements()).toBe(0);
    keepStatements(true);
    expect(preparesOf(() => { get(sql); get(sql); })).toEqual([sql]);
  });
});

describe('the encryption key read once (#1241)', () => {
  const KEY_A = 'a'.repeat(64);
  const KEY_B = 'b'.repeat(64);
  let saved;
  beforeEach(() => { saved = process.env.ENCRYPTION_KEY; });
  afterEach(() => {
    if (saved === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = saved;
  });

  test('a hundred values encrypted read the hex text once', () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    encrypt('warm');
    const from = jest.spyOn(Buffer, 'from');
    try {
      for (let i = 0; i < 100; i++) expect(colDecrypt(colEncrypt(`value ${i}`))).toBe(`value ${i}`);
      expect(from.mock.calls.filter(([, encoding]) => encoding === 'hex')).toHaveLength(0);
    } finally {
      from.mockRestore();
    }
  });

  test('a new ENCRYPTION_KEY is read again: what the old key wrote no longer reads', () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    const written = encrypt('secret');
    expect(decrypt(written)).toBe('secret');
    process.env.ENCRYPTION_KEY = KEY_B;
    expect(() => decrypt(written)).toThrow();
    expect(decrypt(encrypt('other'))).toBe('other');
    process.env.ENCRYPTION_KEY = KEY_A;
    expect(decrypt(written)).toBe('secret');
  });

  test('a key of the wrong length is still refused, each time', () => {
    process.env.ENCRYPTION_KEY = 'abc';
    expect(() => encrypt('x')).toThrow('ENCRYPTION_KEY must be exactly 64 hex characters');
    expect(() => encrypt('x')).toThrow('ENCRYPTION_KEY must be exactly 64 hex characters');
  });
});
