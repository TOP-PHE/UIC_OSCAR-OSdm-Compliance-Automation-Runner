// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * tester-run-privacy.test.js — a tester's runs are theirs (1.11.477): another
 * tester of the company reads none of them, in a run's pages, its messages,
 * the trends, the comparisons or the queue; the Test Managers' runs stay the
 * company's; a Test Manager reads every run.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-tester-run-privacy';

const express = require('express');
const jwt     = require('jsonwebtoken');
const request = require('supertest');
const { randomUUID: uuidv4 } = require('node:crypto');
const { run } = require('../../src/db/db');

const app = express();
app.use(express.json());
app.use('/v1/runs', require('../../src/api/routes/runs'));
app.use('/v1/reports', require('../../src/api/routes/reports'));

const tag = uuidv4().slice(0, 8);
const COMPANY = uuidv4();
const users = {
  TM: { id: uuidv4(), role: 'test_manager' },
  A:  { id: uuidv4(), role: 'company_user' },
  B:  { id: uuidv4(), role: 'company_user' },
};
const emailOf = (who) => `${who.toLowerCase()}-${tag}@privacy.example`;
const as = (who) => ({ Authorization: `Bearer ${jwt.sign({ sub: users[who].id, email: emailOf(who), companyId: COMPANY, role: users[who].role }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}` });

const runs = {};      // who → finished run id
const requests = {};  // who → run_requests id
let queuedOfA;

function addRun(who, key) {
  const id = uuidv4();
  run(`INSERT INTO runs (id, company_id, user_id, status, scenario_code, queued_at, completed_at)
       VALUES (?, ?, ?, 'FAILED', ?, datetime('now'), datetime('now'))`, [id, COMPANY, users[who].id, `CODE_${who}`]);
  const suite = run('INSERT INTO run_suites (run_id, company_id, scenario_name, suite_name) VALUES (?, ?, ?, ?)', [id, COMPANY, `CODE_${who}`, 's']).lastInsertRowid;
  const req = run('INSERT INTO run_requests (suite_id, run_id, company_id, request_name, http_status) VALUES (?, ?, ?, ?, 200)', [suite, id, COMPANY, 'step']).lastInsertRowid;
  run(`INSERT INTO run_assertions (request_id, suite_id, run_id, company_id, assertion_key, assertion_name, type, category, severity, passed, error_msg)
       VALUES (?, ?, ?, ?, ?, ?, 'test', 'business_logic', 'major', 0, ?)`, [req, suite, id, COMPANY, key, key, `failure of ${who}`]);
  return { id, req };
}

beforeAll(() => {
  run(`INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)`, [COMPANY, `Privacy ${tag}`, `privacy-${tag}`]);
  for (const [who, u] of Object.entries(users)) {
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', ?)`, [u.id, COMPANY, emailOf(who), u.role]);
  }
  for (const who of ['TM', 'A', 'B']) {
    const { id, req } = addRun(who, `key-${who}`);
    runs[who] = id;
    requests[who] = req;
  }
  // A shared key, failed in every run.
  for (const who of ['TM', 'A', 'B']) {
    run(`INSERT INTO run_assertions (request_id, suite_id, run_id, company_id, assertion_key, assertion_name, type, category, severity, passed, error_msg)
         SELECT id, suite_id, run_id, company_id, 'key-all', 'key-all', 'test', 'business_logic', 'major', 0, ? FROM run_requests WHERE id = ?`,
    [`all of ${who}`, requests[who]]);
  }
  const second = addRun('A', 'key-A2').id;
  run(`INSERT INTO report_comparisons (id, company_id, run_a_id, run_b_id, diff_json) VALUES (?, ?, ?, ?, '{}')`, [uuidv4(), COMPANY, runs.A, second]);
  queuedOfA = uuidv4();
  run(`INSERT INTO runs (id, company_id, user_id, status, scenario_code, queued_at) VALUES (?, ?, ?, 'QUEUED', 'SECRET_A', datetime('now'))`,
    [queuedOfA, COMPANY, users.A.id]);
});

