// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * api-read-routes.test.js — #503 PR 2: the read routes of the API by key.
 *
 *   - a key reads the runs of its own company or provider, never its
 *     providers' or another company's, never a deleted run: those are the
 *     same 404 as a run that does not exist;
 *   - answers carry statuses, times, counts and check results only: no body,
 *     header, URL, log, endpoint, credential or person;
 *   - parameters are checked, and a value that is not one of them is a 400.
 */

const crypto = require('node:crypto');
const express = require('express');
const request = require('supertest');
const { run } = require('../../src/db/db');
const K = require('../../src/utils/apiKeys');

const app = express();
app.use('/v1/api', require('../../src/api/routes/api'));

const companyId = crypto.randomUUID();
const providerId = crypto.randomUUID();
const otherId = crypto.randomUUID();
const tag = companyId.slice(0, 8);
const TM = { id: crypto.randomUUID(), email: `tm-${tag}@read.test` };
const OTHER_TM = { id: crypto.randomUUID(), email: `tm-o-${tag}@read.test` };
const SECRET_URL = 'https://provider.example/bookings/SECRET-REF';
const SECRET_BODY = '{"passenger":"Jane Secret"}';

function keyFor(company, creator = TM) {
  const made = K.newKey();
  run(`INSERT INTO api_key (id, company_id, created_by, name, prefix, secret_hash, scopes, expires_at)
       VALUES (?, ?, ?, 'read test', ?, ?, 'runs:read', ?)`,
  [crypto.randomUUID(), company, creator.id, made.prefix, made.secretHash, K.expiryAfter(1)]);
  return made.key;
}

let seq = 0;
function runIn(company, fields = {}) {
  const id = fields.id || crypto.randomUUID();
  seq += 1;
  const queuedAt = `2026-10-18 10:${String(seq).padStart(2, '0')}:00`;
  run(`INSERT INTO runs (id, company_id, user_id, status, batch_id, scenario_code, queued_at, api_base_used, auth_mode_used, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'https://provider.example', 'oauth2_basic', 'token refused for Jane Secret')`,
  [id, company, company === otherId ? OTHER_TM.id : TM.id, fields.status || 'COMPLETED', fields.batch || null, fields.code || 'OTST_X', queuedAt]);
  return id;
}

function resultsFor(runId, company) {
  const suite = Number(run(`INSERT INTO run_suites (run_id, company_id, scenario_name, suite_name, total, passed, failed)
                            VALUES (?, ?, 'OTST_X', '02-Sale', 3, 2, 1)`, [runId, company]).lastInsertRowid);
  const req = Number(run(`INSERT INTO run_requests (suite_id, run_id, company_id, request_name, http_method, http_url, http_status,
                            total, passed, failed, result, request_body, response_body, request_headers, response_headers)
                          VALUES (?, ?, ?, '02. POST Booking', 'POST', ?, 201, 3, 2, 1, 'FAIL', ?, ?, '{"Authorization":"Bearer t"}', '{}')`,
  [suite, runId, company, SECRET_URL, SECRET_BODY, SECRET_BODY]).lastInsertRowid);
  const check = (name, passed) => run(`INSERT INTO run_assertions (request_id, suite_id, run_id, company_id, assertion_key, assertion_name,
                                        category, domain, severity, passed, error_msg, expected_value, actual_value)
                                      VALUES (?, ?, ?, ?, ?, ?, 'business_logic', 'booking', 'major', ?, ?, '201', '201')`,
  [req, suite, runId, company, `k|${name}`, name, passed ? 1 : 0, passed ? null : 'expected PREBOOKED']);
  check('status is 201', true);
  check('booking has an id', true);
  check('booking is PREBOOKED', false);
}

let key;
let providerKey;
let otherKey;
const ids = {};

beforeAll(() => {
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Read Co', ?)`, [companyId, `read-${tag}`]);
  run(`INSERT INTO companies (id, name, slug, parent_id) VALUES (?, 'Read Provider', ?, ?)`, [providerId, `read-p-${tag}`, companyId]);
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Read Other', ?)`, [otherId, `read-o-${tag}`]);
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'test_manager')`, [TM.id, companyId, TM.email]);
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'test_manager')`, [OTHER_TM.id, otherId, OTHER_TM.email]);
  key = keyFor(companyId);
  providerKey = keyFor(providerId);
  otherKey = keyFor(otherId, OTHER_TM);

  ids.done = runIn(companyId, { batch: `b-${tag}`, code: 'OTST_DONE' });
  resultsFor(ids.done, companyId);
  ids.failed = runIn(companyId, { status: 'FAILED', batch: `b-${tag}`, code: 'OTST_FAILED' });
  ids.running = runIn(companyId, { status: 'RUNNING', code: 'OTST_RUNNING' });
  ids.queued1 = runIn(companyId, { status: 'QUEUED', code: 'OTST_Q1' });
  ids.queued2 = runIn(companyId, { status: 'QUEUED', code: 'OTST_Q2' });
  ids.deleted = runIn(companyId, { status: 'DELETED', batch: `b-${tag}` });
  ids.asked = runIn(companyId, { status: 'DELETION_REQUESTED', batch: `b-${tag}` });
  ids.flagged = runIn(companyId, { status: 'DELETED_BY_ADMIN' });
  ids.provider = runIn(providerId, { batch: `b-${tag}`, code: 'OTST_PROVIDER' });
  resultsFor(ids.provider, providerId);
  ids.other = runIn(otherId, { batch: `b-${tag}`, status: 'QUEUED' });
  resultsFor(ids.other, otherId);
});

