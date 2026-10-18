// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * aiConfig.js — a Test Manager's AI service (#801, PR 2). Pure.
 *
 * Two connectors: the Anthropic Messages API, and the Chat Completions API
 * that OpenAI and many others (Mistral, vLLM, Ollama, LiteLLM…) answer. The
 * company chooses the service; OSCAR only needs its address, a model and a
 * key. This module checks what a page sends, says when a change must be
 * tested again, builds the small test request and reads its answer. The call
 * itself is in services/aiConnector.js.
 */

const { storedUrlRefusal } = require('./urlPolicy');

const CONNECTORS = Object.freeze({
  anthropic: Object.freeze({
    label: 'Anthropic (Messages API)',
    defaultBaseUrl: 'https://api.anthropic.com',
    keyRequired: true,
  }),
  openai_compatible: Object.freeze({
    label: 'OpenAI-compatible (Chat Completions API)',
    defaultBaseUrl: 'https://api.openai.com/v1',
    keyRequired: false,
  }),
});

const LIMITS = Object.freeze({
  baseUrl: 500, model: 200, apiKey: 500, instruction: 2000,
  minTokenCap: 1000, maxTokenCap: 10_000_000_000, maxPrice: 1000,
});

// Model names seen across services: "claude-opus-5-5", "gpt-4o",
// "mistral-large-latest", "llama3.1:8b", "org/model@rev".
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;
// A key is one word of printable ASCII.
const KEY_PATTERN = /^[\x21-\x7e]+$/;

const TEST_PROMPT = 'This is a connection test from OSCAR. Reply with the single word OK.';
const TEST_MAX_TOKENS = 64;
const ANTHROPIC_VERSION = '2023-06-01';

/** The connectors as the page lists them. */
function connectorsForPage() {
  return Object.entries(CONNECTORS).map(([id, c]) => ({ id, label: c.label, defaultBaseUrl: c.defaultBaseUrl, keyRequired: c.keyRequired }));
}

// "https://x/v1/" → "https://x/v1". Trailing slashes only: a loop, not a
// regex, so a long run of them costs nothing (Sonar S8786).
function trimSlashes(text) {
  let end = text.length;
  while (end > 0 && text[end - 1] === '/') end--;
  return text.slice(0, end);
}

function baseUrlRefusal(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return 'Give the address of the AI service.';
  const text = raw.trim();
  if (text.length > LIMITS.baseUrl) return `The address of the AI service is longer than ${LIMITS.baseUrl} characters.`;
  const policy = storedUrlRefusal(text, 'AI service address');
  if (policy) return policy;
  const url = new URL(text);
  if (url.username || url.password) return 'The address of the AI service must not hold a name or password: put the key in its own field.';
  if (url.search || url.hash) return 'The address of the AI service must not hold a query or a fragment.';
  return null;
}

// Each optional field: { value } (null when empty) or { refusal }.
function checkModel(raw) {
  const model = typeof raw === 'string' ? raw.trim() : '';
  if (!model) return { refusal: 'Give the model to use.' };
  if (model.length > LIMITS.model || !MODEL_PATTERN.test(model)) {
    return { refusal: 'The model is a name such as claude-opus-5-5 or gpt-4o: letters, digits and . _ : / @ - only.' };
  }
  return { value: model };
}

const isEmpty = (v) => v === undefined || v === null || v === '';

function checkKey(raw) {
  if (isEmpty(raw)) return { value: null };
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (!key || key.length > LIMITS.apiKey || !KEY_PATTERN.test(key)) {
    return { refusal: 'The key is one word of printable characters, without spaces.' };
  }
  return { value: key };
}

function checkCap(raw) {
  if (isEmpty(raw)) return { value: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < LIMITS.minTokenCap || n > LIMITS.maxTokenCap) {
    return { refusal: `The monthly token limit is a whole number from ${LIMITS.minTokenCap} to ${LIMITS.maxTokenCap}, or empty for none.` };
  }
  return { value: n };
}

// A price per million tokens (#831): a number from 0 to LIMITS.maxPrice, or empty.
function checkPrice(raw, which) {
  if (isEmpty(raw)) return { value: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > LIMITS.maxPrice) {
    return { refusal: `The ${which} price is a number of US dollars per million tokens, from 0 to ${LIMITS.maxPrice}, or empty.` };
  }
  return { value: n };
}

