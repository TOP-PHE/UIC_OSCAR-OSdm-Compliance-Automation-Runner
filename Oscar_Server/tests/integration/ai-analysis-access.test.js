// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #801, PR 1: access to the AI analysis. Three locks: the administrator's
 * switch per company, the Test Manager's request with the accepted text,
 * the administrator's decision.
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
const otherCompanyId = uuidv4();
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
const accepted = () => ({ version: A.COMMITMENT.version, hash: A.commitmentHash() });
const switchAi = (enabled) => request(app).patch(`/v1/admin/companies/${companyId}`).set('Authorization', admin()).send({ ai_analysis_enabled: enabled });
const requestIdOf = (uid) => get('SELECT id FROM ai_access_request WHERE company_id = ? AND user_id = ?', [companyId, uid]).id;

beforeAll(() => {
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'AI Test', 'ai-test')`, [companyId]);
  run(`INSERT INTO companies (id, name, slug, parent_id) VALUES (?, 'AI Provider', 'ai-provider', ?)`, [providerId, companyId]);
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'AI Platform', 'ai-platform')`, [otherCompanyId]);
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
      expect((await request(app).patch(`/v1/admin/companies/${companyId}`).set('Authorization', t).send({ ai_analysis_enabled: true })).status).toBe(403);
    }
  });
});

