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

const { credentialFingerprint, isCurrentForm } = require('../utils/credentialFingerprint');
const { get, encrypt, decrypt } = require('../db/db');
const { setCredentials } = require('../utils/testerCredentials');
const { fetchToken } = require('./auth-profiles');
const { usableUrlRefusal } = require('../utils/urlPolicy');

const TOKEN_CACHE_SAFETY_MARGIN_S = 60;

/**
 * @param {object} userRow  the tester's credentials for one company, from
 *   credentialsFor(userId, companyId) (#540): the token cache is written back
 *   to that (user_id, company_id) row, never to another company's.
 * @param {{info:Function, error:Function}} log  structured logger adapter
 * @param {object} [opts]
 * @param {boolean} [opts.forceRefresh=false]  skip the cached token and force a fresh
 *   fetch from the OAuth server. Used by the `/v1/runs/:runId/refresh-access-token`
 *   loopback endpoint (#204) so a long-running scenario (e.g. expiredBookingTest's
 *   ~15 min wait on Paxone) can guarantee a fresh token before the next request —
 *   without it, the original token may have expired during the wait and the
 *   provider returns `403 not authenticated`, masking the booking-expiry semantics
 *   the test is trying to grade.
 * @param {Function} [opts.onExpiry]  called with the ISO time the token handed
 *   out expires at, when OSCAR knows it (an OAuth token whose provider said
 *   expires_in); never for a static token (#1327).
 * @returns {Promise<string>} a usable access token
 * @throws {Error} on missing credentials or token-fetch failure
 */

const { credentialsEndpointProblem } = require('../utils/credentialEndpoint');

/** Tells the caller when the token expires; a caller that throws changes nothing. */
function tellExpiry(opts, at) {
  if (!at || typeof opts?.onExpiry !== 'function') return;
  try { opts.onExpiry(at); } catch { /* the token is returned all the same */ }
}

