// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1295: the two trend readings start from the company's latest finished runs
// and read those runs' checks by run. Until then they read the company's checks
// by key, through idx_run_assertions_key, which is gone: a test here drops it
// first, so nothing below can lean on it.

const { randomUUID } = require('node:crypto');
const { all, run, transaction } = require('../../src/db/db');
const T = require('../../src/api/helpers/checkTrends');

const tm = { id: randomUUID(), role: 'test_manager' };
const tester = { id: randomUUID(), role: 'company_user' };
const colleague = { id: randomUUID(), role: 'company_user' };
const certifier = { id: randomUUID(), role: 'certification_user' };

function addCompany() {
  const id = randomUUID();
  run('INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)', [id, `Trends ${id.slice(0, 8)}`, `trends-${id.slice(0, 8)}`]);
  return id;
}

// A finished run queued `minutesAgo` minutes ago, with its checks: [key, passed].
function addRun(companyId, { minutesAgo = 0, user = tm, status = 'COMPLETED', shared = false, checks = [], code = 'CODE' }) {
  const id = randomUUID();
  run(`INSERT INTO runs (id, company_id, user_id, status, scenario_code, queued_at, completed_at, shared_with_certifier_at)
       VALUES (?, ?, ?, ?, ?, datetime('now', ?), datetime('now', ?), ?)`,
  [id, companyId, user.id, status, code, `-${minutesAgo} minutes`, `-${minutesAgo} minutes`, shared ? '2026-11-01 00:00:00' : null]);
  const suite = run('INSERT INTO run_suites (run_id, company_id, scenario_name, suite_name) VALUES (?, ?, ?, ?)', [id, companyId, code, 's']).lastInsertRowid;
  const req = run('INSERT INTO run_requests (suite_id, run_id, company_id, request_name, http_status) VALUES (?, ?, ?, ?, 200)', [suite, id, companyId, 'step']).lastInsertRowid;
  for (const [key, passed, error = null] of checks) {
    run(`INSERT INTO run_assertions (request_id, suite_id, run_id, company_id, assertion_key, assertion_name, type, category, domain, severity, passed, error_msg)
         VALUES (?, ?, ?, ?, ?, ?, 'test', 'business_logic', 'offer', 'major', ?, ?)`, [req, suite, id, companyId, key, `name of ${key}`, passed ? 1 : 0, error]);
  }
  return id;
}

// The two queries as they were until 1.11.536, for a Test Manager.
const OLD_SUMMARY = `
  SELECT ra.assertion_key, COUNT(*) as run_count,
         SUM(CASE WHEN ra.passed = 0 THEN 1 ELSE 0 END) as fail_count,
         ROUND(100.0 * SUM(ra.passed) / COUNT(*), 1) as pass_rate
  FROM run_assertions ra JOIN runs r ON r.id = ra.run_id
  WHERE ra.company_id = ? AND r.status IN ('COMPLETED', 'FAILED') AND r.queued_at >= datetime('now', '-30 days')
  GROUP BY ra.assertion_key HAVING fail_count > 0`;
const OLD_TRENDS = `
  SELECT ra.run_id, ra.passed, ra.error_msg
  FROM run_assertions ra JOIN runs r ON r.id = ra.run_id
  WHERE ra.company_id = ? AND ra.assertion_key = ? AND r.status IN ('COMPLETED', 'FAILED')
  ORDER BY r.queued_at DESC, ra.id LIMIT ?`;

// A small generator with a seed: the same draw at every run of the test.
function drawer(seed) {
  let state = seed;
  return (below) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state % below;
  };
}

beforeAll(() => {
  for (const [user, email] of [[tm, 'tm'], [tester, 'tester'], [colleague, 'colleague'], [certifier, 'certifier']]) {
    const company = addCompany();
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', ?)`,
      [user.id, company, `${email}-${user.id.slice(0, 8)}@trends.example`, user.role]);
  }
  // Whatever the database of the test holds, the readings never need it.
  run('DROP INDEX IF EXISTS idx_run_assertions_key');
});

