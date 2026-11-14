// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1239: a stored request's parent (the "← view originating offer" link) is
// found among the requests this run's results stored, kept in memory. Before,
// each stored request ran a query with a join over run_requests and
// run_suites. The parents must be the same: this test stores drawn runs and
// asks the old query, for each request, over the rows stored before it.

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID: uuidv4 } = require('node:crypto');
const { run, get, all } = require('../../src/db/db');
const { encryptToFile } = require('../../src/utils/at-rest');
const { extractStructuredResults } = require('../../src/reports/structureResults');

const ARTIFACTS_DIR = path.resolve(__dirname, '../../data/artifacts');
const companyId = uuidv4();
const userId = uuidv4();
const runIds = [];

beforeAll(() => {
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Results Parents', ?)`, [companyId, `results-parents-${companyId.slice(0, 8)}`]);
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'test_manager')`,
    [userId, companyId, `parents-${userId.slice(0, 8)}@results-parents-test.com`]);
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

// mulberry32: the same draws on every machine.
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

const BASE = 'https://vendor.example/osdm';
const URLS = [
  `${BASE}/offers`, `${BASE}/offers?x=1`, `${BASE}/bookings`, `${BASE}/bookings/B1`, `${BASE}/bookings/B1/passengers/P1`,
  `${BASE}/bookings/B1/refund-offers`, `${BASE}/bookings/B1/refund-offers/R1`, `${BASE}/refunds`,
  `${BASE}/bookings/B1/exchange-offers`, `${BASE}/exchanges`, `${BASE}/bookings/B1/fulfillments`,
  `${BASE}/places`, `${BASE}/trips-collection`, `${BASE}/OFFERS`, null, '',
];

// Bruno results of `n` requests in a few scenarios and suites, drawn.
function drawnResults(seed, n) {
  const draw = drawer(seed);
  const pick = (list) => list[Math.floor(draw() * list.length)];
  return Array.from({ length: n }, (_, i) => {
    const url = pick(URLS);
    return {
      path: `${pick(['SALE', 'REFUND', 'EXCHANGE'])}/${pick(['01-Sale', '02-After'])}/${String(i).padStart(3, '0')}. Request.bru`,
      name: `Request ${i}`,
      request: url === null ? {} : { method: 'POST', url, headers: {} },
      response: { status: 200, data: {}, headers: {} },
      runDuration: 0.001,
      testResults: [{ description: 'status is 200', status: 'pass' }],
    };
  });
}

function seededRun(results) {
  const id = uuidv4();
  runIds.push(id);
  run(`INSERT INTO runs (id, company_id, user_id, status, scenario_code) VALUES (?, ?, ?, 'RUNNING', 'PARENTS')`, [id, companyId, userId]);
  fs.mkdirSync(path.join(ARTIFACTS_DIR, id), { recursive: true });
  encryptToFile(JSON.stringify(results), path.join(ARTIFACTS_DIR, id, '.bru_results.json'));
  return id;
}

// The rules and the query of inferParentRequestId() before #1239, asked over
// the rows stored before `requestId`.
const PARENT_PATH_RULES = [
  { child: /\/bookings(\b|\?|\/|$)/i, parent: /\/offers(\b|\?|\/|$)/i },
  { child: /\/refund-offers(\b|\?|\/|$)/i, parent: /\/bookings(\/|$)/i },
  { child: /\/refunds(\b|\?|\/|$)/i, parent: /\/refund-offers(\b|\?|\/|$)/i },
  { child: /\/exchange-offers(\b|\?|\/|$)/i, parent: /\/bookings(\/|$)/i },
  { child: /\/exchanges(\b|\?|\/|$)/i, parent: /\/exchange-offers(\b|\?|\/|$)/i },
  { child: /\/fulfillments(\b|\?|\/|$)/i, parent: /\/bookings(\/|$)/i },
];
function oldParentOf(url, runId, scenarioName, requestId) {
  if (!url || !runId) return null;
  for (const { child, parent } of PARENT_PATH_RULES) {
    if (child.test(url)) {
      const candidates = all(
        `SELECT rq.id, rq.http_url
           FROM run_requests rq
           JOIN run_suites s ON s.id = rq.suite_id
          WHERE rq.run_id = ?
            AND s.scenario_name IS ?
            AND rq.http_url IS NOT NULL
            AND rq.id < ?
          ORDER BY rq.id DESC
          LIMIT 30`,
        [runId, scenarioName ?? null, requestId]
      );
      for (const c of candidates) {
        if (parent.test(c.http_url)) return c.id;
      }
      return null;
    }
  }
  return null;
}

function compareWithOldQuery(runId) {
  const rows = all(
    `SELECT rq.id, rq.http_url, rq.parent_request_id, s.scenario_name
       FROM run_requests rq JOIN run_suites s ON s.id = rq.suite_id
      WHERE rq.run_id = ? ORDER BY rq.id`, [runId]);
  for (const row of rows) {
    expect([row.id, row.parent_request_id]).toEqual([row.id, oldParentOf(row.http_url, runId, row.scenario_name, row.id)]);
  }
  return rows;
}

describe('a stored request\'s parent, found in memory (#1239)', () => {
  test.each([1, 2, 3, 4, 5, 6, 7, 8])('the old query\'s parents, on drawn run %i', async (seed) => {
    const runId = seededRun(drawnResults(seed, 160));
    await extractStructuredResults(runId, companyId, { sliceMs: 5 });
    const rows = compareWithOldQuery(runId);
    expect(rows.length).toBeGreaterThan(100);
    // The draws reach requests with a parent (a chain root: the next test).
    expect(rows.filter((r) => r.parent_request_id !== null).length).toBeGreaterThan(10);
  });

  test('a parent more than 30 requests back is not looked for, as before', async () => {
    const results = [`${BASE}/offers`, ...Array.from({ length: 30 }, () => `${BASE}/places`), `${BASE}/bookings`]
      .map((url, i) => ({
        path: `SALE/01-Sale/${String(i).padStart(3, '0')}. Request.bru`,
        name: `Request ${i}`,
        request: { method: 'GET', url, headers: {} },
        response: { status: 200, data: {}, headers: {} },
        testResults: [{ description: 'ok', status: 'pass' }],
      }));
    const runId = seededRun(results);
    await extractStructuredResults(runId, companyId, { sliceMs: 0 });
    const booking = get(`SELECT parent_request_id FROM run_requests WHERE run_id = ? AND request_name = 'Request 31'`, [runId]);
    expect(booking.parent_request_id).toBeNull();
    compareWithOldQuery(runId);
  });

  test('a booking links to the offer of its own scenario only', async () => {
    const make = (scenario, url, i) => ({
      path: `${scenario}/01-Sale/${String(i).padStart(3, '0')}. Request.bru`,
      name: `${scenario} ${i}`,
      request: { method: 'POST', url, headers: {} },
      response: { status: 200, data: {}, headers: {} },
      testResults: [{ description: 'ok', status: 'pass' }],
    });
    const runId = seededRun([make('ONE', `${BASE}/offers`, 0), make('TWO', `${BASE}/bookings`, 1), make('ONE', `${BASE}/bookings`, 2)]);
    await extractStructuredResults(runId, companyId, { sliceMs: 0 });
    const byName = Object.fromEntries(all('SELECT request_name, id, parent_request_id FROM run_requests WHERE run_id = ?', [runId])
      .map((r) => [r.request_name, r]));
    expect(byName['ONE 2'].parent_request_id).toBe(byName['ONE 0'].id);
    expect(byName['TWO 1'].parent_request_id).toBeNull();
  });
});