async function resolveAccessToken(userRow, log, opts) {
  if (!userRow) throw new Error('User row not found — cannot resolve credentials.');
  const forceRefresh = !!opts?.forceRefresh;
  // Credentials go to the endpoint they were saved for, and to no other
  // (utils/credentialEndpoint.js): no token is asked or sent after a change.
  const endpointProblem = credentialsEndpointProblem(userRow);
  if (endpointProblem) throw new Error(endpointProblem);

  if (userRow.auth_mode === 'oauth2') {
    // Trim the credential pair defensively. A trailing space or newline pasted
    // into the API-Config field would otherwise be encrypted, stored, and sent
    // to the OAuth server verbatim — which rejects it as a wrong secret (401
    // "invalid username or password"), even though the identical value works in a
    // standalone client that trims its inputs. token_url and scope are already
    // trimmed on store (me-credentials.js); we trim the secret pair (and scope/
    // extra) here, at use-time, so credentials saved before this fix are healed
    // without the tester having to re-enter them. (#440)
    const rawClientId     = decrypt(userRow.client_id_enc)     || '';
    const rawClientSecret = decrypt(userRow.client_secret_enc) || '';
    const clientId     = rawClientId.trim();
    const clientSecret = rawClientSecret.trim();
    const scope        = (userRow.oauth_scope || '').trim();
    const extra        = userRow.oauth_extra_enc ? (decrypt(userRow.oauth_extra_enc) || '').trim() : '';
    const tokenUrl     = userRow.token_url;
    const profile      = userRow.oauth_profile || 'oauth2_basic';

    // Surface (without leaking the value) when a credential carried stray
    // whitespace — the single most common cause of "works in my other client,
    // 401 in OSCAR". Names the field only; never the secret. (#440)
    const trimmedFields = [];
    if (rawClientId !== clientId)         trimmedFields.push('client_id');
    if (rawClientSecret !== clientSecret) trimmedFields.push('client_secret');
    if (trimmedFields.length) {
      log.info(`[runner] Auth — stripped leading/trailing whitespace from ${trimmedFields.join(', ')} before sending (a stray space or newline in a pasted credential is the classic cause of a 401 that works in other clients).`);
    }

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

    // #208: fingerprint the credentials so the cached token is reused ONLY while
    // the exact credentials are unchanged. Without this, switching to (e.g.)
    // invalid credentials would silently reuse a still-valid cached token and
    // never exercise the new ones — the run would look like it passed/failed for
    // unrelated reasons. The fingerprint is a keyed digest whose key is not in
    // the database (utils/credentialFingerprint.js); the secret is never stored.
    const credFp = await credentialFingerprint([
      profile, tokenUrl, clientId, clientSecret,
      scope, extra,
      userRow.oauth_custom_template || '',
      userRow.credentials_endpoint || ''
    ]);

    // ── Cache check (per-tester) ─────────────────────────────────────────────
    const now = new Date();
    const expIso = userRow.cached_token_expires_at;
    const cachedExp = expIso ? new Date(expIso) : null;
    const timeValid = cachedExp && !Number.isNaN(cachedExp.getTime()) &&
      (cachedExp.getTime() - now.getTime() > TOKEN_CACHE_SAFETY_MARGIN_S * 1000);
    const fpMatch = userRow.cached_token_cred_fp === credFp;
    if (forceRefresh) {
      log.info(`[runner] Auth — forceRefresh=true; skipping cache and refetching (caller asked for a fresh token).`);
    } else if (timeValid && fpMatch && userRow.cached_token_enc) {
      const remainingS = Math.floor((cachedExp.getTime() - now.getTime()) / 1000);
      log.info(`[runner] Auth — using cached token (user=${userRow.email}, expires in ${remainingS}s, at ${expIso}).`);
      tellExpiry(opts, cachedExp.toISOString());
      return decrypt(userRow.cached_token_enc);
    } else if (timeValid && !fpMatch && userRow.cached_token_cred_fp && !isCurrentForm(userRow.cached_token_cred_fp)) {
      // Kept by a server before 1.11.570: its fingerprint was made another way,
      // so nothing says the credentials changed. Asked again, once.
      log.info(`[runner] Auth — the token was kept by an earlier version of the server; asking for a new one, once.`);
    } else if (timeValid && !fpMatch) {
      log.info(`[runner] Auth — credentials changed since the cached token was issued; refetching with the current credentials.`);
    } else if (cachedExp && !timeValid) {
      log.info(`[runner] Auth — cached token expired or within safety margin (was: ${expIso}); refetching.`);
    }

    // S5: re-check the token URL at use time, with DNS, before the fetch —
    // catches a value stored before this policy existed, or a host name that now
    // resolves to an internal address. The structural rule already ran at save.
    const tokenUrlRefusal = await usableUrlRefusal(tokenUrl, 'token URL');
    if (tokenUrlRefusal) throw new Error(tokenUrlRefusal);

    const result = await fetchToken(profile, {
      tokenUrl, clientId, clientSecret,
      scope, extra,
      customTemplate: userRow.oauth_custom_template || ''
    }, log);
    const accessToken = result.token;
    const expiresAt = result.expiresIn > 0 ? new Date(now.getTime() + result.expiresIn * 1000).toISOString() : null;

    // Persist the cache only when the vendor told us how long the token is
    // good for. Anything else risks reusing a token past its real expiry,
    // which would surface as a mid-run 401.
    //
    // Cache persistence is BEST-EFFORT (#208 regression): the token we just
    // fetched is valid and must be returned even if writing the cache fails
    // (e.g. a missing column on an un-migrated DB). A cache-write error must
    // never fail an otherwise-successful auth — degrade to "no caching" instead.
    try {
      // The cache belongs to the (user, company) row the credentials came from.
      const ownerUser = userRow.user_id;
      const ownerCompany = userRow.company_id;
      if (!ownerUser || !ownerCompany) throw new Error('credentials carry no (user, company) to cache against');
      if (expiresAt) {
        const newExp = expiresAt;
        setCredentials(ownerUser, ownerCompany, { cached_token_enc: encrypt(accessToken), cached_token_expires_at: newExp, cached_token_cred_fp: credFp });
        log.info(`[runner] Auth — token cached until ${newExp}.`);
      } else {
        // Clear any stale cache so we don't accidentally serve an old token.
        setCredentials(ownerUser, ownerCompany, { cached_token_enc: null, cached_token_expires_at: null, cached_token_cred_fp: null });
      }
    } catch (e) {
      log.error(`[runner] Auth — token obtained but caching it failed (continuing without cache): ${e?.message ? e.message : e}`);
    }
    tellExpiry(opts, expiresAt);
    return accessToken;
  }

  // Bearer mode
  const accessToken = decrypt(userRow.access_token_enc);
  if (!accessToken) throw new Error('Bearer token not configured. Set it in your profile.');
  return accessToken;
}

/**
 * Drop the cached token of a credentials row when it is still `token`, the
 * token a run used and the provider refused with 401 (#680). Without this, the
 * next runs keep sending the same refused token until it expires (a provider
 * that restarted with a new signing key refuses every token it issued before).
 * A token the cache no longer holds (the watchdog or a refresh replaced it) is
 * left alone. Synchronous on purpose: no other write can come between the read
 * and the clear. Returns true when the cache was cleared.
 *
 * @param {object} userRow  the credentials the run resolved its token from
 * @param {string} token    the token the run sent
 * @returns {boolean}
 */
function dropCachedToken(userRow, token) {
  if (userRow?.auth_mode !== 'oauth2' || !token || !userRow.user_id || !userRow.company_id) return false;
  const row = get('SELECT cached_token_enc FROM tester_credentials WHERE user_id = ? AND company_id = ?',
    [userRow.user_id, userRow.company_id]);
  if (!row?.cached_token_enc || decrypt(row.cached_token_enc) !== token) return false;
  setCredentials(userRow.user_id, userRow.company_id, { cached_token_enc: null, cached_token_expires_at: null, cached_token_cred_fp: null });
  return true;
}

module.exports = { resolveAccessToken, dropCachedToken };
