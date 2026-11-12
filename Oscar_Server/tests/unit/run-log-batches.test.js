// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1210: run log lines are written together. One INSERT a line was one
// SQLite transaction waiting for the disk, about 2 ms of the server's thread
// each: with 15 runs going, half of that thread (#1205).

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID: uuidv4 } = require('node:crypto');
const dbModule = require('../../src/db/db');
const { run, all, get, colEncrypt, colDecrypt } = dbModule;
const metrics = require('../../src/utils/metrics');
const runLog = require('../../src/worker/runLog');

const { queueRunLogLine, flushRunLogs, waitingRunLogLines, FLUSH_MS } = runLog;

const companyId = uuidv4();
const userId = uuidv4();
const runIds = [];

beforeAll(() => {
  run(`INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)`, [companyId, 'Run Log Co', `run-log-${companyId.slice(0, 8)}`]);
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'test_manager')`,
    [userId, companyId, `run-log-${userId.slice(0, 8)}@run-log-test.com`]);
});

afterEach(() => { flushRunLogs(); });

afterAll(() => {
  for (const id of runIds) run('DELETE FROM runs WHERE id = ?', [id]);
  run('DELETE FROM companies WHERE id = ?', [companyId]);
  run('DELETE FROM users WHERE id = ?', [userId]);
});

function newRun() {
  const id = uuidv4();
  runIds.push(id);
  run(`INSERT INTO runs (id, company_id, user_id, status) VALUES (?, ?, ?, 'RUNNING')`, [id, companyId, userId]);
  return id;
}

// One line as logEvent() queues it.
function line(runId, message, extra = {}) {
  return [runId, new Date().toISOString(), extra.level || 'info', colEncrypt(message),
    extra.category, null, null, null, null, 'log', null, null, null];
}

function messagesOf(runId) {
  return all('SELECT message FROM run_events WHERE run_id = ? ORDER BY id ASC', [runId]).map((r) => colDecrypt(r.message));
}

async function logSecondsTotal() {
  const json = await metrics.runLogSeconds.get();
  return json.values[0] ? json.values[0].value : 0;
}

describe('the lines wait, then are written together (#1210)', () => {
  test('a queued line is written by flushRunLogs(), the lines in their order', () => {
    const runId = newRun();
    for (let i = 0; i < 5; i++) queueRunLogLine(line(runId, `line ${i}`));
    expect(messagesOf(runId)).toEqual([]);
    expect(waitingRunLogLines()).toBe(5);
    expect(flushRunLogs()).toBe(5);
    expect(waitingRunLogLines()).toBe(0);
    expect(messagesOf(runId)).toEqual(['line 0', 'line 1', 'line 2', 'line 3', 'line 4']);
    expect(flushRunLogs()).toBe(0);
  });

  test('every waiting line, whatever its run, goes in one transaction', () => {
    const a = newRun();
    const b = newRun();
    for (let i = 0; i < 50; i++) queueRunLogLine(line(i % 2 ? a : b, `line ${i}`));
    const exec = jest.spyOn(dbModule.db, 'exec');
    try {
      flushRunLogs();
      expect(exec.mock.calls.map((c) => c[0])).toEqual(['BEGIN', 'COMMIT']);
    } finally {
      exec.mockRestore();
    }
    expect(messagesOf(a)).toHaveLength(25);
    expect(messagesOf(b)).toHaveLength(25);
  });

  test(`the lines are written within ${FLUSH_MS} ms with no call`, async () => {
    const runId = newRun();
    queueRunLogLine(line(runId, 'on its own'));
    const until = Date.now() + FLUSH_MS + 2000;
    while (messagesOf(runId).length === 0 && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(messagesOf(runId)).toEqual(['on its own']);
    expect(waitingRunLogLines()).toBe(0);
  });

  test('its time counts in oscar_run_log_seconds_total', async () => {
    const runId = newRun();
    const before = await logSecondsTotal();
    for (let i = 0; i < 20; i++) queueRunLogLine(line(runId, `timed ${i}`));
    flushRunLogs();
    expect(await logSecondsTotal()).toBeGreaterThan(before);
  });

  test('an undefined value is stored as null', () => {
    const runId = newRun();
    queueRunLogLine(line(runId, 'no category', { category: undefined }));
    flushRunLogs();
    expect(get('SELECT category FROM run_events WHERE run_id = ?', [runId]).category).toBeNull();
  });
});

describe('a line that cannot be written costs only itself', () => {
  test('a line of a run deleted meanwhile is left out, the others are written', () => {
    const runId = newRun();
    queueRunLogLine(line(runId, 'before'));
    queueRunLogLine(line(uuidv4(), 'of a run that is not there'));
    queueRunLogLine(line(runId, 'after'));
    expect(() => flushRunLogs()).not.toThrow();
    expect(messagesOf(runId)).toEqual(['before', 'after']);
    expect(waitingRunLogLines()).toBe(0);
  });

  test('inside a caller\'s transaction, the lines join it and nothing of the caller\'s is undone', () => {
    const runId = newRun();
    const otherRun = newRun();
    queueRunLogLine(line(runId, 'waiting'));
    dbModule.transaction(() => {
      run(`UPDATE runs SET error_message = 'set inside' WHERE id = ?`, [otherRun]);
      flushRunLogs();
    });
    expect(get('SELECT error_message FROM runs WHERE id = ?', [otherRun]).error_message).toBe('set inside');
    expect(messagesOf(runId)).toEqual(['waiting']);
  });
});

describe('the runner and the live log write the waiting lines first', () => {
  const runner = fs.readFileSync(path.join(__dirname, '../../src/worker/runner.js'), 'utf8');

  test('the runner queues its lines and writes run_events nowhere else', () => {
    const src = path.join(__dirname, '../../src');
    const writers = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js') && /INSERT INTO run_events/.test(fs.readFileSync(p, 'utf8'))) writers.push(path.relative(src, p).replaceAll('\\', '/'));
      }
    };
    walk(src);
    expect(writers).toEqual(['worker/runLog.js']);
    const logEvent = runner.slice(runner.indexOf('function logEvent('), runner.indexOf('\n}\n', runner.indexOf('function logEvent(')));
    expect(logEvent.match(/queueRunLogLine\(/g)).toHaveLength(2);
  });

  test('every status the runner writes goes through writeRunStatus(), which writes the lines first', () => {
    expect(runner).not.toMatch(/\bdbRun\(\s*`UPDATE runs SET status/);
    expect(runner.match(/writeRunStatus\(\s*`UPDATE runs SET status/g).length).toBeGreaterThanOrEqual(7);
    expect(runner).toMatch(/function writeRunStatus\(sql, params\) \{\s+flushRunLogs\(\);\s+return dbRun\(sql, params\);/);
  });

  test('executeRun() writes them however the run ended', () => {
    expect(runner).toMatch(/async function executeRun\(job\) \{\s+try \{\s+return await runSteps\(job\);\s+\} finally \{\s+flushRunLogs\(\);/);
  });

  test('the live log route writes them before it reads', () => {
    const routes = fs.readFileSync(path.join(__dirname, '../../src/api/routes/runs.js'), 'utf8');
    const route = routes.slice(routes.indexOf("router.get('/:id/logs'"));
    expect(route.indexOf('flushRunLogs();')).toBeGreaterThan(-1);
    expect(route.indexOf('flushRunLogs();')).toBeLessThan(route.indexOf('const rows = all(sql'));
  });
});
