// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * provider-isolation.test.js — distributors and their providers (#540).
 *
 * Two distributors (D1, D2), two providers each, a Test Manager and two
 * testers each. Tester A1 is granted provider P1a; tester B1 nothing. The
 * matrix checks, through the real routes, that a request acts in a provider
 * only when canUseCompany() admits it, that everything else answers 404, and
 * that credentials and runs follow the provider the request names.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-provider-isolation';

const express = require('express');
const jwt     = require('jsonwebtoken');
const request = require('supertest');
const { randomUUID: uuidv4 } = require('node:crypto');
const { run, get } = require('../../src/db/db');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/v1/auth',            require('../../src/api/routes/auth'));
  app.use('/v1/me/credentials',  require('../../src/api/routes/me-credentials'));
  app.use('/v1/company/providers', require('../../src/api/routes/company-providers'));
  app.use('/v1/company',         require('../../src/api/routes/company'));
  app.use('/v1/company',         require('../../src/api/routes/company-findings'));
  app.use('/v1/runs',            require('../../src/api/routes/runs'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => res.status(500).json({ status: 500, detail: err.message }));
  return app;
}
const app = buildApp();

const tag = uuidv4().slice(0, 8);
const ids = {};
for (const k of ['D1', 'D2', 'P1a', 'P1b', 'P2a', 'P2b', 'TM1', 'A1', 'B1', 'TM2', 'A2', 'B2',
  'runP1a', 'runP1b', 'runP2a', 'runD1']) ids[k] = uuidv4();

const users = {
  TM1: { company: 'D1', role: 'test_manager' },
  A1:  { company: 'D1', role: 'company_user' },
  B1:  { company: 'D1', role: 'company_user' },
  TM2: { company: 'D2', role: 'test_manager' },
  A2:  { company: 'D2', role: 'company_user' },
  B2:  { company: 'D2', role: 'company_user' },
};

function token(who) {
  const u = users[who];
  return jwt.sign({ sub: ids[who], email: `${who.toLowerCase()}-${tag}@iso.example`, companyId: ids[u.company], role: u.role },
    process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
}
const as = who => ({ Authorization: `Bearer ${token(who)}` });

beforeAll(() => {
  for (const d of ['D1', 'D2']) {
    run(`INSERT INTO companies (id, name, slug, api_base) VALUES (?, ?, ?, ?)`,
      [ids[d], `${d} ${tag}`, `${d.toLowerCase()}-${tag}`, `https://${d.toLowerCase()}-${tag}.example/osdm`]);
  }
  for (const p of ['P1a', 'P1b', 'P2a', 'P2b']) {
    const parent = p.startsWith('P1') ? 'D1' : 'D2';
    run(`INSERT INTO companies (id, name, slug, api_base, parent_id) VALUES (?, ?, ?, ?, ?)`,
      [ids[p], `${p} ${tag}`, `${p.toLowerCase()}-${tag}`, `https://${p.toLowerCase()}-${tag}.example/osdm`, ids[parent]]);
  }
  for (const [who, u] of Object.entries(users)) {
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', ?)`,
      [ids[who], ids[u.company], `${who.toLowerCase()}-${tag}@iso.example`, u.role]);
  }
  run(`INSERT INTO provider_access (company_id, user_id) VALUES (?, ?)`, [ids.P1a, ids.A1]);
  run(`INSERT INTO provider_access (company_id, user_id) VALUES (?, ?)`, [ids.P2a, ids.A2]);
  for (const [r, company, user] of [['runP1a', 'P1a', 'A1'], ['runP1b', 'P1b', 'TM1'], ['runP2a', 'P2a', 'A2'], ['runD1', 'D1', 'A1']]) {
    run(`INSERT INTO runs (id, company_id, user_id, status) VALUES (?, ?, ?, 'COMPLETED')`, [ids[r], ids[company], ids[user]]);
  }
});

