// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * config.js — where the MCP server finds OSCAR, and with which key (#503 PR 3).
 *
 * Two environment variables, nothing else:
 *   OSCAR_URL      the OSCAR address, https://… (http:// only for this machine)
 *   OSCAR_API_KEY  a read-only API key made on OSCAR's API Keys page
 *
 * The key is never written anywhere by this program: not in an answer, not in
 * an error, not in a log line. A message about a refused configuration names
 * the variable, never its value.
 */

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

/** { origin, key } from an environment, or { errors: [...] }. */
function configFrom(env) {
  const origin = originOf(env.OSCAR_URL);
  const key = keyOf(env.OSCAR_API_KEY);
  const errors = [origin.error, key.error].filter(Boolean);
  if (errors.length) return { errors };
  return { origin: origin.origin, key: key.key };
}

module.exports = { configFrom, originOf, keyOf, KEY_PATTERN };
