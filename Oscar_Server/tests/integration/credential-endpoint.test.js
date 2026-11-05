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

  test('another origin is refused, the same origin with another path is not, nothing stored refuses nothing', () => {
    expect(endpointChangeProblem('https://a.example', 'https://b.example/osdm')).toMatch(/saved for https:\/\/a\.example, now https:\/\/b\.example/);
    expect(endpointChangeProblem('https://a.example', 'https://a.example/other/path')).toBeNull();
    expect(endpointChangeProblem(null, 'https://b.example')).toBeNull();
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
