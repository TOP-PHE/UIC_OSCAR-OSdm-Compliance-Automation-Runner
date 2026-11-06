// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * Deleting an account takes its runs with it, by cascade, and must neither
 * fail on a table naming the account nor hold the server: every table the
 * runs' deletion cascades into is read through an index.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-user-deletion';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { randomUUID: uuidv4 } = require('node:crypto');
const { run, get, all } = require('../../src/db/db');
const { ensurePlatformCompany } = require('../../src/api/helpers/shared');

const app = express();
app.use(express.json());
app.use('/v1/admin', require('../../src/api/routes/admin'));
app.use('/v1/company/users', require('../../src/api/routes/company-users'));

const PLAT = ensurePlatformCompany().id;
const ACME = uuidv4();
const ADMIN = uuidv4();
const TM = uuidv4();

function bearer(id) {
  const u = get('SELECT email, role, company_id FROM users WHERE id = ?', [id]);
  return `Bearer ${jwt.sign({ sub: id, email: u.email, companyId: u.company_id, role: u.role }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;
}
const add = (id, cid, role) =>
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', ?)`, [id, cid, `${role}-${id.slice(0, 8)}@del.test`, role]);

// A tester with what a real one leaves behind: runs with their suite,
// requests and checks, a comparison, a report template, a login.
function testerWithHistory() {
  const id = uuidv4();
  add(id, ACME, 'company_user');
  const runs = [uuidv4(), uuidv4()];
  for (const runId of runs) {
    run(`INSERT INTO runs (id, company_id, user_id, status) VALUES (?, ?, ?, 'COMPLETED')`, [runId, ACME, id]);
    const suite = run(`INSERT INTO run_suites (run_id, company_id, suite_name) VALUES (?, ?, 's')`, [runId, ACME]).lastInsertRowid;
    const req = run(`INSERT INTO run_requests (suite_id, run_id, company_id, request_name) VALUES (?, ?, ?, 'r')`, [suite, runId, ACME]).lastInsertRowid;
    run(`INSERT INTO run_assertions (request_id, suite_id, run_id, company_id, assertion_key, assertion_name) VALUES (?, ?, ?, ?, 'k', 'n')`, [req, suite, runId, ACME]);
    run(`INSERT INTO run_events (run_id, level, message) VALUES (?, 'info', 'm')`, [runId]);
  }
  run(`INSERT INTO report_comparisons (id, company_id, run_a_id, run_b_id, diff_json) VALUES (?, ?, ?, ?, '{}')`, [uuidv4(), ACME, runs[0], runs[1]]);
  run(`INSERT INTO report_templates (id, company_id, user_id, name) VALUES (?, ?, ?, 't')`, [uuidv4(), ACME, id]);
  run(`INSERT INTO auth_events (user_id, company_id, event_type) VALUES (?, ?, 'login_success')`, [id, ACME]);
  return { id, runs };
}

function expectGone({ id, runs }) {
  expect(get('SELECT id FROM users WHERE id = ?', [id])).toBeUndefined();
  for (const table of ['runs', 'report_templates']) {
    expect(get(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, [id]).n).toBe(0);
  }
  for (const table of ['run_suites', 'run_requests', 'run_assertions', 'run_events']) {
    expect(get(`SELECT COUNT(*) AS n FROM ${table} WHERE run_id IN (?, ?)`, runs).n).toBe(0);
  }
}

beforeAll(() => {
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Acme', ?)`, [ACME, `acme-${ACME.slice(0, 8)}`]);
  add(ADMIN, PLAT, 'administrator');
  add(TM, ACME, 'test_manager');
});

test('an administrator deletes an account with its history', async () => {
  const tester = testerWithHistory();
  const res = await request(app).delete(`/v1/admin/users/${tester.id}`).set('Authorization', bearer(ADMIN));
  expect(res.status).toBe(200);
  expectGone(tester);
});

test('a Test Manager deletes an account of the company with its history', async () => {
  const tester = testerWithHistory();
  const res = await request(app).delete(`/v1/company/users/${tester.id}`).set('Authorization', bearer(TM));
  expect(res.status).toBe(200);
  expectGone(tester);
});

test('every table the deletion of runs cascades into is read through an index', () => {
  const firstColumns = table => all('SELECT name FROM pragma_index_list(?)', [table])
    .map(index => all('SELECT name FROM pragma_index_info(?)', [index.name])[0]?.name);
  const unindexed = [];
  for (const { name } of all("SELECT name FROM sqlite_master WHERE type = 'table'")) {
    for (const fk of all('SELECT * FROM pragma_foreign_key_list(?)', [name])) {
      if (['runs', 'run_suites', 'run_requests'].includes(fk.table) && !firstColumns(name).includes(fk.from)) {
        unindexed.push(`${name}.${fk.from}`);
      }
    }
  }
  expect(unindexed).toEqual([]);
});