describe('a limit read from the query', () => {
  test.each([
    [undefined, 20], ['', 20], ['abc', 20], ['0', 20], ['-3', 20], ['1', 1], ['7', 7], ['50', 50], ['51', 50], ['9999', 50],
    [['4', '9'], 4], ['12.9', 12],
  ])('%j gives %i (default 20, at most 50)', (value, expected) => {
    expect(T.limitOf(value, 20, 50)).toBe(expected);
  });
});

describe('the checks that fail most (#1295)', () => {
  test('the same counts as the query by key, on drawn runs', async () => {
    const company = addCompany();
    const draw = drawer(1295);
    transaction(() => {
      for (let r = 0; r < 60; r++) {
        const checks = [];
        for (let c = 0; c < 12; c++) checks.push([`key-${draw(15)}`, draw(4) !== 0]);
        addRun(company, { minutesAgo: r, status: draw(3) === 0 ? 'FAILED' : 'COMPLETED', checks });
      }
      addRun(company, { minutesAgo: 5, status: 'CANCELLED', checks: [['key-1', false], ['only-cancelled', false]] });
      addRun(company, { minutesAgo: 60 * 24 * 31, checks: [['key-2', false], ['only-old', false]] });
    });
    const old = all(OLD_SUMMARY, [company]);
    const read = await T.topFailures(company, tm, 50);

    expect(read.runs_read).toBe(60);
    expect(read.more_runs).toBe(false);
    expect(old.length).toBeGreaterThan(5);
    const counts = (rows) => rows.map((row) => [row.assertion_key, row.run_count, row.fail_count])
      .sort((a, b) => a[0].localeCompare(b[0]));
    expect(counts(read.top_failures)).toEqual(counts(old));
    for (const row of read.top_failures) {
      const before = old.find((o) => o.assertion_key === row.assertion_key);
      // One decimal on both sides; a rate exactly halfway may round the other way.
      expect(Math.abs(row.pass_rate - before.pass_rate)).toBeLessThanOrEqual(0.1 + 1e-9);
      expect(row).toMatchObject({ assertion_name: `name of ${row.assertion_key}`, category: 'business_logic', domain: 'offer', severity: 'major' });
    }
    expect(read.top_failures.map((row) => row.assertion_key)).not.toContain('only-cancelled');
    expect(read.top_failures.map((row) => row.assertion_key)).not.toContain('only-old');
  });

  test('most failures first, then the lowest pass rate, then the key; cut at the limit', async () => {
    const company = addCompany();
    addRun(company, { checks: [['two-of-two', false], ['two-of-two', false], ['two-of-four', false], ['two-of-four', false], ['two-of-four', true], ['two-of-four', true]] });
    addRun(company, { minutesAgo: 1, checks: [['three', false], ['three', false], ['three', false], ['b-one', false], ['a-one', false], ['passes', true]] });
    const read = await T.topFailures(company, tm, 50);
    expect(read.top_failures.map((row) => [row.assertion_key, row.fail_count, row.pass_rate])).toEqual([
      ['three', 3, 0], ['two-of-two', 2, 0], ['two-of-four', 2, 50], ['a-one', 1, 0], ['b-one', 1, 0],
    ]);
    expect((await T.topFailures(company, tm, 2)).top_failures.map((row) => row.assertion_key)).toEqual(['three', 'two-of-two']);
  });

  test('checks that failed as often are in the order of their keys, whichever run was read first', async () => {
    const company = addCompany();
    transaction(() => {
      // Read first: the newest run, with the key that sorts last.
      addRun(company, { minutesAgo: 0, checks: [['z-one', false]] });
      for (let r = 1; r <= T.RUNS_PER_SLICE; r++) addRun(company, { minutesAgo: r, checks: [['passes', true]] });
      // Read in a later slice: the key that sorts first.
      addRun(company, { minutesAgo: T.RUNS_PER_SLICE + 1, checks: [['a-one', false]] });
    });
    const read = await T.topFailures(company, tm, 50);
    expect(read.top_failures.map((row) => row.assertion_key)).toEqual(['a-one', 'z-one']);
  });

  test('a tester counts their runs and the Test Managers\', a certifier the shared runs', async () => {
    const company = addCompany();
    addRun(company, { user: tm, checks: [['key', false]] });
    addRun(company, { user: tester, minutesAgo: 1, checks: [['key', false]], shared: true });
    addRun(company, { user: colleague, minutesAgo: 2, checks: [['key', false], ['of-colleague', false]] });
    const failuresFor = async (user) => (await T.topFailures(company, user, 50)).top_failures.map((row) => [row.assertion_key, row.fail_count]);
    expect(await failuresFor(tm)).toEqual([['key', 3], ['of-colleague', 1]]);
    expect(await failuresFor(tester)).toEqual([['key', 2]]);
    expect(await failuresFor(certifier)).toEqual([['key', 1]]);
  });

  test('it reads the latest runs only, and says when the company has more', async () => {
    const company = addCompany();
    transaction(() => {
      for (let r = 0; r < T.RUNS_READ + 3; r++) addRun(company, { minutesAgo: r, checks: [[r < T.RUNS_READ ? 'recent' : 'older', false]] });
    });
    const read = await T.topFailures(company, tm, 50);
    expect(read.runs_read).toBe(T.RUNS_READ);
    expect(read.more_runs).toBe(true);
    expect(read.top_failures.map((row) => [row.assertion_key, row.fail_count])).toEqual([['recent', T.RUNS_READ]]);
  });

  test('the thread is given back between two slices of runs', async () => {
    const company = addCompany();
    transaction(() => {
      for (let r = 0; r < T.RUNS_PER_SLICE * 3; r++) addRun(company, { minutesAgo: r, checks: [['key', false]] });
    });
    let turns = 0;
    let going = true;
    const count = () => { turns++; if (going) setImmediate(count); };
    setImmediate(count);
    const read = await T.topFailures(company, tm, 50);
    going = false;
    expect(read.runs_read).toBe(T.RUNS_PER_SLICE * 3);
    expect(turns).toBeGreaterThanOrEqual(2);
  });

  test('no finished run: nothing, and nothing read', async () => {
    const company = addCompany();
    addRun(company, { status: 'RUNNING', checks: [['key', false]] });
    expect(await T.topFailures(company, tm, 20)).toEqual({ top_failures: [], runs_read: 0, more_runs: false });
  });
});

