// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * run-warnings.test.js — a run's warning lines, kept on their own.
 *
 * The readers of warnings (the coverage report, the AI analysis, a run's
 * detail) walked each run's whole log. The log's writer now keeps a warning
 * line a second time in run_warning_lines, the runner marks the runs it
 * starts, and api/helpers/runWarnings.js reads a marked run from there and any
 * other run from its log.
 *
 * The promise held here: whatever runs are marked, the readers get the rows
 * the statements they had gave, in the same order and under the same limits.
 */

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const store = require('../../src/db/db');
const { run, all, get, colEncrypt, colDecrypt } = store;
const { queueRunLogLine, flushRunLogs, WARNING_SQL } = require('../../src/worker/runLog');
const W = require('../../src/api/helpers/runWarnings');
const { warningsOfBatch, FINISHED } = require('../../src/api/helpers/batchFailures');

const SRC = path.join(__dirname, '..', '..', 'src');
const companyId = randomUUID();
const otherCompanyId = randomUUID();
const userId = randomUUID();
const made = [];

// A generator with a seed: the same runs and lines at every run of the test.
function drawer(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function newRun({ company = companyId, batch = null, status = 'COMPLETED', queuedAt = '2026-11-22 10:00:00', code = 'SCENARIO' } = {}) {
  const id = randomUUID();
  made.push(id);
  run('INSERT INTO runs (id, company_id, user_id, status, batch_id, scenario_code, queued_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, company, userId, status, batch, code, queuedAt]);
  return id;
}

// One line as the runner's logEvent() queues it: the thirteen values of INSERT_SQL.
function line(runId, level, message, requestName = null) {
  return [runId, new Date().toISOString(), level, colEncrypt(message), null, null, null, requestName, null, 'log', null, null, null];
}

const mark = (runId, kept) => run('UPDATE runs SET warn_lines_kept = ? WHERE id = ?', [kept ? 1 : 0, runId]);
const marks = n => Array.from({ length: n }, () => '?').join(',');

// The statements the three readers had before this change, word for word.
const before = {
  ofRun: (runId, limit) => all("SELECT request_name, message FROM run_events WHERE run_id = ? AND level = 'warn' ORDER BY id ASC LIMIT ?", [runId, limit]),
  ofRuns: (ids, limit) => all(`SELECT run_id, message FROM run_events WHERE level = 'warn' AND run_id IN (${marks(ids.length)}) ORDER BY id ASC LIMIT ?`, [...ids, limit]),
  ofBatch: (company, batch, limit) => all(
    `SELECT e.run_id, e.request_name, e.message, r.scenario_code
       FROM run_events e
       JOIN runs r ON r.id = e.run_id
      WHERE r.company_id = ? AND r.batch_id = ? AND r.status IN (?, ?) AND e.level = 'warn'
      ORDER BY r.queued_at ASC, e.id ASC
      LIMIT ?`, [company, batch, ...FINISHED, limit]),
};
const only = (rows, ...names) => rows.map(row => Object.fromEntries(names.map(name => [name, row[name]])));

beforeAll(() => {
  run('INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)', [companyId, 'Run Warnings Co', `run-warn-${companyId.slice(0, 8)}`]);
  run('INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)', [otherCompanyId, 'Run Warnings Other', `run-warn-o-${otherCompanyId.slice(0, 8)}`]);
  run("INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'test_manager')",
    [userId, companyId, `run-warn-${userId.slice(0, 8)}@run-warnings-test.com`]);
});

afterEach(() => { flushRunLogs(); });

afterAll(() => {
  for (const id of made) run('DELETE FROM runs WHERE id = ?', [id]);
  run('DELETE FROM companies WHERE id IN (?, ?)', [companyId, otherCompanyId]);
  run('DELETE FROM users WHERE id = ?', [userId]);
});

describe('the writer of the log keeps a warning line twice', () => {
  test('under the id of its log line, with its step and its stored text; no other line', () => {
    const runId = newRun();
    queueRunLogLine(line(runId, 'info', '[INFO] first'));
    queueRunLogLine(line(runId, 'warn', '[WARNING] seat map not offered', '01. POST Get Offer'));
    queueRunLogLine(line(runId, 'stderr', 'noise'));
    queueRunLogLine(line(runId, 'warn', '[WARNING] no step'));
    queueRunLogLine(line(runId, 'error', '[ERROR] failed'));
    flushRunLogs();
    const inLog = all("SELECT id, request_name, message FROM run_events WHERE run_id = ? AND level = 'warn' ORDER BY id", [runId]);
    const kept = all('SELECT event_id AS id, request_name, message FROM run_warning_lines WHERE run_id = ? ORDER BY event_id', [runId]);
    expect(kept).toEqual(inLog);
    expect(kept.map(row => colDecrypt(row.message))).toEqual(['[WARNING] seat map not offered', '[WARNING] no step']);
    expect(kept.map(row => row.request_name)).toEqual(['01. POST Get Offer', null]);
    expect(all('SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?', [runId])[0].n).toBe(5);
  });

  test('one by one too, when the lines cannot be written together', () => {
    const runId = newRun();
    // Inside a caller's transaction the writer's own BEGIN fails, and the lines
    // are written one at a time (runLog.js).
    store.transaction(() => {
      queueRunLogLine(line(runId, 'warn', '[WARNING] inside a transaction', '02. POST Booking'));
      queueRunLogLine(line(runId, 'info', '[INFO] and a plain line'));
      flushRunLogs();
    });
    const kept = all('SELECT request_name, message FROM run_warning_lines WHERE run_id = ?', [runId]);
    expect(kept.map(row => [row.request_name, colDecrypt(row.message)])).toEqual([['02. POST Booking', '[WARNING] inside a transaction']]);
    expect(all('SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?', [runId])[0].n).toBe(2);
  });

  test('a line whose run is gone costs only itself', () => {
    const runId = newRun();
    queueRunLogLine(line(randomUUID(), 'warn', '[WARNING] of a deleted run'));
    queueRunLogLine(line(runId, 'warn', '[WARNING] kept'));
    flushRunLogs();
    expect(all('SELECT message FROM run_warning_lines WHERE run_id = ?', [runId]).map(row => colDecrypt(row.message))).toEqual(['[WARNING] kept']);
  });

  test('deleting a run deletes what was kept of it', () => {
    const runId = newRun();
    queueRunLogLine(line(runId, 'warn', '[WARNING] soon gone'));
    flushRunLogs();
    expect(get('SELECT COUNT(*) AS n FROM run_warning_lines WHERE run_id = ?', [runId]).n).toBe(1);
    run('DELETE FROM runs WHERE id = ?', [runId]);
    expect(get('SELECT COUNT(*) AS n FROM run_warning_lines WHERE run_id = ?', [runId]).n).toBe(0);
  });

  test('the copy is written in the transaction of its line', () => {
    const source = fs.readFileSync(path.join(SRC, 'worker', 'runLog.js'), 'utf8');
    expect(WARNING_SQL).toBe('INSERT INTO run_warning_lines (event_id, run_id, request_name, message) VALUES (?, ?, ?, ?)');
    expect(source).toContain('for (const row of rows) writeLine(store.db, statements, row);');
    expect(source).toContain("if (row[LEVEL] !== 'warn') return;");
  });
});

describe('the runner marks the runs it starts', () => {
  test('in the statement that starts the run, and nowhere else', () => {
    const runner = fs.readFileSync(path.join(SRC, 'worker', 'runner.js'), 'utf8');
    expect(runner).toContain("UPDATE runs SET status = 'RUNNING', started_at = datetime('now'), warn_lines_kept = 1 WHERE id = ?");
    expect(runner.split('warn_lines_kept = 1').length - 1).toBe(1);
  });

  test('a run of before, or one that never started, is not marked', () => {
    expect(get('SELECT warn_lines_kept AS kept FROM runs WHERE id = ?', [newRun()]).kept).toBe(0);
  });

  test('deleting a company deletes what was kept of its runs', () => {
    const purge = fs.readFileSync(path.join(SRC, 'utils', 'companyPurge.js'), 'utf8');
    expect(purge).toContain("'DELETE FROM run_warning_lines WHERE run_id IN (SELECT id FROM runs WHERE company_id = ?)'");
  });
});

describe('a marked run is read from what was kept, any other from its log', () => {
  test('a marked run: its log is not read', () => {
    const runId = newRun();
    queueRunLogLine(line(runId, 'warn', '[WARNING] kept', '07. GET Booking'));
    flushRunLogs();
    mark(runId, true);
    run('DELETE FROM run_events WHERE run_id = ?', [runId]);
    expect(W.warningRowsOf([runId], 10).map(row => colDecrypt(row.message))).toEqual(['[WARNING] kept']);
  });

  test('a run not marked: what was kept is not read', () => {
    const runId = newRun();
    queueRunLogLine(line(runId, 'warn', '[WARNING] in the log', '07. GET Booking'));
    flushRunLogs();
    run('DELETE FROM run_warning_lines WHERE run_id = ?', [runId]);
    expect(W.warningRowsOf([runId], 10).map(row => colDecrypt(row.message))).toEqual(['[WARNING] in the log']);
    expect([...W.keptAmong([runId])]).toEqual([]);
  });

  test('nothing asked, nothing read; too many runs in one call is refused', () => {
    expect(W.warningRowsOf([], 10)).toEqual([]);
    const runId = newRun();
    queueRunLogLine(line(runId, 'warn', '[WARNING] there is one'));
    flushRunLogs();
    expect(W.warningRowsOf([runId], 1)).toHaveLength(1);
    // A limit is a whole number above zero: anything else reads nothing.
    for (const limit of [0, -1, Number.NaN, undefined, null, 1.5, '3']) {
      expect(W.warningRowsOf([runId], limit)).toEqual([]);
      expect(W.warningRowsOfBatch(companyId, 'no-such-batch', FINISHED, limit)).toEqual([]);
    }
    expect(W.warningRowsOfBatch(companyId, 'no-such-batch', FINISHED, 10)).toEqual([]);
    expect(W.warningRowsOfBatch(companyId, 'no-such-batch', [], 10)).toEqual([]);
    expect(() => W.warningRowsOf(Array.from({ length: W.MAX_RUNS + 1 }, () => randomUUID()), 10)).toThrow(/at most/);
  });

  test('two sorted lists are merged in order and cut at the limit', () => {
    const lower = (x, y) => x < y;
    expect(W.merged([1, 4, 6], [2, 3, 7], lower, 10)).toEqual([1, 2, 3, 4, 6, 7]);
    expect(W.merged([1, 4, 6], [2, 3, 7], lower, 4)).toEqual([1, 2, 3, 4]);
    expect(W.merged([], [2, 3], lower, 10)).toEqual([2, 3]);
    expect(W.merged([5], [], lower, 10)).toEqual([5]);
    expect(W.merged([], [], lower, 10)).toEqual([]);
  });
});

describe('the readers get the rows their statements gave', () => {
  // Three batches of runs with drawn lines. Every warning line is kept by the
  // writer, so a run may be marked or not: both ways must read the same.
  const next = drawer(20261122);
  const batches = ['rw-batch-a', 'rw-batch-b', 'rw-batch-c'];
  const runs = [];

  beforeAll(() => {
    const statuses = ['COMPLETED', 'FAILED', 'COMPLETED', 'RUNNING', 'CANCELLED'];
    for (let i = 0; i < 36; i++) {
      // Several runs of a batch are queued in the same second, as a batch is.
      const queuedAt = `2026-11-22 10:00:0${Math.floor(next() * 3)}`;
      runs.push(newRun({
        batch: batches[i % batches.length], status: statuses[Math.floor(next() * statuses.length)],
        queuedAt, code: `SCENARIO_${i % 7}`,
      }));
    }
    // A run of another company in the first batch's name: never read.
    const foreign = newRun({ company: otherCompanyId, batch: batches[0] });
    // The lines are written interleaved, as runs that go together write them.
    for (let n = 0; n < 900; n++) {
      const runId = n % 50 === 0 ? foreign : runs[Math.floor(next() * runs.length)];
      const draw = next();
      let level = 'stdout';
      if (draw < 0.25) level = 'warn';
      else if (draw < 0.35) level = 'info';
      const step = next() < 0.7 ? `0${1 + Math.floor(next() * 7)}. Step` : null;
      queueRunLogLine(line(runId, level, `[${level === 'warn' ? 'WARNING' : 'INFO'}] line ${n}`, step));
      if (n % 97 === 0) flushRunLogs();
    }
    flushRunLogs();
  });

  const marking = {
    'no run marked': () => false,
    'every run marked': () => true,
    'one run in two marked': (i) => i % 2 === 0,
    'runs marked at random': () => next() < 0.5,
  };

  describe.each(Object.keys(marking))('%s', (name) => {
    beforeAll(() => { runs.forEach((runId, i) => mark(runId, marking[name](i))); });

    test('one run, as a run\'s detail reads it', () => {
      for (const runId of runs) {
        for (const limit of [1, 3, 2000]) {
          expect(only(W.warningRowsOf([runId], limit), 'request_name', 'message')).toEqual(before.ofRun(runId, limit));
        }
      }
    });

    test('several runs at once under a limit, as the coverage report reads them', () => {
      for (let trial = 0; trial < 40; trial++) {
        const ids = runs.filter(() => next() < 0.4);
        if (ids.length === 0) continue;
        const limit = [1, 5, 40, 20000][trial % 4];
        expect(only(W.warningRowsOf(ids, limit), 'run_id', 'message')).toEqual(before.ofRuns(ids, limit));
      }
    });

    test('a batch\'s finished runs, as the AI analysis reads them', () => {
      for (const batch of batches) {
        for (const limit of [1, 7, 20000]) {
          const rows = W.warningRowsOfBatch(companyId, batch, FINISHED, limit);
          expect(only(rows, 'run_id', 'request_name', 'message', 'scenario_code')).toEqual(before.ofBatch(companyId, batch, limit));
        }
      }
    });

    test('and through the reader itself: the same warnings, the same "truncated"', () => {
      for (const batch of batches) {
        const expected = before.ofBatch(companyId, batch, 20000);
        const got = warningsOfBatch(companyId, batch);
        expect(got.truncated).toBe(false);
        expect(got.warnings.map(w => [w.runId, w.step, w.message]))
          .toEqual(expected.map(row => [row.run_id, row.request_name, colDecrypt(row.message)]));
      }
    });
  });

  test('there was something to compare: warnings in every batch, some runs with none', () => {
    for (const batch of batches) expect(before.ofBatch(companyId, batch, 20000).length).toBeGreaterThan(20);
    expect(before.ofRuns(runs, 20000).length).toBeGreaterThan(150);
  });
});

describe('reading a marked run does not touch the log table', () => {
  let statements;
  let spy;

  beforeAll(() => { store.keepStatements(false); });
  afterAll(() => { store.keepStatements(true); });
  beforeEach(() => {
    statements = [];
    spy = jest.spyOn(store.db, 'prepare').mockImplementation(function prepare(sql) {
      statements.push(sql);
      return Object.getPrototypeOf(store.db).prepare.call(store.db, sql);
    });
  });
  afterEach(() => { spy.mockRestore(); });

  const planOf = (sql, params) => store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map(row => row.detail).join(' | ');

  test('runs given by id: by the index of what was kept, no scan', () => {
    const runId = newRun();
    queueRunLogLine(line(runId, 'warn', '[WARNING] one'));
    flushRunLogs();
    mark(runId, true);
    statements.length = 0;
    expect(W.warningRowsOf([runId], 10)).toHaveLength(1);
    const read = statements.filter(sql => /FROM run_/.test(sql));
    expect(read).toHaveLength(1);
    expect(read[0]).toContain('FROM run_warning_lines');
    spy.mockRestore();
    const plan = planOf(read[0], [runId, 10]);
    expect(plan).toContain('idx_run_warning_lines_run');
    expect(plan).not.toMatch(/SCAN/);
  });

  test('a batch: the runs by their batch, what was kept by its index; the log only for runs not marked', () => {
    const batch = `rw-plan-${randomUUID().slice(0, 8)}`;
    const runId = newRun({ batch });
    queueRunLogLine(line(runId, 'warn', '[WARNING] one'));
    flushRunLogs();
    mark(runId, true);
    statements.length = 0;
    expect(W.warningRowsOfBatch(companyId, batch, FINISHED, 10)).toHaveLength(1);
    const [own, log] = statements.filter(sql => /JOIN run_/.test(sql));
    expect(own).toContain('JOIN run_warning_lines');
    expect(own).toContain('r.warn_lines_kept = 1');
    expect(log).toContain('JOIN run_events');
    expect(log).toContain('r.warn_lines_kept = 0');
    spy.mockRestore();
    for (const sql of [own, log]) {
      const plan = planOf(sql, [companyId, batch, ...FINISHED, 10]);
      expect(plan).not.toMatch(/SCAN/);
      expect(plan).toMatch(/idx_runs_company_batch|runs_company_batch|idx_runs/);
    }
  });
});
