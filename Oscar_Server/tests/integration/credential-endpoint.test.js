// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * A tester's credentials go to the OSDM endpoint they were saved for, and to
 * no other (utils/credentialEndpoint.js): after the endpoint is changed to
 * another origin, no token is asked or sent until the tester saves them again.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-credential-endpoint';

const jwt = require('jsonwebtoken');
const { randomUUID: uuidv4 } = require('node:crypto');
const request = require('supertest');
const express = require('express');
const { run, get } = require('../../src/db/db');
const { endpointOrigin, endpointChangeProblem } = require('../../src/utils/credentialEndpoint');
const { credentialsFor } = require('../../src/utils/testerCredentials');
const { resolveAccessToken } = require('../../src/worker/access-token');

const app = express();
app.use(express.json());
app.use('/v1/company', require('../../src/api/routes/company'));
app.use('/v1/me/credentials', require('../../src/api/routes/me-credentials'));

const companyId = uuidv4();
const tmId = uuidv4();
const testerId = uuidv4();
const quiet = { info() {}, error() {}, warn() {} };

const token = (id, role) => jwt.sign({ sub: id, email: `${id}@endpoint.test`, companyId, role },
  process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
const asTm = () => `Bearer ${token(tmId, 'test_manager')}`;
const asTester = () => `Bearer ${token(testerId, 'company_user')}`;

beforeAll(() => {
  run('INSERT INTO companies (id, name, slug, api_base) VALUES (?, ?, ?, ?)',
    [companyId, 'Endpoint Co', `endpoint-${companyId}`, 'https://provider-a.example/osdm/v3']);
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'test_manager')`, [tmId, companyId, `${tmId}@endpoint.test`]);
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'company_user')`, [testerId, companyId, `${testerId}@endpoint.test`]);
});

describe('the pure rules', () => {
  test('endpointOrigin() keeps the scheme, host and port only', () => {
    expect(endpointOrigin('https://a.example:8443/osdm/v3/')).toBe('https://a.example:8443');
    expect(endpointOrigin('')).toBeNull();
    expect(endpointOrigin('not a url')).toBeNull();
  });

  test('another origin is refused, the same origin with another path is not', () => {
    expect(endpointChangeProblem('https://a.example', 'https://b.example/osdm')).toMatch(/saved for https:\/\/a\.example, now https:\/\/b\.example/);
    expect(endpointChangeProblem('https://a.example', 'https://a.example/other/path')).toBeNull();
  });

  // 1.11.479: saved while there was no endpoint, they are tied to none.
  test('nothing stored: refused once there is an endpoint, not before', () => {
    expect(endpointChangeProblem(null, 'https://b.example')).toMatch(/saved before this company or provider had an OSDM endpoint \(now https:\/\/b\.example\)/);
    expect(endpointChangeProblem(null, '')).toBeNull();
    expect(endpointChangeProblem(null, null)).toBeNull();
  });
});

