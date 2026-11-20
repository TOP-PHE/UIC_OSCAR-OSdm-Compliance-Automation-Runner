// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * auth.test.js — #1342 PR 6: the MCP server as a Company API account. Its
 * assertion verifies with the account's public key (ES256 and PS256, as RFC
 * 7518 says), the token is asked once and kept, and no secret is ever in a
 * failure. OSCAR's side is tested against the real token endpoint in
 * Oscar_Server/tests/integration/mcp-account.test.js.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { assertionFor, bearerFor, algOf, SCOPE } = require('../src/auth');
const { configFrom } = require('../src/config');

const ORIGIN = 'https://oscar.example';
const CLIENT = '3f2a91c0-1d2e-4c5b-8a9f-0123456789ab';

function verify(assertion, publicKey) {
  const [h, p, s] = assertion.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url'));
  const options = header.alg === 'ES256'
    ? { key: publicKey, dsaEncoding: 'ieee-p1363' }
    : { key: publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 };
  return { header, payload: JSON.parse(Buffer.from(p, 'base64url')), ok: crypto.verify('sha256', Buffer.from(`${h}.${p}`), options, Buffer.from(s, 'base64url')) };
}

test('an ES256 and a PS256 assertion verify with the public key, and say who, to whom, for one minute', () => {
  for (const [type, opts, alg] of [['ec', { namedCurve: 'P-256' }, 'ES256'], ['rsa', { modulusLength: 2048 }, 'PS256']]) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync(type, opts);
    const a = assertionFor({ clientId: CLIENT, privateKey, origin: ORIGIN, now: 1_800_000_000_000, jti: 'jti-123456' });
    const { header, payload, ok } = verify(a, publicKey);
    assert.equal(ok, true);
    assert.equal(header.alg, alg);
    assert.deepEqual(payload, { iss: CLIENT, sub: CLIENT, aud: `${ORIGIN}/v1/api/oauth/token`, iat: 1_800_000_000, exp: 1_800_000_060, jti: 'jti-123456' });
  }
});

test('a key of another kind is refused before anything is sent', () => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-384' });
  assert.equal(algOf(privateKey), null);
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const config = configFrom({ OSCAR_URL: ORIGIN, OSCAR_CLIENT_ID: CLIENT, OSCAR_PRIVATE_KEY: pem });
  assert.deepEqual(config.errors, ['OSCAR_PRIVATE_KEY must be EC P-256 or RSA of 2048 bits or more.']);
});

test('the account\'s settings: a key written with \\n works; both ways at once, a bad id or key are refused, never quoted', () => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const ok = configFrom({ OSCAR_URL: ORIGIN, OSCAR_CLIENT_ID: CLIENT, OSCAR_PRIVATE_KEY: pem.split('\n').join('\\n') });
  assert.equal(ok.clientId, CLIENT);
  assert.equal(ok.key, undefined);
  const both = configFrom({ OSCAR_URL: ORIGIN, OSCAR_CLIENT_ID: CLIENT, OSCAR_PRIVATE_KEY: pem, OSCAR_API_KEY: 'oscar_x' });
  assert.match(both.errors[0], /not both/);
  const bad = configFrom({ OSCAR_URL: ORIGIN, OSCAR_CLIENT_ID: 'nope', OSCAR_PRIVATE_KEY: 'not a key SECRET' });
  assert.equal(bad.errors.length, 1);
  assert.ok(!JSON.stringify(bad).includes('SECRET'));
  assert.match(configFrom({ OSCAR_URL: ORIGIN, OSCAR_CLIENT_ID: CLIENT, OSCAR_PRIVATE_KEY: 'not a key SECRET' }).errors[0], /not a PEM/);
});

test('the token is asked once with runs:read, kept until a minute before it expires, and a refusal names no secret', async () => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const config = { origin: ORIGIN, clientId: CLIENT, privateKey };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return { status: 200, json: async () => ({ access_token: 'token-1', token_type: 'Bearer', expires_in: 900 }) };
  };
  assert.deepEqual(await bearerFor(config, { fetchImpl, now: 0 }), { bearer: 'token-1' });
  assert.deepEqual(await bearerFor(config, { fetchImpl, now: 839_000 }), { bearer: 'token-1' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${ORIGIN}/v1/api/oauth/token`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'manual');
  const form = new URLSearchParams(calls[0].init.body);
  assert.equal(form.get('grant_type'), 'client_credentials');
  assert.equal(form.get('scope'), SCOPE);
  await bearerFor(config, { fetchImpl, now: 841_000 });
  assert.equal(calls.length, 2);

  const refused = await bearerFor({ origin: ORIGIN, clientId: CLIENT, privateKey },
    { fetchImpl: async () => ({ status: 401, json: async () => ({ error: 'invalid_client' }) }) });
  assert.match(refused.failure, /HTTP 401 \(invalid_client\)/);
  const down = await bearerFor({ origin: ORIGIN, clientId: CLIENT, privateKey }, { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.match(down.failure, /could not be reached/);
  assert.deepEqual(await bearerFor({ key: 'oscar_k' }), { bearer: 'oscar_k' });
});
