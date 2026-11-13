// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1246: every preview of the Run page and every launch read the company's
// newest 20,000 finished runs to keep the latest of each scenario, then
// counted the failed checks of those runs over run_assertions. The slow
// statement log named both at the start of a batch. The latest run of each
// scenario asked is now one seek per code, and the failed checks of a
// finished run, which never change, are counted once. The answer must be the
// one the old reading gave.

const { randomUUID: uuidv4 } = require('node:crypto');
const D = require('../../src/db/db');
const RC = require('../../src/api/helpers/runCandidates');
const { latestRunsOf } = require('../../src/utils/frameworkCoverage');
const { runScopeSql } = require('../../src/api/helpers/run-access');

const { run, all } = D;

const companyId = uuidv4();
const otherCompanyId = uuidv4();
const managerId = uuidv4();
const secondManagerId = uuidv4();
const testerId = uuidv4();
const secondTesterId = uuidv4();
const certifierId = uuidv4();
const users = {
  manager: { id: managerId, role: 'test_manager', companyId },
  tester: { id: testerId, role: 'company_user', companyId },
  certifier: { id: certifierId, role: 'certification_user', companyId },
};

// The reading before #1246, the reference for the answer.
function oldLatestRunStates(company, user) {
  const scope = runScopeSql(user, '');
  const rows = all(
    `SELECT id, scenario_code, status, collection_version, scenario_hash
       FROM runs
      WHERE company_id = ? AND scenario_code IS NOT NULL AND status IN ('COMPLETED', 'FAILED')${scope.sql}
      ORDER BY queued_at DESC, id DESC
      LIMIT 20000`,
    [company, ...scope.params]
  );
  const latest = latestRunsOf(rows);
  const out = {};
  for (const [code, r] of Object.entries(latest)) {
    const c = all(`SELECT SUM(CASE WHEN passed = 1 THEN 0 ELSE 1 END) AS failed FROM run_assertions WHERE run_id = ?`, [r.id])[0];
    out[code] = { status: r.status, failed: Number(c?.failed) || 0, collection_version: r.collection_version, scenario_hash: r.scenario_hash };
  }
  return out;
}

// A small seeded generator: the same runs at every test run.
function generator(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function at(minutes) {
  return new Date(Date.UTC(2026, 10, 13, 20, 0, 0) - minutes * 60000).toISOString().replace('T', ' ').slice(0, 19);
}

function addChecks(runId, company, passed, failed) {
  const suite = run(`INSERT INTO run_suites (run_id, company_id, scenario_name, suite_name) VALUES (?, ?, 'S', 'suite')`, [runId, company]);
  const req = run(`INSERT INTO run_requests (suite_id, run_id, company_id, request_name) VALUES (?, ?, ?, 'R')`,
    [suite.lastInsertRowid, runId, company]);
  for (let i = 0; i < passed + failed; i++) {
    run(`INSERT INTO run_assertions (request_id, suite_id, run_id, company_id, assertion_key, assertion_name, passed)
         VALUES (?, ?, ?, ?, ?, 'check', ?)`, [req.lastInsertRowid, suite.lastInsertRowid, runId, company, `k${i}`, i < passed ? 1 : 0]);
  }
}

function addRun({ company = companyId, user = managerId, code, status = 'COMPLETED', minutes = 0, passed = 0, failed = 0, version = null, hash = null }) {
  const id = uuidv4();
  run(`INSERT INTO runs (id, company_id, user_id, status, scenario_code, queued_at, collection_version, scenario_hash, shared_with_certifier_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [id, company, user, status, code, at(minutes), version, hash, minutes % 3 === 0 ? at(minutes) : null]);
  if (passed + failed > 0) addChecks(id, company, passed, failed);
  return id;
}

const CODES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', '5', 'with space'];
const STATUSES = ['COMPLETED', 'COMPLETED', 'FAILED', 'FAILED', 'RUNNING', 'QUEUED', 'CANCELLED', 'DELETED', 'DELETION_REQUESTED'];
const AUTHORS = [managerId, managerId, secondManagerId, testerId, secondTesterId];

beforeAll(() => {
  for (const [id, name] of [[companyId, 'Candidates Co'], [otherCompanyId, 'Other Co']]) {
    run(`INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)`, [id, name, `rcl-${id}`]);
  }
  for (const [id, role] of [[managerId, 'test_manager'], [secondManagerId, 'test_manager'], [testerId, 'company_user'],
    [secondTesterId, 'company_user'], [certifierId, 'certification_user']]) {
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', ?)`, [id, companyId, `${id}@test.com`, role]);
  }
  const rnd = generator(1246);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  for (let i = 0; i < 400; i++) {
    // Few distinct minutes: many runs queued in the same second, as a batch is.
    addRun({
      company: rnd() < 0.15 ? otherCompanyId : companyId,
      user: pick(AUTHORS),
      code: rnd() < 0.05 ? null : pick(CODES),
      status: pick(STATUSES),
      minutes: Math.floor(rnd() * 40),
      passed: Math.floor(rnd() * 4),
      failed: rnd() < 0.4 ? Math.floor(rnd() * 3) : 0,
      version: pick(['OTST_V2.0.256', 'OTST_V2.0.257', null]),
      hash: pick(['h1', 'h2', null]),
    });
  }
});