describe('a tester\'s credentials follow the endpoint they were saved for', () => {
  test('a save records the endpoint as it is', async () => {
    const res = await request(app).patch('/v1/me/credentials').set('Authorization', asTester())
      .send({ auth_mode: 'bearer', access_token: 'static-provider-token' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ credentials_endpoint: 'https://provider-a.example', endpoint_changed: false });
    run(`UPDATE tester_credentials SET cached_token_enc = 'x', cached_token_expires_at = '2099-01-01', cached_token_cred_fp = 'fp' WHERE user_id = ?`, [testerId]);
    await expect(resolveAccessToken(credentialsFor(testerId, companyId), quiet)).resolves.toBe('static-provider-token');
  });

  test('another path on the same host changes nothing', async () => {
    await request(app).patch('/v1/company').set('Authorization', asTm()).send({ api_base: 'https://provider-a.example/osdm/v4' });
    const res = await request(app).get('/v1/me/credentials').set('Authorization', asTester());
    expect(res.body.endpoint_changed).toBe(false);
  });

  test('another endpoint: cached tokens dropped, nothing sent, the tester is told', async () => {
    run(`UPDATE tester_credentials SET cached_token_enc = 'x', cached_token_expires_at = '2099-01-01', cached_token_cred_fp = 'fp' WHERE user_id = ?`, [testerId]);
    const change = await request(app).patch('/v1/company').set('Authorization', asTm()).send({ api_base: 'https://provider-b.example/osdm' });
    expect(change.status).toBe(200);
    expect(get('SELECT cached_token_enc FROM tester_credentials WHERE user_id = ?', [testerId]).cached_token_enc).toBeNull();

    const res = await request(app).get('/v1/me/credentials').set('Authorization', asTester());
    expect(res.body).toMatchObject({ credentials_endpoint: 'https://provider-a.example', endpoint_changed: true });
    await expect(resolveAccessToken(credentialsFor(testerId, companyId), quiet))
      .rejects.toThrow(/saved for https:\/\/provider-a\.example, now https:\/\/provider-b\.example/);
  });

  test('saving again confirms them for the new endpoint', async () => {
    const res = await request(app).patch('/v1/me/credentials').set('Authorization', asTester()).send({ auth_mode: 'bearer' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ credentials_endpoint: 'https://provider-b.example', endpoint_changed: false });
    await expect(resolveAccessToken(credentialsFor(testerId, companyId), quiet)).resolves.toBe('static-provider-token');
  });
});

// 1.11.479: credentials saved while the company had no endpoint are tied to
// none. The first endpoint set does not get them: the tester saves again.
describe('credentials saved before there was an endpoint', () => {
  const lateCompany = uuidv4();
  const lateTester = uuidv4();
  const asLate = () => `Bearer ${jwt.sign({ sub: lateTester, email: `${lateTester}@endpoint.test`, companyId: lateCompany, role: 'company_user' },
    process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;
  const lateTm = uuidv4();
  const asLateTm = () => `Bearer ${jwt.sign({ sub: lateTm, email: `${lateTm}@endpoint.test`, companyId: lateCompany, role: 'test_manager' },
    process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;

  beforeAll(() => {
    run('INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)', [lateCompany, 'Late Co', `late-${lateCompany}`]);
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'company_user')`, [lateTester, lateCompany, `${lateTester}@endpoint.test`]);
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'test_manager')`, [lateTm, lateCompany, `${lateTm}@endpoint.test`]);
  });

  test('the first endpoint set does not receive them until the tester saves again', async () => {
    const saved = await request(app).patch('/v1/me/credentials').set('Authorization', asLate())
      .send({ auth_mode: 'bearer', access_token: 'early-token' });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ credentials_endpoint: null, endpoint_changed: false });

    const set = await request(app).patch('/v1/company').set('Authorization', asLateTm()).send({ api_base: 'https://first-endpoint.example/osdm' });
    expect(set.status).toBe(200);
    const res = await request(app).get('/v1/me/credentials').set('Authorization', asLate());
    expect(res.body).toMatchObject({ credentials_endpoint: null, endpoint_changed: true });
    await expect(resolveAccessToken(credentialsFor(lateTester, lateCompany), quiet))
      .rejects.toThrow(/saved before this company or provider had an OSDM endpoint/);

    const again = await request(app).patch('/v1/me/credentials').set('Authorization', asLate()).send({ auth_mode: 'bearer' });
    expect(again.body).toMatchObject({ credentials_endpoint: 'https://first-endpoint.example', endpoint_changed: false });
    await expect(resolveAccessToken(credentialsFor(lateTester, lateCompany), quiet)).resolves.toBe('early-token');
  });

  test('a row holding nothing to send is refused nothing here', () => {
    const { credentialsEndpointProblem } = require('../../src/utils/credentialEndpoint');
    expect(credentialsEndpointProblem({ company_id: lateCompany, credentials_endpoint: null, auth_mode: 'bearer' })).toBeNull();
  });
});