afterAll(() => {
  run(`DELETE FROM runs WHERE id IN (?, ?, ?, ?)`, [ids.runP1a, ids.runP1b, ids.runP2a, ids.runD1]);
  run(`DELETE FROM provider_access WHERE user_id IN (SELECT id FROM users WHERE email LIKE ?)`, [`%-${tag}@iso.example`]);
  run(`DELETE FROM tester_credentials WHERE user_id IN (SELECT id FROM users WHERE email LIKE ?)`, [`%-${tag}@iso.example`]);
  run(`DELETE FROM auth_events WHERE email LIKE ?`, [`%-${tag}@iso.example`]);
  run(`DELETE FROM users WHERE email LIKE ?`, [`%-${tag}@iso.example`]);
  run(`DELETE FROM companies WHERE parent_id IN (?, ?)`, [ids.D1, ids.D2]);
  run(`DELETE FROM companies WHERE id IN (?, ?)`, [ids.D1, ids.D2]);
});

// ── Which company a request acts in ──────────────────────────────────────────
describe('enforceTenant — the provider a request names', () => {
  // [who, provider, expected status]
  const matrix = [
    ['TM1', 'P1a', 200], ['TM1', 'P1b', 200], ['TM1', 'P2a', 404], ['TM1', 'D2', 404],
    ['A1', 'P1a', 200],  ['A1', 'P1b', 404],  ['A1', 'P2a', 404],  ['A1', 'D2', 404],
    ['B1', 'P1a', 404],  ['B1', 'P1b', 404],
    ['TM2', 'P1a', 404], ['TM2', 'P2b', 200],
    ['A2', 'P1a', 404],  ['A2', 'P2a', 200],
    ['B2', 'P2a', 404],
  ];
  test.each(matrix)('%s naming %s answers %i', async (who, provider, status) => {
    const res = await request(app).get('/v1/company').set(as(who)).set('X-Provider-Id', ids[provider]);
    expect(res.status).toBe(status);
    if (status === 200) expect(res.body.id).toBe(ids[provider]);
    else expect(res.body.detail).toBe('Provider not found.');
  });

  test('?provider_id= works like the header', async () => {
    const ok = await request(app).get(`/v1/company?provider_id=${ids.P1a}`).set(as('A1'));
    expect(ok.status).toBe(200);
    expect(ok.body.id).toBe(ids.P1a);
    const no = await request(app).get(`/v1/company?provider_id=${ids.P1b}`).set(as('A1'));
    expect(no.status).toBe(404);
  });

  test('a header and a query that disagree, or a repeated query, answer 404', async () => {
    const res = await request(app).get(`/v1/company?provider_id=${ids.P1b}`).set(as('TM1')).set('X-Provider-Id', ids.P1a);
    expect(res.status).toBe(404);
    const rep = await request(app).get(`/v1/company?provider_id=${ids.P1a}&provider_id=${ids.P1a}`).set(as('TM1'));
    expect(rep.status).toBe(404);
  });

  test('an unknown id and the own company named explicitly', async () => {
    expect((await request(app).get('/v1/company').set(as('TM1')).set('X-Provider-Id', uuidv4())).status).toBe(404);
    const own = await request(app).get('/v1/company').set(as('A1')).set('X-Provider-Id', ids.D1);
    expect(own.status).toBe(200);
    expect(own.body.id).toBe(ids.D1);
  });

  test('without a provider, a member acts in the own company', async () => {
    const res = await request(app).get('/v1/company').set(as('A1'));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(ids.D1);
  });

  test('a provider named in the body is not a scope', async () => {
    const res = await request(app).patch('/v1/company').set(as('TM1'))
      .send({ provider_id: ids.P1a, company_id: ids.P1a, api_base: `https://body-${tag}.example/osdm` });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(ids.D1);
    expect(get('SELECT api_base FROM companies WHERE id = ?', [ids.P1a]).api_base).toBe(`https://p1a-${tag}.example/osdm`);
  });

  test('scoped routes beyond /v1/company follow the same rule (findings)', async () => {
    expect((await request(app).get('/v1/company/findings').set(as('A1')).set('X-Provider-Id', ids.P1a)).status).toBe(200);
    expect((await request(app).get('/v1/company/findings').set(as('B1')).set('X-Provider-Id', ids.P1a)).status).toBe(404);
  });
});

