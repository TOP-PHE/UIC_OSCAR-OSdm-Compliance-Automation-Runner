// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * oscarApi.js — what the example Bruno collection does in its scripts (#1455):
 * sign the client assertion, keep a token, find the provider, build the test
 * request, decide whether to wait again, and say the results in lines.
 *
 * Node's own `crypto` and `fs` only, so Bruno runs it in Developer mode
 * (`bru run --sandbox=developer`, or *Developer Mode* in the app) and the
 * example client's tests run it as it is.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');

const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const TOKEN_PATH = '/v1/api/oauth/token';
const SCOPE = 'runs:read runs:write';
// A token is asked again two minutes before it ends (it lasts 15).
const RENEW_BEFORE_MS = 2 * 60 * 1000;
// A wait asks OSCAR to answer within 50 s: under the 60 s a proxy often allows.
const WAIT_S = 50;

const b64url = text => Buffer.from(text).toString('base64url');

/** The private key: from a PEM file, else from its text (line breaks may be written \n). */
function privateKeyOf({ file, text }) {
  const pem = file ? fs.readFileSync(file, 'utf8') : String(text || '').replaceAll(String.raw`\n`, '\n');
  if (!pem.includes('PRIVATE KEY')) {
    throw new Error('No private key: set private_key_file (the path of the PEM file) or private_key (its text) in the environment.');
  }
  return crypto.createPrivateKey({ key: pem, format: 'pem' });
}

/** ES256 for an EC P-256 key, PS256 for an RSA key of 2048 bits or more; null otherwise. */
function algOf(key) {
  if (key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1') return 'ES256';
  if (key.asymmetricKeyType === 'rsa' && (key.asymmetricKeyDetails?.modulusLength || 0) >= 2048) return 'PS256';
  return null;
}

/** OSCAR's address without a path or a final slash. */
const originOf = url => new URL(String(url || '')).origin;

/**
 * The signed client assertion (RFC 7523): iss = sub = the client id, aud = the
 * token endpoint, one minute, a new jti each time.
 */
function assertionFor({ clientId, key, oscarUrl, now = Date.now(), jti = crypto.randomUUID() }) {
  const alg = algOf(key);
  if (!alg) throw new Error('The private key must be EC P-256 or RSA of 2048 bits or more.');
  if (!clientId) throw new Error('No client_id in the environment: the UUID shown under the account on API Accounts.');
  const iat = Math.floor(now / 1000);
  const data = `${b64url(JSON.stringify({ alg, typ: 'JWT' }))}.${b64url(JSON.stringify({
    iss: clientId, sub: clientId, aud: originOf(oscarUrl) + TOKEN_PATH, iat, exp: iat + 60, jti,
  }))}`;
  const options = alg === 'ES256'
    ? { key, dsaEncoding: 'ieee-p1363' }
    : { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 };
  return `${data}.${crypto.sign('sha256', Buffer.from(data), options).toString('base64url')}`;
}

/** The token request's form, as text. */
const tokenForm = assertion => new URLSearchParams({
  grant_type: 'client_credentials',
  client_assertion_type: ASSERTION_TYPE,
  client_assertion: assertion,
  scope: SCOPE,
}).toString();

// The environment's settings the scripts read.
const settingsOf = bru => ({
  oscarUrl: bru.getEnvVar('oscar_url'),
  clientId: String(bru.getEnvVar('client_id') || '').trim(),
  keyFile: bru.getEnvVar('private_key_file'),
  keyText: bru.getEnvVar('private_key'),
});

/** The assertion the token request sends, from the environment. */
function assertionOf(bru, now = Date.now()) {
  const s = settingsOf(bru);
  return assertionFor({ clientId: s.clientId, key: privateKeyOf({ file: s.keyFile, text: s.keyText }), oscarUrl: s.oscarUrl, now });
}

/** Keeps a token answer: { ok, error }. */
function keepToken(bru, status, body, now = Date.now()) {
  if (status !== 200 || typeof body?.access_token !== 'string') {
    const described = body?.error_description ? ': ' + body.error_description : '';
    const said = body?.error ? body.error + described : '';
    return { ok: false, error: `OSCAR refused the token request (HTTP ${status}). ${said}`.trim() };
  }
  const lifetime = Number.isFinite(body.expires_in) ? body.expires_in : 900;
  bru.setVar('access_token', body.access_token);
  bru.setVar('token_until', String(now + lifetime * 1000 - RENEW_BEFORE_MS));
  return { ok: true };
}

// One request sent from a script: { status, body }.
function send(bru, request) {
  return new Promise((resolve, reject) => {
    bru.sendRequest({ maxRedirects: 0, ...request },
      (err, r) => (err && !err.response ? reject(err) : resolve(r || err.response)));
  }).then((res) => {
    let body = res?.data ?? res?.body ?? null;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* kept as text */ } }
    return { status: res?.status || 0, body };
  });
}

