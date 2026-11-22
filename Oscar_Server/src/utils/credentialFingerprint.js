// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * credentialFingerprint.js — are a tester's credentials the ones that obtained
 * the access token OSCAR kept?
 *
 * worker/access-token.js keeps each tester's token until it expires and uses
 * it again only while the credentials are the same (#208). To tell, it keeps a
 * fingerprint of them beside the token (tester_credentials.cached_token_cred_fp).
 *
 * The fingerprint is a keyed digest (HMAC-SHA-256). Its key is made from the
 * server's ENCRYPTION_KEY, which is not in the database: a copy of the
 * database alone gives no way to try a guessed secret against it. Until
 * 1.11.570 it was a plain SHA-256 of the same values.
 *
 * A fingerprint starts with FORM. One kept by an earlier version does not, so
 * it never equals a new one: the token is asked again once, and isCurrentForm()
 * lets the caller say why.
 */

const crypto = require('node:crypto');

const FORM = 'v2:';
const PURPOSE = 'oscar:credential-fingerprint:v2';
// The values are joined by a character none of them can hold in a form field.
// Written with fromCharCode on purpose: typed as an escape, an editing tool
// once stored the character itself, and git then read the file that held it
// as binary (no diff in a review).
const SEPARATOR = String.fromCharCode(0);

let kept = null;   // { hex, key }: the key is derived once per ENCRYPTION_KEY

/** The key of the fingerprints, derived from the server's encryption key. */
function fingerprintKey(env = process.env) {
  const hex = typeof env.ENCRYPTION_KEY === 'string' ? env.ENCRYPTION_KEY : '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes).');
  }
  if (kept?.hex !== hex) {
    kept = { hex, key: crypto.createHmac('sha256', Buffer.from(hex, 'hex')).update(PURPOSE).digest() };
  }
  return kept.key;
}

/**
 * The fingerprint of a list of credential values, in their order. A value
 * that is missing counts as empty text, as it always did.
 */
function credentialFingerprint(values, env = process.env) {
  const text = values.map(v => (v === null || v === undefined ? '' : String(v))).join(SEPARATOR);
  return FORM + crypto.createHmac('sha256', fingerprintKey(env)).update(text).digest('hex');
}

/** True for a fingerprint this version made (an earlier one has no FORM). */
function isCurrentForm(fingerprint) {
  return typeof fingerprint === 'string' && fingerprint.startsWith(FORM);
}

module.exports = { credentialFingerprint, isCurrentForm, fingerprintKey, FORM };
