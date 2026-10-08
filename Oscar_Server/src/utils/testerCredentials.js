// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * testerCredentials.js — a tester's OSDM credentials for one company (#540).
 *
 * Credentials and the token cache are kept per (user, company) in
 * tester_credentials: the tester's own company, and each provider they test.
 * Migration 29 copied every user's credentials from the users row into a row
 * for their own company; nothing reads or writes the users.* credential
 * columns any more.
 *
 * credentialsFor() returns the shape the credential consumers have always
 * read (auth_mode, *_enc fields, token cache), plus the user's id, email and
 * role, and user_id / company_id naming the row it came from. A company with
 * no stored row reads as "nothing configured" (bearer, no token): the caller
 * then reports what is missing, as it did for an empty users row.
 */

const { get, run } = require('../db/db');

// Every column a caller may write through setCredentials(). The keys are
// fixed here, never taken from a request.
const CREDENTIAL_COLUMNS = Object.freeze([
  'auth_mode', 'access_token_enc', 'client_id_enc', 'client_secret_enc',
  'token_url', 'oauth_profile', 'oauth_scope', 'oauth_extra_enc', 'oauth_custom_template',
  'cached_token_enc', 'cached_token_expires_at', 'cached_token_cred_fp',
  'requestor_enc', 'subscription_key_enc',
]);
const COLUMN_SET = new Set(CREDENTIAL_COLUMNS);

const EMPTY = Object.freeze({
  auth_mode: 'bearer', oauth_profile: 'oauth2_basic',
  access_token_enc: null, client_id_enc: null, client_secret_enc: null,
  token_url: null, oauth_scope: null, oauth_extra_enc: null, oauth_custom_template: null,
  cached_token_enc: null, cached_token_expires_at: null, cached_token_cred_fp: null,
  requestor_enc: null, subscription_key_enc: null, updated_at: null,
});

/**
 * The credentials of `userId` for `companyId`, or null when the user does not
 * exist. Does not decide whether the user may use the company: callers have
 * done that already (enforceTenant, or the run they are executing).
 */
function credentialsFor(userId, companyId) {
  if (!userId || !companyId) return null;
  const user = get('SELECT id, email, role FROM users WHERE id = ?', [userId]);
  if (!user) return null;
  const row = get('SELECT * FROM tester_credentials WHERE user_id = ? AND company_id = ?', [userId, companyId]);
  return {
    ...EMPTY,
    ...(row || {}),
    id: user.id, email: user.email, role: user.role,
    user_id: user.id, company_id: companyId,
  };
}

/**
 * Write some credential columns of (userId, companyId), creating the row when
 * it is the first write. `fields` maps a column name to its stored value; a
 * name outside CREDENTIAL_COLUMNS throws (a programming error, not input).
 */
function setCredentials(userId, companyId, fields) {
  const names = Object.keys(fields);
  for (const n of names) {
    if (!COLUMN_SET.has(n)) throw new Error(`setCredentials: unknown column ${n}`);
  }
  if (names.length === 0) return;
  const cols = ['user_id', 'company_id', ...names];
  const placeholders = cols.map(() => '?').join(', ');
  const updates = names.map(n => `${n} = excluded.${n}`).concat(["updated_at = datetime('now')"]).join(', ');
  run(
    `INSERT INTO tester_credentials (${cols.join(', ')}) VALUES (${placeholders})
     ON CONFLICT (user_id, company_id) DO UPDATE SET ${updates}`,
    [userId, companyId, ...names.map(n => fields[n])]
  );
}

module.exports = { credentialsFor, setCredentials, CREDENTIAL_COLUMNS };