describe('#801 the three locks', () => {
  test('switched off: the page says so, and a request is refused', async () => {
    const res = await request(app).get(ACCESS).set('Authorization', tm());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: false, state: 'disabled', request: null, company: { name: 'AI Test' } });
    expect(res.body.commitment).toMatchObject({ version: A.COMMITMENT.version, hash: A.commitmentHash() });
    expect((await request(app).post(`${ACCESS}/request`).set('Authorization', tm()).send(accepted())).status).toBe(409);
  });

  test('the administrator switches it on; the switch must be a boolean, and is audited', async () => {
    expect((await request(app).patch(`/v1/admin/companies/${companyId}`).set('Authorization', admin()).send({ ai_analysis_enabled: 'yes' })).status).toBe(400);
    const res = await switchAi(true);
    expect(res.status).toBe(200);
    expect(res.body.company.ai_analysis_enabled).toBe(1);
    expect((await switchAi(true)).status).toBe(200);
    expect(get(`SELECT COUNT(*) AS n FROM auth_events WHERE company_id = ? AND event_type = 'ai_analysis_enabled'`, [companyId]).n).toBe(1);
    const list = await request(app).get('/v1/admin/companies').set('Authorization', admin());
    expect(list.body.companies.find(c => c.id === companyId).ai_analysis_enabled).toBe(1);
  });

  test('a request must name the text in force', async () => {
    for (const body of [{}, { version: A.COMMITMENT.version, hash: 'x' }, { version: 0, hash: A.commitmentHash() }]) {
      expect((await request(app).post(`${ACCESS}/request`).set('Authorization', tm()).send(body)).status).toBe(400);
    }
  });

  test('a Test Manager asks; the request waits, once, and is audited', async () => {
    const res = await request(app).post(`${ACCESS}/request`).set('Authorization', tm()).send(accepted());
    expect(res.status).toBe(201);
    expect(res.body.state).toBe('pending');
    expect((await request(app).post(`${ACCESS}/request`).set('Authorization', tm()).send(accepted())).status).toBe(409);
    const row = get('SELECT * FROM ai_access_request WHERE company_id = ? AND user_id = ?', [companyId, tmId]);
    expect(row).toMatchObject({ state: 'pending', text_version: A.COMMITMENT.version, text_hash: A.commitmentHash() });
    expect(get(`SELECT COUNT(*) AS n FROM auth_events WHERE event_type = ?`, [`ai_access_requested:v${A.COMMITMENT.version}`]).n).toBe(1);
  });

  test('working on a provider, the request is the distributor\'s', async () => {
    const res = await request(app).get(ACCESS).set('Authorization', tm()).set('X-Provider-Id', providerId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ company: { id: companyId }, state: 'pending' });
  });

  test('the administrator sees it, and approves it', async () => {
    const list = await request(app).get(REQUESTS).set('Authorization', admin());
    expect(list.status).toBe(200);
    const mine = list.body.requests.find(r => r.id === requestIdOf(tmId));
    expect(mine).toMatchObject({ state: 'pending', company: { name: 'AI Test', aiAnalysisEnabled: true }, user: { role: 'test_manager' } });
    expect((await request(app).post(`${REQUESTS}/${mine.id}/nonsense`).set('Authorization', admin())).status).toBe(404);
    expect((await request(app).post(`${REQUESTS}/${uuidv4()}/approve`).set('Authorization', admin())).status).toBe(404);
    expect((await request(app).post(`${REQUESTS}/${mine.id}/revoke`).set('Authorization', admin()).send({ reason: 'x' })).status).toBe(409);
    const res = await request(app).post(`${REQUESTS}/${mine.id}/approve`).set('Authorization', admin());
    expect(res.body).toEqual({ id: mine.id, state: 'approved' });
    expect((await request(app).get(ACCESS).set('Authorization', tm())).body.state).toBe('approved');
    expect((await request(app).post(`${ACCESS}/request`).set('Authorization', tm()).send(accepted())).status).toBe(409);
  });

  test('switched off again: closed, but the approval is kept for when it comes back', async () => {
    await switchAi(false);
    expect((await request(app).get(ACCESS).set('Authorization', tm())).body.state).toBe('disabled');
    await switchAi(true);
    expect((await request(app).get(ACCESS).set('Authorization', tm())).body.state).toBe('approved');
  });

  test('a new text asks for acceptance again, without a new approval', async () => {
    run('UPDATE ai_access_request SET text_version = 0 WHERE id = ?', [requestIdOf(tmId)]);
    expect((await request(app).get(ACCESS).set('Authorization', tm())).body.state).toBe('needs_acceptance');
    const res = await request(app).post(`${ACCESS}/request`).set('Authorization', tm()).send(accepted());
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('approved');
    const row = get('SELECT * FROM ai_access_request WHERE id = ?', [requestIdOf(tmId)]);
    expect(row.decided_by).toBe(adminId);
    expect(row.text_version).toBe(A.COMMITMENT.version);
  });

  test('a refusal needs a reason; the Test Manager reads it and may ask again', async () => {
    expect((await request(app).post(`${ACCESS}/request`).set('Authorization', tm(tm2Id)).send(accepted())).status).toBe(201);
    const id = requestIdOf(tm2Id);
    expect((await request(app).post(`${REQUESTS}/${id}/refuse`).set('Authorization', admin()).send({ reason: '  ' })).status).toBe(400);
    expect((await request(app).post(`${REQUESTS}/${id}/refuse`).set('Authorization', admin()).send({ reason: 'No contract yet' })).status).toBe(200);
    const seen = (await request(app).get(ACCESS).set('Authorization', tm(tm2Id))).body;
    expect(seen).toMatchObject({ state: 'none', request: { state: 'refused', reason: 'No contract yet' } });
    const again = await request(app).post(`${ACCESS}/request`).set('Authorization', tm(tm2Id)).send(accepted());
    expect(again.status).toBe(201);
    expect(again.body.request).toMatchObject({ state: 'pending', reason: null });
  });

  test('an approved access can be withdrawn, with a reason', async () => {
    const id = requestIdOf(tmId);
    const res = await request(app).post(`${REQUESTS}/${id}/revoke`).set('Authorization', admin()).send({ reason: 'Contract ended' });
    expect(res.body.state).toBe('revoked');
    expect((await request(app).get(ACCESS).set('Authorization', tm())).body).toMatchObject({ state: 'none', request: { state: 'revoked' } });
    expect(get(`SELECT COUNT(*) AS n FROM auth_events WHERE event_type LIKE 'ai_access_revoked:%'`).n).toBe(1);
  });
});
