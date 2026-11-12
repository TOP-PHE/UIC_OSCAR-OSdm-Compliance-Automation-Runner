// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1214: a run's results are stored in slices. On the k3s test machine,
// storing one run's results held the server's one thread for 2.2 s at the
// 95th percentile, up to 3 s, in one block: every page waited while a run
// ended. Each slice is its own transaction, other requests are served between
// two slices, and a slice that fails removes what the run stored.

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID: uuidv4 } = require('node:crypto');
const dbModule = require('../../src/db/db');
const { run, get, all } = dbModule;
const { encryptToFile } = require('../../src/utils/at-rest');
const metrics = require('../../src/utils/metrics');
const { extractStructuredResults, SLICE_MS } = require('../../src/reports/structureResults');

const ARTIFACTS_DIR = path.resolve(__dirname, '../../data/artifacts');
const companyId = uuidv4();
const userId = uuidv4();
const runIds = [];

beforeAll(() => {
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Results Slices', ?)`, [companyId, `results-slices-${companyId.slice(0, 8)}`]);
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'test_manager')`,
    [userId, companyId, `slices-${userId.slice(0, 8)}@results-slices-test.com`]);
});

afterAll(() => {
  for (const id of runIds) {
    for (const table of ['run_assertions', 'run_requests', 'run_suites']) run(`DELETE FROM ${table} WHERE run_id = ?`, [id]);
    run('DELETE FROM runs WHERE id = ?', [id]);
    fs.rmSync(path.join(ARTIFACTS_DIR, id), { recursive: true, force: true });
  }
  run('DELETE FROM users WHERE id = ?', [userId]);
  run('DELETE FROM companies WHERE id = ?', [companyId]);
});

// Bruno results of `n` requests in two suites, two checks each.
function resultsOf(n) {
  return Array.from({ length: n }, (_, i) => ({
    path: `SLICES/${i % 2 ? '02-Common' : '01-System'}/${String(i).padStart(2, '0')}. GET Thing.bru`,
    name: `GET Thing ${i}`,
    request: { method: 'GET', url: `https://vendor.example/osdm/things/${i}`, headers: { Accept: 'application/json' } },
    response: { status: 200, data: { thing: i }, headers: {} },
    runDuration: 0.01,
    testResults: [{ description: 'status is 200', status: 'pass' }, { description: `thing ${i} named`, status: i % 5 ? 'pass' : 'fail' }],
  }));
}

function seededRun(n) {
  const id = uuidv4();
  runIds.push(id);
  run(`INSERT INTO runs (id, company_id, user_id, status, scenario_code) VALUES (?, ?, ?, 'RUNNING', 'SLICES')`, [id, companyId, userId]);
  fs.mkdirSync(path.join(ARTIFACTS_DIR, id), { recursive: true });
  encryptToFile(JSON.stringify(resultsOf(n)), path.join(ARTIFACTS_DIR, id, '.bru_results.json'));
  return id;
}

const countOf = (table, runId) => get(`SELECT COUNT(*) AS n FROM ${table} WHERE run_id = ?`, [runId]).n;

describe('a run\'s results are stored in slices (#1214)', () => {
  test('a slice lasts about 20 ms', () => {
    expect(SLICE_MS).toBe(20);
  });

  test('each slice is one block of its own: the plan, then the requests', async () => {
    const runId = seededRun(6);
    let blocks = 0;
    const out = await extractStructuredResults(runId, companyId, { sliceMs: 0, timeSlice: (fn) => { blocks++; return fn(); } });
    expect(out).toEqual({ suites: 2, requests: 6, assertions: 12 });
    expect(blocks).toBe(1 + 6);
    expect(countOf('run_requests', runId)).toBe(6);
    const suites = all('SELECT suite_name, total, passed, failed FROM run_suites WHERE run_id = ? ORDER BY suite_name', [runId]);
    expect(suites).toEqual([
      // Requests 0 and 5 fail their second check: one in each suite.
      { suite_name: '01-System', total: 6, passed: 5, failed: 1 },
      { suite_name: '02-Common', total: 6, passed: 5, failed: 1 },
    ]);
  });

  test('other requests are served between two slices', async () => {
    const runId = seededRun(8);
    const seen = [];
    const storing = extractStructuredResults(runId, companyId, { sliceMs: 0 });
    // Waits for the file to be read, then for each turn: what another request would see.
    const watch = setInterval(() => seen.push(countOf('run_requests', runId)), 0);
    await storing;
    clearInterval(watch);
    expect(seen.some((n) => n > 0 && n < 8)).toBe(true);
    expect(countOf('run_requests', runId)).toBe(8);
  });

  test('every slice is one transaction', async () => {
    const runId = seededRun(4);
    const exec = jest.spyOn(dbModule.db, 'exec');
    try {
      await extractStructuredResults(runId, companyId, { sliceMs: 0 });
      expect(exec.mock.calls.map((c) => c[0]).filter((s) => s === 'BEGIN')).toHaveLength(4);
    } finally {
      exec.mockRestore();
    }
  });

  test('a run\'s statements are prepared once, not once a row', async () => {
    const runId = seededRun(10);
    const prepare = jest.spyOn(dbModule.db, 'prepare');
    try {
      await extractStructuredResults(runId, companyId, { sliceMs: 0 });
      const checks = prepare.mock.calls.filter((c) => /^INSERT INTO run_assertions/.test(c[0]));
      expect(checks).toHaveLength(1);
    } finally {
      prepare.mockRestore();
    }
    expect(countOf('run_assertions', runId)).toBe(20);
  });

  test('a slice that fails removes what the run stored: all or nothing, as before', async () => {
    const runId = seededRun(6);
    let blocks = 0;
    const failing = (fn) => {
      blocks++;
      if (blocks === 4) throw new Error('slice failed');
      return fn();
    };
    await expect(extractStructuredResults(runId, companyId, { sliceMs: 0, timeSlice: failing })).rejects.toThrow('slice failed');
    expect(blocks).toBeGreaterThan(4);
    for (const table of ['run_suites', 'run_requests', 'run_assertions']) expect(countOf(table, runId)).toBe(0);
  });

  test('the file is read off the thread', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/reports/structureResults.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function extractStructuredResults('));
    expect(fn).toContain('await fs.promises.readFile(jsonPath)');
    expect(fn).not.toMatch(/readFileSync|decryptFromFile\(/);
  });
});

describe('runWorkClock(): the slices\' time, observed once (#1214)', () => {
  async function countAndSum() {
    const json = await metrics.runWork.get();
    const of = (name) => json.values.find((v) => v.metricName === name && v.labels.work === 'results_store')?.value || 0;
    return { count: of('oscar_run_work_seconds_count'), sum: of('oscar_run_work_seconds_sum') };
  }

  test('time() gives each slice\'s result, done() observes their sum once, a failed slice counted too', async () => {
    const before = await countAndSum();
    const clock = metrics.runWorkClock('results_store');
    expect(clock.time(() => 'first')).toBe('first');
    expect(() => clock.time(() => { const end = Date.now() + 5; while (Date.now() < end) { /* busy */ } throw new Error('x'); })).toThrow('x');
    clock.done();
    const after = await countAndSum();
    expect(after.count).toBe(before.count + 1);
    expect(after.sum - before.sum).toBeGreaterThanOrEqual(0.004);
  });
});
