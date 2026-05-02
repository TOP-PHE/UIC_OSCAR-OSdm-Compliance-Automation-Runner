// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * auth-profiles.js — pluggable token-fetch adapters
 *
 * Different OSDM vendors require very different shapes for "fetch us an
 * access token." This module owns the small adapter table and the shared
 * HTTP/timeout/error-handling plumbing so runner.js doesn't have to grow
 * a giant switch.
 *
 * Supported profiles:
 *   'oauth2_basic'      — RFC 6749 client_credentials, Authorization: Basic
 *   'oauth2_post'       — RFC 6749 client_credentials, credentials in body
 *   'paxone_json'       — Paxone's POST {accountName, accountSecret}
 *   'sqills_extension'  — Sqills custom grant_type URI + Basic + JSON body
 *   'custom'            — user-supplied JSON request template
 *
 * Each adapter is async, takes (ctx, runId, log) where:
 *   ctx = { tokenUrl, clientId, clientSecret, scope, extra, customTemplate }
 *   log = { info(msg, meta), error(msg, meta) }   (thin wrapper around runner's logEvent)
 * and returns a string access token.
 *
 * Error policy: the *request* body NEVER hits the log path (it carries the
 * client secret). The *response* body of a failed token call IS logged
 * (truncated to 500 chars) — RFC 6749 §5.2 error responses don't echo the
 * secret, and surfacing them is what makes misconfiguration self-diagnosable.
 */

const FETCH_TIMEOUT_MS = 15000;
const PROFILES = ['oauth2_basic', 'oauth2_post', 'paxone_json', 'sqills_extension', 'custom'];

function isValidProfile(p) {
  return PROFILES.includes(p);
}

// ── Shared HTTP wrapper ─────────────────────────────────────────────────────
// Every adapter funnels through this. Keeps timeout + error capture + RFC
// 6749 §5.2 parsing consistent across profiles.
async function _doFetch({ method, url, headers, body }, label, log) {
  log.info(`[runner] ${label} — ${method} ${url}`);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { method, headers, body, signal: controller.signal });
  } catch (err) {
    clearTimeout(t);
    if (err.name === 'AbortError') {
      const msg = `${label} request timed out after ${FETCH_TIMEOUT_MS / 1000}s (${url})`;
      log.error(`[runner] ${msg}`);
      throw new Error(msg);
    }
    log.error(`[runner] ${label} — network error: ${err.message}`);
    throw err;
  }
  clearTimeout(t);

  if (!res.ok) {
    let summary = '';
    try {
      const text = await res.text();
      try {
        const parsed = JSON.parse(text);
        if (parsed && (parsed.error || parsed.error_description)) {
          summary = `${parsed.error || 'unknown_error'}${parsed.error_description ? ` — ${parsed.error_description}` : ''}`;
        } else {
          summary = text;
        }
      } catch (_) {
        summary = text;
      }
      summary = summary.slice(0, 500);
    } catch (_) { /* body read failed; status alone */ }

    const msg = `${label} request failed — HTTP ${res.status}${summary ? `: ${summary}` : ''}`;
    log.error(`[runner] ${msg}`, { http_status: res.status });
    throw new Error(msg);
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    const msg = `${label} response was not valid JSON — ${err.message}`;
    log.error(`[runner] ${msg}`, { http_status: res.status });
    throw new Error(msg);
  }
  return { json, status: res.status };
}

// ── Templating for the 'custom' profile ─────────────────────────────────────
// Substitute {{client_id}}, {{client_secret}}, {{scope}}, {{extra}} into a
// string. We deliberately do NOT support arbitrary expressions or filters —
// this is config, not a programming language.
function _substitute(str, ctx) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/\{\{\s*client_id\s*\}\}/g,     ctx.clientId     || '')
    .replace(/\{\{\s*client_secret\s*\}\}/g, ctx.clientSecret || '')
    .replace(/\{\{\s*scope\s*\}\}/g,         ctx.scope        || '')
    .replace(/\{\{\s*extra\s*\}\}/g,         ctx.extra        || '');
}

