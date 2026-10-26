// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #986: GET /v1/runs?whole_batches=1 adds the other runs of each batch on the
// page, under the page's own visibility rule. The dashboard groups by batch,
// and a batch of 301 runs read through a page of 100 showed "100 scenarios".

process.env.JWT_SECRET = 'test-jwt-secret-for-whole-batches';

const jwt     = require('jsonwebtoken');
const fs      = require('fs');
const path    = require('path');
const { randomUUID: uuidv4 } = require('node:crypto');
const request = require('supertest');
const { buildAppWithRoute } = require('../helpers/test-app');
const { run } = require('../../src/db/db');

const app = buildAppWithRoute('/v1/runs', '../../src/api/routes/runs');

const companyId = uuidv4();
const otherCompanyId = uuidv4();
const managerId = uuidv4();
const testerId = uuidv4();
const colleagueId = uuidv4();
const strangerId = uuidv4();

const bigBatch = uuidv4();
const testerBatch = uuidv4();
const BIG = 7;

function token(role, uid, cid = companyId) {
  return jwt.sign({ sub: uid, email: `${uid}@test.com`, companyId: cid, role },
    process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
}

// Minutes before a fixed instant, so the order of the rows is known.
function at(minutes) {
  return new Date(Date.UTC(2026, 9, 26, 20, 0, 0) - minutes * 60000).toISOString().replace('T', ' ').slice(0, 19);
}

function addRun({ company = companyId, user, batch = null, status = 'COMPLETED', minutes }) {
  const id = uuidv4();
  run(`INSERT INTO runs (id, company_id, user_id, status, batch_id, scenario_code, queued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, company, user, status, batch, `S_${minutes}`, at(minutes)]);
  return id;
}

let bigIds;
let hiddenId;
let otherCompanyRunId;
let colleagueInTesterBatch;

beforeAll(() => {
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Whole Batches Co', ?)`, [companyId, `wb-${companyId}`]);
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Other Co', ?)`, [otherCompanyId, `wb-${otherCompanyId}`]);
  for (const [id, cid, role] of [[managerId, companyId, 'test_manager'], [testerId, companyId, 'company_user'],
    [colleagueId, companyId, 'company_user'], [strangerId, otherCompanyId, 'test_manager']]) {
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', ?)`,
      [id, cid, `${id}@test.com`, role]);
  }
  // The manager's batch: the newest run first, one minute apart.
  bigIds = Array.from({ length: BIG }, (_, i) => addRun({ user: managerId, batch: bigBatch, minutes: i }));
  // Hidden from every list: asked for deletion.
  hiddenId = addRun({ user: managerId, batch: bigBatch, status: 'DELETION_REQUESTED', minutes: 3.5 });
  // Another company under the same batch id must never come in.
  otherCompanyRunId = addRun({ company: otherCompanyId, user: strangerId, batch: bigBatch, minutes: 2.5 });
  // The tester's batch, and a colleague's run under the same id.
  addRun({ user: testerId, batch: testerBatch, minutes: 100 });
  addRun({ user: testerId, batch: testerBatch, minutes: 101 });
  addRun({ user: testerId, batch: testerBatch, minutes: 102 });
  colleagueInTesterBatch = addRun({ user: colleagueId, batch: testerBatch, minutes: 101.5 });
  // A run of no batch.
  addRun({ user: managerId, minutes: 200 });
});

afterAll(() => {
  run('DELETE FROM runs WHERE company_id IN (?, ?)', [companyId, otherCompanyId]);
  run('DELETE FROM companies WHERE id IN (?, ?)', [companyId, otherCompanyId]);
  run('DELETE FROM users WHERE id IN (?, ?, ?, ?)', [managerId, testerId, colleagueId, strangerId]);
});

const list = (query, tok) => request(app).get(`/v1/runs?${query}`).set('Authorization', `Bearer ${tok}`);

describe('GET /v1/runs?whole_batches=1 (#986)', () => {
  const manager = () => token('test_manager', managerId);

  test('without it, the page holds limit rows, as before', async () => {
    const res = await list('limit=3', manager());
    expect(res.status).toBe(200);
    expect(res.body.runs.map(r => r.id)).toEqual(bigIds.slice(0, 3));
  });

  test('with it, every run of a batch the page cuts is there, newest first', async () => {
    const res = await list('limit=3&whole_batches=1', manager());
    expect(res.status).toBe(200);
    expect(res.body.runs.map(r => r.id)).toEqual(bigIds);
    expect(res.body.limit).toBe(3);
  });

  test('total, limit and offset keep their meaning', async () => {
    const plain = await list('limit=3', manager());
    const whole = await list('limit=3&whole_batches=1', manager());
    expect(whole.body.total).toBe(plain.body.total);
    expect(whole.body.offset).toBe(0);
  });

  test('runs the page hides stay hidden, and another company\'s never come in', async () => {
    const res = await list('limit=3&whole_batches=1', manager());
    const ids = res.body.runs.map(r => r.id);
    expect(ids).not.toContain(hiddenId);
    expect(ids).not.toContain(otherCompanyRunId);
  });

  test('a tester gets the rest of their own batch only', async () => {
    const res = await list('limit=1&whole_batches=1', token('company_user', testerId));
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(3);
    expect(res.body.runs.every(r => r.user_id === testerId)).toBe(true);
    expect(res.body.runs.map(r => r.id)).not.toContain(colleagueInTesterBatch);
  });

  test('a page that ends inside a batch at its old end gets that batch whole', async () => {
    const res = await list('limit=2&offset=5&whole_batches=1', manager());
    expect(res.body.runs.map(r => r.id)).toEqual(bigIds);
  });

  test('a page with no batch is left as it is', async () => {
    const res = await list('limit=5&offset=11&whole_batches=1', manager());
    expect(res.status).toBe(200);
    expect(res.body.runs.every(r => r.batch_id == null)).toBe(true);
  });

  test('the dashboard asks for whole batches', () => {
    const page = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'dashboard.html'), 'utf8');
    expect(page).toContain("fetch('/v1/runs?limit=100&whole_batches=1'");
  });
});
