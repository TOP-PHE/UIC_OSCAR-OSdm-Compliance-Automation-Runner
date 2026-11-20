// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * mcp-account.test.js — #1342 PR 6: the MCP server signs in as a Company API
 * account against OSCAR's real token endpoint. The MCP's own modules
 * (OSCAR_MCP/src/auth.js, client.js) run in this process against the API on
 * a loopback port: the assertion it signs with node:crypto, ES256 and PS256,
 * must be one OSCAR's verifier accepts.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-mcp-account';
delete process.env.APP_URL;

const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { run } = require('../../src/db/db');
const { getFromOscar } = require('../../../OSCAR_MCP/src/client');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/v1/company/api-accounts', require('../../src/api/routes/company-api-accounts'));
app.use('/v1/api/oauth', require('../../src/api/routes/api-oauth'));
app.use('/v1/api', require('../../src/api/routes/api'));

const D = crypto.randomUUID();
const TM = { id: crypto.randomUUID(), email: `tm-${D.slice(0, 8)}@mcp-account.test`, role: 'test_manager', companyId: D };
const session = u => `Bearer ${jwt.sign({ sub: u.id, email: u.email, companyId: u.companyId, role: u.role }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;
let server;
let origin;
let account;

beforeAll(async () => {
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'MCP Account Co', ?)`, [D, `mcpa-${D.slice(0, 8)}`]);
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'test_manager')`, [TM.id, D, TM.email]);
  account = (await request(app).post('/v1/company/api-accounts').set('Authorization', session(TM)).send({ name: 'MCP' })).body;
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => { server.close(resolve); }));

test.each([
  ['EC P-256 (ES256)', 'ec', { namedCurve: 'P-256' }],
  ['RSA 2048 (PS256)', 'rsa', { modulusLength: 2048 }],
])('with %s, the MCP server asks a token OSCAR accepts and reads as the account', async (_, type, options) => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync(type, options);
  const added = await request(app).post(`/v1/company/api-accounts/${account.id}/keys`).set('Authorization', session(TM))
    .send({ public_key: publicKey.export({ type: 'spki', format: 'pem' }) });
  expect(added.status).toBe(201);
  const config = { origin, clientId: account.id, privateKey };
  const answer = await getFromOscar(config, '/v1/api/key');
  expect(answer.status).toBe(200);
  expect(answer.body).toMatchObject({ kind: 'company_api_account', client_id: account.id, scopes: ['runs:read'] });
  // The token is kept: a second call asks none.
  const kept = config.cache.token;
  await getFromOscar(config, '/v1/api/runs');
  expect(config.cache.token).toBe(kept);
  await request(app).delete(`/v1/company/api-accounts/${account.id}/keys/${added.body.id}`).set('Authorization', session(TM));
});

test('a key OSCAR does not hold for the account is refused, and the failure quotes no secret', async () => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const answer = await getFromOscar({ origin, clientId: account.id, privateKey }, '/v1/api/key');
  expect(answer.failure).toMatch(/HTTP 401 \(invalid_client\)/);
});
