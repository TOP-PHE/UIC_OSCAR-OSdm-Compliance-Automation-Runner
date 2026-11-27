// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * The example Bruno collection (#1455): its scripts' module, run as it is,
 * and the collection's files read as Bruno reads them.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const api = require('../bruno/lib/oscarApi.js');

const DIR = path.resolve(__dirname, '..', 'bruno');
const CLIENT = '3f2a91c0-1d2e-4c5b-8a9f-0123456789ab';

// A Bruno stand-in: environment, runtime variables, and the requests a script sends.
function fakeBru(env, answer = { status: 200, data: { access_token: 'tok-1', expires_in: 900 } }) {
  const vars = {};
  const sent = [];
  return {
    vars, sent,
    getEnvVar: name => env[name],
    getVar: name => vars[name],
    setVar: (name, value) => { vars[name] = value; },
    sendRequest: (request, callback) => { sent.push(request); callback(null, answer); },
  };
}

test('the assertion: ES256 or PS256 by key, one minute, iss = sub = client id, aud = the token endpoint', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const now = Date.UTC(2026, 10, 27, 9, 0, 0);
  const jwt = api.assertionFor({ clientId: CLIENT, key: privateKey, oscarUrl: 'https://oscar.example.org/', now, jti: 'j-1' });
  const [h, p, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url')),
    { iss: CLIENT, sub: CLIENT, aud: 'https://oscar.example.org/v1/api/oauth/token', iat: now / 1000, exp: now / 1000 + 60, jti: 'j-1' });
  assert.equal(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')), true);

  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const r = api.assertionFor({ clientId: CLIENT, key: rsa.privateKey, oscarUrl: 'https://oscar.example.org', now });
  const [rh, rp, rs] = r.split('.');
  assert.equal(JSON.parse(Buffer.from(rh, 'base64url')).alg, 'PS256');
  assert.equal(crypto.verify('sha256', Buffer.from(`${rh}.${rp}`),
    { key: rsa.publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, Buffer.from(rs, 'base64url')), true);

  const p384 = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey;
  assert.throws(() => api.assertionFor({ clientId: CLIENT, key: p384, oscarUrl: 'https://o.example' }), /EC P-256 or RSA of 2048 bits/);
  assert.throws(() => api.assertionFor({ clientId: '', key: privateKey, oscarUrl: 'https://o.example' }), /No client_id/);
});

test('the private key from a file or from its text, line breaks written \\n; none is said', () => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'oscar-bruno-'));
  try {
    fs.writeFileSync(path.join(dir, 'k.pem'), pem);
    assert.equal(api.algOf(api.privateKeyOf({ file: path.join(dir, 'k.pem') })), 'ES256');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(api.algOf(api.privateKeyOf({ text: pem.replaceAll('\n', String.raw`\n`) })), 'ES256');
  assert.throws(() => api.privateKeyOf({ text: '' }), /No private key: set private_key_file/);
});

test('a token is kept as runtime variables, asked again two minutes before it ends', async () => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const env = { oscar_url: 'https://oscar.example.org/', client_id: ` ${CLIENT} `, private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const bru = fakeBru(env);
  const now = Date.now();
  await api.ensureToken(bru, now);
  assert.equal(bru.sent.length, 1);
  assert.equal(bru.sent[0].url, 'https://oscar.example.org/v1/api/oauth/token');
  assert.equal(bru.sent[0].maxRedirects, 0);
  const form = new URLSearchParams(bru.sent[0].data);
  assert.equal(form.get('grant_type'), 'client_credentials');
  assert.equal(form.get('client_assertion_type'), api.ASSERTION_TYPE);
  assert.equal(form.get('scope'), 'runs:read runs:write');
  assert.equal(bru.vars.access_token, 'tok-1');
  assert.equal(Number(bru.vars.token_until), now + 13 * 60 * 1000);
  // Still valid: nothing sent. Two minutes before its end: asked again.
  await api.ensureToken(bru, now + 12 * 60 * 1000);
  assert.equal(bru.sent.length, 1);
  await api.ensureToken(bru, now + 13 * 60 * 1000 + 1);
  assert.equal(bru.sent.length, 2);

  const refused = fakeBru(env, { status: 401, data: { error: 'invalid_client', error_description: 'not accepted' } });
  await assert.rejects(api.ensureToken(refused), /OSCAR refused the token request \(HTTP 401\)\. invalid_client: not accepted/);
  assert.equal(refused.vars.access_token, undefined);
});

