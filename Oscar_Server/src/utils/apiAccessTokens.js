// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * apiAccessTokens.js — the access tokens OSCAR's token endpoint gives a
 * Company API account (#1342, D2), and their check on /v1/api.
 *
 * A token is a JWT signed HS256 with a key of its own, derived from
 * JWT_SECRET for this use only (HMAC-SHA256 of a fixed label): a session
 * token never verifies as an access token, nor an access token as a session
 * (requireAuth verifies with JWT_SECRET itself, and sessionUser() refuses the
 * account's role anyway). Claims: iss "oscar", aud "oscar-api", sub the
 * account, scope, jti, iat, exp (15 minutes), and `key`, the id of the
 * account's key the assertion was signed with (#1367). The account is read
 * again at each call (apiCaller.js): suspended, deleted, a token issued
 * before its suspension, or a token whose key has been revoked since, and the
 * token is refused. A token issued before #1367 names no key and lives out
 * its quarter of an hour.
 */

const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const LIFETIME_S = 15 * 60;
const AUDIENCE = 'oscar-api';
const ISSUER = 'oscar';
const SCOPES = Object.freeze(['runs:read', 'runs:write']);

function signingKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  return crypto.createHmac('sha256', secret).update('oscar-api-access-token/v1').digest();
}

/**
 * The scopes asked: { scopes } (every scope when none is asked), or { error }.
 * A scope OSCAR does not have is invalid_scope (RFC 6749 §5.2).
 */
function scopesOf(value) {
  if (value === undefined || value === null || value === '') return { scopes: [...SCOPES] };
  if (typeof value !== 'string' || value.length > 200) return { error: 'invalid_scope' };
  const asked = [...new Set(value.split(' ').filter(Boolean))];
  if (asked.length === 0 || asked.some(s => !SCOPES.includes(s))) return { error: 'invalid_scope' };
  return { scopes: asked };
}

/**
 * OSCAR's own address, as clients name it in an assertion's aud: APP_URL in
 * production (else null: the token endpoint answers 503, as the reset link
 * does), the request's own address elsewhere. The Host header is the
 * client's to write, so production never reads it.
 */
function oscarBase(req, env = process.env) {
  if (env.APP_URL) {
    let base = String(env.APP_URL);
    while (base.endsWith('/')) base = base.slice(0, -1);
    return base;
  }
  if (env.NODE_ENV === 'production') return null;
  return `${req.protocol}://${req.get('host')}`;
}

const TOKEN_PATH = '/v1/api/oauth/token';

/**
 * A new access token for `accountId` with `scopes`: { token, expiresIn }.
 * `keyId` is the account's key that signed the assertion: the token names it,
 * so that revoking that key ends this token and no other.
 */
function issue(accountId, scopes, now = new Date(), keyId = null) {
  const iat = Math.floor(now.getTime() / 1000);
  const claims = { sub: accountId, scope: scopes.join(' '), jti: crypto.randomUUID(), iat, exp: iat + LIFETIME_S };
  if (typeof keyId === 'string' && keyId !== '') claims.key = keyId;
  const token = jwt.sign(
    claims,
    signingKey(),
    { algorithm: 'HS256', audience: AUDIENCE, issuer: ISSUER, header: { typ: 'at+jwt', alg: 'HS256' } },
  );
  return { token, expiresIn: LIFETIME_S };
}

/** The claims of a valid access token, or null. Never throws. */
function verify(token, now = new Date()) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  try {
    const claims = jwt.verify(token, signingKey(), {
      algorithms: ['HS256'], audience: AUDIENCE, issuer: ISSUER,
      clockTimestamp: Math.floor(now.getTime() / 1000),
    });
    if (typeof claims.sub !== 'string' || typeof claims.scope !== 'string') return null;
    // A `key` that is not a text is no token of ours: refused, not read as "no key".
    if (claims.key !== undefined && (typeof claims.key !== 'string' || claims.key === '')) return null;
    return {
      accountId: claims.sub,
      scopes: claims.scope.split(' ').filter(s => SCOPES.includes(s)),
      iat: claims.iat,
      jti: claims.jti,
      keyId: claims.key ?? null,
    };
  } catch {
    return null;
  }
}

module.exports = { LIFETIME_S, AUDIENCE, ISSUER, SCOPES, TOKEN_PATH, scopesOf, oscarBase, issue, verify };