const asKey = (path, k = key) => request(app).get(path).set('Authorization', `Bearer ${k}`);

/** No answer of the API may hold any of these, anywhere. */
function expectNothingPrivate(body) {
  const text = JSON.stringify(body);
  for (const word of ['SECRET-REF', 'Jane Secret', 'provider.example', 'Authorization', 'Bearer', TM.email, TM.id, 'oauth2_basic',
    'http_url', 'request_body', 'response_body', 'request_headers', 'response_headers', 'api_base', 'user_id', 'error_message']) {
    expect(text).not.toContain(word);
  }
}

describe('the run list', () => {
  test('the key\'s own runs only, newest first, no deleted run, with check counts', async () => {
    const res = await asKey('/v1/api/runs');
    expect(res.status).toBe(200);
    const got = res.body.runs.map(r => r.id);
    expect(got).toEqual([ids.queued2, ids.queued1, ids.running, ids.failed, ids.done]);
    expect(res.body).toMatchObject({ total: 5, limit: 50, offset: 0 });
    const done = res.body.runs.find(r => r.id === ids.done);
    expect(done).toEqual({
      id: ids.done, status: 'COMPLETED', scenario_code: 'OTST_DONE', batch_id: `b-${tag}`,
      queued_at: expect.any(String), started_at: null, completed_at: null, exit_code: null,
      checks: { total: 3, passed: 2, failed: 1 },
    });
    expectNothingPrivate(res.body);
  });

  test('a provider\'s key sees the provider\'s runs, not the company\'s', async () => {
    const res = await asKey('/v1/api/runs', providerKey);
    expect(res.body.runs.map(r => r.id)).toEqual([ids.provider]);
  });

  test('filters: status, batch, scenario, and paging', async () => {
    expect((await asKey('/v1/api/runs?status=QUEUED')).body.runs.map(r => r.id)).toEqual([ids.queued2, ids.queued1]);
    expect((await asKey(`/v1/api/runs?batch_id=b-${tag}`)).body.runs.map(r => r.id)).toEqual([ids.failed, ids.done]);
    expect((await asKey('/v1/api/runs?scenario_code=OTST_RUNNING')).body.runs.map(r => r.id)).toEqual([ids.running]);
    const page = await asKey('/v1/api/runs?limit=2&offset=1');
    expect(page.body).toMatchObject({ total: 5, limit: 2, offset: 1 });
    expect(page.body.runs.map(r => r.id)).toEqual([ids.queued1, ids.running]);
  });

  test.each([
    'limit=0', 'limit=201', 'limit=abc', 'limit=2.5', 'limit=-1', 'offset=-1', 'offset=x',
    'status=DELETED', 'status=DELETION_REQUESTED', 'status=completed', 'limit=1&limit=2',
    'status=QUEUED&status=RUNNING', `batch_id=${'x'.repeat(201)}`, 'scenario_code=a&scenario_code=b',
  ])('?%s is a 400', async (query) => {
    const res = await asKey(`/v1/api/runs?${query}`);
    expect(res.status).toBe(400);
    expect(res.body.detail).toBeTruthy();
  });
});

