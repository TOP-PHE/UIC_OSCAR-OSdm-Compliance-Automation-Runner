// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1227: GET /v1/runs reads its page from `runs` alone and adds each run's
// counts for the rows read. Joined as aggregates, the counts were computed
// over every run of the database at each call: the Dashboard asks every 3 s
// during a batch, and each call held the server's thread 0.5 to 1 s on
// production's data. The answer must be the one the old query gave, and no
// query of the list may read a whole table again.

process.env.JWT_SECRET = 'test-jwt-secret-for-runs-list-counts';

const jwt = require('jsonwebtoken');
const { randomUUID: uuidv4 } = require('node:crypto');
const request = require('supertest');
const { buildAppWithRoute } = require('../helpers/test-app');
const D = require('../../src/db/db');

const { run, all } = D;
const app = buildAppWithRoute('/v1/runs', '../../src/api/routes/runs');

const companyId = uuidv4();
const operatorId = uuidv4();
const secondOperatorId = uuidv4();
const managerId = uuidv4();
const testerId = uuidv4();
const certifierId = uuidv4();
const managerBatch = uuidv4();
const testerBatch = uuidv4();

function token(role, uid) {
  return jwt.sign({ sub: uid, email: `${uid}@test.com`, companyId, role },
    process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
}

function at(minutes) {
  return new Date(Date.UTC(2026, 10, 12, 20, 0, 0) - minutes * 60000).toISOString().replace('T', ' ').slice(0, 19);
}

// The list as it was read before #1227, the reference for the answer.
const OLD_AGG = `
       LEFT JOIN (
         SELECT run_id, COUNT(*) AS artifact_count
         FROM   run_artifacts
         GROUP  BY run_id
       ) ra ON ra.run_id = r.id
       LEFT JOIN (
         SELECT run_id,
                COUNT(*)                              AS scenario_count,
                GROUP_CONCAT(DISTINCT scenario_name)  AS scenario_names
         FROM   run_suites
         WHERE  scenario_name IS NOT NULL
         GROUP  BY run_id
       ) rs ON rs.run_id = r.id`;
const OLD_COMPANY = (ownScope) => `SELECT r.id, r.company_id, c.name AS company_name, r.status,
              r.auth_mode_used, r.api_base_used, r.env_name_used,
              r.queued_at, r.started_at, r.completed_at, r.exit_code,
              r.user_id, r.deleted_by, r.batch_id, r.scenario_code,
              r.shared_with_certifier_at, r.shared_with_certifier_by,
              (SELECT MAX(sh.shared_at) FROM run_share sh WHERE sh.run_id = r.id AND sh.revoked_at IS NULL) AS shared_with_operator_at,
              u.email AS submitted_by,
              COALESCE(ra.artifact_count, 0) AS artifact_count,
              COALESCE(rs.scenario_count,  0) AS scenario_count,
              rs.scenario_names
       FROM runs r
       JOIN users u ON u.id = r.user_id
       JOIN companies c ON c.id = r.company_id${OLD_AGG}
       WHERE r.company_id = ?${ownScope} AND r.status NOT IN ('DELETION_REQUESTED', 'DELETED')
       ORDER BY r.queued_at DESC, r.id DESC`;
const OLD_CERTIFIER = `SELECT r.id, r.company_id, c.name AS company_name, r.status,
              r.auth_mode_used, r.api_base_used, r.env_name_used,
              r.queued_at, r.started_at, r.completed_at, r.exit_code,
              r.deleted_by, r.previous_status, r.batch_id, r.scenario_code,
              u.email AS submitted_by,
              COALESCE(ra.artifact_count, 0) AS artifact_count,
              COALESCE(rs.scenario_count,  0) AS scenario_count,
              rs.scenario_names
       FROM runs r
       JOIN users u ON u.id = r.user_id
       JOIN companies c ON c.id = r.company_id${OLD_AGG}
       WHERE r.status != 'DELETED' AND r.shared_with_certifier_at IS NOT NULL
       ORDER BY r.queued_at DESC, r.id DESC`;

const runIds = [];

function addRun({ user, batch = null, status = 'COMPLETED', minutes, suites = [], artifacts = 0, certifier = false }) {
  const id = uuidv4();
  run(`INSERT INTO runs (id, company_id, user_id, status, batch_id, scenario_code, queued_at, shared_with_certifier_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  [id, companyId, user, status, batch, `S_${minutes}`, at(minutes), certifier ? at(minutes - 1) : null]);
  for (const name of suites) {
    run(`INSERT INTO run_suites (run_id, company_id, scenario_name, suite_name) VALUES (?, ?, ?, 'suite')`, [id, companyId, name]);
  }
  for (let i = 0; i < artifacts; i++) {
    run(`INSERT INTO run_artifacts (id, run_id, type, filename, path) VALUES (?, ?, 'html_report', 'f', 'p')`, [uuidv4(), id]);
  }
  runIds.push(id);
  return id;
}

function share(runId, operator, minutes, revoked = false) {
  run(`INSERT INTO run_share (run_id, company_id, shared_by, shared_at, revoked_at) VALUES (?, ?, ?, ?, ?)`,
    [runId, operator, managerId, at(minutes), revoked ? at(minutes - 1) : null]);
}

let manager0;
let manager1;
let manager2;

beforeAll(() => {
  for (const [id, name] of [[companyId, 'Counts Co'], [operatorId, 'Operator Co'], [secondOperatorId, 'Second Operator Co']]) {
    run(`INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)`, [id, name, `rlc-${id}`]);
  }
  for (const [id, role] of [[managerId, 'test_manager'], [testerId, 'company_user'], [certifierId, 'certification_user']]) {
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', ?)`,
      [id, companyId, `${id}@test.com`, role]);
  }
  // Several names, a name twice, a suite with no name, no suite at all.
  manager0 = addRun({ user: managerId, batch: managerBatch, minutes: 0, suites: ['B', 'A', 'B', null], artifacts: 2, certifier: true });
  manager1 = addRun({ user: managerId, batch: managerBatch, minutes: 1, suites: ['C'], artifacts: 1 });
  manager2 = addRun({ user: managerId, batch: managerBatch, minutes: 2, suites: [null, null], certifier: true });
  addRun({ user: managerId, batch: managerBatch, minutes: 3, suites: ['A', 'C', 'B'], artifacts: 3 });
  addRun({ user: managerId, batch: managerBatch, minutes: 4 });
  addRun({ user: managerId, batch: managerBatch, minutes: 5, status: 'DELETION_REQUESTED', suites: ['A'] });
  addRun({ user: testerId, batch: testerBatch, minutes: 10, suites: ['T'], artifacts: 1, certifier: true });
  addRun({ user: testerId, batch: testerBatch, minutes: 11, suites: ['T', 'U'] });
  addRun({ user: testerId, minutes: 20, artifacts: 1 });
  addRun({ user: managerId, minutes: 30, suites: ['Z'], certifier: true });
  // Shared with two operators (the later date counts), shared then revoked,
  // and revoked with one share still standing.
  share(manager0, operatorId, 0.5);
  share(manager0, secondOperatorId, 0.2);
  share(manager1, operatorId, 0.8, true);
  share(manager2, operatorId, 1.9, true);
  share(manager2, secondOperatorId, 1.5);
});