// ── A provider's endpoint ─────────────────────────────────────────────────────
describe('a provider\'s endpoint — companyEndpointChange() applies', () => {
  test('a granted tester cannot change it; the Test Manager can', async () => {
    const t = await request(app).patch('/v1/company').set(as('A1')).set('X-Provider-Id', ids.P1a)
      .send({ api_base: `https://elsewhere-${tag}.example/osdm` });
    expect(t.status).toBe(403);
    const m = await request(app).patch('/v1/company').set(as('TM1')).set('X-Provider-Id', ids.P1a)
      .send({ api_base: `https://p1a-${tag}.example/osdm/v2` });
    expect(m.status).toBe(200);
    expect(m.body.id).toBe(ids.P1a);
    expect(m.body.parent_id).toBe(ids.D1);
  });

  test('an endpoint another company of the family uses needs confirming, and the confirmation is audited', async () => {
    const clash = await request(app).patch('/v1/company').set(as('TM1')).set('X-Provider-Id', ids.P1b)
      .send({ api_base: `https://p1a-${tag}.example/osdm/v2/` });
    expect(clash.status).toBe(409);
    const ok = await request(app).patch('/v1/company').set(as('TM1')).set('X-Provider-Id', ids.P1b)
      .send({ api_base: `https://p1a-${tag}.example/osdm/v2`, allow_duplicate_endpoint: true });
    expect(ok.status).toBe(200);
    expect(get(`SELECT 1 AS x FROM auth_events WHERE company_id = ? AND event_type = 'company_update:api_base:duplicate_endpoint_confirmed'`, [ids.P1b])).toBeTruthy();
    // Another distributor's endpoint is not a clash.
    const other = await request(app).patch('/v1/company').set(as('TM2')).set('X-Provider-Id', ids.P2b)
      .send({ api_base: `https://p1a-${tag}.example/osdm/v2` });
    expect(other.status).toBe(200);
  });
});

// ── Credentials follow the provider ──────────────────────────────────────────
describe('credentials per (tester, provider)', () => {
  test('a token saved for a provider is that provider\'s only', async () => {
    const save = await request(app).patch('/v1/me/credentials').set(as('A1')).set('X-Provider-Id', ids.P1a)
      .send({ access_token: 'p1a-token' });
    expect(save.status).toBe(200);
    expect(save.body.has_token).toBe(true);
    const own = await request(app).get('/v1/me/credentials').set(as('A1'));
    expect(own.body.has_token).toBe(false);
    const p1a = await request(app).get('/v1/me/credentials').set(as('A1')).set('X-Provider-Id', ids.P1a);
    expect(p1a.body.has_token).toBe(true);
    expect(get('SELECT company_id FROM tester_credentials WHERE user_id = ? AND access_token_enc IS NOT NULL', [ids.A1]).company_id).toBe(ids.P1a);
  });

  test('credentials cannot be read or written for a provider the tester may not use', async () => {
    expect((await request(app).get('/v1/me/credentials').set(as('B1')).set('X-Provider-Id', ids.P1a)).status).toBe(404);
    expect((await request(app).patch('/v1/me/credentials').set(as('B1')).set('X-Provider-Id', ids.P1a).send({ access_token: 'x' })).status).toBe(404);
    expect(get('SELECT 1 AS x FROM tester_credentials WHERE user_id = ? AND company_id = ?', [ids.B1, ids.P1a])).toBeUndefined();
  });
});