describe('one run', () => {
  test('its own run, built field by field', async () => {
    const res = await asKey(`/v1/api/runs/${ids.done}`);
    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual({ total: 3, passed: 2, failed: 1 });
    expect(Object.keys(res.body).sort()).toEqual(
      ['batch_id', 'checks', 'completed_at', 'exit_code', 'id', 'queued_at', 'scenario_code', 'started_at', 'status']);
    expectNothingPrivate(res.body);
  });

  test.each([
    ['a provider\'s run', 'provider'], ['another company\'s run', 'other'],
    ['a deleted run', 'deleted'], ['a run its company asked to delete', 'asked'], ['a run an administrator flagged', 'flagged'],
  ])('%s is the same 404 as no run', async (_label, which) => {
    const res = await asKey(`/v1/api/runs/${ids[which]}`);
    const none = await asKey(`/v1/api/runs/${crypto.randomUUID()}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual(none.body);
    expect((await asKey(`/v1/api/runs/${ids[which]}/assertions`)).status).toBe(404);
  });

  test('a provider\'s run is read with the provider\'s key', async () => {
    expect((await asKey(`/v1/api/runs/${ids.provider}`, providerKey)).status).toBe(200);
    expect((await asKey(`/v1/api/runs/${ids.done}`, providerKey)).status).toBe(404);
    expect((await asKey(`/v1/api/runs/${ids.done}`, otherKey)).status).toBe(404);
  });
});

describe('a run\'s checks', () => {
  test('suites, requests and checks, without bodies, headers or URL', async () => {
    const res = await asKey(`/v1/api/runs/${ids.done}/assertions`);
    expect(res.status).toBe(200);
    expect(res.body.run.id).toBe(ids.done);
    expect(res.body.suites).toHaveLength(1);
    const [suite] = res.body.suites;
    expect(suite).toMatchObject({ scenario: 'OTST_X', name: '02-Sale', checks: { total: 3, passed: 2, failed: 1, skipped: 0 } });
    const [req] = suite.requests;
    expect(req).toMatchObject({ name: '02. POST Booking', method: 'POST', http_status: 201, result: 'FAIL', checks: { total: 3, passed: 2, failed: 1 } });
    expect(req.assertions.map(a => [a.name, a.passed])).toEqual([
      ['status is 201', true], ['booking has an id', true], ['booking is PREBOOKED', false]]);
    expect(req.assertions[2]).toMatchObject({ error: 'expected PREBOOKED', category: 'business_logic', domain: 'booking', severity: 'major' });
    expectNothingPrivate(res.body);
  });

  test('?result=failed or passed narrows the checks, anything else is a 400', async () => {
    const failed = await asKey(`/v1/api/runs/${ids.done}/assertions?result=failed`);
    expect(failed.body.suites[0].requests[0].assertions.map(a => a.name)).toEqual(['booking is PREBOOKED']);
    const passed = await asKey(`/v1/api/runs/${ids.done}/assertions?result=passed`);
    expect(passed.body.suites[0].requests[0].assertions).toHaveLength(2);
    expect((await asKey(`/v1/api/runs/${ids.done}/assertions?result=all`)).status).toBe(400);
  });

  test('a run without results has no suites', async () => {
    const res = await asKey(`/v1/api/runs/${ids.failed}/assertions`);
    expect(res.status).toBe(200);
    expect(res.body.suites).toEqual([]);
    expect(res.body.run.checks).toEqual({ total: 0, passed: 0, failed: 0 });
  });
});

describe('a batch and the queue', () => {
  test('a batch holds the key\'s own runs only, with counts by status', async () => {
    const res = await asKey(`/v1/api/batches/b-${tag}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ batch_id: `b-${tag}`, total: 2, completed: 1, failed: 1, queued: 0, running: 0, cancelled: 0 });
    expect(res.body.runs.map(r => r.id)).toEqual([ids.done, ids.failed]);
    expectNothingPrivate(res.body);
    expect((await asKey(`/v1/api/batches/b-${tag}`, providerKey)).body.runs.map(r => r.id)).toEqual([ids.provider]);
  });

  test('a batch with none of the key\'s runs is a 404', async () => {
    expect((await asKey('/v1/api/batches/no-such-batch')).status).toBe(404);
    expect((await asKey(`/v1/api/batches/${'x'.repeat(201)}`)).status).toBe(404);
  });

  test('the queue: running and queued runs of the key\'s company, in order, with no person', async () => {
    const res = await asKey('/v1/api/queue');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ running: 1, queued: 2 });
    expect(res.body.runs.map(r => [r.id, r.position])).toEqual([[ids.running, null], [ids.queued1, 1], [ids.queued2, 2]]);
    expectNothingPrivate(res.body);
    expect((await asKey('/v1/api/queue', otherKey)).body.runs.map(r => r.id)).toEqual([ids.other]);
    expect((await asKey('/v1/api/queue', providerKey)).body.runs).toEqual([]);
  });
});

describe('what the API still refuses', () => {
  test.each([
    '/v1/api/runs/ID/logs', '/v1/api/runs/ID/requests', '/v1/api/runs/ID/artifacts', '/v1/api/batches/B/reports.zip',
  ])('%s is a 404 (no bodies, logs or files)', async (path) => {
    const res = await asKey(path.replace('ID', ids.done).replace('B', `b-${tag}`));
    expect(res.status).toBe(404);
    expect(res.body.detail).toBe('The API has no such route.');
  });

  test('no read route answers another method', async () => {
    for (const path of ['/v1/api/runs', `/v1/api/runs/${ids.done}`, '/v1/api/queue']) {
      expect((await request(app).delete(path).set('Authorization', `Bearer ${key}`)).status).toBe(404);
      expect((await request(app).post(path).set('Authorization', `Bearer ${key}`)).status).toBe(404);
    }
  });

  test('without a key every read route is a 401', async () => {
    for (const path of ['/v1/api/runs', `/v1/api/runs/${ids.done}`, `/v1/api/runs/${ids.done}/assertions`, `/v1/api/batches/b-${tag}`, '/v1/api/queue']) {
      expect((await request(app).get(path)).status).toBe(401);
    }
  });

  test('a revoked key reads nothing', async () => {
    const k = keyFor(companyId);
    expect((await asKey('/v1/api/runs', k)).status).toBe(200);
    run("UPDATE api_key SET revoked_at = datetime('now') WHERE prefix = ?", [K.parseKey(k).prefix]);
    expect((await asKey('/v1/api/runs', k)).status).toBe(401);
    expect((await asKey(`/v1/api/runs/${ids.done}`, k)).status).toBe(401);
  });
});
