// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * credentialTest.js — "Test my credentials" in API Config (#872).
 *
 * Tests what is saved for one (user, company or provider), in two steps:
 * 1. a token, by the path a run takes (resolveAccessToken, forced fresh), so
 *    the token cache is written as a run would write it, and nothing else;
 * 2. one GET {api_base}/versions with that token and the headers a run sends
 *    (Requestor, subscription key, the dedicated headers).
 *
 * The token never leaves this module: the answer says whether one was
 * obtained, how long it lives, and what the provider made of it. The token
 * request is logged by auth-profiles.js with its default-deny mask (#437),
 * to the server log only; no log line is returned.
 */

const { get, decrypt } = require('../db/db');
const { credentialsFor } = require('../utils/testerCredentials');
const { resolveAccessToken } = require('../worker/access-token');
const { buildTesterHeaders, mergeDedicatedHeaders, stripTrailingSlashes } = require('../utils/osdm-client');
const { usableUrlRefusal } = require('../utils/urlPolicy');
const { frameworkConfigOf } = require('../api/helpers/configurationStore');
const O = require('../utils/credentialTestOutcome');
const log = require('../utils/logger').child({ module: 'credential-test' });

const API_TIMEOUT_MS = 15000;
const MAX_ANSWER_BYTES = 64 * 1024;

// Every secret of a credentials row, decrypted, so that none can be echoed
// back in a message.
function secretsOf(userRow) {
  return ['access_token_enc', 'client_id_enc', 'client_secret_enc', 'oauth_extra_enc', 'requestor_enc', 'subscription_key_enc']
    .map((column) => {
      try { return userRow?.[column] ? decrypt(userRow[column]) : null; } catch { return null; }
    })
    .filter(Boolean);
}

// Seconds left of the token the resolver just cached, when the token
// endpoint said how long it lives.
function cachedLifetime(userId, companyId) {
  const row = credentialsFor(userId, companyId);
  const at = row?.cached_token_expires_at ? new Date(row.cached_token_expires_at).getTime() : Number.NaN;
  return Number.isNaN(at) ? null : Math.floor((at - Date.now()) / 1000);
}

// Step 1: a token, the way a run gets one.
async function tokenStep(userId, companyId) {
  const userRow = credentialsFor(userId, companyId);
  const mode = userRow?.auth_mode === 'oauth2' ? 'oauth2' : 'bearer';
  const profile = mode === 'oauth2' ? (userRow.oauth_profile || 'oauth2_basic') : null;
  const result = { ok: false, mode, profile };
  let token = null;
  try {
    token = await resolveAccessToken(userRow, { info: (m) => log.debug(m), error: (m) => log.warn(m) }, { forceRefresh: true });
  } catch (err) {
    result.error = O.cleanTokenError(err?.message, secretsOf(userRow));
    return { result, token: null, userRow };
  }
  result.ok = true;
  const lifetime = mode === 'oauth2' ? cachedLifetime(userId, companyId) : O.bearerExpiry(token);
  if (lifetime !== null) result.expiresInSeconds = lifetime;
  return { result, token, userRow };
}

// The answer, read up to `max` bytes; the rest is not downloaded.
async function readCapped(res, max) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks).toString('utf8');
    const part = Buffer.from(value).subarray(0, max - size);
    chunks.push(part);
    size += part.length;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).toString('utf8');
}

// What a failed fetch was, in a word: never its message, which may name the
// address with its query.
function failureKind(err) {
  if (err?.name === 'AbortError') return `No answer within ${API_TIMEOUT_MS / 1000} s.`;
  const code = err?.cause?.code;
  if (typeof code === 'string' && /^[A-Z_]{2,40}$/.test(code)) return `No answer (${code}).`;
  return 'No answer: the request could not be sent.';
}

// One GET {apiBase}/versions. { status, text } or { error }.
async function askVersions(apiBase, token, headers) {
  const url = `${stripTrailingSlashes(String(apiBase))}/versions`;
  const refusal = await usableUrlRefusal(url, 'OSDM endpoint');
  if (refusal) return { refused: refusal };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json', ...headers },
      redirect: 'manual',
      signal: controller.signal,
    });
    let text = '';
    try { text = await readCapped(res, MAX_ANSWER_BYTES); } catch { text = ''; }
    return { status: res.status, text };
  } catch (err) {
    return { error: failureKind(err) };
  } finally {
    clearTimeout(timer);
  }
}

// Step 2: the provider's answer to the token.
async function apiStep(companyId, userRow, token) {
  const company = get('SELECT id, api_base, extra_headers FROM companies WHERE id = ?', [companyId]);
  if (!company?.api_base) return { ok: false, outcome: 'no_endpoint' };
  if (!token) return { ok: false, outcome: 'not_tried' };
  const headers = mergeDedicatedHeaders(buildTesterHeaders(userRow), company, token);
  const answer = await askVersions(company.api_base, token, headers);
  if (answer.refused) return { ok: false, outcome: 'url_refused', error: answer.refused };
  if (answer.error) return { ok: false, outcome: 'no_answer', error: answer.error };
  const api = O.classifyVersionsAnswer(answer.status, answer.text);
  const frameworkVersion = frameworkConfigOf(companyId)?.osdmVersion;
  if (typeof frameworkVersion === 'string' && frameworkVersion.trim()) {
    api.frameworkVersion = frameworkVersion.trim();
    if (api.versions) api.frameworkVersionListed = api.versions.some(v => O.sameVersion(v, api.frameworkVersion));
  }
  return api;
}

/**
 * Test the saved credentials of `userId` for `companyId`.
 * @returns {Promise<{ token: object, api: object, outcome: string, summary: string }>}
 */
async function testCredentials(userId, companyId) {
  const { result: token, token: value, userRow } = await tokenStep(userId, companyId);
  const api = await apiStep(companyId, userRow, value);
  const result = { token, api };
  return { ...result, outcome: O.outcomeOf(result), summary: O.summaryOf(result) };
}

module.exports = { testCredentials, API_TIMEOUT_MS, MAX_ANSWER_BYTES };