function checkInstruction(raw) {
  if (raw === undefined || raw === null) return { value: null };
  if (typeof raw !== 'string') return { refusal: 'The instruction is text.' };
  const text = raw.trim();
  if (text.length > LIMITS.instruction) return { refusal: `The instruction is longer than ${LIMITS.instruction} characters.` };
  return { value: text || null };
}

/**
 * Check what a page sends. Returns { value } with the cleaned fields, or
 * { refusal } with a sentence. `apiKey` is in value only when one was typed
 * ('' and absent both mean "keep the stored one").
 */
function checkConfig(body) {
  const b = body && typeof body === 'object' ? body : {};
  const connector = CONNECTORS[b.connector] ? b.connector : null;
  if (!connector) return { refusal: 'Choose the kind of AI service.' };
  const urlRefusal = baseUrlRefusal(b.baseUrl);
  if (urlRefusal) return { refusal: urlRefusal };

  const fields = { model: checkModel(b.model), apiKey: checkKey(b.apiKey),
    monthlyTokenCap: checkCap(b.monthlyTokenCap), instruction: checkInstruction(b.instruction),
    priceInput: checkPrice(b.priceInput, 'input'), priceOutput: checkPrice(b.priceOutput, 'output') };
  const refused = Object.values(fields).find(f => f.refusal);
  if (refused) return { refusal: refused.refusal };
  if ((fields.priceInput.value === null) !== (fields.priceOutput.value === null)) {
    return { refusal: 'Give both prices, input and output, or neither.' };
  }

  const value = { connector, baseUrl: trimSlashes(b.baseUrl.trim()), model: fields.model.value,
    monthlyTokenCap: fields.monthlyTokenCap.value, instruction: fields.instruction.value,
    priceInput: fields.priceInput.value, priceOutput: fields.priceOutput.value };
  if (fields.apiKey.value) value.apiKey = fields.apiKey.value;
  return { value };
}

function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

/**
 * Does saving `next` need the key typed again? A stored key is only ever sent
 * where it was typed for: another kind of service or another host needs it
 * again. Returns a sentence, or null.
 */
function keyRefusal(stored, next) {
  if (next.apiKey) return null;
  const hasStoredKey = !!stored?.api_key_enc;
  if (hasStoredKey && (stored.connector !== next.connector || originOf(stored.base_url) !== originOf(next.baseUrl))) {
    return 'Type the key again: a stored key is only sent to the service it was typed for.';
  }
  if (!hasStoredKey && CONNECTORS[next.connector].keyRequired) return 'Give the key of the AI service.';
  return null;
}

/** Must `next` be tested before it is saved? A new service, address, model or key. */
function needsTest(stored, next) {
  if (!stored?.tested_at) return true;
  return stored.connector !== next.connector || stored.base_url !== next.baseUrl
    || stored.model !== next.model || !!next.apiKey;
}

// The Anthropic address may be given with or without its "/v1".
function anthropicEndpoint(baseUrl) {
  const base = trimSlashes(baseUrl);
  return (base.endsWith('/v1') ? base : `${base}/v1`) + '/messages';
}

/**
 * A request to the model: { url, headers, body }. `system` is optional;
 * `maxTokens` is sent to Anthropic only (it requires one). An
 * OpenAI-compatible service gets no token limit: newer models refuse
 * max_tokens and older services do not know max_completion_tokens.
 */