describe('the last results of one check (#1295)', () => {
  test('the same results as the query by key, newest run first', async () => {
    const company = addCompany();
    const draw = drawer(77);
    transaction(() => {
      for (let r = 0; r < 80; r++) {
        const checks = [];
        if (draw(3) !== 0) checks.push(['the-check', draw(2) === 0, `error ${r}`]);
        if (draw(5) === 0) checks.push(['the-check', false, `again ${r}`]);
        checks.push([`other-${draw(4)}`, true]);
        addRun(company, { minutesAgo: r, checks, code: `CODE_${r}` });
      }
      addRun(company, { minutesAgo: 3, status: 'CANCELLED', checks: [['the-check', false, 'cancelled']] });
    });
    for (const limit of [5, 20, 100]) {
      const old = all(OLD_TRENDS, [company, 'the-check', limit]);
      const read = await T.resultsOfCheck(company, tm, 'the-check', limit);
      expect(read.points.map((p) => [p.run_id, p.passed, p.error])).toEqual(old.map((o) => [o.run_id, !!o.passed, o.error_msg]));
    }
    const first = (await T.resultsOfCheck(company, tm, 'the-check', 1)).points[0];
    expect(first).toEqual({
      run_id: expect.any(String), passed: expect.any(Boolean), error: expect.stringMatching(/^error \d+$/),
      category: 'business_logic', severity: 'major', scenario_code: expect.stringMatching(/^CODE_\d+$/), completed_at: expect.any(String),
    });
  });

  test('it stops once it has the results asked', async () => {
    const company = addCompany();
    transaction(() => {
      for (let r = 0; r < T.RUNS_PER_SLICE * 4; r++) addRun(company, { minutesAgo: r, checks: [['key', r % 2 === 0]] });
    });
    const read = await T.resultsOfCheck(company, tm, 'key', 3);
    expect(read.points).toHaveLength(3);
    expect(read.runs_read).toBe(T.RUNS_PER_SLICE);
    expect(read.more_runs).toBe(true);

    const all4 = await T.resultsOfCheck(company, tm, 'key', 100);
    expect(all4.points).toHaveLength(T.RUNS_PER_SLICE * 4);
    expect(all4.runs_read).toBe(T.RUNS_PER_SLICE * 4);
    expect(all4.more_runs).toBe(false);
  });

  test('a check no recent run holds: every recent run is read, no older one', async () => {
    const company = addCompany();
    transaction(() => {
      for (let r = 0; r < T.RUNS_READ + 2; r++) addRun(company, { minutesAgo: r, checks: [[r < T.RUNS_READ ? 'recent' : 'older', false]] });
    });
    expect(await T.resultsOfCheck(company, tm, 'older', 20)).toEqual({ points: [], runs_read: T.RUNS_READ, more_runs: true });
  });

  test('a tester reads no result of a colleague\'s run, a certifier the shared runs\' only', async () => {
    const company = addCompany();
    const ofTm = addRun(company, { user: tm, checks: [['key', false, 'of the Test Manager']] });
    const own = addRun(company, { user: tester, minutesAgo: 1, shared: true, checks: [['key', false, 'own']] });
    addRun(company, { user: colleague, minutesAgo: 2, checks: [['key', false, 'of the colleague']] });
    const runsFor = async (user) => (await T.resultsOfCheck(company, user, 'key', 20)).points.map((p) => p.run_id);
    expect(await runsFor(tm)).toHaveLength(3);
    expect(await runsFor(tester)).toEqual([ofTm, own]);
    expect(await runsFor(certifier)).toEqual([own]);
    expect(JSON.stringify(await T.resultsOfCheck(company, tester, 'key', 20))).not.toContain('colleague');
  });

  test('another company\'s runs are never read', async () => {
    const company = addCompany();
    const other = addCompany();
    addRun(other, { checks: [['key', false, 'of another company']] });
    expect((await T.resultsOfCheck(company, tm, 'key', 20)).points).toEqual([]);
    expect((await T.topFailures(company, tm, 20)).top_failures).toEqual([]);
  });
});