afterAll(() => {
  run('DELETE FROM report_comparisons WHERE company_id = ?', [COMPANY]);
  run('DELETE FROM auth_events WHERE company_id = ?', [COMPANY]);
  run('DELETE FROM companies WHERE id = ?', [COMPANY]);
  for (const u of Object.values(users)) run('DELETE FROM users WHERE id = ?', [u.id]);
});

describe('a tester reads their own runs and the Test Managers\', never a colleague\'s', () => {
  test.each([
    ['B', 'A', 404], ['B', 'B', 200], ['B', 'TM', 200], ['A', 'A', 200], ['TM', 'A', 200], ['TM', 'B', 200],
  ])('%s reading the run of %s answers %i', async (who, owner, status) => {
    expect((await request(app).get(`/v1/runs/${runs[owner]}`).set(as(who))).status).toBe(status);
    expect((await request(app).get(`/v1/runs/${runs[owner]}/assertions`).set(as(who))).status).toBe(status);
    expect((await request(app).get(`/v1/reports/requests/${requests[owner]}/messages`).set(as(who))).status).toBe(status);
  });

  test('the trends hold no check of a colleague\'s run', async () => {
    const summary = await request(app).get('/v1/reports/trends/summary').set(as('B'));
    expect(summary.status).toBe(200);
    const keys = summary.body.top_failures.map((r) => r.assertion_key).sort();
    expect(keys).toEqual(['key-B', 'key-TM', 'key-all']);
    expect(summary.body.top_failures.find((r) => r.assertion_key === 'key-all').fail_count).toBe(2);

    const trend = await request(app).get('/v1/reports/trends?assertion_key=key-all').set(as('B'));
    expect(trend.body.points.map((p) => p.run_id).sort()).toEqual([runs.B, runs.TM].sort());
    expect(JSON.stringify(trend.body)).not.toContain('all of A');

    const tm = await request(app).get('/v1/reports/trends?assertion_key=key-all').set(as('TM'));
    expect(tm.body.points).toHaveLength(3);
  });

  test('a comparison of a colleague\'s runs is not listed', async () => {
    expect((await request(app).get('/v1/reports/comparisons').set(as('B'))).body.comparisons).toEqual([]);
    expect((await request(app).get('/v1/reports/comparisons').set(as('A'))).body.comparisons).toHaveLength(1);
    expect((await request(app).get('/v1/reports/comparisons').set(as('TM'))).body.comparisons).toHaveLength(1);
  });

  test('the queue tells a colleague\'s run by its place only', async () => {
    const b = await request(app).get('/v1/runs/queue-status').set(as('B'));
    expect(b.status).toBe(200);
    expect(b.body.runs).toEqual([expect.objectContaining({ id: null, scenario_code: null, batch_id: null, user_email: null, is_current_user: false, position: 1 })]);
    expect(JSON.stringify(b.body)).not.toContain('SECRET_A');
    const a = await request(app).get('/v1/runs/queue-status').set(as('A'));
    expect(a.body.runs[0]).toMatchObject({ id: queuedOfA, scenario_code: 'SECRET_A', is_current_user: true });
    const tm = await request(app).get('/v1/runs/queue-status').set(as('TM'));
    expect(tm.body.runs[0]).toMatchObject({ scenario_code: 'SECRET_A', user_email: emailOf('A') });
  });

  test('a tester shares a run of their own with certifiers, not a colleague\'s', async () => {
    expect((await request(app).post(`/v1/runs/${runs.A}/share`).set(as('B'))).status).toBe(404);
    expect((await request(app).post(`/v1/runs/${runs.A}/share`).set(as('A'))).status).toBe(200);
    expect((await request(app).delete(`/v1/runs/${runs.A}/share`).set(as('A'))).status).toBe(200);
  });
});
