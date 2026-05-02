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
const { get, run, encrypt } = require('../../db/db');
const { requireAuth } = require('../middleware/auth');
const { isValidProfile, PROFILES } = require('../../worker/auth-profiles');
const { auditLog } = require('../helpers/shared');

const router = express.Router();
router.use(requireAuth);

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
  const u = get('SELECT * FROM users WHERE id = ?', [req.user.id]);
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

  const updates = [];
  const values  = [];

  if (auth_mode)         { updates.push('auth_mode = ?');             values.push(auth_mode); }
  if (token_url)         { updates.push('token_url = ?');             values.push(token_url.trim()); }
  if (oauth_profile)     { updates.push('oauth_profile = ?');         values.push(oauth_profile); }
  if (oauth_scope !== undefined) {
    updates.push('oauth_scope = ?');
    values.push(oauth_scope ? String(oauth_scope).trim() : null);
  }
  if (oauth_extra !== undefined) {
    updates.push('oauth_extra_enc = ?');
    values.push(oauth_extra ? encrypt(oauth_extra) : null);
  }
  if (oauth_custom_template !== undefined) {
    updates.push('oauth_custom_template = ?');
    values.push(oauth_custom_template || null);
  }
  if (access_token)      { updates.push('access_token_enc = ?');      values.push(encrypt(access_token)); }
  if (client_id)         { updates.push('client_id_enc = ?');         values.push(encrypt(client_id)); }
  if (client_secret)     { updates.push('client_secret_enc = ?');     values.push(encrypt(client_secret)); }
  if (requestor !== undefined) {
    updates.push('requestor_enc = ?');
    values.push(requestor ? encrypt(requestor) : null);
  }
  if (subscription_key !== undefined) {
    updates.push('subscription_key_enc = ?');
    values.push(subscription_key ? encrypt(subscription_key) : null);
  }

  if (updates.length === 0) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'No fields to update.' });
  }

  // Same cache-invalidation rule as the previous company-scoped version: any
  // change to a field fetchToken consumes wipes the cached token.
  const AUTH_FIELDS = new Set([
    'auth_mode = ?', 'token_url = ?', 'access_token_enc = ?',
    'client_id_enc = ?', 'client_secret_enc = ?',
    'oauth_profile = ?', 'oauth_scope = ?', 'oauth_extra_enc = ?',
    'oauth_custom_template = ?'
  ]);
  if (updates.some(u => AUTH_FIELDS.has(u))) {
    updates.push('cached_token_enc = ?');         values.push(null);
    updates.push('cached_token_expires_at = ?');  values.push(null);
  }

  values.push(req.user.id);
  run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);

  const changedFields = updates
    .filter(u => !u.startsWith('cached_'))
    .map(u => u.split(' = ')[0]);
  auditLog(req.user.id, req.user.companyId, req.user.email, `me_credential_update:${changedFields.join(',')}`);

  const updated = get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  return res.json(safeUserCreds(updated));
});

module.exports = router;