afterAll(() => {
  run(`DELETE FROM runs WHERE company_id = ?`, [companyId]);
  run(`DELETE FROM users WHERE id IN (?, ?, ?)`, [managerId, testerId, certifierId]);
  run(`DELETE FROM companies WHERE id IN (?, ?, ?)`, [companyId, operatorId, secondOperatorId]);
});

const list = (query, tok) => request(app).get(`/v1/runs?${query}`).set('Authorization', `Bearer ${tok}`);

// Each run of the answer holds exactly the old query's fields with the old
// values, and the batch label the list adds since #1029.
function expectAsBefore(answer, oldRows) {
  const old = new Map(oldRows.map(r => [r.id, r]));
  expect(answer.length).toBeGreaterThan(0);
  for (const row of answer) {
    const before = old.get(row.id);
    expect(before).toBeDefined();
    const { batch_label: label, ...fields } = row;
    expect(label === null || typeof label === 'string').toBe(true);
    expect(fields).toEqual({ ...before });
  }
}

describe('GET /v1/runs: the answer is the old query\'s (#1227)', () => {
  test('a Test Manager\'s page holds the same runs, in the same order, with the same counts', async () => {
    const res = await list('limit=4', token('test_manager', managerId));
    expect(res.status).toBe(200);
    const old = all(OLD_COMPANY(''), [companyId]);
    expect(res.body.runs.map(r => r.id)).toEqual(old.slice(0, 4).map(r => r.id));
    expectAsBefore(res.body.runs, old);
  });

  test('with whole batches, every added run carries its counts too', async () => {
    const res = await list('limit=2&whole_batches=1', token('test_manager', managerId));
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(5);
    expectAsBefore(res.body.runs, all(OLD_COMPANY(''), [companyId]));
  });

  test('the counts read the runs as written', async () => {
    const res = await list('limit=50', token('test_manager', managerId));
    const byId = new Map(res.body.runs.map(r => [r.id, r]));
    expect(byId.get(manager0)).toMatchObject({ artifact_count: 2, scenario_count: 3, shared_with_operator_at: at(0.2) });
    expect(byId.get(manager0).scenario_names.split(',').sort()).toEqual(['A', 'B']);
    expect(byId.get(manager1)).toMatchObject({ artifact_count: 1, scenario_count: 1, scenario_names: 'C', shared_with_operator_at: null });
    expect(byId.get(manager2)).toMatchObject({ artifact_count: 0, scenario_count: 0, scenario_names: null, shared_with_operator_at: at(1.5) });
  });

  test('a tester\'s list is their own runs, as before', async () => {
    const res = await list('limit=50&whole_batches=1', token('company_user', testerId));
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(3);
    expectAsBefore(res.body.runs, all(OLD_COMPANY(' AND r.user_id = ?'), [companyId, testerId]));
  });

  test('a certifier\'s list has the counts and never the operator share', async () => {
    const res = await list('limit=50&whole_batches=1', token('certification_user', certifierId));
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(4);
    expectAsBefore(res.body.runs, all(OLD_CERTIFIER, []));
    expect(res.body.runs.some(r => 'shared_with_operator_at' in r)).toBe(false);
  });
});

