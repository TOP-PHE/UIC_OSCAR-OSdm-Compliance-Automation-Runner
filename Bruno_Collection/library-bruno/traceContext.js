/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * traceContext.js — the W3C Trace Context headers of every OSDM request (#1070).
 *
 * OSDM declares `traceparent` and `tracestate` (W3C Trace Context Level 1,
 * Recommendation of 23 November 2021) on every operation:
 *   traceparent = 00-<trace-id: 32 hex>-<parent-id: 16 hex>-<flags: 2 hex>
 * with a new parent-id for each request sent.
 *
 * One trace per sale flow (maintainer, 2026-11-03): each send of
 * `01. POST Get Offer` starts a new one (a first sale, a loop-back, an expiry
 * sub-run, a retry); every request after it, request files and script-sent
 * requests alike, carries it with a parent-id of its own. A request sent while
 * no flow is open (the system information reads at the start of a run, a
 * scenario that would start at a refund) starts a trace of its own.
 *
 * The flow is `__traceUuid`, a UUID: its 32 hex digits are the trace id, and
 * a tracestate template may name it as `{{uuid}}` (SBB's `processid`). It is
 * cleared at the scenario start (/versions) only, never by the scenario
 * parser's reset or the expiry sub-run's: both run inside 01's own script,
 * after the collection's before-request has started the new trace here.
 *
 * `__traceContext` holds the Test Framework's settings, written by the runner
 * (`runSettingsOf()` of Oscar_Server/public/js/trace-context.js, a test keeps
 * the two alike): { send, flags, tracestate: [['t', text] | ['v', name]] }.
 * The template comes already parsed, so no "{{" reaches Bruno, which would
 * fill it in itself. Absent (a standalone run): a sampled traceparent and no
 * tracestate.
 */

const FLOW_START = '01. post get offer';
const TRACE_VAR = '__traceUuid';
const SETTINGS_VAR = '__traceContext';
const REPLACED_SAID = '__traceHeaderReplacedSaid';
const PLACEHOLDERS = new Set(['traceId', 'uuid', 'parentId']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ── Pure ────────────────────────────────────────────────────────────────────

const isPart = (p) => Array.isArray(p) && p.length === 2 && typeof p[1] === 'string'
  && (p[0] === 't' || (p[0] === 'v' && PLACEHOLDERS.has(p[1])));

/** The run's settings: { send, flags, tracestate: parts }, defaults when unset. */
function settingsFrom(raw) {
  let s = raw;
  if (typeof s === 'string') {
    try { s = JSON.parse(s); } catch { s = null; }
  }
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { send: true, flags: '01', tracestate: [] };
  return {
    send: s.send !== false,
    flags: s.flags === '00' ? '00' : '01',
    tracestate: Array.isArray(s.tracestate) && s.tracestate.every(isPart) ? s.tracestate : [],
  };
}

/** True for the request that starts a sale flow. */
function isFlowStart(name) {
  return String(name ?? '').trim().toLowerCase() === FLOW_START;
}

/** True for a request of 00-Access Token, named as the run filter reads them. */
function isTokenRequest(name) {
  return String(name ?? '').toLowerCase().includes('token');
}

/** The trace id of a flow's UUID: its 32 hex digits. */
function traceIdOf(uuid) {
  return String(uuid ?? '').toLowerCase().replaceAll('-', '');
}

/** { traceparent, tracestate? } of one request, or {} when none is sent. */
function headersFor(settings, uuid, parentId) {
  if (!settings.send) return {};
  const values = { traceId: traceIdOf(uuid), uuid: String(uuid).toLowerCase(), parentId };
  const headers = { traceparent: `00-${values.traceId}-${parentId}-${settings.flags}` };
  if (settings.tracestate.length > 0) {
    headers.tracestate = settings.tracestate.map(([kind, v]) => (kind === 'v' ? values[v] : v)).join('');
  }
  return headers;
}

/** A copy of `headers` without the names given, in any case. */
function withoutHeaders(headers, names) {
  const drop = new Set(names.map((n) => n.toLowerCase()));
  return Object.fromEntries(Object.entries(headers || {}).filter(([k]) => !drop.has(k.toLowerCase())));
}

// ── Ids ─────────────────────────────────────────────────────────────────────

let uuidCounter = 0;

/** A new UUID: node:crypto's, else time and a counter (never twice in a run). */
function newUuid() {
  try {
    return require('node:crypto').randomUUID().toLowerCase();
  } catch {
    uuidCounter += 1;
    const hex = Date.now().toString(16).padStart(12, '0') + uuidCounter.toString(16).padStart(20, '0');
    const bytes = Array.from({ length: 16 }, (_, i) => Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16));
    return require('./idempotency.js').uuidFromBytes(bytes);
  }
}

/**
 * A new parent-id: the last 16 hex digits of a new UUID. Its first digit
 * holds the UUID's variant bits, so it is never all zero, as W3C requires.
 */
function newParentId() {
  return traceIdOf(newUuid()).slice(16);
}

// ── Bruno glue ──────────────────────────────────────────────────────────────

// The logger already loaded when there is one: loading displays.js puts its
// own on the global object, over one a caller set.
function log(message) {
  try {
    const logger = typeof globalThis.validationLogger === 'function'
      ? globalThis.validationLogger
      : require('./displays.js').validationLogger;
    logger(message);
  } catch {
    console.log(message);
  }
}

function requestNameOf(req) {
  try {
    return req && typeof req.getName === 'function' ? String(req.getName() || '') : '';
  } catch {
    return '';
  }
}

/**
 * The flow's UUID: a new one when `starts` or when none is open, said in the
 * run log when `label` names the request (a request file).
 */
function flowUuid(store, starts, label) {
  const open = store.getEnvVar(TRACE_VAR);
  if (!starts && typeof open === 'string' && UUID.test(open)) return open;
  const uuid = newUuid();
  store.setEnvVar(TRACE_VAR, uuid);
  if (label) log(`[INFO] 🔗 Trace ${traceIdOf(uuid)} starts at ${label}: the W3C traceparent of every request until the next offer search carries this trace id, for the provider's logs.`);
  return uuid;
}

/**
 * The collection's before-request: put the trace headers on `req`, after the
 * dedicated headers of API Config, which they replace (said once per run).
 * Returns the headers set.
 */
function applyTraceContext(req, store = globalThis.bru) {
  const settings = settingsFrom(store.getEnvVar(SETTINGS_VAR));
  const name = requestNameOf(req);
  // A token request (00-Access Token, standalone runs only) is OAuth, not OSDM.
  if (!settings.send || isTokenRequest(name)) return {};
  const headers = headersFor(settings, flowUuid(store, isFlowStart(name), name || 'this request'), newParentId());
  const present = Object.keys((typeof req.getHeaders === 'function' && req.getHeaders()) || {});
  const replaced = present.filter((k) => Object.keys(headers).includes(k.toLowerCase()));
  replaced.forEach((k) => req.deleteHeader(k));
  Object.entries(headers).forEach(([k, v]) => req.setHeader(k, v));
  if (replaced.length > 0 && store.getEnvVar(REPLACED_SAID) !== 'true') {
    store.setEnvVar(REPLACED_SAID, 'true');
    log(`[WARNING] The dedicated header ${replaced.map((k) => k.toLowerCase()).join(' and ')} of API Config is replaced by OSCAR's W3C trace context, which gives each request a parent-id of its own. Set it in the Test Framework (Trace context) and remove it from API Config.`);
  }
  return headers;
}

/**
 * The headers of a request a step's script sends itself (`bru.sendRequest`):
 * `headers` with the flow's trace added (any trace header in them replaced).
 * In a run a trace is always open by then (the system information reads
 * start one); with none, one starts without a log line. A trace never stops
 * a request: anything that goes wrong here gives the headers as they are.
 */
function withTrace(headers, store = globalThis.bru) {
  try {
    const settings = settingsFrom(store.getEnvVar(SETTINGS_VAR));
    if (!settings.send) return { ...headers };
    const trace = headersFor(settings, flowUuid(store, false, null), newParentId());
    return { ...withoutHeaders(headers, ['traceparent', 'tracestate']), ...trace };
  } catch {
    return { ...headers };
  }
}

module.exports = {
  FLOW_START, TRACE_VAR, SETTINGS_VAR,
  settingsFrom, isFlowStart, isTokenRequest, traceIdOf, headersFor, withoutHeaders, newUuid, newParentId,
  applyTraceContext, withTrace,
};