function messageRequest({ connector, baseUrl, model, apiKey }, { system = null, user, maxTokens }) {
  if (connector === 'anthropic') {
    const body = { model, max_tokens: maxTokens, messages: [{ role: 'user', content: user }] };
    if (system) body.system = system;
    return {
      url: anthropicEndpoint(baseUrl),
      headers: { 'content-type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION, 'x-api-key': apiKey || '' },
      body,
    };
  }
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const messages = system ? [{ role: 'system', content: system }] : [];
  messages.push({ role: 'user', content: user });
  return { url: `${trimSlashes(baseUrl)}/chat/completions`, headers, body: { model, messages } };
}

/**
 * Anthropic's list of models (#831): { url, headers }, a GET. The address
 * may be given with or without its "/v1", like the Messages endpoint.
 */
function modelsRequest({ baseUrl, apiKey }) {
  const base = trimSlashes(baseUrl);
  return {
    url: (base.endsWith('/v1') ? base : `${base}/v1`) + '/models?limit=100',
    headers: { 'anthropic-version': ANTHROPIC_VERSION, 'x-api-key': apiKey || '' },
  };
}

/** The connection test: one small question, one word asked back. */
function testRequest(config) {
  return messageRequest(config, { user: TEST_PROMPT, maxTokens: TEST_MAX_TOKENS });
}

const ANSWER_SHOWN = 200;
const ERROR_SHOWN = 300;

function shorten(text, max) {
  const t = String(text ?? '').replaceAll(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/** Replace the key wherever a service echoed it. */
function maskKey(text, key) {
  if (!key || key.length < 4) return text;
  return String(text).replaceAll(key, '***');
}

const numberOr = (v) => (Number.isFinite(v) ? v : null);

/**
 * The model's answer to a successful (2xx) call, or null when the body is not
 * one the connector knows. { answer, model, usage: { input, output } }.
 */
function readAnswer(connector, json) {
  if (!json || typeof json !== 'object') return null;
  if (connector === 'anthropic') {
    if (!Array.isArray(json.content)) return null;
    const text = json.content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('');
    return {
      answer: shorten(text, ANSWER_SHOWN),
      text,
      stopReason: typeof json.stop_reason === 'string' ? json.stop_reason : null,
      model: typeof json.model === 'string' ? json.model : null,
      usage: { input: numberOr(json.usage?.input_tokens), output: numberOr(json.usage?.output_tokens) },
    };
  }
  const choice = Array.isArray(json.choices) ? json.choices[0] : null;
  if (!choice || typeof choice !== 'object') return null;
  const content = choice.message?.content;
  const text = typeof content === 'string' ? content : '';
  return {
    answer: shorten(text, ANSWER_SHOWN),
    text,
    stopReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
    model: typeof json.model === 'string' ? json.model : null,
    usage: { input: numberOr(json.usage?.prompt_tokens), output: numberOr(json.usage?.completion_tokens) },
  };
}

/** The sentence for a refused call: the status and the service's own message, key masked. */
function describeError(status, json, rawText, key) {
  const fromBody = json?.error?.message ?? (typeof json?.error === 'string' ? json.error : null) ?? json?.message ?? json?.detail;
  const said = typeof fromBody === 'string' && fromBody.trim() ? fromBody : shorten(rawText, ERROR_SHOWN);
  const reason = said ? `: ${shorten(maskKey(said, key), ERROR_SHOWN)}` : '';
  return `The AI service answered HTTP ${status}${reason}`;
}

/** The stored row as a page sees it: never the key. */
function configView(row) {
  if (!row) return null;
  return {
    connector: row.connector,
    baseUrl: row.base_url,
    model: row.model,
    hasKey: !!row.api_key_enc,
    monthlyTokenCap: row.monthly_token_cap ?? null,
    instruction: row.instruction || '',
    priceInput: row.price_input ?? null,
    priceOutput: row.price_output ?? null,
    testedAt: row.tested_at || null,
    updatedAt: row.updated_at || null,
  };
}

/** The fields a save changes, by name (for the audit log; never a value). */
function changedFields(stored, next) {
  if (!stored) return ['connector', 'baseUrl', 'model', ...(next.apiKey ? ['apiKey'] : []), 'monthlyTokenCap', 'instruction', 'prices'];
  const pairs = [['connector', stored.connector, next.connector], ['baseUrl', stored.base_url, next.baseUrl],
    ['model', stored.model, next.model], ['monthlyTokenCap', stored.monthly_token_cap ?? null, next.monthlyTokenCap],
    ['instruction', stored.instruction || null, next.instruction],
    ['prices', `${stored.price_input ?? ''}/${stored.price_output ?? ''}`, `${next.priceInput ?? ''}/${next.priceOutput ?? ''}`]];
  const names = pairs.filter(([, a, b]) => a !== b).map(([n]) => n);
  if (next.apiKey) names.push('apiKey');
  return names;
}

module.exports = {
  CONNECTORS, LIMITS, TEST_PROMPT, TEST_MAX_TOKENS, ANTHROPIC_VERSION,
  connectorsForPage, checkConfig, checkModel, baseUrlRefusal, modelsRequest, keyRefusal, needsTest, messageRequest, testRequest, readAnswer, describeError,
  maskKey, configView, changedFields, anthropicEndpoint,
};
