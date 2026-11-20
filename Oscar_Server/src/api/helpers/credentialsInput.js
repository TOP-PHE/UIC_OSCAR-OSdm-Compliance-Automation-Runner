// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * credentialsInput.js — what a save of OSDM credentials sends, checked and
 * turned into stored fields, and what is shown of them. Shared by a tester's
 * own credentials (PATCH /v1/me/credentials) and those a Test Manager keeps
 * for a Company API account (#1342): one rule for both.
 */

const { encrypt, get } = require('../../db/db');
const { credentialsFor, setCredentials } = require('../../utils/testerCredentials');
const { endpointOrigin, credentialsEndpointProblem } = require('../../utils/credentialEndpoint');
const { isValidProfile, PROFILES } = require('../../worker/auth-profiles');
const { storedUrlRefusal } = require('../../utils/urlPolicy');
const keptPods = require('../../worker/keptPods');

// Sanitised projection — booleans for "is set?" instead of the encrypted
// values themselves.
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
    has_subscription_key:    !!u.subscription_key_enc,
    // The endpoint changed since the save: nothing is sent until saved again.
    credentials_endpoint:    u.credentials_endpoint || null,
    endpoint_changed:        !!credentialsEndpointProblem(u)
  };
}

/** The refusal of a body's settings, as a sentence, or null. */
function settingsRefusal({ auth_mode, oauth_profile, oauth_custom_template, token_url }) {
  if (auth_mode && !['bearer', 'oauth2'].includes(auth_mode)) return 'auth_mode must be "bearer" or "oauth2".';
  if (oauth_profile && !isValidProfile(oauth_profile)) return `oauth_profile must be one of: ${PROFILES.join(', ')}.`;
  if (oauth_custom_template) {
    try { JSON.parse(oauth_custom_template); } catch (err) { return `oauth_custom_template must be valid JSON: ${err.message}`; }
  }
  // S5: the token URL is fetched server-side, so it must be a public https
  // address — not loopback, the private network or a Docker service name.
  // Structural only here; access-token.js re-checks, with DNS, before it fetches.
  if (token_url) return storedUrlRefusal(String(token_url).trim(), 'token URL');
  return null;
}

// Any change to a field fetchToken consumes wipes the cached token.
const AUTH_FIELDS = new Set([
  'auth_mode', 'token_url', 'access_token_enc',
  'client_id_enc', 'client_secret_enc',
  'oauth_profile', 'oauth_scope', 'oauth_extra_enc',
  'oauth_custom_template'
]);

/**
 * The stored fields a save's body asks for: { fields, changed } or { error }.
 * For a secret, three intentions: key absent = keep, truthy = encrypt and
 * store, null or "" = clear (issue #16). Every pasted value is trimmed (#440).
 */
function credentialFieldsOf(body) {
  const b = body || {};
  const refusal = settingsRefusal(b);
  if (refusal) return { error: refusal };
  const secret = (value) => (value ? encrypt(String(value).trim()) : null);
  const fields = {};
  if (b.auth_mode)     fields.auth_mode = b.auth_mode;
  if (b.token_url)     fields.token_url = String(b.token_url).trim();
  if (b.oauth_profile) fields.oauth_profile = b.oauth_profile;
  if (b.oauth_scope !== undefined) fields.oauth_scope = b.oauth_scope ? String(b.oauth_scope).trim() : null;
  if (b.oauth_extra !== undefined) fields.oauth_extra_enc = secret(b.oauth_extra);
  if (b.oauth_custom_template !== undefined) fields.oauth_custom_template = b.oauth_custom_template || null;
  if (b.access_token  !== undefined) fields.access_token_enc  = secret(b.access_token);
  if (b.client_id     !== undefined) fields.client_id_enc     = secret(b.client_id);
  if (b.client_secret !== undefined) fields.client_secret_enc = secret(b.client_secret);
  if (b.requestor !== undefined) fields.requestor_enc = secret(b.requestor);
  if (b.subscription_key !== undefined) fields.subscription_key_enc = secret(b.subscription_key);

  const changed = Object.keys(fields);
  if (changed.length === 0) return { error: 'No fields to update.' };
  if (changed.some(f => AUTH_FIELDS.has(f))) {
    fields.cached_token_enc = null;
    fields.cached_token_expires_at = null;
  }
  return { fields, changed };
}

/**
 * Stores `fields` as the credentials of `userId` for `companyId`, tied to that
 * company's endpoint as it is now (utils/credentialEndpoint.js), and stops any
 * run pod kept for that user there (#1309). Returns what is shown of them.
 */
function saveCredentialFields(userId, companyId, fields) {
  const company = get('SELECT api_base FROM companies WHERE id = ?', [companyId]);
  setCredentials(userId, companyId, { ...fields, credentials_endpoint: endpointOrigin(company?.api_base) });
  keptPods.revokeUser(userId, companyId);
  return safeUserCreds(credentialsFor(userId, companyId));
}

module.exports = { safeUserCreds, credentialFieldsOf, saveCredentialFields };