describe('what the readings cost (#1295)', () => {
  const planOf = (sql, params) => all(`EXPLAIN QUERY PLAN ${sql}`, params).map((row) => row.detail).join(' | ');

  test('a slice of checks is found by run, never by walking the table', () => {
    for (const [sql, params] of [[T.COUNTS_BY_KEY, ['[]']], [T.RESULTS_OF_KEY, ['[]', 'key']]]) {
      const plan = planOf(sql, params);
      expect(plan).toContain('USING INDEX idx_run_assertions_run_passed (run_id=?)');
      expect(plan).not.toMatch(/SCAN ra( |$)/);
    }
  });

  test('the latest runs come from the index that holds their order: no sort', () => {
    const company = addCompany();
    const statements = [];
    const db = require('../../src/db/db');
    db.keepStatements(false);
    const spy = jest.spyOn(db.db, 'prepare');
    try {
      T.latestFinishedRuns(company, tm, { days: 30 });
      T.latestFinishedRuns(company, tester);
      statements.push(...spy.mock.calls.map(([sql]) => sql).filter((sql) => sql.includes('FROM runs r')));
    } finally {
      spy.mockRestore();
      db.keepStatements(true);
    }
    expect(statements).toHaveLength(2);
    const plans = [
      planOf(statements[0], [company, '-30 days', T.RUNS_READ + 1]),
      planOf(statements[1], [company, tester.id, T.RUNS_READ + 1]),
    ];
    for (const plan of plans) {
      expect(plan).toContain('idx_runs_company_queued');
      expect(plan).not.toContain('TEMP B-TREE');
    }
  });
});
