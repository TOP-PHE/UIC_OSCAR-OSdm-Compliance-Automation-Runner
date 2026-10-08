// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * me-credentials.js — per-user OSDM credential management.
 *
 * Each tester maintains their own auth credentials against the company's
 * OSDM API. The company row holds shared infrastructure (api_base, datafile);
 * everything below this comment is per-user.
 *
 * GET   /v1/me/credentials  — sanitised profile (no secret values)
 * PATCH /v1/me/credentials  — update credentials, encrypt secrets, clear cache
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { encrypt } = require('../../db/db');
const { requireAuth, isPlatformRole } = require('../middleware/auth');
const { enforceTenant, scopedCompanyId } = require('../middleware/tenant');
const { credentialsFor, setCredentials } = require('../../utils/testerCredentials');
const { isValidProfile, PROFILES } = require('../../worker/auth-profiles');
const { auditLog } = require('../helpers/shared');
const { storedUrlRefusal } = require('../../utils/urlPolicy');

const router = express.Router();
// #540: credentials are per (user, company). The company is the one the
// request acts in: the own company, or a provider named with X-Provider-Id /
// ?provider_id= that enforceTenant admitted (404 otherwise).
// A platform user (administrator, certifier) is not a tenant member: it keeps
// one set, for its own company, used for any company it names (as before
// #540), so no company is resolved for it here.
const credentialsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many requests in a short window.' }
});
router.use(credentialsLimiter);
router.use(requireAuth, (req, res, next) => (isPlatformRole(req.user.role) ? next() : enforceTenant(req, res, next)));

// Sanitised projection — booleans for "is set?" instead of the encrypted
// values themselves. Mirrors the pattern company.js used to use for company-
// scoped credentials before they moved here in v12.
function safeUserCreds(u) {
  return {
    auth_mode:               u.auth_mode || 'bearer',
    token_url:               u.token_url || null,
    oauth_profile:           u.oauth_profile || 'oauth2_basic',
    oauth_scope:             u.oauth_scope || null,
    oauth_custom_template:   u.oauth_custom_template || null,
    cached_token_expires_at: u.cached_token_expires_at || null,
    has_token:               !!u.access_token_enc,
    has_client_id:           !!u.client_id_enc,
    has_client_secret:       !!u.client_secret_enc,
    has_extra:               !!u.oauth_extra_enc,
    has_cached_token:        !!u.cached_token_enc,
    has_requestor:           !!u.requestor_enc,
    has_subscription_key:    !!u.subscription_key_enc
  };
}

router.get('/', (req, res) => {
  const u = credentialsFor(req.user.id, scopedCompanyId(req));
  if (!u) return res.status(404).json({ status: 404, title: 'Not Found' });
  return res.json(safeUserCreds(u));
});

router.patch('/', (req, res) => {
  const {
    auth_mode, token_url,
    oauth_profile, oauth_scope, oauth_extra, oauth_custom_template,
    access_token, client_id, client_secret,
    requestor, subscription_key
  } = req.body || {};

  if (auth_mode && !['bearer', 'oauth2'].includes(auth_mode)) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'auth_mode must be "bearer" or "oauth2".' });
  }
  if (oauth_profile && !isValidProfile(oauth_profile)) {
    return res.status(400).json({
      status: 400, title: 'Bad Request',
      detail: `oauth_profile must be one of: ${PROFILES.join(', ')}.`
    });
  }
  if (oauth_custom_template) {
    try { JSON.parse(oauth_custom_template); }
    catch (err) {
      return res.status(400).json({
        status: 400, title: 'Bad Request',
        detail: `oauth_custom_template must be valid JSON: ${err.message}`
      });
    }
  }
  // S5: the token URL is fetched server-side, so it must be a public https
  // address — not loopback, the private network or a Docker service name.
  // Structural only here; access-token.js re-checks, with DNS, before it fetches.
  if (token_url) {
    const urlRefusal = storedUrlRefusal(String(token_url).trim(), 'token URL');
    if (urlRefusal) {
      return res.status(400).json({ status: 400, title: 'Bad Request', detail: urlRefusal });
    }
  }

  const fields = {};

  if (auth_mode)         fields.auth_mode = auth_mode;
  if (token_url)         fields.token_url = token_url.trim();
  if (oauth_profile)     fields.oauth_profile = oauth_profile;
  if (oauth_scope !== undefined) fields.oauth_scope = oauth_scope ? String(oauth_scope).trim() : null;
  if (oauth_extra !== undefined) fields.oauth_extra_enc = oauth_extra ? encrypt(String(oauth_extra).trim()) : null;
  if (oauth_custom_template !== undefined) fields.oauth_custom_template = oauth_custom_template || null;
  // For credentials we accept three intentions:
  //   key absent              → don't touch the field (keep existing)
  //   key present, truthy     → encrypt and store the new value
  //   key present, null/""    → clear the field (issue #16: tester wants to
  //                             remove credentials at the end of a campaign)
  // We .trim() every pasted secret before encrypting (as token_url/oauth_scope
  // already are): a trailing space or newline from a copy-paste would otherwise
  // be sent to the provider verbatim and rejected as a wrong secret — a 401 that
  // works fine in a client that trims its inputs. (#440)
  if (access_token  !== undefined) fields.access_token_enc  = access_token  ? encrypt(String(access_token).trim())  : null;
  if (client_id     !== undefined) fields.client_id_enc     = client_id     ? encrypt(String(client_id).trim())     : null;
  if (client_secret !== undefined) fields.client_secret_enc = client_secret ? encrypt(String(client_secret).trim()) : null;
  if (requestor !== undefined) fields.requestor_enc = requestor ? encrypt(String(requestor).trim()) : null;
  if (subscription_key !== undefined) fields.subscription_key_enc = subscription_key ? encrypt(String(subscription_key).trim()) : null;

  const changedFields = Object.keys(fields);
  if (changedFields.length === 0) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'No fields to update.' });
  }

  // Same cache-invalidation rule as the previous company-scoped version: any
  // change to a field fetchToken consumes wipes the cached token.
  const AUTH_FIELDS = new Set([
    'auth_mode', 'token_url', 'access_token_enc',
    'client_id_enc', 'client_secret_enc',
    'oauth_profile', 'oauth_scope', 'oauth_extra_enc',
    'oauth_custom_template'
  ]);
  if (changedFields.some(f => AUTH_FIELDS.has(f))) {
    fields.cached_token_enc = null;
    fields.cached_token_expires_at = null;
  }

  // Written for the company this request acts in (#540), never another's.
  const companyId = scopedCompanyId(req);
  setCredentials(req.user.id, companyId, fields);

  auditLog(req.user.id, companyId, req.user.email, `me_credential_update:${changedFields.join(',')}`);

  return res.json(safeUserCreds(credentialsFor(req.user.id, companyId)));
});

module.exports = router;
