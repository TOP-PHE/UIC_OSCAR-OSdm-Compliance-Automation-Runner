// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #801, PR 1: access to the AI analysis. A Test Manager asks, accepting the
 * text, for the company and the providers they choose; the administrator
 * decides each one on its own.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-ai-analysis-access';

const express = require('express');
const jwt     = require('jsonwebtoken');
const { randomUUID: uuidv4 } = require('node:crypto');
const request = require('supertest');
const { run, get } = require('../../src/db/db');
const A = require('../../src/utils/aiAccess');

const app = express();
app.use(express.json());
app.use('/v1/company', require('../../src/api/routes/company-ai-analysis'));
app.use('/v1/admin', require('../../src/api/routes/admin'));

const companyId = uuidv4();
const providerId = uuidv4();
const provider2Id = uuidv4();
const otherCompanyId = uuidv4();
const foreignProviderId = uuidv4();
const tmId = uuidv4();
const tm2Id = uuidv4();
const testerId = uuidv4();
const adminId = uuidv4();
const ACCESS = '/v1/company/ai-analysis/access';
const REQUESTS = '/v1/admin/ai-access-requests';

function token(role, uid, cid = companyId) {
  return `Bearer ${jwt.sign({ sub: uid, email: `${role}-${uid.slice(0, 4)}@ai-test.com`, companyId: cid, role },
    process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;
}
const tm = (uid = tmId) => token('test_manager', uid);
const admin = () => token('administrator', adminId, otherCompanyId);
const accepted = (companies = [companyId]) => ({ version: A.COMMITMENT.version, hash: A.commitmentHash(), companies });
const ask = (companies, uid = tmId) => request(app).post(`${ACCESS}/request`).set('Authorization', tm(uid)).send(accepted(companies));
const requestIdOf = (uid, cid = companyId) => get('SELECT id FROM ai_access_request WHERE company_id = ? AND user_id = ?', [cid, uid]).id;
const stateOf = (body, id) => body.targets.find(t => t.id === id);

beforeAll(() => {
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'AI Test', 'ai-test')`, [companyId]);
  run(`INSERT INTO companies (id, name, slug, parent_id) VALUES (?, 'AI Provider', 'ai-provider', ?)`, [providerId, companyId]);
  run(`INSERT INTO companies (id, name, slug, parent_id) VALUES (?, 'AI Second', 'ai-second', ?)`, [provider2Id, companyId]);
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'AI Platform', 'ai-platform')`, [otherCompanyId]);
  run(`INSERT INTO companies (id, name, slug, parent_id) VALUES (?, 'AI Foreign', 'ai-foreign', ?)`, [foreignProviderId, otherCompanyId]);
  for (const [id, cid, role] of [[tmId, companyId, 'test_manager'], [tm2Id, companyId, 'test_manager'],
    [testerId, companyId, 'company_user'], [adminId, otherCompanyId, 'administrator']]) {
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', ?)`, [id, cid, `${id}@ai-test.com`, role]);
  }
});

describe('#801 who may use the AI analysis page', () => {
  test('a tester and a certifier are refused', async () => {
    for (const t of [token('company_user', testerId), token('certification_user', uuidv4())]) {
      expect((await request(app).get(ACCESS).set('Authorization', t)).status).toBe(403);
      expect((await request(app).post(`${ACCESS}/request`).set('Authorization', t).send(accepted())).status).toBe(403);
    }
  });

  test('a Test Manager and a tester cannot reach the administrator\'s side', async () => {
    for (const t of [tm(), token('company_user', testerId)]) {
      expect((await request(app).get(REQUESTS).set('Authorization', t)).status).toBe(403);
    }
  });
});

