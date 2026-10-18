// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #848: one AI service for all (the default) or one per provider, and the
 * overview of what each company or provider uses and has cost. Every call
 * goes to a local stub AI service, never a real one.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-ai-setup';

const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { randomUUID: uuidv4 } = require('node:crypto');
const request = require('supertest');
const { run, get, all } = require('../../src/db/db');
const A = require('../../src/utils/aiAccess');

const app = express();
app.use(express.json());
app.use('/v1/company', require('../../src/api/routes/company-ai-analysis'));
app.use('/v1/company', require('../../src/api/routes/company-ai-analysis-results'));

const companyId = uuidv4();
const providerId = uuidv4();
const provider2Id = uuidv4();
const otherId = uuidv4();
const tmId = uuidv4();
const tm2Id = uuidv4();
const testerId = uuidv4();
const KEY = 'sk-ant-setup-0123456789';
const AI = '/v1/company/ai-analysis';

const calls = [];
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ url: req.url, key: req.headers['x-api-key'] });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: body?.model, stop_reason: 'end_turn', content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 21, output_tokens: 1 } }));
  });
});
let base;

function token(role, uid, cid = companyId) {
  return `Bearer ${jwt.sign({ sub: uid, email: `${role}-${uid.slice(0, 4)}@ai-setup.com`, companyId: cid, role },
    process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;
}
const as = (method, path, { uid = tmId, provider = '', role = 'test_manager' } = {}) =>
  request(app)[method](AI + path).set('Authorization', token(role, uid)).set('X-Provider-Id', provider);
const anthropic = (over = {}) => ({ connector: 'anthropic', baseUrl: base, model: 'claude-opus-5-5', apiKey: KEY, ...over });
const approve = (cid, uid) => run(
  `INSERT INTO ai_access_request (id, company_id, user_id, state, text_version, text_hash) VALUES (?, ?, ?, 'approved', ?, 'h')
   ON CONFLICT (company_id, user_id) DO UPDATE SET state = 'approved'`, [uuidv4(), cid, uid, A.COMMITMENT.version]);
const stored = (cid, uid = tmId) => get('SELECT * FROM ai_config WHERE company_id = ? AND user_id = ?', [cid, uid]);
const analysis = (cid, uid, fields) => run(
  `INSERT INTO ai_analysis (id, company_id, user_id, mode, batch_a, language, connector, model, input_hash, input_chars, status, input_tokens, output_tokens, cost_usd)
   VALUES (?, ?, ?, 'one', 'b', 'English', 'anthropic', ?, 'h', 10, 'done', ?, ?, ?)`,
  [uuidv4(), cid, uid, fields.model || 'claude-opus-5-5', fields.input ?? null, fields.output ?? null, fields.cost ?? null]);

beforeAll(async () => {
  await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${stub.address().port}`;
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Setup Co', 'ai-setup-co')`, [companyId]);
  run(`INSERT INTO companies (id, name, slug, parent_id) VALUES (?, 'Alpha', 'ai-setup-alpha', ?)`, [providerId, companyId]);
  run(`INSERT INTO companies (id, name, slug, parent_id) VALUES (?, 'Beta', 'ai-setup-beta', ?)`, [provider2Id, companyId]);
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Other Co', 'ai-setup-other')`, [otherId]);
  for (const [id, role] of [[tmId, 'test_manager'], [tm2Id, 'test_manager'], [testerId, 'company_user']]) {
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', ?)`, [id, companyId, `${id}@ai-setup.com`, role]);
  }
  approve(companyId, tmId);
  approve(providerId, tmId);
});
afterAll(() => new Promise(resolve => stub.close(resolve)));
beforeEach(() => { calls.length = 0; });