describe('GET /v1/runs: no query reads a whole table (#1227)', () => {
  // The SQL the route prepares, read through the connection's prepare().
  async function queriesOf(query, tok) {
    const spy = jest.spyOn(D.db, 'prepare');
    try {
      const res = await list(query, tok);
      expect(res.status).toBe(200);
      return spy.mock.calls.map(([sql]) => sql).filter(sql => /^\s*SELECT/i.test(sql));
    } finally {
      spy.mockRestore();
    }
  }
  const planOf = (sql) => D.db.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...Array.from(sql.matchAll(/\?/g), () => null)).map(r => r.detail);

  test.each([
    ['a Test Manager', () => token('test_manager', managerId)],
    ['a tester', () => token('company_user', testerId)],
  ])('%s\'s list reads its page and batches through the indexes, and counts by run', async (_who, tok) => {
    const queries = await queriesOf('limit=2&whole_batches=1', tok());
    const page = queries.find(sql => /LIMIT \? OFFSET \?/.test(sql));
    const batches = queries.find(sql => /r\.batch_id IN/.test(sql));
    expect(planOf(page).join('\n')).toMatch(/idx_runs_company_queued/);
    expect(planOf(batches).join('\n')).toMatch(/idx_runs_company_batch/);
    for (const sql of queries) {
      for (const step of planOf(sql)) {
        expect(step).not.toMatch(/^(SCAN|MATERIALIZE)\b/);
      }
    }
  });
});
