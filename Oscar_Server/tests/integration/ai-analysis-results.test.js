// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #801 PR 3: the AI analysis of one batch or two, against a local stub AI
 * service, never a real one.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-ai-analysis-results';

const http = require('node:http');
const express = require('express');
const jwt     = require('jsonwebtoken');
const { randomUUID: uuidv4 } = require('node:crypto');
const request = require('supertest');
const { run, get, all, colEncrypt, encrypt } = require('../../src/db/db');
const A = require('../../src/utils/aiAccess');

const app = express();
app.use(express.json());
app.use('/v1/company', require('../../src/api/routes/company-ai-analysis'));
app.use('/v1/company', require('../../src/api/routes/company-ai-analysis-results'));

const companyId = uuidv4();
const providerId = uuidv4();
const otherCompanyId = uuidv4();
const tmId = uuidv4();
const tm2Id = uuidv4();
const testerId = uuidv4();
const KEY = 'sk-ant-analysis-0123456789';
const BASE = '/v1/company/ai-analysis';

// ── The stub AI service ──────────────────────────────────────────────────────
const calls = [];
let reply = null;
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    const body = JSON.parse(raw);
    calls.push({ url: req.url, headers: req.headers, body, raw });
    const r = reply ? reply() : { status: 200, json: answerOf(defaultAnswer) };
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r.json));
  });
});
const defaultAnswer = { summary: 'One problem: the purchaser.', groups: [{ title: 'Purchaser refused', cause: 'The provider asks a purchaser.',
  owner: 'provider', why: 'A 400 MISSING_INFORMATION at booking.', steps: ['02. POST Booking'], scenarios: ['OTST_SALE_1ADT'] }],
comparison: { fixed: ['Fulfillment'], stillFailing: ['Purchaser'], new: ['Refund'] } };
const answerOf = (obj, text) => ({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: text ?? JSON.stringify(obj) }],
  usage: { input_tokens: 1200, output_tokens: 300 } });

function token(role, uid, cid = companyId) {
  return `Bearer ${jwt.sign({ sub: uid, email: `${role}-${uid.slice(0, 4)}@ai-an.com`, companyId: cid, role },
    process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;
}
const tm = (uid = tmId) => token('test_manager', uid);
const approve = (cid, uid) => run(`INSERT INTO ai_access_request (id, company_id, user_id, state, text_version, text_hash)
  VALUES (?, ?, ?, 'approved', ?, 'h')`, [uuidv4(), cid, uid, A.COMMITMENT.version]);
const configure = (cid, uid, over = {}) => run(`INSERT INTO ai_config (company_id, user_id, connector, base_url, model, api_key_enc, monthly_token_cap, instruction, tested_at)
  VALUES (?, ?, 'anthropic', ?, 'claude-opus-5-5', ?, ?, ?, datetime('now'))`,
[cid, uid, over.base ?? stubBase, encrypt(KEY), over.cap ?? null, over.instruction ?? 'Name the OSDM section.']);

// One run of one scenario with its failed checks.
function seedRun(batch, scenario, step, status, body, checks, company = companyId, at = '2026-10-14 17:00:00') {
  const runId = uuidv4();
  run(`INSERT INTO runs (id, company_id, user_id, status, batch_id, scenario_code, queued_at, completed_at) VALUES (?, ?, ?, 'COMPLETED', ?, ?, ?, ?)`,
    [runId, company, tmId, batch, scenario, at, at]);
  const suite = run(`INSERT INTO run_suites (run_id, company_id, scenario_name, suite_name) VALUES (?, ?, ?, '02-Common Requests')`,
    [runId, company, scenario]).lastInsertRowid;
  const reqId = run(`INSERT INTO run_requests (suite_id, run_id, company_id, request_name, http_status, response_body) VALUES (?, ?, ?, ?, ?, ?)`,
    [suite, runId, company, step, status, colEncrypt(JSON.stringify(body))]).lastInsertRowid;
  for (const [name, error] of checks) {
    run(`INSERT INTO run_assertions (request_id, suite_id, run_id, company_id, assertion_key, assertion_name, passed, error_msg) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      [reqId, suite, runId, company, `${step}|${name}`, name, error]);
  }
}

const missing = { code: 'urn:uic:problem:MISSING_INFORMATION', title: 'Purchaser Jane Doe is missing', detail: 'jane.doe@example.com' };
let stubBase;

