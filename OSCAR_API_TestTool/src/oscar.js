// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * oscar.js — talking to OSCAR's API as a Company API account (#1342).
 *
 * Signing in: OAuth 2.0 client credentials with private_key_jwt (RFC 7523).
 * The assertion is signed here with node:crypto (ES256 for an EC P-256 key,
 * PS256 for an RSA key of 2048 bits or more): iss = sub = the client id,
 * aud = OSCAR's token endpoint, one minute of life, a fresh jti. The token is
 * kept until two minutes before it expires, then asked again.
 *
 * Nothing secret is ever printed or written: not the private key, not the
 * assertion, not the token. Errors name what OSCAR said (status and detail).
 */

const crypto = require('node:crypto');

const TOKEN_PATH = '/v1/api/oauth/token';
const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const CALL_TIMEOUT_MS = 90 * 1000;           // a long poll waits 60 s at most
const REFRESH_BEFORE_MS = 2 * 60 * 1000;

class OscarError extends Error {
  constructor(message, status = null, body = null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const b64url = (value) => Buffer.from(value).toString('base64url');

/** The JWS algorithm of a private key: ES256, PS256, or null. */
function algOf(key) {
  if (key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1') return 'ES256';
  if (key.asymmetricKeyType === 'rsa' && (key.asymmetricKeyDetails?.modulusLength || 0) >= 2048) return 'PS256';
  return null;
}

/** A private key from PEM text; throws a plain sentence when it is not one. */
function privateKeyOf(pem) {
  let key;
  try {
    key = crypto.createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    throw new OscarError('The private key is not a PEM private key.');
  }
  if (!algOf(key)) throw new OscarError('The private key must be EC P-256 or RSA of 2048 bits or more.');
  return key;
}

/** A signed client assertion for the account. */
function assertionFor({ clientId, privateKey, origin, now = Date.now(), jti = crypto.randomUUID() }) {
  const alg = algOf(privateKey);
  const iat = Math.floor(now / 1000);
  const data = `${b64url(JSON.stringify({ alg, typ: 'JWT' }))}.${b64url(JSON.stringify({
    iss: clientId, sub: clientId, aud: origin + TOKEN_PATH, iat, exp: iat + 60, jti,
  }))}`;
  const options = alg === 'ES256'
    ? { key: privateKey, dsaEncoding: 'ieee-p1363' }
    : { key: privateKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 };
  return `${data}.${crypto.sign('sha256', Buffer.from(data), options).toString('base64url')}`;
}

/** OSCAR's origin from an address: https, or http for this machine only. */
function originOf(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new OscarError('--oscar is not an address (https://<oscar host>).'); }
  if (url.pathname !== '/' && url.pathname !== '') throw new OscarError('--oscar is the OSCAR address only, without a path.');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new OscarError('--oscar must start with https:// (http:// is accepted for this machine only).');
  }
  return url.origin;
}

/**
 * A client of OSCAR's API for one account: token() and call(method, path, …).
 * `fetchImpl` and `now` are for the tests.
 */
function clientFor({ origin, clientId, privateKey, scope = 'runs:read runs:write', fetchImpl = fetch, now = () => Date.now() }) {
  let kept = null;

  async function send(url, init) {
    try {
      return await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(CALL_TIMEOUT_MS), ...init });
    } catch (e) {
      const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      throw new OscarError(timedOut ? `OSCAR did not answer within ${CALL_TIMEOUT_MS / 1000} s.` : `OSCAR could not be reached (${e?.cause?.code || e?.message || 'network error'}).`);
    }
  }

  async function token() {
    if (kept && kept.until > now()) return kept.value;
    const res = await send(new URL(TOKEN_PATH, origin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_assertion_type: ASSERTION_TYPE,
        client_assertion: assertionFor({ clientId, privateKey, origin, now: now() }),
        scope,
      }).toString(),
    });
    const body = await res.json().catch(() => null);
    if (res.status !== 200 || typeof body?.access_token !== 'string') {
      const described = body?.error_description ? ': ' + body.error_description : '';
      const said = body?.error ? ' ' + body.error + described : '';
      throw new OscarError(`OSCAR refused the token request (HTTP ${res.status}).${said}`, res.status, body);
    }
    const lifetime = Number.isFinite(body.expires_in) ? body.expires_in : 900;
    kept = { value: body.access_token, until: now() + Math.max(0, lifetime * 1000 - REFRESH_BEFORE_MS) };
    return kept.value;
  }

  /** One call: the parsed JSON answer, or the text with `as: 'text'`; throws OscarError on a refusal. */
  async function call(method, path, { body, headers = {}, as = 'json' } = {}) {
    const res = await send(new URL(path, origin), {
      method,
      headers: {
        Authorization: `Bearer ${await token()}`,
        Accept: as === 'json' ? 'application/json' : '*/*',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status >= 300 && res.status < 400) throw new OscarError(`OSCAR answered with a redirect (HTTP ${res.status}): check --oscar.`, res.status);
    if (as === 'text' && res.ok) return { status: res.status, body: await res.text() };
    const parsed = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = parsed?.detail || parsed?.title || '';
      throw new OscarError(`${method} ${path.split('?')[0]}: HTTP ${res.status}${detail ? ' — ' + detail : ''}`, res.status, parsed);
    }
    return { status: res.status, body: parsed };
  }

  return { token, call };
}

module.exports = { clientFor, assertionFor, privateKeyOf, originOf, algOf, OscarError, TOKEN_PATH };