afterAll(() => {
  run(`DELETE FROM runs WHERE company_id IN (?, ?)`, [companyId, otherCompanyId]);
  run(`DELETE FROM users WHERE company_id = ?`, [companyId]);
  run(`DELETE FROM companies WHERE id IN (?, ?)`, [companyId, otherCompanyId]);
});

// What facetsOf() reads: runs[code] for each code asked.
const asRead = (states, codes) => codes.map((code) => [code, states[code] ?? null]);
const ASKED = [...CODES, 'NEVER_RUN', 'A', 5];

describe('the latest run of each scenario asked (#1246)', () => {
  test.each(Object.keys(users))('the answer the old reading gave, for a %s', (who) => {
    const old = oldLatestRunStates(companyId, users[who]);
    const now = RC.latestRunStates(companyId, users[who], ASKED);
    expect(asRead(now, ASKED)).toEqual(asRead(old, ASKED));
    // And again, the failed checks now kept.
    expect(asRead(RC.latestRunStates(companyId, users[who], ASKED), ASKED)).toEqual(asRead(old, ASKED));
  });

  test('the drawn runs hold what the comparison must see', () => {
    const old = oldLatestRunStates(companyId, users.manager);
    expect(Object.keys(old).length).toBeGreaterThan(6);
    expect(Object.values(old).some((s) => s.failed > 0)).toBe(true);
    expect(Object.values(old).some((s) => s.status === 'FAILED')).toBe(true);
    const ties = all(`SELECT COUNT(*) AS n FROM (SELECT queued_at FROM runs WHERE company_id = ? AND status IN ('COMPLETED', 'FAILED')
                       GROUP BY scenario_code, queued_at HAVING COUNT(*) > 1)`, [companyId])[0].n;
    expect(Number(ties)).toBeGreaterThan(0);
  });

  test('no code asked, nothing read', () => {
    const spy = jest.spyOn(D.db, 'prepare');
    expect(RC.latestRunStates(companyId, users.manager, [])).toEqual({});
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test.each([['a Test Manager', users.manager], ['a tester', users.tester]])('for %s, one seek per code, no walk of the runs', (_, user) => {
    const scope = runScopeSql(user, 'x');
    const plan = D.db.prepare(`EXPLAIN QUERY PLAN ${RC.latestRunsSql(scope.sql)}`)
      .all(JSON.stringify(CODES), companyId, ...scope.params).map((r) => r.detail);
    expect(plan.join('\n')).toMatch(/SEARCH x USING INDEX idx_runs_company_scenario \(company_id=\? AND scenario_code=\?\)/);
    expect(plan.join('\n')).toMatch(/SEARCH r USING INDEX sqlite_autoindex_runs_1 \(id=\?\)/);
    expect(plan.filter((d) => /^SCAN (r|x|runs)\b/.test(d))).toEqual([]);
  });
});

describe('the failed checks of a finished run, counted once (#1246)', () => {
  const statementsOn = (fn) => {
    const spy = jest.spyOn(D.db, 'prepare');
    fn();
    const sql = spy.mock.calls.map(([s]) => String(s)).filter((s) => s.includes('run_assertions'));
    spy.mockRestore();
    return sql;
  };

  test('a second reading reads no check; a run finished since is counted alone', () => {
    const code = `ONCE_${uuidv4()}`;
    addRun({ code, minutes: 5, passed: 2, failed: 1 });
    const first = statementsOn(() => {
      expect(RC.latestRunStates(companyId, users.manager, [code])[code].failed).toBe(1);
    });
    expect(first).toHaveLength(1);
    expect(statementsOn(() => RC.latestRunStates(companyId, users.manager, [code]))).toEqual([]);

    addRun({ code, minutes: 1, passed: 1, failed: 3, status: 'FAILED' });
    let states;
    const after = statementsOn(() => { states = RC.latestRunStates(companyId, users.manager, [code]); });
    expect(states[code]).toEqual(expect.objectContaining({ status: 'FAILED', failed: 3 }));
    expect(after).toHaveLength(1);
    expect((after[0].match(/\?/g) || []).length).toBe(1);
  });

  test('a run without checks counts 0, and is not read again', () => {
    const code = `NONE_${uuidv4()}`;
    addRun({ code, minutes: 2 });
    expect(RC.latestRunStates(companyId, users.manager, [code])[code].failed).toBe(0);
    expect(statementsOn(() => RC.latestRunStates(companyId, users.manager, [code]))).toEqual([]);
  });

  test('a run still going is not the latest finished one, and its checks are not kept', () => {
    const code = `GOING_${uuidv4()}`;
    const done = addRun({ code, minutes: 9, failed: 2 });
    addRun({ code, minutes: 0, status: 'RUNNING', failed: 5 });
    const states = RC.latestRunStates(companyId, users.manager, [code]);
    expect(states[code].failed).toBe(2);
    expect(all(`SELECT id FROM runs WHERE id = ?`, [done])).toHaveLength(1);
  });
});