function _substituteDeep(value, ctx) {
  if (typeof value === 'string') return _substitute(value, ctx);
  if (Array.isArray(value))      return value.map(v => _substituteDeep(v, ctx));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = _substituteDeep(value[k], ctx);
    return out;
  }
  return value;
}

function _firstToken(json, fields) {
  for (const f of fields) {
    if (json && typeof json[f] === 'string' && json[f]) return json[f];
  }
  return null;
}

// Extract the token lifetime in seconds from a parsed token-endpoint response.
// Returns null when the vendor didn't include any usable expires_in field —
// the runner treats null as "don't cache" rather than guessing.
function _expiresIn(json) {
  if (!json || typeof json !== 'object') return null;
  const candidates = ['expires_in', 'expiresIn', 'ExpiresIn'];
  for (const k of candidates) {
    const v = json[k];
    if (typeof v === 'number' && v > 0 && Number.isFinite(v)) return Math.floor(v);
    if (typeof v === 'string' && /^\d+$/.test(v)) {
      const n = parseInt(v, 10);
      if (n > 0) return n;
    }
  }
  return null;
}

// ── Adapters ────────────────────────────────────────────────────────────────

async function _oauth2Basic(ctx, log) {
  const { tokenUrl, clientId, clientSecret, scope } = ctx;
  const body = new URLSearchParams({ grant_type: 'client_credentials' });
  if (scope) body.set('scope', scope);
  const headers = {
    'Authorization': `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    'Content-Type':  'application/x-www-form-urlencoded',
    'Accept':        'application/json'
  };
  const { json } = await _doFetch({ method: 'POST', url: tokenUrl, headers, body }, 'OAuth2[basic]', log);
  if (!json.access_token) throw new Error('OAuth2[basic] response did not contain access_token.');
  return { token: json.access_token, expiresIn: _expiresIn(json) };
}

async function _oauth2Post(ctx, log) {
  const { tokenUrl, clientId, clientSecret, scope } = ctx;
  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     clientId,
    client_secret: clientSecret
  });
  if (scope) body.set('scope', scope);
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept':       'application/json'
  };
  const { json } = await _doFetch({ method: 'POST', url: tokenUrl, headers, body }, 'OAuth2[post]', log);
  if (!json.access_token) throw new Error('OAuth2[post] response did not contain access_token.');
  return { token: json.access_token, expiresIn: _expiresIn(json) };
}

async function _paxoneJson(ctx, log) {
  const { tokenUrl, clientId, clientSecret } = ctx;
  // Per the vendor doc: POST JSON { accountName, accountSecret }. The doc
  // didn't show the response shape, so probe a few common field names.
  const body = JSON.stringify({ accountName: clientId, accountSecret: clientSecret });
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
  const { json } = await _doFetch({ method: 'POST', url: tokenUrl, headers, body }, 'Paxone', log);
  const tok = _firstToken(json, ['access_token', 'token', 'accessToken', 'Token']);
  if (!tok) {
    throw new Error(
      'Paxone response did not contain a recognised token field ' +
      '(tried access_token, token, accessToken, Token). Body: ' +
      JSON.stringify(json).slice(0, 200)
    );
  }
  return { token: tok, expiresIn: _expiresIn(json) };
}

async function _sqillsExtension(ctx, log) {
  const { tokenUrl, clientId, clientSecret, extra } = ctx;
  if (!extra) {
    throw new Error('Sqills profile requires the "Extra credential" field (the pre-encoded Basic auth value).');
  }
  // Sqills layers a Basic auth header on top of body credentials with a
  // custom grant_type URI. The Basic value is provided as opaque pre-encoded
  // text in `extra` — Sqills hands it to integrators as a single string.
  const body = JSON.stringify({
    grant_type: 'https://com.sqills.s3.oauth.agent',
    username:   clientId,
    password:   clientSecret
  });
  const headers = {
    // `extra` may already include the literal "Basic " prefix; tolerate both.
    'Authorization': /^Basic\s/i.test(extra) ? extra : `Basic ${extra}`,
    'Content-Type':  'application/json',
    'Accept':        'application/json'
  };
  const { json } = await _doFetch({ method: 'POST', url: tokenUrl, headers, body }, 'Sqills', log);
  if (!json.access_token) throw new Error('Sqills response did not contain access_token.');
  return { token: json.access_token, expiresIn: _expiresIn(json) };
}

async function _custom(ctx, log) {
  const { tokenUrl, customTemplate } = ctx;
  if (!customTemplate) {
    throw new Error('Custom profile requires a JSON template (Profile → API Configuration → Custom request template).');
  }
  let tpl;
  try {
    tpl = typeof customTemplate === 'string' ? JSON.parse(customTemplate) : customTemplate;
  } catch (err) {
    throw new Error(`Custom template is not valid JSON: ${err.message}`);
  }
  const method = (tpl.method || 'POST').toUpperCase();
  const headers = _substituteDeep(tpl.headers || {}, ctx);
  let body;
  if (tpl.body !== undefined) {
    const fmt = (tpl.body_format || 'json').toLowerCase();
    if (fmt === 'form') {
      // body must be an object after substitution
      const flat = typeof tpl.body === 'string' ? JSON.parse(_substitute(tpl.body, ctx)) : _substituteDeep(tpl.body, ctx);
      body = new URLSearchParams(Object.entries(flat).map(([k, v]) => [k, String(v ?? '')]));
      if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else {
      // 'json' default
      const obj = typeof tpl.body === 'string' ? _substitute(tpl.body, ctx) : JSON.stringify(_substituteDeep(tpl.body, ctx));
      body = obj;
      if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
    }
  }
  const { json } = await _doFetch({ method, url: tokenUrl, headers, body }, 'Custom', log);
  const field = tpl.token_field || 'access_token';
  const tok = json && typeof json[field] === 'string' ? json[field] : null;
  if (!tok) {
    throw new Error(
      `Custom response did not contain field "${field}". Body: ${JSON.stringify(json).slice(0, 200)}`
    );
  }
  return { token: tok, expiresIn: _expiresIn(json) };
}

const ADAPTERS = {
  oauth2_basic:     _oauth2Basic,
  oauth2_post:      _oauth2Post,
  paxone_json:      _paxoneJson,
  sqills_extension: _sqillsExtension,
  custom:           _custom
};

/**
 * Dispatch to the right adapter and return the access token plus its lifetime.
 *
 * @param {string} profile  — one of PROFILES
 * @param {object} ctx      — { tokenUrl, clientId, clientSecret, scope?, extra?, customTemplate? }
 * @param {object} log      — { info(msg, meta), error(msg, meta) }
 * @returns {Promise<{token:string, expiresIn:(number|null)}>}
 *   `expiresIn` is the token lifetime in seconds parsed from the vendor's
 *   response, or null when the vendor did not include any usable
 *   `expires_in` field. The runner uses null to mean "do not cache."
 */
async function fetchToken(profile, ctx, log) {
  if (!isValidProfile(profile)) {
    throw new Error(`Unknown OAuth profile: "${profile}". Expected one of: ${PROFILES.join(', ')}.`);
  }
  log.info(`[runner] Auth — profile=${profile}${ctx.scope ? `, scope=${ctx.scope}` : ''}`);
  const result = await ADAPTERS[profile](ctx, log);
  if (result && result.expiresIn) {
    log.info(`[runner] Auth — token obtained successfully (expires_in=${result.expiresIn}s).`);
  } else {
    log.info('[runner] Auth — token obtained successfully (no expires_in returned — will not be cached).');
  }
  return result;
}

module.exports = { fetchToken, PROFILES, isValidProfile };
