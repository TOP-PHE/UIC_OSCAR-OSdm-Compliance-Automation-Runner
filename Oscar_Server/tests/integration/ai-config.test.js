// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #801 PR 2: a Test Manager's AI service, per company or provider, where
 * their access is approved. Every call goes to a local stub AI service,
 * never a real one.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-ai-config';

const http = require('node:http');
const express = require('express');
const jwt     = require('jsonwebtoken');
const { randomUUID: uuidv4 } = require('node:crypto');
const request = require('supertest');
const { run, get, all } = require('../../src/db/db');
const A = require('../../src/utils/aiAccess');
const { testConnection } = require('../../src/services/aiConnector');

const app = express();
app.use(express.json());
app.use('/v1/company', require('../../src/api/routes/company-ai-analysis'));

const companyId = uuidv4();
const providerId = uuidv4();
const provider2Id = uuidv4();
const tmId = uuidv4();
const tm2Id = uuidv4();
const testerId = uuidv4();
const CONFIG = '/v1/company/ai-analysis/config';
const KEY = 'sk-ant-test-0123456789';

// ── The stub AI service ──────────────────────────────────────────────────────
const calls = [];
let reply = null;   // (req) => { status, json?, text?, headers? }
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ method: req.method, url: req.url, headers: req.headers, body });
    const r = reply ? reply(req) : defaultReply(req, body);
    res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers || {}) });
    res.end(r.text ?? JSON.stringify(r.json));
  });
});
function defaultReply(req, body) {
  if (req.url === '/v1/messages') {
    if (req.headers['x-api-key'] !== KEY) {
      return { status: 401, json: { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${req.headers['x-api-key']}` } } };
    }
    return { status: 200, json: { model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 21, output_tokens: 1 } } };
  }
  if (req.method === 'GET' && req.url === '/v1/models?limit=100') {
    if (req.headers['x-api-key'] !== KEY) return { status: 401, json: { type: 'error', error: { message: 'invalid x-api-key' } } };
    return { status: 200, json: { data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', type: 'model' },
      { id: 'claude-new-9', display_name: 'Claude New <9>', type: 'model' }, { id: 'bad id', type: 'model' }], has_more: false } };
  }
  if (req.url === '/v1/chat/completions') {
    return { status: 200, json: { model: body.model, choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 19, completion_tokens: 1 } } };
  }
  return { status: 404, json: { error: { message: 'no such route' } } };
}
let base;     // http://127.0.0.1:<port>
let other;    // the same stub under another host name

function token(role, uid, cid = companyId) {
  return `Bearer ${jwt.sign({ sub: uid, email: `${role}-${uid.slice(0, 4)}@ai-config.com`, companyId: cid, role },
    process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;
}
const tm = (uid = tmId) => token('test_manager', uid);
const anthropic = (over = {}) => ({ connector: 'anthropic', baseUrl: base, model: 'claude-opus-5-5', apiKey: KEY, ...over });
const put = (body, { uid = tmId, provider = '' } = {}) => request(app).put(CONFIG).set('Authorization', tm(uid)).set('X-Provider-Id', provider).send(body);
const approve = (cid, uid, version = A.COMMITMENT.version) => run(
  `INSERT INTO ai_access_request (id, company_id, user_id, state, text_version, text_hash) VALUES (?, ?, ?, 'approved', ?, 'h')
   ON CONFLICT (company_id, user_id) DO UPDATE SET state = 'approved', text_version = excluded.text_version`, [uuidv4(), cid, uid, version]);
const stored = (cid = companyId, uid = tmId) => get('SELECT * FROM ai_config WHERE company_id = ? AND user_id = ?', [cid, uid]);

beforeAll(async () => {
  await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${stub.address().port}`;
  other = `http://localhost:${stub.address().port}`;
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'AI Config', 'ai-config')`, [companyId]);
  run(`INSERT INTO companies (id, name, slug, parent_id) VALUES (?, 'AI Config Provider', 'ai-config-provider', ?)`, [providerId, companyId]);
  run(`INSERT INTO companies (id, name, slug, parent_id) VALUES (?, 'AI Config Second', 'ai-config-second', ?)`, [provider2Id, companyId]);
  for (const [id, role] of [[tmId, 'test_manager'], [tm2Id, 'test_manager'], [testerId, 'company_user']]) {
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', ?)`, [id, companyId, `${id}@ai-config.com`, role]);
  }
  approve(companyId, tmId);
  approve(providerId, tmId);
});

afterAll(async () => {
  // The rows stay: the database of this test file is removed by the teardown.
  await new Promise(resolve => stub.close(resolve));
});

beforeEach(() => { calls.length = 0; reply = null; });

describe('#801 PR 2 who may configure', () => {
  test('a tester and a certifier are refused', async () => {
    for (const t of [token('company_user', testerId), token('certification_user', uuidv4())]) {
      expect((await request(app).get(CONFIG).set('Authorization', t)).status).toBe(403);
      expect((await request(app).put(CONFIG).set('Authorization', t).send(anthropic())).status).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });

  test('a Test Manager whose access is not approved here is refused, before any call', async () => {
    const res = await put(anthropic(), { uid: tm2Id });
    expect(res.status).toBe(403);
    expect(res.body.detail).toContain('not approved for AI Config');
    expect((await put(anthropic(), { provider: provider2Id })).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test('an approval on an older text asks for the text first', async () => {
    approve(companyId, tm2Id, A.COMMITMENT.version - 1);
    const res = await request(app).get(CONFIG).set('Authorization', tm(tm2Id));
    expect(res.status).toBe(403);
    expect(res.body.detail).toContain('accept it again');
  });

  test('nothing configured yet: the kinds of service and no config', async () => {
    const res = await request(app).get(CONFIG).set('Authorization', tm()).set('X-Provider-Id', providerId);
    expect(res.status).toBe(200);
    expect(res.body.config).toBeNull();
    expect(res.body.company).toMatchObject({ id: providerId, provider: true });
    expect(res.body.connectors.map(c => c.id)).toEqual(['anthropic', 'openai_compatible']);
  });
});

describe('#801 PR 2 saving is testing first', () => {
  test('a failed test saves nothing, and the key the service echoes is masked', async () => {
    const res = await put(anthropic({ apiKey: 'sk-wrong-key-999' }));
    expect(res.status).toBe(422);
    expect(res.body.test.ok).toBe(false);
    expect(res.body.detail).toContain('HTTP 401: invalid x-api-key ***');
    expect(JSON.stringify(res.body)).not.toContain('sk-wrong-key-999');
    expect(stored()).toBeUndefined();
  });

  test('a working service is saved, with the Anthropic headers, and the key encrypted and never sent back', async () => {
    const res = await put(anthropic({ instruction: 'Be short.' }));
    expect(res.status).toBe(201);
    expect(res.body.test).toMatchObject({ ok: true, answer: 'OK', usage: { input: 21, output: 1 } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/v1/messages');
    expect(calls[0].headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0].body.model).toBe('claude-opus-5-5');
    const row = stored();
    expect(row.api_key_enc).toBeTruthy();
    expect(row.api_key_enc).not.toContain(KEY);
    expect(row.tested_at).toBeTruthy();
    const read = await request(app).get(CONFIG).set('Authorization', tm());
    expect(read.body.config).toMatchObject({ connector: 'anthropic', baseUrl: base, model: 'claude-opus-5-5', hasKey: true, instruction: 'Be short.' });
    expect(JSON.stringify(read.body)).not.toContain(KEY);
    const events = all('SELECT event_type FROM auth_events WHERE company_id = ?', [companyId]).map(e => e.event_type);
    expect(events).toContain('ai_config_saved:anthropic:connector,baseUrl,model,apiKey,monthlyTokenCap,instruction,prices:tested');
    expect(events.join(' ')).not.toContain(KEY);
  });

  test('a limit or an instruction is saved without a call; a new model is tested again with the stored key', async () => {
    const quiet = await put(anthropic({ apiKey: '', monthlyTokenCap: 50000, instruction: 'Longer.' }));
    expect(quiet.status).toBe(200);
    expect(quiet.body.test).toBeNull();
    expect(calls).toHaveLength(0);
    expect(stored().monthly_token_cap).toBe(50000);

    const model = await put(anthropic({ apiKey: '', model: 'claude-sonnet-5-5' }));
    expect(model.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].headers['x-api-key']).toBe(KEY);
    expect(stored().model).toBe('claude-sonnet-5-5');
  });

  test('another host without the key typed again is refused, and nothing is sent there', async () => {
    const res = await put(anthropic({ apiKey: '', baseUrl: other }));
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain('Type the key again');
    expect(calls).toHaveLength(0);
  });

  test('a redirect is not followed', async () => {
    reply = (req) => (req.url === '/v1/messages'
      ? { status: 307, json: {}, headers: { location: `${base}/elsewhere/v1/messages` } }
      : { status: 200, json: { content: [{ type: 'text', text: 'followed' }] } });
    const res = await put(anthropic({ model: 'claude-haiku-5-5' }));
    expect(res.status).toBe(422);
    expect(res.body.detail).toContain('redirect (HTTP 307)');
    expect(calls.map(c => c.url)).toEqual(['/v1/messages']);
    expect(stored().model).toBe('claude-sonnet-5-5');
  });

  test('an answer of another kind of service is not taken for a working one', async () => {
    const res = await put({ connector: 'openai_compatible', baseUrl: `${base}/v1/messages-only`, model: 'm', apiKey: 'k' });
    expect(res.status).toBe(422);
  });

  test('the address rule of every outbound call applies', async () => {
    const saved = process.env.ALLOW_PRIVATE_TARGETS;
    process.env.ALLOW_PRIVATE_TARGETS = '';
    try {
      const res = await put(anthropic());
      expect(res.status).toBe(400);
      expect(res.body.detail).toContain('https');
    } finally { process.env.ALLOW_PRIVATE_TARGETS = saved; }
    expect(calls).toHaveLength(0);
  });
});

describe('#801 PR 2 testing, per provider, and removing', () => {
  test('the stored service is tested on demand; a candidate is tested without being saved', async () => {
    const before = stored().tested_at;
    const res = await request(app).post(`${CONFIG}/test`).set('Authorization', tm()).send({});
    expect(res.status).toBe(200);
    expect(res.body.test.ok).toBe(true);
    expect(stored().tested_at).not.toBe(before);

    const candidate = await request(app).post(`${CONFIG}/test`).set('Authorization', tm())
      .send({ connector: 'openai_compatible', baseUrl: `${base}/v1`, model: 'gpt-4o', apiKey: 'sk-oai-1' });
    expect(candidate.body.test).toMatchObject({ ok: true, answer: 'OK', usage: { input: 19, output: 1 } });
    expect(calls[1].url).toBe('/v1/chat/completions');
    expect(calls[1].headers.authorization).toBe('Bearer sk-oai-1');
    expect(stored().connector).toBe('anthropic');
  });

  test('a provider has its own service, OpenAI-compatible without a key', async () => {
    const res = await put({ connector: 'openai_compatible', baseUrl: `${base}/v1/`, model: 'llama3.1:8b' }, { provider: providerId });
    expect(res.status).toBe(201);
    expect(calls[0].headers).not.toHaveProperty('authorization');
    expect(stored(providerId)).toMatchObject({ connector: 'openai_compatible', base_url: `${base}/v1`, api_key_enc: null });
    expect(stored().connector).toBe('anthropic');
  });

  test('nothing configured: a test without a body is 404', async () => {
    approve(provider2Id, tmId);
    const res = await request(app).post(`${CONFIG}/test`).set('Authorization', tm()).set('X-Provider-Id', provider2Id).send({});
    expect(res.status).toBe(404);
  });

  test('removing is allowed even once the access is withdrawn, and removes the key', async () => {
    run(`UPDATE ai_access_request SET state = 'revoked' WHERE company_id = ? AND user_id = ?`, [providerId, tmId]);
    expect((await request(app).get(CONFIG).set('Authorization', tm()).set('X-Provider-Id', providerId)).status).toBe(403);
    const res = await request(app).delete(CONFIG).set('Authorization', tm()).set('X-Provider-Id', providerId);
    expect(res.status).toBe(204);
    expect(stored(providerId)).toBeUndefined();
    expect((await request(app).delete(CONFIG).set('Authorization', tm()).set('X-Provider-Id', providerId)).status).toBe(404);
  });
});

describe('#801 PR 2 the connector gives up', () => {
  test('a service that does not answer in time', async () => {
    const slow = http.createServer(() => {});
    await new Promise(resolve => slow.listen(0, '127.0.0.1', resolve));
    try {
      const t = await testConnection({ connector: 'anthropic', baseUrl: `http://127.0.0.1:${slow.address().port}`, model: 'm', apiKey: 'k' }, { timeoutMs: 200 });
      expect(t).toEqual({ ok: false, error: 'The AI service did not answer within 1 s.' });
    } finally {
      slow.closeAllConnections();
      await new Promise(resolve => slow.close(resolve));
    }
  });

  test('an answer too large, and a service that is not there', async () => {
    reply = () => ({ status: 200, text: 'x'.repeat(300 * 1024) });
    const big = await testConnection({ connector: 'anthropic', baseUrl: base, model: 'm', apiKey: KEY });
    expect(big.error).toContain('larger than 256 KB');
    const gone = await testConnection({ connector: 'anthropic', baseUrl: 'http://127.0.0.1:1', model: 'm', apiKey: KEY });
    expect(gone.ok).toBe(false);
    expect(gone.error).toContain('could not be reached');
  });
});

describe('#831 the list of models, prices and suggestions', () => {
  const models = (body, provider = '') => request(app).post(`${CONFIG}/models`).set('Authorization', tm()).set('X-Provider-Id', provider).send(body);

  test('the page gets OSCAR\'s list of models with prices, the suggested limit and instruction', async () => {
    const res = await request(app).get(CONFIG).set('Authorization', tm());
    expect(res.body.models[0]).toMatchObject({ id: 'claude-opus-5-5', input: 4, output: 20 });
    expect(res.body.suggested.monthlyTokenCap).toBe(2000000);
    expect(res.body.suggested.instruction).toContain('OSDM member');
    expect(res.body.limits.maxPrice).toBe(1000);
  });

  test('the stored service lists its models with the stored key; unknown ones have no price, bad ids are left out', async () => {
    const res = await models({});
    expect(res.status).toBe(200);
    expect(res.body.models).toEqual([
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', input: 4, output: 20, note: expect.any(String), above: null },
      { id: 'claude-new-9', label: 'Claude New <9>', input: null, output: null, note: null, above: null }]);
    expect(calls[0]).toMatchObject({ method: 'GET', url: '/v1/models?limit=100' });
    expect(calls[0].headers['x-api-key']).toBe(KEY);
    expect(calls[0].headers['anthropic-version']).toBe('2023-06-01');
  });

  test('a typed service: the stored key never goes to another host; a typed key does; a refusal is a 502', async () => {
    expect((await models({ connector: 'anthropic', baseUrl: other })).body.detail).toContain('Type the key again');
    expect(calls).toHaveLength(0);
    expect((await models({ connector: 'anthropic', baseUrl: other, apiKey: KEY })).status).toBe(200);
    const refused = await models({ connector: 'anthropic', baseUrl: base, apiKey: 'sk-wrong-1' });
    expect(refused.status).toBe(502);
    expect(refused.body.detail).toContain('HTTP 401');
    expect((await models({ connector: 'openai_compatible', baseUrl: base })).status).toBe(400);
    expect((await models({}, provider2Id)).status).toBe(404);
  });

  test('a price for a model OSCAR does not know is saved, both or neither', async () => {
    const same = { apiKey: '', model: stored().model };   // nothing to test again
    expect((await put(anthropic({ ...same, priceInput: 3 }))).body.detail).toContain('both prices');
    const res = await put(anthropic({ ...same, priceInput: '3', priceOutput: 15.5 }));
    expect(res.status).toBe(200);
    expect(res.body.config).toMatchObject({ priceInput: 3, priceOutput: 15.5 });
    expect(stored()).toMatchObject({ price_input: 3, price_output: 15.5 });
    expect(calls).toHaveLength(0);
  });
});
