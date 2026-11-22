// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * api-sign-in.test.js — #1367: an assertion's lifetime is counted from
 * OSCAR's clock, and an access token names the key it was obtained with.
 *
 * utils/clientAssertion.js and utils/apiAccessTokens.js, both pure. The
 * routes' side (a revoked key ends its tokens) is in
 * tests/integration/api-oauth.test.js.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-api-sign-in';

const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const CA = require('../../src/utils/clientAssertion');
const Tokens = require('../../src/utils/apiAccessTokens');

const NOW = new Date('2026-11-22T10:00:00Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);
const YEARS = 10 * 365 * 24 * 3600;

describe('lifetimeRefusal(): the five minutes are counted from now', () => {
  const refused = (claims) => CA.lifetimeRefusal(claims, NOW_S);

  test('the usual assertion: signed now, for a minute', () => {
    expect(refused({ iat: NOW_S, exp: NOW_S + 60 })).toBeNull();
    expect(refused({ iat: NOW_S, exp: NOW_S + CA.MAX_LIFETIME_S })).toBeNull();
  });

  test('no exp, or one that is not a number', () => {
    for (const exp of [undefined, null, '1795341600', Number.NaN, Infinity]) expect(refused({ iat: NOW_S, exp })).toBe('no exp');
  });

  test('exp far ahead is refused whatever iat says, or with none', () => {
    const exp = NOW_S + YEARS;
    expect(refused({ exp })).toBe('expires more than five minutes from now');
    expect(refused({ iat: exp - 60, exp })).toBe('expires more than five minutes from now');
    expect(refused({ iat: NOW_S, exp })).toBe('expires more than five minutes from now');
  });

  test('the limit: five minutes plus the tolerance for the client\'s clock', () => {
    const limit = CA.MAX_LIFETIME_S + CA.CLOCK_TOLERANCE_S;
    expect(refused({ exp: NOW_S + limit })).toBeNull();
    expect(refused({ exp: NOW_S + limit + 1 })).toBe('expires more than five minutes from now');
  });

  test('iat later than the tolerance is refused; within it, accepted', () => {
    expect(refused({ iat: NOW_S + CA.CLOCK_TOLERANCE_S, exp: NOW_S + 120 })).toBeNull();
    expect(refused({ iat: NOW_S + CA.CLOCK_TOLERANCE_S + 1, exp: NOW_S + 120 })).toBe('issued in the future');
  });

  test('iat that is not a number is refused, not read as none', () => {
    for (const iat of ['now', null, Number.NaN, {}]) expect(refused({ iat, exp: NOW_S + 60 })).toBe('iat is not a number');
  });

  test('exp more than five minutes after iat is still refused', () => {
    // Signed four minutes ago for six minutes: two minutes left, six in all.
    expect(refused({ iat: NOW_S - 240, exp: NOW_S + 120 })).toBe('lives longer than five minutes');
    expect(refused({ iat: NOW_S - 240, exp: NOW_S + 60 })).toBeNull();
  });
});

describe('verifyAssertion() with a real key', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const key = { id: 'key-1', ...CA.publicKeyOf(publicKey.export({ type: 'spki', format: 'pem' })) };
  const clientId = crypto.randomUUID();
  const aud = 'https://oscar.test/v1/api/oauth/token';
  // noTimestamp: jsonwebtoken would write its own iat, and remove one given.
  const sign = (claims) => jwt.sign({ iss: clientId, sub: clientId, aud, jti: crypto.randomUUID(), ...claims }, privateKey,
    { algorithm: 'ES256', noTimestamp: claims.iat === undefined });
  const check = (claims, at = NOW) => CA.verifyAssertion(sign(claims), { clientId, keys: [key], audiences: [aud], now: at });

  test('signed now for a minute: accepted, and the key named', () => {
    expect(check({ iat: NOW_S, exp: NOW_S + 60 })).toMatchObject({ ok: true, keyId: 'key-1' });
  });

  test.each([
    ['no iat, exp in ten years', { exp: NOW_S + YEARS }],
    ['iat a minute before an exp in ten years', { iat: NOW_S + YEARS - 60, exp: NOW_S + YEARS }],
    ['iat now, exp in ten years', { iat: NOW_S, exp: NOW_S + YEARS }],
  ])('%s: refused, though rightly signed', (_name, claims) => {
    const result = check(claims);
    expect(result.ok).toBe(false);
    expect(result.why).toMatch(/five minutes/);
  });

  test('the long assertion is refused years later too, until its last five minutes', () => {
    const claims = { iat: NOW_S + YEARS - 60, exp: NOW_S + YEARS };
    expect(check(claims, new Date((NOW_S + YEARS / 2) * 1000)).ok).toBe(false);
    // Checked a minute before it expires it is an ordinary assertion.
    expect(check(claims, new Date((NOW_S + YEARS - 30) * 1000)).ok).toBe(true);
  });

  test('an expired assertion is still refused', () => {
    expect(check({ iat: NOW_S - 400, exp: NOW_S - 100 }).ok).toBe(false);
  });
});

describe('an access token names the key it was obtained with', () => {
  const account = crypto.randomUUID();

  test('issued with a key: the claim, read back', () => {
    const { token } = Tokens.issue(account, ['runs:read'], NOW, 'key-1');
    expect(jwt.decode(token).key).toBe('key-1');
    expect(Tokens.verify(token, NOW)).toMatchObject({ accountId: account, keyId: 'key-1', scopes: ['runs:read'] });
  });

  test('issued without one, as before #1367: no claim, keyId null', () => {
    const { token } = Tokens.issue(account, ['runs:read'], NOW);
    expect(jwt.decode(token)).not.toHaveProperty('key');
    expect(Tokens.verify(token, NOW).keyId).toBeNull();
    for (const empty of ['', null, undefined, 42]) {
      expect(jwt.decode(Tokens.issue(account, ['runs:read'], NOW, empty).token)).not.toHaveProperty('key');
    }
  });

  test('a key claim that is not a text is no token of OSCAR\'s', () => {
    const signingKey = crypto.createHmac('sha256', process.env.JWT_SECRET).update('oscar-api-access-token/v1').digest();
    for (const key of [42, '', null, { id: 'key-1' }, ['key-1']]) {
      const forged = jwt.sign({ sub: account, scope: 'runs:read', jti: 'j', iat: NOW_S, exp: NOW_S + 900, key }, signingKey,
        { algorithm: 'HS256', audience: Tokens.AUDIENCE, issuer: Tokens.ISSUER });
      expect(Tokens.verify(forged, NOW)).toBeNull();
    }
  });
});
