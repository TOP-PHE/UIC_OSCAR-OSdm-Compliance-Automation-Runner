// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * aiConnector.js — the one place OSCAR calls an AI service (#801, PR 2).
 *
 * Plain HTTP for both connectors, on purpose: the address is the company's
 * choice and goes through urlPolicy.js like an OSDM endpoint (https on a
 * public host), redirects are not followed (a redirect could aim the key at
 * an internal address), the answer is read up to a limit, and the call gives
 * up after a time. The key is sent in its header and nowhere else: never
 * logged, and masked in any error the service echoes it in. The log line
 * names the connector, host, status and time only.
 */

/* global AbortSignal */  // Node 22 global
const { usableUrlRefusal } = require('../utils/urlPolicy');
const C = require('../utils/aiConfig');
const log = require('../utils/logger').child({ module: 'ai-connector' });

const TIMEOUT_MS = 30000;
const MAX_ANSWER_BYTES = 256 * 1024;

// Read at most `limit` bytes of the body; more is an error, not a cut. One
// chunk per step, by recursion: the body is read as it arrives.
async function readCapped(res, limit) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  const step = async (size) => {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks).toString('utf8');
    if (size + value.byteLength > limit) {
      await reader.cancel().catch(() => {});
      throw Object.assign(new Error('answer too large'), { code: 'AI_ANSWER_TOO_LARGE' });
    }
    chunks.push(Buffer.from(value));
    return step(size + value.byteLength);
  };
  return step(0);
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return null; }
}

function failureOf(err, timeoutMs) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return `The AI service did not answer within ${Math.max(1, Math.round(timeoutMs / 1000))} s.`;
  }
  if (err?.code === 'AI_ANSWER_TOO_LARGE') return `The AI service sent an answer larger than ${MAX_ANSWER_BYTES / 1024} KB.`;
  const code = err?.cause?.code || err?.code;
  return code ? `The AI service could not be reached (${code}).` : 'The AI service could not be reached.';
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Send one request to the model. `config` is { connector, baseUrl, model,
 * apiKey }, `request` a C.messageRequest(). Resolves { ok: true, answer,
 * text, stopReason, model, usage, ms } or { ok: false, error, status? };
 * never rejects. `purpose` names the call in the log line.
 */
async function callModel(config, request, { timeoutMs = TIMEOUT_MS, purpose = 'call' } = {}) {
  const refusal = await usableUrlRefusal(request.url, 'AI service address');
  if (refusal) return { ok: false, error: refusal };

  const started = Date.now();
  const where = { connector: config.connector, host: hostOf(request.url), purpose };
  let res;
  let text;
  try {
    res = await fetch(request.url, {
      method: 'POST', headers: request.headers, body: JSON.stringify(request.body),
      redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    });
    text = await readCapped(res, MAX_ANSWER_BYTES);
  } catch (err) {
    const error = failureOf(err, timeoutMs);
    log.warn({ ...where, ms: Date.now() - started, failure: err?.name || 'error' }, 'AI call failed');
    return { ok: false, error };
  }
  const ms = Date.now() - started;
  log.info({ ...where, status: res.status, ms }, 'AI call');

  if (res.status >= 300 && res.status < 400) {
    return { ok: false, status: res.status,
      error: `The AI service answered with a redirect (HTTP ${res.status}). Give the address it redirects to.` };
  }
  const json = parseJson(text);
  if (!res.ok) return { ok: false, status: res.status, error: C.describeError(res.status, json, text, config.apiKey) };
  const answer = C.readAnswer(config.connector, json);
  if (!answer) {
    return { ok: false, status: res.status,
      error: 'The AI service answered, but not in the shape this kind of service gives. Check the kind of service and the address.' };
  }
  return { ok: true, ...answer, ms };
}

/** The connection test: { ok, answer, … } as callModel gives it. */
function testConnection(config, options = {}) {
  return callModel(config, C.testRequest(config), { ...options, purpose: 'test' });
}

module.exports = { callModel, testConnection, TIMEOUT_MS, MAX_ANSWER_BYTES };