describe('#848 one service for all, by default', () => {
  test('no choice made reads as shared, with no service yet', async () => {
    const res = await as('get', '/setup');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ company: { id: companyId, name: 'Setup Co' }, mode: 'shared', modes: ['shared', 'per_provider'], services: [] });
    expect(get('SELECT * FROM ai_setup WHERE company_id = ? AND user_id = ?', [companyId, tmId])).toBeUndefined();
  });

  test('saved from a provider, the service is the company\'s, and every approved provider uses it', async () => {
    const res = await as('put', '/config', { provider: providerId }).send(anthropic());
    expect(res.status).toBe(201);
    expect(stored(companyId)).toMatchObject({ connector: 'anthropic', model: 'claude-opus-5-5' });
    expect(stored(providerId)).toBeUndefined();

    const fromProvider = await as('get', '/config', { provider: providerId });
    expect(fromProvider.body).toMatchObject({ mode: 'shared', serviceOf: { id: companyId, name: 'Setup Co' }, config: { model: 'claude-opus-5-5', hasKey: true } });
    const fromCompany = await as('get', '/config');
    expect(fromCompany.body.serviceOf).toEqual({ id: companyId, name: 'Setup Co' });

    const test = await as('post', '/config/test', { provider: providerId }).send({});
    expect(test.body.test.ok).toBe(true);
    // One call for the test before the save, one for this test: both to the shared service, with its key.
    expect(calls).toEqual([{ url: '/v1/messages', key: KEY }, { url: '/v1/messages', key: KEY }]);
  });

  test('access stays per company or provider: an unapproved provider is refused, shared service or not', async () => {
    const res = await as('get', '/config', { provider: provider2Id });
    expect(res.status).toBe(403);
    expect(res.body.detail).toContain('Beta');
    expect((await as('post', '/preview', { provider: provider2Id }).send({ batches: ['x'] })).status).toBe(403);
  });

  test('one monthly limit for the shared service, counted over the company and its providers', async () => {
    analysis(companyId, tmId, { input: 1000, output: 200 });
    analysis(providerId, tmId, { input: 500, output: 100 });
    analysis(providerId, tm2Id, { input: 9000, output: 900 });   // another Test Manager's: not counted against mine
    const spend = await as('get', '/spend', { provider: providerId });
    expect(spend.status).toBe(200);
    expect(spend.body.mine.used).toBe(1800);
  });
});

