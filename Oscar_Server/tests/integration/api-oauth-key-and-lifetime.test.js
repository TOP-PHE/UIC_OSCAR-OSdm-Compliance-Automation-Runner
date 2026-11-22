// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * api-oauth-key-and-lifetime.test.js — #1367, on the real routes:
 *
 *   - an assertion's five minutes are counted from OSCAR's clock: one with no
 *     iat, or an iat written later than now, and an exp far ahead is refused
 *     though rightly signed;
 *   - an access token names the key its assertion was signed with, and
 *     revoking that key ends the tokens obtained with it at once, and no
 *     other.
 *
 * A file of its own: the token endpoint takes 30 requests a minute from an
 * address, which api-oauth.test.js already uses.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-api-oauth-1367';
process.env.APP_URL = 'https://oscar.test/';

const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { run } = require('../../src/db/db');
const Tokens = require('../../src/utils/apiAccessTokens');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/v1/company/api-accounts', require('../../src/api/routes/company-api-accounts'));
app.use('/v1/api/oauth', require('../../src/api/routes/api-oauth'));
app.use('/v1/api', require('../../src/api/routes/api'));

const TOKEN_URL = 'https://oscar.test/v1/api/oauth/token';
const YEARS = 10 * 365 * 24 * 3600;
const companyId = crypto.randomUUID();
const tag = companyId.slice(0, 8);
const TM = { id: crypto.randomUUID(), email: `tm-${tag}@oauth-1367.test`, role: 'test_manager', companyId };
const session = `Bearer ${jwt.sign({ sub: TM.id, email: TM.email, companyId, role: TM.role }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;
const ec = () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pemOf = key => key.export({ type: 'spki', format: 'pem' });
const now = () => Math.floor(Date.now() / 1000);

const FIRST = ec();
const SECOND = ec();
let ci;
let firstKeyId;
let secondKeyId;

const manage = (method, path) => request(app)[method](`/v1/company/api-accounts${path}`).set('Authorization', session);
const api = (token, path) => request(app).get(`/v1/api${path}`).set('Authorization', `Bearer ${token}`);
const askToken = assertion => request(app).post('/v1/api/oauth/token').type('form').send({
  grant_type: 'client_credentials',
  client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
  client_assertion: assertion,
});
// jsonwebtoken writes its own iat unless told not to, and then removes one given.
const signed = (claims, key, account = ci) => jwt.sign(
  { iss: account.id, sub: account.id, aud: TOKEN_URL, jti: crypto.randomUUID(), ...claims }, key,
  { algorithm: 'ES256', noTimestamp: claims.iat === undefined });
async function tokenWith(key) {
  const t = now();
  const res = await askToken(signed({ iat: t, exp: t + 60 }, key));
  expect(res.status).toBe(200);
  return res.body.access_token;
}

beforeAll(async () => {
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'OAuth 1367 Co', ?)`, [companyId, `oauth-1367-${tag}`]);
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'test_manager')`, [TM.id, companyId, TM.email]);
  ci = (await manage('post', '').send({ name: 'CI', providers: [] })).body;
  firstKeyId = (await manage('post', `/${ci.id}/keys`).send({ public_key: pemOf(FIRST.publicKey) })).body.id;
  secondKeyId = (await manage('post', `/${ci.id}/keys`).send({ public_key: pemOf(SECOND.publicKey) })).body.id;
  expect(firstKeyId).toBeTruthy();
  expect(secondKeyId).toBeTruthy();
});

describe("an assertion's five minutes are counted from OSCAR's clock", () => {
  test.each([
    ['no iat, exp in ten years', () => ({ exp: now() + YEARS })],
    ['iat a minute before an exp in ten years', () => ({ iat: now() + YEARS - 60, exp: now() + YEARS })],
    ['iat ten minutes ahead', () => ({ iat: now() + 600, exp: now() + 660 })],
    ['no iat, exp in seven minutes', () => ({ exp: now() + 420 })],
  ])('refused though rightly signed: %s', async (_name, claims) => {
    const res = await askToken(signed(claims(), FIRST.privateKey));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
  });

  test('accepted: signed now for a minute, as the guide and the example client do', async () => {
    const t = now();
    expect((await askToken(signed({ iat: t, exp: t + 60 }, FIRST.privateKey))).status).toBe(200);
  });

  test('accepted: no iat and an exp within five minutes', async () => {
    expect((await askToken(signed({ exp: now() + 240 }, FIRST.privateKey))).status).toBe(200);
  });

  test('a refused assertion does not use up its jti: nothing of it is kept', async () => {
    const jti = crypto.randomUUID();
    expect((await askToken(signed({ jti, exp: now() + YEARS }, FIRST.privateKey))).status).toBe(401);
    const t = now();
    expect((await askToken(signed({ jti, iat: t, exp: t + 60 }, FIRST.privateKey))).status).toBe(200);
  });
});

describe('a token and the key it was obtained with', () => {
  test('the token names the key its assertion was signed with', async () => {
    expect(jwt.decode(await tokenWith(FIRST.privateKey)).key).toBe(firstKeyId);
    expect(jwt.decode(await tokenWith(SECOND.privateKey)).key).toBe(secondKeyId);
  });

  test('a token naming a key of another account is refused', async () => {
    const other = (await manage('post', '').send({ name: 'CI other', providers: [] })).body;
    const theirs = Tokens.issue(other.id, ['runs:read'], new Date(), secondKeyId).token;
    expect((await api(theirs, '/key')).status).toBe(401);
    // The same account with a token as issued before #1367: accepted.
    expect((await api(Tokens.issue(other.id, ['runs:read']).token, '/key')).status).toBe(200);
  });

  test('a token naming a key that does not exist is refused', async () => {
    const unknown = Tokens.issue(ci.id, ['runs:read'], new Date(), crypto.randomUUID()).token;
    expect((await api(unknown, '/key')).status).toBe(401);
  });

  test('revoking a key ends the tokens obtained with it at once, and no other', async () => {
    const fromFirst = await tokenWith(FIRST.privateKey);
    const fromSecond = await tokenWith(SECOND.privateKey);
    // A token as issued before #1367: it names no key.
    const older = Tokens.issue(ci.id, ['runs:read']).token;
    for (const token of [fromFirst, fromSecond, older]) expect((await api(token, '/key')).status).toBe(200);

    expect((await manage('delete', `/${ci.id}/keys/${firstKeyId}`)).body.state).toBe('revoked');

    expect((await api(fromFirst, '/key')).status).toBe(401);
    expect((await api(fromFirst, '/runs')).status).toBe(401);
    expect((await api(fromSecond, '/key')).status).toBe(200);
    expect((await api(older, '/key')).status).toBe(200);
    // No new token with the revoked key, as before; the other key goes on.
    const t = now();
    expect((await askToken(signed({ iat: t, exp: t + 60 }, FIRST.privateKey))).status).toBe(401);
    expect((await api(await tokenWith(SECOND.privateKey), '/key')).status).toBe(200);
  });
});
