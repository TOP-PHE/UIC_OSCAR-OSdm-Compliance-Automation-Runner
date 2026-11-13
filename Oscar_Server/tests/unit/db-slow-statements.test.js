// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1234: every statement of db.js's all/get/run is timed once server.js asks
// for it, and one of OSCAR_DB_SLOW_MS or more is counted and logged with its
// SQL and the place in OSCAR's code that ran it, never its values. Seven
// rounds of measurement on the k3s test machine found the slow statements one
// by one; this names them.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { slowStatementSetting, sqlShape, callerOf } = require('../../src/db/db');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oscar-slow-'));
const booted = [];

afterAll(() => {
  for (const m of booted) {
    try { m.db.close(); } catch { /* already closed */ }
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// db.js loaded afresh against a database of its own, OSCAR_DB_SLOW_MS set to
// `setting`. The environment is put back after.
function boot(setting, name) {
  const saved = { path: process.env.OSCAR_DB_PATH, slow: process.env.OSCAR_DB_SLOW_MS };
  let fresh;
  try {
    process.env.OSCAR_DB_PATH = path.join(tempDir, `${name}.db`);
    if (setting === undefined) delete process.env.OSCAR_DB_SLOW_MS;
    else process.env.OSCAR_DB_SLOW_MS = setting;
    jest.isolateModules(() => {
      fresh = require('../../src/db/db');
    });
  } finally {
    for (const [key, value] of [['OSCAR_DB_PATH', saved.path], ['OSCAR_DB_SLOW_MS', saved.slow]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  booted.push(fresh);
  return fresh;
}

// What the server hands the helpers: a histogram, a counter and a logger.
function observer() {
  const seen = { seconds: [], slow: 0, lines: [] };
  return {
    seen,
    seconds: { observe: (s) => seen.seconds.push(s) },
    slow: { inc: () => { seen.slow += 1; } },
    log: { warn: (fields, msg) => seen.lines.push({ ...fields, msg }) },
  };
}

// A statement that takes a few milliseconds, whatever the machine.
const SLOW_SQL = `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 300000)
                  SELECT count(*) AS n, ? AS asked FROM c`;

describe('the threshold (#1234)', () => {
  test('50 ms by default, a whole number from 1 to 60000, anything else refused', () => {
    expect(slowStatementSetting(undefined)).toBe(50);
    expect(slowStatementSetting('')).toBe(50);
    expect(slowStatementSetting(' 200 ')).toBe(200);
    expect(slowStatementSetting('1')).toBe(1);
    expect(slowStatementSetting('60000')).toBe(60000);
    for (const wrong of ['0', '60001', '1.5', '-5', 'fast', '1e3']) {
      expect(() => slowStatementSetting(wrong)).toThrow('OSCAR_DB_SLOW_MS must be a whole number of milliseconds from 1 to 60000');
    }
  });

  test('a wrong value stops the start before the database is opened', () => {
    expect(() => boot('soon', 'soon')).toThrow('OSCAR_DB_SLOW_MS must be');
    expect(fs.existsSync(path.join(tempDir, 'soon.db'))).toBe(false);
  });
});

describe('statements timed and the slow ones logged (#1234)', () => {
  test('nothing is timed until the server asks for it', () => {
    const m = boot('1', 'unobserved');
    const o = observer();
    expect(m.get(SLOW_SQL, ['x']).n).toBe(300000);
    expect(o.seen.seconds).toEqual([]);
  });

  test('a slow statement is counted and logged with its SQL and place, never its values', () => {
    const m = boot('1', 'slow');
    const o = observer();
    m.observeStatements(o);
    expect(m.get(SLOW_SQL, ['TOP-SECRET-VALUE']).n).toBe(300000);
    expect(o.seen.slow).toBe(1);
    expect(o.seen.lines).toHaveLength(1);
    const [line] = o.seen.lines;
    expect(line.msg).toBe('slow database statement');
    expect(line.ms).toBeGreaterThanOrEqual(1);
    expect(line.sql).toMatch(/^WITH RECURSIVE c\(x\) AS \(SELECT 1 UNION ALL SELECT x \+ 1 FROM c WHERE x < 300000\) SELECT count\(\*\) AS n, \? AS asked FROM c$/);
    expect(line.from).toMatch(/^tests\/unit\/db-slow-statements\.test\.js:\d+$/);
    expect(JSON.stringify(o.seen)).not.toContain('TOP-SECRET-VALUE');
  });

  test('every helper is timed; a quick statement is measured but not logged', () => {
    const m = boot('60000', 'quick');
    const o = observer();
    m.observeStatements(o);
    m.run('CREATE TABLE IF NOT EXISTS t (x)');
    m.run('INSERT INTO t (x) VALUES (?)', [1]);
    expect(m.get('SELECT x FROM t WHERE x = ?', [1]).x).toBe(1);
    expect(m.all('SELECT x FROM t', [])).toHaveLength(1);
    expect(o.seen.seconds).toHaveLength(4);
    expect(o.seen.seconds.every((s) => s >= 0 && s < 60)).toBe(true);
    expect(o.seen.slow).toBe(0);
    expect(o.seen.lines).toEqual([]);
  });

  test('a statement that fails is timed and its error goes on', () => {
    const m = boot('60000', 'failing');
    const o = observer();
    m.observeStatements(o);
    expect(() => m.get('SELECT x FROM nowhere', [])).toThrow(/no such table/);
    expect(o.seen.seconds).toHaveLength(1);
  });

  test('a logger that throws never stops the statement', () => {
    const m = boot('1', 'logger');
    m.observeStatements({ log: { warn: () => { throw new Error('logger down'); } } });
    expect(m.get(SLOW_SQL, ['x']).n).toBe(300000);
  });

  test('observeStatements(null) stops the timing', () => {
    const m = boot('1', 'stopped');
    const o = observer();
    m.observeStatements(o);
    m.observeStatements(null);
    m.get(SLOW_SQL, ['x']);
    expect(o.seen.seconds).toEqual([]);
  });
});

describe('what a slow statement line says (#1234)', () => {
  test('the SQL on one line, a list of ? as one, 400 characters at most', () => {
    expect(sqlShape('SELECT a\n   FROM t\n  WHERE id IN (?, ?, ?) AND b = ?')).toBe('SELECT a FROM t WHERE id IN (?…) AND b = ?');
    expect(sqlShape('INSERT INTO t VALUES (?,?,?)')).toBe('INSERT INTO t VALUES (?…)');
    const long = sqlShape(`SELECT ${'x, '.repeat(300)}y FROM t`);
    expect(long).toHaveLength(401);
    expect(long.endsWith('…')).toBe(true);
  });

  test('the place is the first frame outside db.js, from the server folder', () => {
    const dbFile = path.resolve(__dirname, '../../src/db/db.js');
    const route = path.resolve(__dirname, '../../src/api/routes/runs.js');
    const stack = [
      'Error: where',
      `    at noteStatement (${dbFile}:1290:57)`,
      `    at timed (${dbFile}:1279:5)`,
      `    at all (${dbFile}:1241:10)`,
      `    at withRunCounts (${route}:530:19)`,
      '    at Layer.handle (node:internal/whatever:1:1)',
    ].join('\n');
    expect(callerOf(stack)).toBe('src/api/routes/runs.js:530');
    expect(callerOf(`Error: where\n    at ${route}:12:3`)).toBe('src/api/routes/runs.js:12');
    expect(callerOf('Error: where\n    at node:internal/x:1:1')).toBeNull();
  });
});