describe('#848 switching to one service per provider, and back', () => {
  test('per provider: the provider has no service, and the company\'s is kept and still used for the company', async () => {
    const res = await as('put', '/setup').send({ mode: 'per_provider' });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('per_provider');
    expect(res.body.services).toEqual([{ company: { id: companyId, name: 'Setup Co', provider: false }, connector: 'anthropic', model: 'claude-opus-5-5', inUse: true }]);
    expect(all("SELECT event_type FROM auth_events WHERE company_id = ? AND event_type = 'ai_setup_mode:per_provider'", [companyId])).toHaveLength(1);
    await as('put', '/setup').send({ mode: 'per_provider' });   // the same choice again: not logged twice
    expect(all("SELECT event_type FROM auth_events WHERE company_id = ? AND event_type = 'ai_setup_mode:per_provider'", [companyId])).toHaveLength(1);

    const fromProvider = await as('get', '/config', { provider: providerId });
    expect(fromProvider.body).toMatchObject({ mode: 'per_provider', serviceOf: { id: providerId }, config: null });
    expect((await as('post', '/config/test', { provider: providerId }).send({})).status).toBe(404);
    expect((await as('get', '/config')).body.config.model).toBe('claude-opus-5-5');
  });

  test('per provider, a provider\'s service is its own; the monthly use is the provider\'s only', async () => {
    const res = await as('put', '/config', { provider: providerId }).send(anthropic({ model: 'claude-sonnet-5-5' }));
    expect(res.status).toBe(201);
    expect(stored(providerId).model).toBe('claude-sonnet-5-5');
    expect(stored(companyId).model).toBe('claude-opus-5-5');
    expect((await as('get', '/spend', { provider: providerId })).body.mine.used).toBe(600);
  });

  test('back to shared: nothing is deleted; the provider\'s own service is kept, unused', async () => {
    const res = await as('put', '/setup').send({ mode: 'shared' });
    expect(res.body.mode).toBe('shared');
    expect(res.body.services.map(s => [s.company.name, s.model, s.inUse])).toEqual([
      ['Setup Co', 'claude-opus-5-5', true], ['Alpha', 'claude-sonnet-5-5', false]]);
    expect((await as('get', '/config', { provider: providerId })).body.config.model).toBe('claude-opus-5-5');
    expect(stored(providerId)).toBeTruthy();
  });

  test('removing from a provider in shared mode removes the shared service', async () => {
    const other = uuidv4();
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'test_manager')`, [other, companyId, `${other}@ai-setup.com`]);
    approve(providerId, other);
    expect((await as('put', '/config', { uid: other, provider: providerId }).send(anthropic())).status).toBe(201);
    expect(stored(companyId, other)).toBeTruthy();
    expect((await as('delete', '/config', { uid: other, provider: providerId })).status).toBe(204);
    expect(stored(companyId, other)).toBeUndefined();
  });

  test('a mode that is not one of the two is refused, and only Test Managers choose', async () => {
    expect((await as('put', '/setup').send({ mode: 'both' })).status).toBe(400);
    expect((await as('put', '/setup').send({})).status).toBe(400);
    expect((await as('put', '/setup', { uid: testerId, role: 'company_user' }).send({ mode: 'shared' })).status).toBe(403);
    expect((await as('get', '/overview', { uid: testerId, role: 'company_user' })).status).toBe(403);
  });

  test('each Test Manager has their own choice', async () => {
    expect((await as('get', '/setup', { uid: tm2Id })).body.mode).toBe('shared');
    expect((await as('get', '/setup')).body.mode).toBe('shared');
  });
});

describe('#848 the overview', () => {
  test('per company or provider: access, service used, analyses and cost; then the totals', async () => {
    analysis(provider2Id, tm2Id, { input: 1_000_000, output: 0, model: 'claude-opus-5-5' });   // no stored cost: priced now
    analysis(providerId, tmId, { input: 10, output: 10, model: 'unknown-model' });              // no price at all
    const res = await as('get', '/overview');
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('shared');
    const byName = Object.fromEntries(res.body.targets.map(t => [t.name, t]));
    expect(Object.keys(byName)).toEqual(['Setup Co', 'Alpha', 'Beta']);
    expect(byName['Setup Co']).toMatchObject({ provider: false, access: 'approved', service: { connector: 'anthropic', model: 'claude-opus-5-5', of: { id: companyId, name: 'Setup Co' } }, analyses: 1, tokens: 1200 });
    expect(byName.Alpha).toMatchObject({ provider: true, access: 'approved', service: { model: 'claude-opus-5-5', of: { name: 'Setup Co' } }, analyses: 3, unpriced: 1 });
    expect(byName.Beta).toMatchObject({ access: 'none', analyses: 1, unpriced: 0 });
    expect(byName.Beta.cost).toBeGreaterThan(0);
    expect(res.body.totals.analyses).toBe(5);
    expect(res.body.totals.tokens).toBe(res.body.targets.reduce((n, t) => n + t.tokens, 0));
    expect(res.body.totals.cost).toBeCloseTo(res.body.targets.reduce((n, t) => n + t.cost, 0), 6);
    expect(JSON.stringify(res.body)).not.toContain(KEY);
  });

  test('per provider, each row names its own service, or none', async () => {
    await as('put', '/setup').send({ mode: 'per_provider' });
    const res = await as('get', '/overview');
    const byName = Object.fromEntries(res.body.targets.map(t => [t.name, t]));
    expect(byName.Alpha.service).toMatchObject({ model: 'claude-sonnet-5-5', of: { id: providerId, name: 'Alpha' } });
    expect(byName.Beta.service).toBeNull();
    await as('put', '/setup').send({ mode: 'shared' });
  });

  test('another company\'s analyses never appear', async () => {
    analysis(otherId, tmId, { input: 5, output: 5 });
    const res = await as('get', '/overview');
    expect(res.body.targets.map(t => t.id)).not.toContain(otherId);
    expect(all('SELECT id FROM ai_analysis WHERE company_id = ?', [otherId])).toHaveLength(1);
  });
});