// ── Runs follow canUserSeeRun → canUseCompany ───────────────────────────────
describe('run visibility across providers', () => {
  const see = [
    ['A1', 'runP1a', 200], ['A1', 'runP1b', 404], ['A1', 'runP2a', 404],
    ['B1', 'runP1a', 404], ['B1', 'runD1', 200],
    ['TM1', 'runP1a', 200], ['TM1', 'runP1b', 200], ['TM1', 'runP2a', 404],
    ['TM2', 'runP1a', 404], ['A2', 'runP1a', 404], ['A2', 'runP2a', 200],
  ];
  test.each(see)('%s reading %s answers %i', async (who, r, status) => {
    const res = await request(app).get(`/v1/runs/${ids[r]}`).set(as(who));
    expect(res.status).toBe(status);
  });

  test('sharing a provider run: its distributor\'s Test Manager yes, another distributor\'s no', async () => {
    expect((await request(app).post(`/v1/runs/${ids.runP2a}/share`).set(as('TM1'))).status).toBe(404);
    expect((await request(app).post(`/v1/runs/${ids.runP1a}/share`).set(as('TM1'))).status).toBe(200);
    expect((await request(app).delete(`/v1/runs/${ids.runP1a}/share`).set(as('TM2'))).status).toBe(404);
    expect((await request(app).delete(`/v1/runs/${ids.runP1a}/share`).set(as('TM1'))).status).toBe(200);
  });

  test('the run list follows the named provider', async () => {
    const res = await request(app).get('/v1/runs').set(as('TM1')).set('X-Provider-Id', ids.P1b);
    expect(res.status).toBe(200);
    expect(res.body.runs.map(r => r.id)).toEqual([ids.runP1b]);
  });
});

