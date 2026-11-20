// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * config.js — where the MCP server finds OSCAR, and as whom (#503 PR 3, #1342).
 *
 *   OSCAR_URL          the OSCAR address, https://… (http:// only for this machine)
 * and either
 *   OSCAR_API_KEY      a read-only API key made on OSCAR's API Keys page
 * or a Company API account (#1342), which signs in with private_key_jwt:
 *   OSCAR_CLIENT_ID    the account's client id (API Accounts page)
 *   OSCAR_PRIVATE_KEY  its private key, PEM (line breaks may be written \n)
 *
 * No secret is ever written anywhere by this program: not in an answer, not in
 * an error, not in a log line. A message about a refused configuration names
 * the variable, never its value.
 */

const crypto = require('node:crypto');
const { algOf } = require('./auth');

const KEY_PATTERN = /^oscar_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The OSCAR origin from OSCAR_URL: { origin } or { error }. */
function originOf(value) {
  if (typeof value !== 'string' || value.trim() === '') return { error: 'OSCAR_URL is not set.' };
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return { error: 'OSCAR_URL is not an address (expected https://<oscar host>).' };
  }
  if (url.username || url.password) return { error: 'OSCAR_URL must not hold a user name or password.' };
  if (url.search || url.hash) return { error: 'OSCAR_URL must not hold a query or a fragment.' };
  if (url.pathname !== '/' && url.pathname !== '') return { error: 'OSCAR_URL must be the OSCAR address only, without a path.' };
  if (url.protocol === 'https:') return { origin: url.origin };
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return { origin: url.origin };
  return { error: 'OSCAR_URL must start with https:// (http:// is accepted for this machine only).' };
}

/** The key from OSCAR_API_KEY: { key } or { error }. The error never quotes it. */
function keyOf(value) {
  if (typeof value !== 'string' || value === '') return { error: 'OSCAR_API_KEY is not set.' };
  const key = value.trim();
  if (!KEY_PATTERN.test(key)) return { error: 'OSCAR_API_KEY is not an OSCAR API key (oscar_<8 hex>_<43 characters>).' };
  return { key };
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A Company API account from OSCAR_CLIENT_ID and OSCAR_PRIVATE_KEY: { clientId, privateKey } or { error }. */
function accountOf(clientId, pem) {
  if (typeof clientId !== 'string' || !UUID.test(clientId.trim())) return { error: 'OSCAR_CLIENT_ID is not a client id (the account\'s id on OSCAR\'s API Accounts page).' };
  if (typeof pem !== 'string' || pem.trim() === '') return { error: 'OSCAR_PRIVATE_KEY is not set.' };
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey({ key: pem.includes('\\n') ? pem.split('\\n').join('\n') : pem, format: 'pem' });
  } catch {
    return { error: 'OSCAR_PRIVATE_KEY is not a PEM private key.' };
  }
  if (!algOf(privateKey)) return { error: 'OSCAR_PRIVATE_KEY must be EC P-256 or RSA of 2048 bits or more.' };
  return { clientId: clientId.trim(), privateKey };
}

/** { origin, key } or { origin, clientId, privateKey } from an environment, or { errors: [...] }. */
function configFrom(env) {
  const origin = originOf(env.OSCAR_URL);
  const asAccount = env.OSCAR_CLIENT_ID !== undefined || env.OSCAR_PRIVATE_KEY !== undefined;
  if (asAccount && env.OSCAR_API_KEY !== undefined) {
    return { errors: [origin.error, 'Set OSCAR_API_KEY, or OSCAR_CLIENT_ID and OSCAR_PRIVATE_KEY, not both.'].filter(Boolean) };
  }
  const who = asAccount ? accountOf(env.OSCAR_CLIENT_ID, env.OSCAR_PRIVATE_KEY) : keyOf(env.OSCAR_API_KEY);
  const errors = [origin.error, who.error].filter(Boolean);
  if (errors.length) return { errors };
  return asAccount
    ? { origin: origin.origin, clientId: who.clientId, privateKey: who.privateKey }
    : { origin: origin.origin, key: who.key };
}

module.exports = { configFrom, originOf, keyOf, accountOf, KEY_PATTERN };