beforeAll(async () => {
  await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
  stubBase = `http://127.0.0.1:${stub.address().port}`;
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'AI An', 'ai-an')`, [companyId]);
  run(`INSERT INTO companies (id, name, slug, parent_id) VALUES (?, 'AI An Provider', 'ai-an-provider', ?)`, [providerId, companyId]);
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'AI An Other', 'ai-an-other')`, [otherCompanyId]);
  for (const [id, cid, role] of [[tmId, companyId, 'test_manager'], [tm2Id, companyId, 'test_manager'], [testerId, companyId, 'company_user']]) {
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', ?)`, [id, cid, `${id}@ai-an.com`, role]);
  }
  approve(companyId, tmId);
  configure(companyId, tmId);
  run(`INSERT INTO test_frameworks (id, company_id, config) VALUES (?, ?, ?)`, [uuidv4(), companyId, colEncrypt(JSON.stringify({ osdmVersion: '3.8', salesFlows: ['SALE'] }))]);
  run(`INSERT INTO finding (id, company_id, title, step, category) VALUES (?, ?, 'Purchaser required at booking', 'POST Booking', 'provider_deviation')`, [uuidv4(), companyId]);
  seedRun('batch-1', 'OTST_SALE_1ADT', '02. POST Booking', 400, missing, [['status is 201', "expected 'Jane Doe' to be a purchaser"]], companyId, '2026-10-14 17:00:00');
  seedRun('batch-1', 'OTST_SALE_1ADT', '06. POST Fulfillments', 500, {}, [['fulfilled', null]], companyId, '2026-10-14 17:01:00');
  seedRun('batch-2', 'OTST_SALE_1ADT', '02. POST Booking', 400, missing, [['status is 201', null]], companyId, '2026-10-15 09:00:00');
  seedRun('batch-2', 'OTST_REFUND_1ADT', '10. POST Refund Offers', 422, {}, [['refund offered', null]], companyId, '2026-10-15 09:01:00');
  seedRun('batch-other', 'X', '01. POST Get Offer', 400, {}, [['offers', null]], otherCompanyId);
});

afterAll(async () => { await new Promise(resolve => stub.close(resolve)); });
beforeEach(() => { calls.length = 0; reply = null; });

const preview = (batches, uid = tmId, extra = {}) => request(app).post(`${BASE}/preview`).set('Authorization', tm(uid)).send({ batches, ...extra });
const start = (batches, hash, extra = {}) => request(app).post(`${BASE}/run`).set('Authorization', tm()).send({ batches, hash, ...extra });

