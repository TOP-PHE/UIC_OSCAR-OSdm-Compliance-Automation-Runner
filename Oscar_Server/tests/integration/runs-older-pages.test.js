// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// The dashboard's "Show older batches": GET /v1/runs reads on after the last
// run of the page before (before_at + before_id, from next_before), so a large
// batch at the top no longer hides the history under it.

process.env.JWT_SECRET = 'test-jwt-secret-for-older-pages';

const jwt     = require('jsonwebtoken');
const fs      = require('fs');
const path    = require('path');
const vm      = require('node:vm');
const { randomUUID: uuidv4 } = require('node:crypto');
const request = require('supertest');
const { buildAppWithRoute } = require('../helpers/test-app');
const { run } = require('../../src/db/db');

const app = buildAppWithRoute('/v1/runs', '../../src/api/routes/runs');

const companyId = uuidv4();
const managerId = uuidv4();
const bigBatch = uuidv4();
const oldBatch = uuidv4();

function token() {
  return jwt.sign({ sub: managerId, email: `${managerId}@test.com`, companyId, role: 'test_manager' },
    process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
}

function at(minutes) {
  return new Date(Date.UTC(2026, 10, 7, 10, 0, 0) - minutes * 60000).toISOString().replace('T', ' ').slice(0, 19);
}

function addRun({ batch = null, minutes, status = 'COMPLETED' }) {
  const id = uuidv4();
  run(`INSERT INTO runs (id, company_id, user_id, status, batch_id, scenario_code, queued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, companyId, managerId, status, batch, `S_${minutes}`, at(minutes)]);
  return id;
}

const visible = [];
let hiddenId;

beforeAll(() => {
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Older Pages Co', ?)`, [companyId, `op-${companyId}`]);
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'test_manager')`,
    [managerId, companyId, `${managerId}@test.com`]);
  // A large batch queued in one second, as POST /v1/runs does: only the id
  // tells its runs apart in the order.
  for (let i = 0; i < 9; i++) visible.push(addRun({ batch: bigBatch, minutes: 0 }));
  // The history under it.
  for (let i = 0; i < 3; i++) visible.push(addRun({ batch: oldBatch, minutes: 60 + i }));
  visible.push(addRun({ minutes: 600 }));
  hiddenId = addRun({ minutes: 30, status: 'DELETION_REQUESTED' });
});

afterAll(() => {
  run('DELETE FROM runs WHERE company_id = ?', [companyId]);
  run('DELETE FROM companies WHERE id = ?', [companyId]);
  run('DELETE FROM users WHERE id = ?', [managerId]);
});

const list = (query) => request(app).get(`/v1/runs?${query}`).set('Authorization', `Bearer ${token()}`);
const cursorQuery = (c) => `before_at=${encodeURIComponent(c.at)}&before_id=${encodeURIComponent(c.id)}`;

describe('GET /v1/runs: the page after another', () => {
  test('a full page names where the next starts; the last page names none', async () => {
    const full = await list('limit=4');
    expect(full.status).toBe(200);
    const last = full.body.runs.at(-1);
    expect(full.body.next_before).toEqual({ at: last.queued_at, id: last.id });
    const short = await list('limit=50');
    expect(short.body.runs).toHaveLength(visible.length);
    expect(short.body.next_before).toBeNull();
  });

  test('walking the pages gives every run once, in order, ties in one second included', async () => {
    const seen = [];
    let res = await list('limit=4');
    seen.push(...res.body.runs.map(r => r.id));
    while (res.body.next_before) {
      res = await list(`limit=4&${cursorQuery(res.body.next_before)}`);
      seen.push(...res.body.runs.map(r => r.id));
    }
    expect(seen).toHaveLength(visible.length);
    expect(new Set(seen)).toEqual(new Set(visible));
    expect(seen).not.toContain(hiddenId);
    const all = (await list('limit=50')).body.runs.map(r => r.id);
    expect(seen).toEqual(all);
  });

  test('with whole batches, the walk reaches the history under a batch larger than a page', async () => {
    const seen = new Set();
    let res = await list('limit=4&whole_batches=1');
    for (const r of res.body.runs) seen.add(r.id);
    expect(res.body.runs.filter(r => r.batch_id === bigBatch)).toHaveLength(9);
    let pages = 1;
    while (res.body.next_before) {
      res = await list(`limit=4&whole_batches=1&${cursorQuery(res.body.next_before)}`);
      for (const r of res.body.runs) seen.add(r.id);
      pages++;
    }
    expect(seen).toEqual(new Set(visible));
    expect(pages).toBeGreaterThan(2);
  });

  test('before_at and before_id go together, as plain short values', async () => {
    const one = await list(`before_at=${encodeURIComponent(at(0))}`);
    expect(one.status).toBe(400);
    const other = await list(`before_id=${visible[0]}`);
    expect(other.status).toBe(400);
    const long = await list(`before_at=${'9'.repeat(41)}&before_id=x`);
    expect(long.status).toBe(400);
    const repeated = await list(`before_at=a&before_at=b&before_id=x`);
    expect(repeated.status).toBe(400);
  });
});

describe('the dashboard page', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'dashboard.html'), 'utf8');
  function loadFunction(name) {
    const lines = page.split('\n');
    const start = lines.findIndex(l => l.startsWith(`function ${name}(`));
    if (start === -1) throw new Error(`no top-level function ${name}`);
    const end = lines.findIndex((l, i) => i > start && l === '}');
    return vm.runInNewContext(`(${lines.slice(start, end + 1).join('\n')})`, {});
  }

  test('older pages are merged under the first, each run once, the first page\'s copy kept', () => {
    const merge = loadFunction('mergeRunPages');
    const first = [{ id: 'b', queued_at: '2026-11-07 10:00:00', status: 'RUNNING' }, { id: 'a', queued_at: '2026-11-07 10:00:00' }];
    const older = [{ id: 'b', queued_at: '2026-11-07 10:00:00', status: 'QUEUED' }, { id: 'c', queued_at: '2026-11-06 09:00:00' }];
    const out = merge(first, older);
    expect(out.map(r => r.id)).toEqual(['b', 'a', 'c']);
    expect(out[0].status).toBe('RUNNING');
  });

  test('the next page is asked with the answer\'s cursor, encoded', () => {
    const url = loadFunction('olderRunsUrl')({ at: '2026-11-07 10:00:00', id: 'x&y' });
    expect(url).toBe('/v1/runs?limit=100&whole_batches=1&before_at=2026-11-07%2010%3A00%3A00&before_id=x%26y');
  });

  test('the button is there and wired', () => {
    expect(page).toContain('id="older-runs-btn"');
    expect(page).toContain("getElementById('older-runs-btn').addEventListener('click'");
    expect(page).toContain('olderCursor = data.next_before || null');
  });
});
