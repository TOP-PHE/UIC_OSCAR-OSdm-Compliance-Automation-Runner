// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * auth.js — the bearer a call to OSCAR carries (#1342 PR 6): a read-only API
 * key as it is, or the access token of a Company API account, asked of
 * OSCAR's token endpoint with OAuth 2.0 client credentials and
 * private_key_jwt (RFC 7523).
 *
 * The assertion is signed here with node:crypto (no dependency): ES256 for an
 * EC P-256 key, PS256 for an RSA key; iss = sub = the client id, aud = the
 * token endpoint, one minute of life, a fresh jti. The token asked holds
 * runs:read only: this server reads, it never launches a test. It is kept
 * until a minute before it expires. Neither the private key, the assertion
 * nor the token is ever written by this program.
 */

const crypto = require('node:crypto');
const { version } = require('../package.json');

const TOKEN_PATH = '/v1/api/oauth/token';
const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const TIMEOUT_MS = 30 * 1000;
const SCOPE = 'runs:read';

const b64url = (value) => Buffer.from(value).toString('base64url');

/** The JWS algorithm of a private key: ES256, PS256, or null. */
function algOf(key) {
  if (key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1') return 'ES256';
  if (key.asymmetricKeyType === 'rsa' && (key.asymmetricKeyDetails?.modulusLength || 0) >= 2048) return 'PS256';
  return null;
}

/** A signed client assertion for the account. */
function assertionFor({ clientId, privateKey, origin, now = Date.now(), jti = crypto.randomUUID() }) {
  const alg = algOf(privateKey);
  if (!alg) throw new Error('The private key must be EC P-256 or RSA of 2048 bits or more.');
  const iat = Math.floor(now / 1000);
  const data = `${b64url(JSON.stringify({ alg, typ: 'JWT' }))}.${b64url(JSON.stringify({
    iss: clientId, sub: clientId, aud: origin + TOKEN_PATH, iat, exp: iat + 60, jti,
  }))}`;
  const options = alg === 'ES256'
    ? { key: privateKey, dsaEncoding: 'ieee-p1363' }
    : { key: privateKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 };
  return `${data}.${crypto.sign('sha256', Buffer.from(data), options).toString('base64url')}`;
}

/**
 * The bearer for a call: { bearer } or { failure } (a sentence, never a
 * secret). A key is used as it is; an account's token is asked, then kept in
 * `config.cache` until a minute before it expires.
 */
async function bearerFor(config, { fetchImpl = fetch, now = Date.now(), timeoutMs = TIMEOUT_MS } = {}) {
  if (config.key) return { bearer: config.key };
  const cache = config.cache || {};
  if (cache.token && cache.until > now) return { bearer: cache.token };
  let response;
  try {
    response = await fetchImpl(new URL(TOKEN_PATH, config.origin), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': `oscar-mcp/${version}` },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_assertion_type: ASSERTION_TYPE,
        client_assertion: assertionFor({ clientId: config.clientId, privateKey: config.privateKey, origin: config.origin, now }),
        scope: SCOPE,
      }).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { failure: timedOut ? 'OSCAR\'s token endpoint did not answer in time.' : 'OSCAR\'s token endpoint could not be reached.' };
  }
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (response.status !== 200 || typeof body?.access_token !== 'string') {
    const said = typeof body?.error === 'string' ? ` (${body.error.slice(0, 40)})` : '';
    return { failure: `OSCAR refused the token request: HTTP ${response.status}${said}. Check OSCAR_CLIENT_ID, the key OSCAR holds for it, and the clock.` };
  }
  const lifetime = Number.isFinite(body.expires_in) ? body.expires_in : 900;
  config.cache = { token: body.access_token, until: now + Math.max(0, lifetime - 60) * 1000 };
  return { bearer: body.access_token };
}

module.exports = { bearerFor, assertionFor, algOf, TOKEN_PATH, SCOPE };