async function waitFor(id) {
  for (let i = 0; i < 100; i++) {
    const res = await request(app).get(`${BASE}/history/${id}`).set('Authorization', tm());
    if (res.body.status !== 'running') return res;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('analysis still running');
}

describe('#801 PR 3 who may analyse', () => {
  test('testers and certifiers are refused; a Test Manager without approved access cannot preview or run', async () => {
    for (const t of [token('company_user', testerId), token('certification_user', uuidv4())]) {
      expect((await request(app).get(`${BASE}/batches`).set('Authorization', t)).status).toBe(403);
      expect((await request(app).get(`${BASE}/history`).set('Authorization', t)).status).toBe(403);
    }
    expect((await preview(['batch-1'], tm2Id)).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test('approved but no AI service configured: 409', async () => {
    approve(providerId, tmId);
    const res = await request(app).post(`${BASE}/preview`).set('Authorization', tm()).set('X-Provider-Id', providerId).send({ batches: ['batch-1'] });
    expect(res.status).toBe(404);   // the provider has no such batch
    seedRun('batch-p', 'P', '02. POST Booking', 400, {}, [['x', null]], providerId);
    const res2 = await request(app).post(`${BASE}/preview`).set('Authorization', tm()).set('X-Provider-Id', providerId).send({ batches: ['batch-p'] });
    expect(res2.status).toBe(409);
    expect(res2.body.detail).toContain('Configure the AI service');
  });

  test('the batches offered are this company\'s only; another company\'s batch is not found', async () => {
    const res = await request(app).get(`${BASE}/batches`).set('Authorization', tm());
    expect(res.body.batches.map(b => b.batchId).sort()).toEqual(['batch-1', 'batch-2']);
    expect((await preview(['batch-other'])).status).toBe(404);
    expect((await preview([])).status).toBe(400);
    expect((await preview(['batch-1', 'batch-1'])).status).toBe(400);
  });
});

describe('#801 PR 3 the preview is what is sent', () => {
  test('one batch: the failed checks without values, the framework, the findings; no name, contact or response body', async () => {
    const res = await preview(['batch-1'], tmId, { language: 'French' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: 'one', model: 'claude-opus-5-5', counts: { groups: 2 }, summarisedByStep: false });
    const input = JSON.parse(res.body.input);
    expect(input.failures.map(g => g.step).sort()).toEqual(['02. POST Booking', '06. POST Fulfillments']);
    expect(input.testFramework).toEqual({ osdmVersion: '3.8', salesFlows: ['SALE'] });
    expect(input.findings[0].title).toBe('Purchaser required at booking');
    for (const secret of ['Jane', 'jane.doe', KEY, stubBase]) expect(res.body.input + res.body.instructions).not.toContain(secret);
    expect(res.body.instructions).toContain('Answer in French');
    expect(res.body.instructions).toContain('Name the OSDM section.');
    expect(res.body.estimatedTokens).toBeGreaterThan(0);
    expect(res.body.monthly).toEqual({ cap: null, used: 0 });
    expect(calls).toHaveLength(0);
  });

  test('two batches in either order: the earlier first, sorted into fixed, still failing and new', async () => {
    const res = await preview(['batch-2', 'batch-1']);
    expect(res.body.mode).toBe('compare');
    expect(res.body.batches.map(b => b.batchId)).toEqual(['batch-1', 'batch-2']);
    expect(res.body.counts).toEqual({ fixed: 1, stillFailing: 1, new: 1 });
  });
});

describe('#801 PR 3 running an analysis', () => {
  test('a run needs the hash of the preview it confirms', async () => {
    const res = await start(['batch-1'], 'not-the-hash');
    expect(res.status).toBe(409);
    expect(res.body.detail).toContain('Look at the preview again');
    expect(calls).toHaveLength(0);
  });

  test('confirmed: the stub gets exactly the preview, the result is stored, read back and audited', async () => {
    const p = await preview(['batch-1', 'batch-2']);
    const res = await start(['batch-1', 'batch-2'], p.body.hash);
    expect(res.status).toBe(202);
    const done = await waitFor(res.body.id);
    expect(done.body).toMatchObject({ status: 'done', mode: 'compare', batches: ['batch-1', 'batch-2'], model: 'claude-opus-5-5',
      tokens: { input: 1200, output: 300 }, inputHash: p.body.hash });
    expect(done.body.result.groups[0]).toMatchObject({ title: 'Purchaser refused', owner: 'provider' });
    expect(done.body.result.comparison).toEqual(defaultAnswer.comparison);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/v1/messages');
    expect(calls[0].headers['x-api-key']).toBe(KEY);
    expect(calls[0].body.system).toBe(p.body.instructions);
    expect(calls[0].body.messages[0].content).toBe(p.body.input);
    const row = get('SELECT result_enc FROM ai_analysis WHERE id = ?', [res.body.id]);
    expect(row.result_enc).not.toContain('Purchaser refused');
    const events = all('SELECT event_type FROM auth_events WHERE company_id = ? AND event_type LIKE ?', [companyId, 'ai_analysis%']).map(e => e.event_type);
    expect(events).toContain(`ai_analysis_started:${res.body.id}:compare:anthropic:claude-opus-5-5`);
    expect(events).toContain(`ai_analysis_done:${res.body.id}:in=1200:out=300:usd=0.0108`);
    expect(events.join(' ')).not.toContain(KEY);
  });

  test('the monthly limit counts the tokens used; over it, nothing is sent', async () => {
    run('UPDATE ai_config SET monthly_token_cap = 1600 WHERE company_id = ? AND user_id = ?', [companyId, tmId]);
    try {
      const p = await preview(['batch-1']);
      expect(p.body.monthly).toEqual({ cap: 1600, used: 1500 });
      const res = await start(['batch-1'], p.body.hash);
      expect(res.status).toBe(409);
      expect(res.body.detail).toContain('monthly token limit');
      expect(calls).toHaveLength(0);
    } finally {
      run('UPDATE ai_config SET monthly_token_cap = NULL WHERE company_id = ? AND user_id = ?', [companyId, tmId]);
    }
  });

  test('an answer that is not the JSON asked is kept as it came', async () => {
    reply = () => ({ status: 200, json: answerOf(null, 'I think the provider is wrong.') });
    const p = await preview(['batch-1']);
    const done = await waitFor((await start(['batch-1'], p.body.hash)).body.id);
    expect(done.body).toMatchObject({ status: 'unreadable', error: 'The answer is not a JSON object.', result: { raw: 'I think the provider is wrong.' } });
  });

  test('a refused call is stored as failed, the key masked', async () => {
    reply = () => ({ status: 401, json: { type: 'error', error: { message: `invalid x-api-key ${KEY}` } } });
    const p = await preview(['batch-1']);
    const done = await waitFor((await start(['batch-1'], p.body.hash)).body.id);
    expect(done.body.status).toBe('failed');
    expect(done.body.error).toBe('The AI service answered HTTP 401: invalid x-api-key ***');
  });

  test('one running analysis at a time per Test Manager; a stale one reads as interrupted', async () => {
    const id = uuidv4();
    run(`INSERT INTO ai_analysis (id, company_id, user_id, mode, batch_a, language, connector, model, input_hash, input_chars)
         VALUES (?, ?, ?, 'one', 'batch-1', 'English', 'anthropic', 'm', 'h', 1)`, [id, companyId, tmId]);
    const p = await preview(['batch-1']);
    expect((await start(['batch-1'], p.body.hash)).status).toBe(409);
    run(`UPDATE ai_analysis SET created_at = datetime('now', '-1 hour') WHERE id = ?`, [id]);
    const res = await request(app).get(`${BASE}/history/${id}`).set('Authorization', tm());
    expect(res.body.status).toBe('interrupted');
  });
});

describe('#801 PR 3 the history', () => {
  test('every Test Manager of the company reads it, approved or not; another company\'s analysis is not found', async () => {
    const list = await request(app).get(`${BASE}/history`).set('Authorization', tm(tm2Id));
    expect(list.status).toBe(200);
    expect(list.body.analyses.length).toBeGreaterThan(0);
    expect(list.body.analyses[0]).not.toHaveProperty('result');
    const id = list.body.analyses.find(a => a.status === 'done').id;
    expect((await request(app).get(`${BASE}/history/${id}`).set('Authorization', tm(tm2Id))).status).toBe(200);
    const foreign = await request(app).get(`${BASE}/history/${id}`).set('Authorization', token('test_manager', uuidv4(), otherCompanyId));
    expect(foreign.status).toBe(404);
    const provider = await request(app).get(`${BASE}/history/${id}`).set('Authorization', tm()).set('X-Provider-Id', providerId);
    expect(provider.status).toBe(404);
  });
});

describe('#827 PR C the masked sample', () => {
  test('one failing request of the group, its personal and connection data masked, never its headers or URL', async () => {
    const runId = uuidv4();
    run(`INSERT INTO runs (id, company_id, user_id, status, batch_id, scenario_code, queued_at, completed_at) VALUES (?, ?, ?, 'COMPLETED', 'batch-sample', 'OTST_S', '2026-10-16 09:00:00', '2026-10-16 09:00:00')`,
      [runId, companyId, tmId]);
    const suite = run(`INSERT INTO run_suites (run_id, company_id, scenario_name, suite_name) VALUES (?, ?, 'OTST_S', 'x')`, [runId, companyId]).lastInsertRowid;
    const sent = { offers: [{ offerId: 'O-77' }], passengerSpecifications: [{ externalRef: 'p1', type: 'ADULT', detail: { firstName: 'Marie', lastName: 'Curie' }, dateOfBirth: '1990-02-03' }],
      purchaser: { detail: { firstName: 'Pierre', contact: { email: 'pierre@example.com' } } } };
    const got = { problems: [{ code: 'urn:uic:problem:MISSING_INFORMATION', title: 'Marie Curie needs a phone', detail: 'pierre@example.com' }] };
    const reqId = run(`INSERT INTO run_requests (suite_id, run_id, company_id, request_name, http_method, http_url, http_status, request_headers, request_body, response_body)
      VALUES (?, ?, ?, '02. POST Booking', 'POST', 'https://secret-host.example/alpha/bookings', 400, ?, ?, ?)`,
    [suite, runId, companyId, colEncrypt(JSON.stringify({ Authorization: 'Bearer tok-123' })), colEncrypt(JSON.stringify(sent)), colEncrypt(JSON.stringify(got))]).lastInsertRowid;
    run(`INSERT INTO run_assertions (request_id, suite_id, run_id, company_id, assertion_key, assertion_name, passed) VALUES (?, ?, ?, ?, 'k', 'status is 201', 0)`,
      [reqId, suite, runId, companyId]);
    const res = await preview(['batch-sample']);
    expect(res.status).toBe(200);
    const group = JSON.parse(res.body.input).failures[0];
    expect(group.operation).toBe('POST /bookings');
    expect(group.sample.request.offers).toEqual([{ offerId: 'O-77' }]);
    expect(group.sample.request.passengerSpecifications[0]).toEqual({ externalRef: 'p1', type: 'ADULT', detail: { firstName: '<masked>', lastName: '<masked>' }, dateOfBirth: '<masked>' });
    expect(group.sample.response.problems[0]).toEqual({ code: 'urn:uic:problem:MISSING_INFORMATION', title: '<masked>', detail: '<masked>' });
    for (const secret of ['Marie', 'Curie', 'Pierre', 'pierre@', '1990-02-03', 'tok-123', 'secret-host']) expect(res.body.input).not.toContain(secret);
  });
});

describe('#831 the model per analysis, its cost, and what was spent', () => {
  test('another model: in the preview, its hash and its price; the same input shares the content hash', async () => {
    const own = await preview(['batch-1']);
    const other = await preview(['batch-1'], tmId, { model: 'claude-sonnet-5-5' });
    expect(other.body).toMatchObject({ model: 'claude-sonnet-5-5', configuredModel: 'claude-opus-5-5', price: { input: 2, output: 10, source: 'list' } });
    expect(other.body.hash).not.toBe(own.body.hash);
    expect(other.body.contentHash).toBe(own.body.contentHash);
    expect(other.body.estimatedCost.input).toBeCloseTo(other.body.estimatedTokens * 2 / 1e6, 6);
    expect(other.body.estimatedCost.atMost).toBeGreaterThan(other.body.estimatedCost.input);
    expect((await preview(['batch-1'], tmId, { model: 'claude opus 5.5' })).status).toBe(400);
  });

  test('a run must confirm the model of its preview, and goes to that model; its cost is stored', async () => {
    const p = await preview(['batch-1'], tmId, { model: 'claude-sonnet-5-5' });
    expect((await start(['batch-1'], p.body.hash)).status).toBe(409);   // the configured model is not the one confirmed
    const res = await start(['batch-1'], p.body.hash, { model: 'claude-sonnet-5-5' });
    expect(res.status).toBe(202);
    const done = await waitFor(res.body.id);
    expect(calls[0].body.model).toBe('claude-sonnet-5-5');
    expect(done.body).toMatchObject({ model: 'claude-sonnet-5-5', cost: 0.0054, contentHash: p.body.contentHash });   // 1200 × 2 + 300 × 10
    expect(get('SELECT cost_usd FROM ai_analysis WHERE id = ?', [res.body.id]).cost_usd).toBe(0.0054);
  });

  test('a model OSCAR has no price for takes the Test Manager\'s, else has none', async () => {
    let p = await preview(['batch-1'], tmId, { model: 'my-model' });
    expect(p.body.price).toBeNull();
    expect(p.body.estimatedCost).toBeNull();
    run('UPDATE ai_config SET price_input = 1, price_output = 2 WHERE company_id = ? AND user_id = ?', [companyId, tmId]);
    try {
      p = await preview(['batch-1'], tmId, { model: 'my-model' });
      expect(p.body.price).toEqual({ input: 1, output: 2, source: 'custom' });
      const done = await waitFor((await start(['batch-1'], p.body.hash, { model: 'my-model' })).body.id);
      expect(done.body.cost).toBe(0.0018);
    } finally {
      run('UPDATE ai_config SET price_input = NULL, price_output = NULL WHERE company_id = ? AND user_id = ?', [companyId, tmId]);
    }
  });

  test('what was spent: every Test Manager\'s analyses here, today, this month, per model', async () => {
    const res = await request(app).get(`${BASE}/spend`).set('Authorization', tm(tm2Id));
    expect(res.status).toBe(200);
    const history = (await request(app).get(`${BASE}/history`).set('Authorization', tm())).body.analyses
      .filter(a => a.tokens.input !== null);
    expect(res.body.currency).toBe('USD');
    expect(res.body.month.analyses).toBe(history.length);
    expect(res.body.today.analyses).toBe(history.length);
    expect(res.body.month.cost).toBeCloseTo(history.reduce((t, a) => t + (a.cost || 0), 0), 6);
    expect(res.body.models.map(m => m.model)).toEqual(expect.arrayContaining(['claude-opus-5-5', 'claude-sonnet-5-5', 'my-model']));
    expect(res.body.mine).toEqual({ cap: null, used: 0 });
    expect((await request(app).get(`${BASE}/spend`).set('Authorization', token('company_user', testerId))).status).toBe(403);
    const provider = await request(app).get(`${BASE}/spend`).set('Authorization', tm()).set('X-Provider-Id', providerId);
    expect(provider.body.month.analyses).toBe(0);
  });
});