describe('#801 asked and decided per company or provider', () => {
  test('the page lists the company and each provider, nothing asked yet, and the text', async () => {
    const res = await request(app).get(ACCESS).set('Authorization', tm());
    expect(res.status).toBe(200);
    expect(res.body.company).toMatchObject({ id: companyId, name: 'AI Test' });
    expect(res.body.targets.map(t => [t.name, t.provider, t.state])).toEqual([
      ['AI Test', false, 'none'], ['AI Provider', true, 'none'], ['AI Second', true, 'none']]);
    expect(res.body.commitment).toMatchObject({ version: A.COMMITMENT.version, hash: A.commitmentHash() });
  });

  test('working on a provider, the list is the same: the distributor and its providers', async () => {
    const res = await request(app).get(ACCESS).set('Authorization', tm()).set('X-Provider-Id', providerId);
    expect(res.status).toBe(200);
    expect(res.body.company.id).toBe(companyId);
    expect(res.body.targets.map(t => t.id)).toEqual([companyId, providerId, provider2Id]);
  });

  test('there is no switch to turn on first: the administrator\'s company update has no AI field', async () => {
    const res = await request(app).patch(`/v1/admin/companies/${companyId}`).set('Authorization', admin()).send({ ai_analysis_enabled: true });
    expect(res.status).toBe(400);
    expect(res.body.detail).toBe('No update fields provided.');
  });

  test('a request names the text in force and at least one target the Test Manager may use', async () => {
    const wrongText = [{}, { version: A.COMMITMENT.version, hash: 'x', companies: [companyId] }, { version: 0, hash: A.commitmentHash(), companies: [companyId] }];
    for (const body of wrongText) {
      expect((await request(app).post(`${ACCESS}/request`).set('Authorization', tm()).send(body)).status).toBe(400);
    }
    const text = { version: A.COMMITMENT.version, hash: A.commitmentHash() };
    for (const companies of [undefined, [], 'x', [42], Array(101).fill(companyId)]) {
      expect((await request(app).post(`${ACCESS}/request`).set('Authorization', tm()).send({ ...text, companies })).status).toBe(400);
    }
    for (const companies of [[uuidv4()], [otherCompanyId], [companyId, foreignProviderId]]) {
      expect((await ask(companies)).status).toBe(404);
    }
    expect(get('SELECT COUNT(*) AS n FROM ai_access_request').n).toBe(0);
  });

  test('a Test Manager asks for the company and one provider: two requests, each waiting and audited', async () => {
    const res = await ask([companyId, providerId, providerId]);
    expect(res.status).toBe(201);
    expect(res.body.targets.map(t => [t.id, t.state])).toEqual([[companyId, 'pending'], [providerId, 'pending']]);
    for (const cid of [companyId, providerId]) {
      expect(get('SELECT * FROM ai_access_request WHERE company_id = ? AND user_id = ?', [cid, tmId]))
        .toMatchObject({ state: 'pending', text_version: A.COMMITMENT.version, text_hash: A.commitmentHash() });
      expect(get('SELECT COUNT(*) AS n FROM auth_events WHERE company_id = ? AND event_type = ?', [cid, `ai_access_requested:v${A.COMMITMENT.version}`]).n).toBe(1);
    }
    const seen = (await request(app).get(ACCESS).set('Authorization', tm())).body;
    expect(stateOf(seen, provider2Id).state).toBe('none');
  });

  test('asking again for one already waiting is refused, and nothing else is saved', async () => {
    const res = await ask([provider2Id, providerId]);
    expect(res.status).toBe(409);
    expect(res.body.detail).toContain('AI Provider');
    expect(get('SELECT COUNT(*) AS n FROM ai_access_request WHERE company_id = ?', [provider2Id]).n).toBe(0);
  });

  test('the administrator sees each, a provider with its distributor, and decides them one by one', async () => {
    const list = await request(app).get(REQUESTS).set('Authorization', admin());
    expect(list.status).toBe(200);
    const own = list.body.requests.find(r => r.id === requestIdOf(tmId));
    const prov = list.body.requests.find(r => r.id === requestIdOf(tmId, providerId));
    expect(own).toMatchObject({ state: 'pending', company: { name: 'AI Test', providerOf: null }, user: { role: 'test_manager' } });
    expect(prov).toMatchObject({ state: 'pending', company: { name: 'AI Provider', providerOf: 'AI Test' } });
    expect((await request(app).post(`${REQUESTS}/${own.id}/nonsense`).set('Authorization', admin())).status).toBe(404);
    expect((await request(app).post(`${REQUESTS}/${uuidv4()}/approve`).set('Authorization', admin())).status).toBe(404);
    expect((await request(app).post(`${REQUESTS}/${own.id}/revoke`).set('Authorization', admin()).send({ reason: 'x' })).status).toBe(409);
    expect((await request(app).post(`${REQUESTS}/${own.id}/approve`).set('Authorization', admin())).body).toEqual({ id: own.id, state: 'approved' });
    expect((await request(app).post(`${REQUESTS}/${prov.id}/refuse`).set('Authorization', admin()).send({ reason: '  ' })).status).toBe(400);
    expect((await request(app).post(`${REQUESTS}/${prov.id}/refuse`).set('Authorization', admin()).send({ reason: 'No contract yet' })).status).toBe(200);
  });

  test('a refused provider leaves the company open; the Test Manager reads why and may ask again for it alone', async () => {
    const seen = (await request(app).get(ACCESS).set('Authorization', tm())).body;
    expect(stateOf(seen, companyId).state).toBe('approved');
    expect(stateOf(seen, providerId)).toMatchObject({ state: 'none', request: { state: 'refused', reason: 'No contract yet' } });
    expect((await ask([companyId])).status).toBe(409);
    const again = await ask([providerId]);
    expect(again.status).toBe(201);
    expect(again.body.targets[0].request).toMatchObject({ state: 'pending', reason: null });
  });

  test('another Test Manager\'s requests are their own', async () => {
    const seen = (await request(app).get(ACCESS).set('Authorization', tm(tm2Id))).body;
    expect(seen.targets.every(t => t.state === 'none')).toBe(true);
  });

  test('a new text asks for acceptance again, without a new approval, alongside a new request', async () => {
    run('UPDATE ai_access_request SET text_version = 0 WHERE id = ?', [requestIdOf(tmId)]);
    expect(stateOf((await request(app).get(ACCESS).set('Authorization', tm())).body, companyId).state).toBe('needs_acceptance');
    const kept = await ask([companyId]);
    expect(kept.status).toBe(200);
    expect(kept.body.targets[0].state).toBe('approved');
    const row = get('SELECT * FROM ai_access_request WHERE id = ?', [requestIdOf(tmId)]);
    expect(row.decided_by).toBe(adminId);
    expect(row.text_version).toBe(A.COMMITMENT.version);

    run('UPDATE ai_access_request SET text_version = 0 WHERE id = ?', [requestIdOf(tmId)]);
    const both = await ask([companyId, provider2Id]);
    expect(both.status).toBe(201);
    expect(both.body.targets.map(t => t.state)).toEqual(['approved', 'pending']);
  });

  test('an approved access can be withdrawn, with a reason', async () => {
    const id = requestIdOf(tmId);
    const res = await request(app).post(`${REQUESTS}/${id}/revoke`).set('Authorization', admin()).send({ reason: 'Contract ended' });
    expect(res.body.state).toBe('revoked');
    expect(stateOf((await request(app).get(ACCESS).set('Authorization', tm())).body, companyId))
      .toMatchObject({ state: 'none', request: { state: 'revoked' } });
    expect(get(`SELECT COUNT(*) AS n FROM auth_events WHERE event_type LIKE 'ai_access_revoked:%'`).n).toBe(1);
  });
});