/**
 * Before a request to the API: a token that has not run out, asked again when
 * needed (a run may last longer than a token).
 */
async function ensureToken(bru, now = Date.now()) {
  if (bru.getVar('access_token') && Number(bru.getVar('token_until')) > now) return;
  const { status, body } = await send(bru, {
    method: 'POST',
    url: originOf(bru.getEnvVar('oscar_url')) + TOKEN_PATH,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    data: tokenForm(assertionOf(bru, now)),
  });
  const kept = keepToken(bru, status, body, now);
  if (!kept.ok) throw new Error(kept.error);
}

/** The id of the provider named (name without case, or id), among those the account may test. */
function providerIdOf(account, name) {
  const places = [account?.company, ...(account?.providers || [])].filter(Boolean);
  const wanted = String(name || '').trim().toLowerCase();
  const found = places.find(p => p.id === name || String(p.name).toLowerCase() === wanted);
  if (!found) {
    throw new Error(`"${name}" is not a company or provider this account may test. It may test: ${places.map(p => p.name).join(', ')}.`);
  }
  return found.id;
}

const list = value => String(value || '').split(',').map(s => s.trim()).filter(Boolean);

/** The test request's body: a suite when one is named, else the scenario codes. */
function testRequestBody({ providerId, scenarios, suite, reference }) {
  const body = { providers: [providerId] };
  if (String(suite || '').trim()) body.suite = String(suite).trim();
  else body.scenarios = list(scenarios);
  if (!body.suite && body.scenarios.length === 0) throw new Error('Name a suite (suite) or scenario codes (scenarios) in the environment.');
  if (reference) body.reference = String(reference);
  return body;
}

/**
 * After a wait: 'done' (finished), 'again' (still running, or a proxy cut the
 * wait), or 'stop' (refused, or waited too long).
 */
function afterWait({ status, body, tries, maxTries }) {
  if (status === 200 && body?.state === 'finished') return 'done';
  if (tries >= maxTries) return 'stop';
  if (status === 200 || [502, 503, 504].includes(status)) return 'again';
  return 'stop';
}

/** How many waits fit in `minutes` (60 if not a number). */
const maxWaitsOf = minutes => Math.max(1, Math.ceil(((Number(minutes) > 0 ? Number(minutes) : 60) * 60) / WAIT_S));

// One failed check's line.
function failureLine(f) {
  const step = f.step ? f.step + ': ' : '';
  const message = f.message ? ' — ' + f.message : '';
  return `      ✗ ${step}${f.check}${message}`;
}

// A run not passed, then its failed checks.
const runLines = r => [`    ${r.scenario_code}: ${r.verdict || r.state}  ${r.run_url || ''}`.trimEnd(), ...(r.failures || []).map(failureLine)];

/** The results in lines for a person: the verdict, then each run not passed and its failed checks. */
function reportLines(results) {
  const lines = [`Verdict: ${String(results?.verdict).toUpperCase()}`];
  for (const p of results?.providers || []) {
    lines.push(`  ${p.name || p.id}: ${p.verdict || p.state}`);
    for (const r of (p.runs || []).filter(run => run.verdict !== 'passed')) lines.push(...runLines(r));
  }
  return lines;
}

/** A new Idempotency-Key for one test request: a retry of that request sends it again. */
const idempotencyKey = () => 'bruno-' + crypto.randomUUID();

module.exports = {
  ASSERTION_TYPE, TOKEN_PATH, SCOPE, WAIT_S,
  privateKeyOf, algOf, originOf, assertionFor, tokenForm, assertionOf, keepToken, ensureToken,
  providerIdOf, testRequestBody, afterWait, maxWaitsOf, reportLines, idempotencyKey,
};
