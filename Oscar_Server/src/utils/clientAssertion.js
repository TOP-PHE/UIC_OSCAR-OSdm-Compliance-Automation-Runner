// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * clientAssertion.js — OAuth 2.0 client authentication by `private_key_jwt`
 * for Company API accounts (#1342, decision D2; RFC 7523 §2.2 and §3, RFC
 * 7521 §4.2, OpenID Connect Core §9).
 *
 * The company makes a key pair and gives OSCAR the public key only, as a PEM
 * file (never fetched from an address the client names). At each token
 * request its CI signs a short assertion with the private key:
 *   header  { alg: ES256 | PS256, kid?: the key's fingerprint }
 *   claims  { iss = sub = client_id, aud = OSCAR's token endpoint (or OSCAR's
 *             address), iat, exp (at most 5 minutes after iat), jti (once) }
 * OSCAR holds no secret: a leak of its database gives nothing that can call
 * as the client.
 *
 * Pure: no database, no clock of its own (`now` is given).
 */

const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const ALGORITHMS = Object.freeze(['ES256', 'PS256']);
const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const MAX_LIFETIME_S = 300;        // exp - iat: "about a minute", five at most
const CLOCK_TOLERANCE_S = 60;      // the client's clock is not OSCAR's
const MAX_PEM = 8 * 1024;
const MAX_KEYS = 2;                // two at once: the old and the new during a rotation

/**
 * A public key as uploaded: { pem, alg, fingerprint } or { error }. EC P-256
 * (ES256) or RSA of 2048 bits or more (PS256); never a private key, never a
 * certificate chain or anything else.
 */
function publicKeyOf(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_PEM) {
    return { error: 'public_key must be a PEM public key ("-----BEGIN PUBLIC KEY-----"), at most 8 KB.' };
  }
  if (/PRIVATE KEY/.test(text)) {
    return { error: 'This is a private key. Send the public key only: the private key never leaves your company.' };
  }
  let key;
  try {
    key = crypto.createPublicKey({ key: text, format: 'pem' });
  } catch {
    return { error: 'public_key must be a PEM public key ("-----BEGIN PUBLIC KEY-----").' };
  }
  let alg = null;
  if (key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1') alg = 'ES256';
  if (key.asymmetricKeyType === 'rsa' && (key.asymmetricKeyDetails?.modulusLength || 0) >= 2048) alg = 'PS256';
  if (!alg) return { error: 'The key must be EC P-256 (ES256) or RSA of 2048 bits or more (PS256).' };
  const der = key.export({ type: 'spki', format: 'der' });
  return {
    pem: key.export({ type: 'spki', format: 'pem' }),
    alg,
    fingerprint: crypto.createHash('sha256').update(der).digest('base64url'),
  };
}

/** The assertion's claims, read without trusting them: { header, payload } or null. */
function peek(assertion) {
  if (typeof assertion !== 'string' || assertion.length > 8192) return null;
  try {
    const decoded = jwt.decode(assertion, { complete: true });
    return decoded && typeof decoded.payload === 'object' ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * Why an assertion's times are refused, or null (#1367). The five minutes are
 * counted from OSCAR's clock (`nowS`, in seconds): `exp` and `iat` are both the
 * client's to write, so their difference alone bounds nothing. With no `iat`,
 * or one written later than now, an assertion expiring years ahead used to
 * be accepted until then.
 *   - exp at most MAX_LIFETIME_S after now, plus the tolerance for the
 *     client's clock;
 *   - iat, when there, a number, not later than now plus that tolerance, and
 *     at most MAX_LIFETIME_S before exp.
 * That it has not expired yet is jwt.verify()'s to say, with the signature.
 */
function lifetimeRefusal(payload, nowS) {
  if (!Number.isFinite(payload.exp)) return 'no exp';
  if (payload.exp - nowS > MAX_LIFETIME_S + CLOCK_TOLERANCE_S) return 'expires more than five minutes from now';
  if (payload.iat === undefined) return null;
  if (!Number.isFinite(payload.iat)) return 'iat is not a number';
  if (payload.iat - nowS > CLOCK_TOLERANCE_S) return 'issued in the future';
  if (payload.exp - payload.iat > MAX_LIFETIME_S) return 'lives longer than five minutes';
  return null;
}

/**
 * Checks a client assertion against the client's keys. Returns
 * { ok: true, clientId, jti, exp, keyId } or { ok: false, why }. `why` is for
 * the log; the client is only told invalid_client.
 *   keys:      [{ id, pem, alg, fingerprint }] of the client, active only
 *   audiences: the values aud may hold (the token endpoint, OSCAR's address)
 */
function verifyAssertion(assertion, { clientId, keys, audiences, now }) {
  const decoded = peek(assertion);
  if (!decoded) return { ok: false, why: 'not a JWT' };
  const { header, payload } = decoded;
  if (!ALGORITHMS.includes(header.alg)) return { ok: false, why: `alg ${header.alg}` };
  if (payload.iss !== clientId || payload.sub !== clientId) return { ok: false, why: 'iss or sub is not the client' };
  if (typeof payload.jti !== 'string' || payload.jti.length < 8 || payload.jti.length > 200) return { ok: false, why: 'no jti' };
  const nowS = Math.floor(now.getTime() / 1000);
  const times = lifetimeRefusal(payload, nowS);
  if (times) return { ok: false, why: times };
  const candidates = keys.filter(k => k.alg === header.alg && (!header.kid || header.kid === k.fingerprint));
  for (const key of candidates) {
    try {
      jwt.verify(assertion, key.pem, {
        algorithms: [key.alg],
        audience: audiences,
        issuer: clientId,
        subject: clientId,
        clockTolerance: CLOCK_TOLERANCE_S,
        clockTimestamp: nowS,
      });
      return { ok: true, clientId, jti: payload.jti, exp: payload.exp, keyId: key.id };
    } catch (err) {
      if (err?.name !== 'JsonWebTokenError' || err.message !== 'invalid signature') {
        return { ok: false, why: err?.message || 'refused' };
      }
    }
  }
  return { ok: false, why: candidates.length ? 'signature' : 'no key of that kind' };
}

module.exports = { ALGORITHMS, ASSERTION_TYPE, MAX_LIFETIME_S, CLOCK_TOLERANCE_S, MAX_KEYS, publicKeyOf, peek, lifetimeRefusal, verifyAssertion };