test('the provider by name without case, or by id; the others listed when it is not one', () => {
  const account = { company: { id: 'c1', name: 'UIC Simulateurs' }, providers: [{ id: 'g1', name: 'GAMMA' }] };
  assert.equal(api.providerIdOf(account, 'gamma'), 'g1');
  assert.equal(api.providerIdOf(account, 'g1'), 'g1');
  assert.equal(api.providerIdOf(account, 'UIC Simulateurs'), 'c1');
  assert.throws(() => api.providerIdOf(account, 'ALPHA'), /"ALPHA" is not a company or provider this account may test\. It may test: UIC Simulateurs, GAMMA\./);
});

test('the request: a suite when named, else the codes; nothing named is said', () => {
  assert.deepEqual(api.testRequestBody({ providerId: 'g1', scenarios: ' A, B ,', suite: '', reference: 'Bruno example' }),
    { providers: ['g1'], scenarios: ['A', 'B'], reference: 'Bruno example' });
  assert.deepEqual(api.testRequestBody({ providerId: 'g1', scenarios: 'A', suite: ' nightly ' }), { providers: ['g1'], suite: 'nightly' });
  assert.throws(() => api.testRequestBody({ providerId: 'g1', scenarios: '', suite: '' }), /Name a suite/);
});

test('after a wait: done when finished, again while running or when a proxy cuts it, stop otherwise', () => {
  assert.equal(api.afterWait({ status: 200, body: { state: 'finished' }, tries: 1, maxTries: 3 }), 'done');
  assert.equal(api.afterWait({ status: 200, body: { state: 'running' }, tries: 1, maxTries: 3 }), 'again');
  assert.equal(api.afterWait({ status: 504, body: null, tries: 1, maxTries: 3 }), 'again');
  assert.equal(api.afterWait({ status: 200, body: { state: 'running' }, tries: 3, maxTries: 3 }), 'stop');
  assert.equal(api.afterWait({ status: 401, body: null, tries: 1, maxTries: 3 }), 'stop');
  assert.equal(api.maxWaitsOf('60'), 72);
  assert.equal(api.maxWaitsOf('nonsense'), 72);
  assert.equal(api.maxWaitsOf('1'), 2);
});

test('the results in lines: the verdict, then each run not passed and its failed checks', () => {
  const lines = api.reportLines({ verdict: 'failed', providers: [{ id: 'g1', name: 'GAMMA', verdict: 'failed', runs: [
    { scenario_code: 'A', verdict: 'passed' },
    { scenario_code: 'B', verdict: 'failed', run_url: 'https://o/r', failures: [{ step: '02. POST Booking', check: 'HTTP response status', message: 'expected 200, actual: 400' }] },
  ] }] });
  assert.deepEqual(lines, ['Verdict: FAILED', '  GAMMA: failed', '    B: failed  https://o/r', '      ✗ 02. POST Booking: HTTP response status — expected 200, actual: 400']);
});

test('the collection: each request runs the module, the loop names a request, no secret in the environment file', () => {
  const requests = fs.readdirSync(DIR).filter(f => f.endsWith('.yml') && f !== 'opencollection.yml');
  assert.deepEqual(requests.sort(), ['1 Get a token.yml', '2 Find the provider.yml', '3 Ask for tests.yml',
    '4 Wait for the verdict.yml', '5 Read the results.yml', '6 JUnit report.yml']);
  const names = requests.map(f => /^ {2}name: (.+)$/m.exec(fs.readFileSync(path.join(DIR, f), 'utf8'))[1]);
  for (const f of requests) {
    const text = fs.readFileSync(path.join(DIR, f), 'utf8');
    assert.match(text, /require\('\.\/lib\/oscarApi\.js'\)/, f);
    // A script that calls the API makes sure of its token first; the token request signs instead.
    if (f !== '1 Get a token.yml') assert.match(text, /ensureToken\(bru\)/, f);
    for (const [, next] of text.matchAll(/setNextRequest\('([^']+)'\)/g)) assert.ok(names.includes(next), `${f}: ${next}`);
  }
  const env = fs.readFileSync(path.join(DIR, 'environments', 'OSCAR.yml'), 'utf8');
  // The client id and the key's text are secret variables: Bruno keeps their values out of the file.
  assert.match(env, /- secret: true\n {4}name: client_id\n/);
  assert.match(env, /- secret: true\n {4}name: private_key\n/);
  assert.doesNotMatch(env, /PRIVATE KEY|access_token/);
});