// ── Provider management ──────────────────────────────────────────────────────
describe('/v1/company/providers', () => {
  test('a tester lists only the providers granted; cannot create', async () => {
    const list = await request(app).get('/v1/company/providers').set(as('A1'));
    expect(list.status).toBe(200);
    expect(list.body.providers.map(p => p.id)).toEqual([ids.P1a]);
    expect((await request(app).post('/v1/company/providers').set(as('A1')).send({ name: 'x' })).status).toBe(403);
  });

  test('a Test Manager lists every provider of the own company only', async () => {
    const list = await request(app).get('/v1/company/providers').set(as('TM1'));
    expect(list.body.providers.map(p => p.id).sort()).toEqual([ids.P1a, ids.P1b].sort());
  });

  test('create: name required, endpoint checked, duplicate needs confirming', async () => {
    expect((await request(app).post('/v1/company/providers').set(as('TM1')).send({})).status).toBe(400);
    expect((await request(app).post('/v1/company/providers').set(as('TM1')).send({ name: `P1a ${tag}` })).status).toBe(409);
    expect((await request(app).post('/v1/company/providers').set(as('TM1')).send({ name: 'Bad', api_base: 42 })).status).toBe(400);
    const d1Endpoint = get('SELECT api_base FROM companies WHERE id = ?', [ids.D1]).api_base;   // the distributor's own
    expect((await request(app).post('/v1/company/providers').set(as('TM1'))
      .send({ name: 'Dup', api_base: d1Endpoint })).status).toBe(409);
    const ok = await request(app).post('/v1/company/providers').set(as('TM1'))
      .send({ name: 'Dup', api_base: d1Endpoint, allow_duplicate_endpoint: true });
    expect(ok.status).toBe(201);
    expect(ok.body.provider.parent_id).toBe(ids.D1);
    expect(ok.body.provider.slug).toBe(`d1-${tag}--dup`);
    const fresh = await request(app).post('/v1/company/providers').set(as('TM1')).send({ name: 'Fresh' });
    expect(fresh.status).toBe(201);
    expect(fresh.body.provider.api_base).toBeNull();
  });

  test('another distributor\'s provider is 404 to every provider route', async () => {
    expect((await request(app).patch(`/v1/company/providers/${ids.P1a}`).set(as('TM2')).send({ name: 'mine' })).status).toBe(404);
    expect((await request(app).get(`/v1/company/providers/${ids.P1a}/access`).set(as('TM2'))).status).toBe(404);
    expect((await request(app).put(`/v1/company/providers/${ids.P1a}/access/${ids.A2}`).set(as('TM2'))).status).toBe(404);
    expect((await request(app).delete(`/v1/company/providers/${ids.P1a}/access/${ids.A1}`).set(as('TM2'))).status).toBe(404);
  });

  test('only a tester of the distributor can be granted', async () => {
    expect((await request(app).put(`/v1/company/providers/${ids.P1a}/access/${ids.A2}`).set(as('TM1'))).status).toBe(404);
    expect((await request(app).put(`/v1/company/providers/${ids.P1a}/access/${ids.TM1}`).set(as('TM1'))).status).toBe(404);
    expect(get('SELECT 1 AS x FROM provider_access WHERE company_id = ? AND user_id = ?', [ids.P1a, ids.A2])).toBeUndefined();
  });

  test('grant and withdraw take effect on the next request', async () => {
    expect((await request(app).get('/v1/company').set(as('B1')).set('X-Provider-Id', ids.P1b)).status).toBe(404);
    expect((await request(app).put(`/v1/company/providers/${ids.P1b}/access/${ids.B1}`).set(as('TM1'))).status).toBe(200);
    expect((await request(app).get('/v1/company').set(as('B1')).set('X-Provider-Id', ids.P1b)).status).toBe(200);
    const access = await request(app).get(`/v1/company/providers/${ids.P1b}/access`).set(as('TM1'));
    expect(access.body.testers.map(t => t.id)).toEqual([ids.B1]);
    expect((await request(app).delete(`/v1/company/providers/${ids.P1b}/access/${ids.B1}`).set(as('TM1'))).status).toBe(200);
    expect((await request(app).get('/v1/company').set(as('B1')).set('X-Provider-Id', ids.P1b)).status).toBe(404);
  });

  test('withdrawing access hides the tester\'s own runs on that provider', async () => {
    run('DELETE FROM provider_access WHERE company_id = ? AND user_id = ?', [ids.P1a, ids.A1]);
    try {
      expect((await request(app).get(`/v1/runs/${ids.runP1a}`).set(as('A1'))).status).toBe(404);
    } finally {
      run(`INSERT INTO provider_access (company_id, user_id) VALUES (?, ?)`, [ids.P1a, ids.A1]);
    }
  });

  test('the registration list shows top-level companies only', async () => {
    const res = await request(app).get('/v1/auth/register/companies');
    const slugs = res.body.companies.map(c => c.slug);
    expect(slugs).toContain(`d1-${tag}`);
    expect(slugs).not.toContain(`p1a-${tag}`);
  });

  test('names: one line of plain text, unique ignoring case beyond ASCII', async () => {
    for (const name of ['x\ny', '<b>x</b>', 'tab\there']) {
      expect((await request(app).post('/v1/company/providers').set(as('TM2')).send({ name })).status).toBe(400);
    }
    expect((await request(app).post('/v1/company/providers').set(as('TM2')).send({ name: 'Ärger' })).status).toBe(201);
    expect((await request(app).post('/v1/company/providers').set(as('TM2')).send({ name: 'ärger' })).status).toBe(409);
  });

  test('a grant can be withdrawn whoever the user has become', async () => {
    run('INSERT INTO provider_access (company_id, user_id) VALUES (?, ?)', [ids.P1b, ids.A2]);   // e.g. left after a data repair
    expect((await request(app).delete(`/v1/company/providers/${ids.P1b}/access/${ids.A2}`).set(as('TM1'))).status).toBe(200);
    expect((await request(app).delete(`/v1/company/providers/${ids.P1b}/access/${ids.A2}`).set(as('TM1'))).status).toBe(404);
  });
});

describe('administrators keep one set of credentials', () => {
  test('a company named by an administrator does not split the set', async () => {
    const adm = uuidv4();
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'administrator')`,
      [adm, ids.D1, `adm-${tag}@iso.example`]);
    const tok = jwt.sign({ sub: adm, email: `adm-${tag}@iso.example`, companyId: ids.D1, role: 'administrator' },
      process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
    const auth = { Authorization: `Bearer ${tok}` };
    expect((await request(app).patch(`/v1/me/credentials?company_id=${ids.D2}`).set(auth).send({ access_token: 't' })).status).toBe(200);
    const got = await request(app).get(`/v1/me/credentials?company_id=${uuidv4()}`).set(auth);
    expect(got.status).toBe(200);
    expect(got.body.has_token).toBe(true);
    expect(get('SELECT COUNT(*) AS n FROM tester_credentials WHERE user_id = ?', [adm]).n).toBe(1);
  });
});
