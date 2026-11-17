// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1238: SQLite's statistics. ANALYZE had never run on OSCAR's database, so
// the planner guessed how many rows an index gives. The checkpoint thread now
// runs SQLite's PRAGMA optimize (one table at a time), never the server's
// thread; the server's connection then reads the statistics again, and waits
// (busy timeout) rather than fails when a table is being analyzed.
// #1269: off by default. An ANALYZE reads each index in full whatever the
// analysis limit, under the write lock: one table took over a minute after a
// restart on the k3s test machine, sign-ins failed and the checkpoint thread,
// silent all along, was given up.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const metrics = require('../../src/utils/metrics');
const { optimizeSetting } = require('../../src/db/db');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oscar-stats-'));
const booted = [];
const SETTINGS = ['OSCAR_DB_PATH', 'OSCAR_DB_CHECKPOINTS', 'OSCAR_DB_OPTIMIZE'];
// The statistics are asked for: off is the default (#1269).
const DAILY = { OSCAR_DB_OPTIMIZE: 'daily' };

// Worker threads start, write and analyze: see db-checkpoints.test.js.
jest.setTimeout(60000);

afterAll(async () => {
  for (const m of booted) {
    await m.stopCheckpointThread();
    try { m.db.close(); } catch { /* already closed */ }
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// db.js loaded afresh against a database of its own with `settings`; the
// environment is put back after.
function boot(name, settings = {}) {
  const saved = Object.fromEntries(SETTINGS.map((key) => [key, process.env[key]]));
  let fresh;
  try {
    process.env.OSCAR_DB_PATH = path.join(tempDir, `${name}.db`);
    // Unset when not given, whatever tests/setup.js set (OSCAR_DB_OPTIMIZE off).
    for (const key of SETTINGS.slice(1)) {
      if (settings[key] === undefined) delete process.env[key];
      else process.env[key] = settings[key];
    }
    jest.isolateModules(() => {
      fresh = require('../../src/db/db');
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  booted.push(fresh);
  return fresh;
}

async function until(condition, ms = 20000) {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// A table whose best index only statistics can tell: `k` is unique, `s` has
// three values. Without statistics SQLite takes the index on `s` for
// `k = ? AND s = ?`; with them, the one on `k`.
function fillPicky(m) {
  m.db.exec('CREATE TABLE picky (id INTEGER PRIMARY KEY, k INTEGER, s INTEGER); CREATE INDEX picky_k ON picky(k); CREATE INDEX picky_s ON picky(s);');
  m.transaction(() => {
    const insert = m.db.prepare('INSERT INTO picky (k, s) VALUES (?, ?)');
    for (let i = 0; i < 20000; i++) insert.run(i, i % 3);
  });
}
const pickyPlan = (m) => m.db.prepare('EXPLAIN QUERY PLAN SELECT * FROM picky WHERE k = 5 AND s = 1')
  .all().map((row) => row.detail).join(' | ');

describe('the statistics setting (#1238)', () => {
  test('off by default (#1269), daily on demand, anything else refused', () => {
    expect(optimizeSetting(undefined)).toBe('off');
    expect(optimizeSetting('')).toBe('off');
    expect(optimizeSetting(' OFF ')).toBe('off');
    expect(optimizeSetting('Daily')).toBe('daily');
    for (const wrong of ['hourly', 'on', '1', 'daily;']) {
      expect(() => optimizeSetting(wrong)).toThrow('OSCAR_DB_OPTIMIZE must be daily or off');
    }
  });

  test('a wrong value stops the start before the database is opened', () => {
    expect(() => boot('never', { OSCAR_DB_OPTIMIZE: 'weekly' })).toThrow('OSCAR_DB_OPTIMIZE must be daily or off, not "weekly"');
    expect(fs.existsSync(path.join(tempDir, 'never.db'))).toBe(false);
  });

  test('the start-up line says whether statistics are kept', () => {
    const lines = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((line) => { lines.push(String(line)); });
    try {
      boot('line-default');
      boot('line-daily', DAILY);
      boot('line-off', { OSCAR_DB_OPTIMIZE: 'off' });
      boot('line-inline', { OSCAR_DB_CHECKPOINTS: 'inline' });
    } finally {
      spy.mockRestore();
    }
    const ready = lines.filter((line) => line.startsWith('[db] SQLite ready'));
    expect(ready[0]).toContain('checkpoints thread, statistics off,');
    expect(ready[1]).toContain('checkpoints thread, statistics daily,');
    expect(ready[2]).toContain('checkpoints thread, statistics off,');
    expect(ready[3]).toContain('checkpoints inline, statistics off,');
  });
});

describe('the statistics, kept by the checkpoint thread (#1238)', () => {
  test('the tables are analyzed off the server\'s thread, and the server\'s plans follow', async () => {
    const m = boot('daily', DAILY);
    // Statistics kept before, as on every day after the first: then another
    // connection's ANALYZE changes rows of sqlite_stat1, not the schema, and
    // the server's connection keeps the statistics it read until it reads
    // them again (checked: a query of its own did not make it). The first
    // ANALYZE ever creates sqlite_stat1, a change of the schema it does see.
    m.db.exec('CREATE TABLE seed (x INTEGER); CREATE INDEX seed_x ON seed(x); INSERT INTO seed VALUES (1), (2); ANALYZE seed;');
    fillPicky(m);
    expect(pickyPlan(m)).toContain('USING INDEX picky_s');
    const logs = [];
    const posted = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((line) => { logs.push(String(line)); });
    try {
      const worker = m.startCheckpointThread({ intervalMs: 20, optimizeDelayMs: 10, optimizeEveryMs: 600000, optimizePauseMs: 1 });
      worker.on('message', (msg) => posted.push(msg));
      await until(() => m.checkpointState().statistics !== null);
    } finally {
      spy.mockRestore();
    }
    const { statistics } = m.checkpointState();
    expect(statistics.error).toBeNull();
    expect(statistics.tables).toContain('picky');
    // #1269: each table is announced before it is analyzed, in that order, and
    // nothing is being analyzed once the run is reported.
    const told = posted.slice(0, posted.findIndex((msg) => msg.type === 'optimized'))
      .filter((msg) => msg.type === 'analyzing').map((msg) => msg.table);
    expect(told).toEqual(statistics.tables);
    expect(m.checkpointState().analyzing).toBeNull();
    expect(statistics.reloadMs).toBeGreaterThanOrEqual(0);
    expect(m.db.prepare("SELECT stat FROM sqlite_stat1 WHERE idx = 'picky_k'").get().stat).toMatch(/^\d+ 1$/);
    // A query of its own first: EXPLAIN alone never looks at the schema.
    expect(m.get('SELECT count(*) AS n FROM picky').n).toBe(20000);
    expect(pickyPlan(m)).toContain('USING INDEX picky_k');
    expect(logs.find((line) => line.startsWith('[db] statistics:'))).toMatch(/^\[db\] statistics: \d+ tables analyzed in [\d.]+ s \(.*picky.*\), read again in [\d.]+ ms$/);
    const runs = await metrics.register.getSingleMetricAsString('oscar_db_optimize_runs_total');
    expect(runs).toMatch(/oscar_db_optimize_runs_total\{outcome="done"\} [1-9]/);
    const analyzed = await metrics.register.getSingleMetricAsString('oscar_db_analyze_seconds');
    expect(Number(/oscar_db_analyze_seconds_count (\d+)/.exec(analyzed)[1])).toBeGreaterThan(0);
  });

  test('a table analyzed once is not analyzed again until it changes tenfold', async () => {
    const m = boot('again', DAILY);
    fillPicky(m);
    m.startCheckpointThread({ intervalMs: 20, optimizeDelayMs: 10, optimizeEveryMs: 50, optimizePauseMs: 1 });
    await until(() => m.checkpointState().statistics !== null);
    const first = m.checkpointState().statistics;
    await until(() => m.checkpointState().statistics !== first);
    expect(m.checkpointState().statistics.tables).not.toContain('picky');
  });

  test('a stop between two tables ends the thread at once, and nothing is reported', async () => {
    const m = boot('stopped', DAILY);
    for (const name of ['first', 'second', 'third']) {
      m.db.exec(`CREATE TABLE ${name} (x INTEGER); CREATE INDEX ${name}_x ON ${name}(x); INSERT INTO ${name} VALUES (1), (2);`);
    }
    // The first table analyzed, then a pause of a minute before the next.
    const worker = m.startCheckpointThread({ intervalMs: 20, optimizeDelayMs: 10, optimizeEveryMs: 600000, optimizePauseMs: 60000 });
    await until(() => m.checkpointState().running);
    await until(() => m.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'sqlite_stat1'").get().n === 1);
    let exited = false;
    worker.once('exit', () => { exited = true; });
    const started = Date.now();
    await m.stopCheckpointThread();
    // A timer left would keep the thread alive until the 5 s fallback ends it.
    expect(Date.now() - started).toBeLessThan(2000);
    expect(exited).toBe(true);
    expect(m.checkpointState().statistics).toBeNull();
  });

  test.each([
    ['off', { OSCAR_DB_OPTIMIZE: 'off' }],
    ['nothing set (#1269)', {}],
  ])('%s: the thread checkpoints and never analyzes', async (name, settings) => {
    const m = boot(`off-${name.split(' ')[0]}`, settings);
    fillPicky(m);
    // A checkpoint at every look, as before #1294: the count is what is watched.
    m.startCheckpointThread({ intervalMs: 20, limitBytes: 0, maxWaitMs: 0, optimizeDelayMs: 10, optimizePauseMs: 1 });
    await until(() => m.checkpointState().count >= 10);
    expect(m.checkpointState()).toMatchObject({ optimize: 'off', statistics: null });
    expect(m.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'sqlite_stat1'").get().n).toBe(0);
  });

  test('a long analysis is no silence: the thread is kept, and the wait is told once (#1269)', async () => {
    const m = boot('long');
    // No checkpoint of its own for ten minutes: only the messages below count.
    const worker = m.startCheckpointThread({ intervalMs: 600000, staleMs: 200 });
    await until(() => m.checkpointState().running);
    const errors = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((line) => { errors.push(String(line)); });
    const quiet = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      worker.emit('message', { type: 'analyzing', table: 'run_assertions' });
      expect(m.checkpointState().analyzing).toBe('run_assertions');
      await until(() => errors.length > 0);
      // Three more periods of the watchdog: still kept, and told only once.
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(m.checkpointState().running).toBe(true);
      expect(m.db.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint).toBe(0);
      expect(errors).toEqual(["[db] statistics: run_assertions analyzed for over 0.2 s, holding the write lock: the server's writes fail after 5 s until it ends (OSCAR_DB_OPTIMIZE=off stops the statistics)"]);
      // The analysis ends; a silence after it is a dead thread again.
      worker.emit('message', { type: 'optimized', seconds: 0.8, tables: [], error: null });
      expect(m.checkpointState().analyzing).toBeNull();
      await until(() => !m.checkpointState().running);
    } finally {
      spy.mockRestore();
      quiet.mockRestore();
    }
    expect(m.db.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint).toBe(1000);
    expect(errors[1]).toMatch(/reported nothing for 0\.2 s/);
  });

  test('a failed run is logged and counted, and the thread goes on', async () => {
    const m = boot('failed');
    const worker = m.startCheckpointThread({ intervalMs: 20, limitBytes: 0, maxWaitMs: 0 });
    await until(() => m.checkpointState().running);
    const errors = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((line) => { errors.push(String(line)); });
    try {
      worker.emit('message', { type: 'optimized', seconds: 0.5, tables: [{ name: 'runs', seconds: 0.5 }], error: 'database is locked' });
    } finally {
      spy.mockRestore();
    }
    expect(m.checkpointState().statistics).toMatchObject({ tables: ['runs'], error: 'database is locked' });
    expect(errors).toEqual(['[db] statistics: 1 tables analyzed in 0.5 s (runs), then: database is locked']);
    expect(await metrics.register.getSingleMetricAsString('oscar_db_optimize_runs_total')).toMatch(/outcome="failed"\} [1-9]/);
    const count = m.checkpointState().count;
    await until(() => m.checkpointState().count > count);
  });
});

describe('the server\'s connection waits for another writer (#1238)', () => {
  test('a busy timeout of 5 s', () => {
    const m = boot('busy');
    expect(m.db.prepare('PRAGMA busy_timeout').get().timeout).toBe(5000);
  });

  test('a write while another connection holds the write lock waits, then goes in', async () => {
    const m = boot('locked');
    m.db.exec('CREATE TABLE waits (x INTEGER)');
    const holder = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const other = new DatabaseSync(workerData);
      other.exec('BEGIN IMMEDIATE');
      parentPort.postMessage('locked');
      setTimeout(() => { other.exec('COMMIT'); other.close(); parentPort.postMessage('released'); }, 300);
    `, { eval: true, workerData: path.join(tempDir, 'locked.db') });
    try {
      await new Promise((resolve) => holder.once('message', resolve));
      const started = Date.now();
      m.run('INSERT INTO waits (x) VALUES (1)');
      expect(Date.now() - started).toBeGreaterThanOrEqual(200);
      expect(m.get('SELECT count(*) AS n FROM waits').n).toBe(1);
    } finally {
      await holder.terminate();
    }
  });
});
