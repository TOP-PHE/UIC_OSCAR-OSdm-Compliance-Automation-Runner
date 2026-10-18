// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * client.js — one GET to OSCAR's read-only API (#503 PR 3).
 *
 * GET only, to the configured OSCAR only: a redirect is never followed (it
 * would carry the key elsewhere), an answer is read up to MAX_ANSWER_BYTES,
 * and a call gives up after TIMEOUT_MS. What comes back is { status, body }
 * or { failure }: a sentence for the person, never holding the key.
 */

const { version } = require('../package.json');

const TIMEOUT_MS = 30 * 1000;
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;

async function readCapped(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** GET `path` (under /v1/api) on the configured OSCAR. */
async function getFromOscar(config, path, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS, maxBytes = MAX_ANSWER_BYTES } = {}) {
  if (typeof path !== 'string' || !path.startsWith('/v1/api/')) return { failure: 'Only the read-only API of OSCAR is called.' };
  const url = new URL(path, config.origin);
  if (url.origin !== config.origin || !url.pathname.startsWith('/v1/api/')) return { failure: 'Only the read-only API of the configured OSCAR is called.' };
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { Authorization: `Bearer ${config.key}`, Accept: 'application/json', 'User-Agent': `oscar-mcp/${version}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { failure: timedOut ? `OSCAR did not answer within ${Math.round(timeoutMs / 1000)} s.` : 'OSCAR could not be reached.' };
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    return { failure: `OSCAR answered with a redirect (HTTP ${response.status}), which is not followed: check OSCAR_URL.` };
  }
  const text = await readCapped(response, maxBytes);
  if (text === null) return { failure: `OSCAR's answer is over ${Math.round(maxBytes / 1024 / 1024)} MB and was not read.` };
  let body;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    return { failure: `OSCAR's answer (HTTP ${response.status}) is not JSON: check OSCAR_URL.` };
  }
  return { status: response.status, body };
}

module.exports = { getFromOscar, TIMEOUT_MS, MAX_ANSWER_BYTES };
