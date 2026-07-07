// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * osdm-client.js — thin helpers for authenticated server-side calls to a
 * vendor's OSDM API (as opposed to the Bruno CLI run path).
 *
 * Mirrors the local `_postJson` helper in company-test-resources.js, factored
 * out so the Places discovery route (#450) can reuse it without duplicating the
 * auth-header / URL-join / timeout boilerplate.
 */

const { decrypt } = require('../db/db');

const DEFAULT_TIMEOUT_MS = 20000;

/**
 * GET {apiBase}/{path}. Returns { ok, status, json, text } and never throws on
 * a non-2xx — the caller decides how to handle it. Throws only on
 * network/timeout errors (AbortError on timeout), same as fetch.
 */
async function osdmGet(apiBase, path, token, extraHeaders = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const base = String(apiBase).replace(/\/+$/, '');
  const rel  = String(path).replace(/^\/+/, '');
  const url  = `${base}/${rel}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        ...extraHeaders
      },
      signal: controller.signal
    });
    let text = '';
    let json = null;
    try { text = await res.text(); json = text ? JSON.parse(text) : null; } catch (_) { /* keep raw text */ }
    return { ok: res.ok, status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the optional per-tester OSDM headers (Requestor + Azure APIM
 * subscription key) from a decrypted users row, mirroring the Bruno run path
 * and the discover-timetable route. Missing/undecryptable values are skipped.
 */
function buildTesterHeaders(userRow) {
  const headers = {};
  try { const r = userRow && userRow.requestor_enc ? decrypt(userRow.requestor_enc) : null; if (r) headers.Requestor = r; } catch (_) {}
  try { const k = userRow && userRow.subscription_key_enc ? decrypt(userRow.subscription_key_enc) : null; if (k) headers['Ocp-Apim-Subscription-Key'] = k; } catch (_) {}
  return headers;
}

module.exports = { osdmGet, buildTesterHeaders, DEFAULT_TIMEOUT_MS };
