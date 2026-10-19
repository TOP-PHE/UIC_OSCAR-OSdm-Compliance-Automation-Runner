// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * credentialTestOutcome.js — what "Test my credentials" tells (#872). Pure.
 *
 * The route (services/credentialTest.js) gets a token the way a run does, then
 * sends one GET {api_base}/versions. This module reads what came back:
 * - classifyVersionsAnswer(): the provider's answer to GET /versions;
 * - cleanTokenError(): the resolver's message, without a secret in it;
 * - bearerExpiry(): the seconds left of a bearer token that is a JWT;
 * - summaryOf(): one sentence for the page.
 *
 * Nothing here holds or returns a token.
 */

// At most this many versions of the answer are listed, each this long.
const MAX_VERSIONS = 20;
const MAX_VERSION_LENGTH = 40;
// The resolver's message is cut to this length.
const MAX_ERROR_LENGTH = 500;

/**
 * The OSDM versions of a GET /versions answer (OSDM 3.8: an array of
 * ApiVersion, each with a required `version` string). null when the answer is
 * not such a list.
 */
function versionsOf(text) {
  let body;
  try { body = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(body)) return null;
  return body
    .map(v => (v && typeof v.version === 'string' ? v.version.trim().slice(0, MAX_VERSION_LENGTH) : ''))
    .filter(Boolean)
    .slice(0, MAX_VERSIONS);
}

/** "3.8" and "3.8.0" are the same version. */
function sameVersion(a, b) {
  const parts = v => String(v || '').trim().split('.').map(Number);
  const x = parts(a);
  const y = parts(b);
  if (x.some(Number.isNaN) || y.some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return false;
  }
  return true;
}

/**
 * The provider's answer to GET /versions.
 * @param {number} status  the HTTP status
 * @param {string} text    the answer, as read (at most 64 KB)
 * @returns {{ ok: boolean, outcome: string, status: number, versions?: string[], versionsReadable?: boolean }}
 *   outcome: accepted (2xx), token_refused (401, 403), not_offered (404, 405,
 *   501: the token was not refused, the provider has no /versions),
 *   redirect (3xx, not followed), unexpected (anything else).
 */
function classifyVersionsAnswer(status, text) {
  if (status >= 200 && status < 300) {
    const versions = versionsOf(text);
    return { ok: true, outcome: 'accepted', status, versions: versions || [], versionsReadable: versions !== null };
  }
  if (status === 401 || status === 403) return { ok: false, outcome: 'token_refused', status };
  if (status === 404 || status === 405 || status === 501) return { ok: true, outcome: 'not_offered', status };
  if (status >= 300 && status < 400) return { ok: false, outcome: 'redirect', status };
  return { ok: false, outcome: 'unexpected', status };
}

/**
 * The resolver's message, safe to show. Two adapters quote the token
 * endpoint's answer after " Body: " when they find no token in it, and that
 * answer may hold a token under another name: it is cut there. Every secret
 * given is replaced by ***, in case an answer quoted it back.
 */
function cleanTokenError(message, secrets = []) {
  let text = String(message || 'The token could not be obtained.');
  const quoted = text.indexOf(' Body: ');
  if (quoted !== -1) text = text.slice(0, quoted);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) text = text.split(secret).join('***');
  }
  return text.slice(0, MAX_ERROR_LENGTH);
}

/**
 * Seconds left before a bearer token expires, when it is a JWT naming `exp`;
 * negative when it has expired; null when it says nothing. Reads the claim
 * only; the token itself is never returned.
 */
function bearerExpiry(token, now = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (typeof claims?.exp !== 'number' || !Number.isFinite(claims.exp)) return null;
    return Math.floor(claims.exp - now / 1000);
  } catch {
    return null;
  }
}

/** The audit outcome of a test: the token's failure, else the API's outcome. */
function outcomeOf(result) {
  if (!result.token.ok) return 'token_failed';
  return result.api.outcome;
}

// The sentence for each API outcome, once the token was obtained.
function apiSentence(api) {
  switch (api.outcome) {
    case 'accepted': {
      let listed = 'Its answer lists no OSDM version.';
      if (api.versionsReadable === false) listed = 'Its answer is not a list of OSDM versions.';
      else if (api.versions?.length) listed = `It lists OSDM ${api.versions.join(', ')}.`;
      let framework = '';
      if (api.frameworkVersion && api.versions?.length) {
        framework = api.frameworkVersionListed
          ? ` Your Test Framework's version ${api.frameworkVersion} is among them.`
          : ` Your Test Framework's version ${api.frameworkVersion} is not among them.`;
      }
      return `The provider accepted the token (GET /versions answered ${api.status}). ${listed}${framework}`;
    }
    case 'token_refused':
      return `The provider refused the token: GET /versions answered ${api.status}.`;
    case 'not_offered':
      return `The token was not refused, but the provider does not offer GET /versions (it answered ${api.status}).`;
    case 'redirect':
      return `GET /versions answered ${api.status}, a redirect. It was not followed: check the endpoint.`;
    case 'unexpected':
      return `GET /versions answered ${api.status}.`;
    case 'no_endpoint':
      return 'No OSDM endpoint is saved here, so the API was not called.';
    default:
      return api.error || 'The API could not be reached.';
  }
}

/** One sentence that says what the test found. */
function summaryOf(result) {
  const { token, api } = result;
  if (!token.ok) {
    const endpoint = api.outcome === 'no_endpoint' ? ' No OSDM endpoint is saved here either.' : '';
    return `No token: ${token.error}${endpoint}`;
  }
  return apiSentence(api);
}

module.exports = {
  classifyVersionsAnswer, versionsOf, sameVersion, cleanTokenError, bearerExpiry, outcomeOf, summaryOf,
  MAX_VERSIONS,
};
