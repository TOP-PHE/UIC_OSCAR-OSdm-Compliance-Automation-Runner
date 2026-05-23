// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * access-token.js — resolve a usable OSDM access token for a tester.
 *
 * Extracted from runner.js (issue #157) so the Bruno run worker and the
 * server-side Timetable Discovery endpoint share ONE implementation of
 * "give me a bearer token for this user" — including the per-tester token
 * cache. The caller supplies a `log` adapter ({ info, error }) and decides
 * what to do with thrown errors (the runner writes the run FAILED; the
 * discovery route returns a 502).
 *
 * Behaviour mirrors the original runner logic exactly:
 *   • auth_mode 'oauth2' → validate fields, reuse a cached token when it has
 *     >60 s of life left, otherwise fetch via the vendor profile and persist
 *     the cache when (and only when) the vendor returned expires_in.
 *   • auth_mode 'bearer' → decrypt the stored token.
 */

const { run: dbRun, encrypt, decrypt } = require('../db/db');
const { fetchToken } = require('./auth-profiles');

const TOKEN_CACHE_SAFETY_MARGIN_S = 60;

/**
 * @param {object} userRow  a row from the `users` table (carries credentials)
 * @param {{info:Function, error:Function}} log  structured logger adapter
 * @returns {Promise<string>} a usable access token
 * @throws {Error} on missing credentials or token-fetch failure
 */
async function resolveAccessToken(userRow, log) {
  if (!userRow) throw new Error('User row not found — cannot resolve credentials.');

  if (userRow.auth_mode === 'oauth2') {
    const clientId     = decrypt(userRow.client_id_enc);
    const clientSecret = decrypt(userRow.client_secret_enc);
    const tokenUrl     = userRow.token_url;
    const profile      = userRow.oauth_profile || 'oauth2_basic';

    // Field-level "what's missing" message — operator doesn't have to play
    // guess-which-credential after fixing one and getting the same error.
    const missing = [];
    if (!tokenUrl)     missing.push('token_url');
    if (!clientId)     missing.push('client_id');
    if (!clientSecret) missing.push('client_secret');
    if (profile === 'sqills_extension' && !userRow.oauth_extra_enc) missing.push('extra credential (Basic auth value)');
    if (profile === 'custom' && !userRow.oauth_custom_template)     missing.push('custom request template');
    if (missing.length > 0) {
      throw new Error(`Auth profile "${profile}" is missing: ${missing.join(', ')}. Set ${missing.length > 1 ? 'them' : 'it'} in your profile (Profile → API Configuration).`);
    }

    // ── Cache check (per-tester) ─────────────────────────────────────────────
    const now = new Date();
    const expIso = userRow.cached_token_expires_at;
    const cachedExp = expIso ? new Date(expIso) : null;
    const cachedValid = cachedExp && !isNaN(cachedExp) &&
      (cachedExp.getTime() - now.getTime() > TOKEN_CACHE_SAFETY_MARGIN_S * 1000);
    if (cachedValid && userRow.cached_token_enc) {
      const remainingS = Math.floor((cachedExp.getTime() - now.getTime()) / 1000);
      log.info(`[runner] Auth — using cached token (user=${userRow.email}, expires in ${remainingS}s, at ${expIso}).`);
      return decrypt(userRow.cached_token_enc);
    }
    if (cachedExp && !cachedValid) {
      log.info(`[runner] Auth — cached token expired or within safety margin (was: ${expIso}); refetching.`);
    }

    const result = await fetchToken(profile, {
      tokenUrl, clientId, clientSecret,
      scope:          userRow.oauth_scope || '',
      extra:          userRow.oauth_extra_enc ? decrypt(userRow.oauth_extra_enc) : '',
      customTemplate: userRow.oauth_custom_template || ''
    }, log);
    const accessToken = result.token;

    // Persist the cache only when the vendor told us how long the token is
    // good for. Anything else risks reusing a token past its real expiry,
    // which would surface as a mid-run 401.
    if (result.expiresIn && result.expiresIn > 0) {
      const newExp = new Date(now.getTime() + result.expiresIn * 1000).toISOString();
      dbRun(
        'UPDATE users SET cached_token_enc = ?, cached_token_expires_at = ? WHERE id = ?',
        [encrypt(accessToken), newExp, userRow.id]
      );
      log.info(`[runner] Auth — token cached until ${newExp}.`);
    } else {
      // Clear any stale cache so we don't accidentally serve an old token.
      dbRun(
        'UPDATE users SET cached_token_enc = NULL, cached_token_expires_at = NULL WHERE id = ?',
        [userRow.id]
      );
    }
    return accessToken;
  }

  // Bearer mode
  const accessToken = decrypt(userRow.access_token_enc);
  if (!accessToken) throw new Error('Bearer token not configured. Set it in your profile.');
  return accessToken;
}

module.exports = { resolveAccessToken };
