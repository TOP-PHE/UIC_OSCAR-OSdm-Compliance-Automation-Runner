// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * tokens.js — access tokens the simulator issues and checks.
 *
 * A token is `payload.signature`, both base64url. The payload names the
 * provider and the client the token was issued for, and when it ends. The
 * signature is an HMAC-SHA-256 under a key drawn when the process starts and
 * kept nowhere: a restart ends every token.
 *
 * Nothing is stored per token, so issuing them costs no memory.
 */

const crypto = require('node:crypto');

function createTokenService({ key = crypto.randomBytes(32), now = Date.now } = {}) {
  const sign = (payload) => crypto.createHmac('sha256', key).update(payload).digest('base64url');

  function issue(provider, clientId, lifetimeSeconds) {
    const payload = Buffer.from(JSON.stringify({
      p: provider,
      c: clientId,
      e: Math.floor(now() / 1000) + lifetimeSeconds,
      // Two tokens issued in the same second for the same client still differ.
      n: crypto.randomBytes(6).toString('base64url'),
    })).toString('base64url');
    return `${payload}.${sign(payload)}`;
  }

  // The token's provider and client, or null when it is not one of ours, has
  // been altered, or has ended.
  function verify(token) {
    if (typeof token !== 'string' || token.length > 1024) return null;
    const dot = token.indexOf('.');
    if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
    const payload = token.slice(0, dot);
    const given = Buffer.from(token.slice(dot + 1), 'utf8');
    const expected = Buffer.from(sign(payload), 'utf8');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    let claims;
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (!claims || typeof claims.p !== 'string' || typeof claims.c !== 'string' || typeof claims.e !== 'number') return null;
    if (claims.e <= Math.floor(now() / 1000)) return null;
    return { provider: claims.p, clientId: claims.c, expiresAt: claims.e };
  }

  return { issue, verify };
}

module.exports = { createTokenService };
