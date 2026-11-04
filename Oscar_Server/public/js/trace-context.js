// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

// ── W3C Trace Context of a Test Framework (#1070) ───────────────────────────
// OSDM declares the W3C Trace Context headers `traceparent` and `tracestate`
// on every operation. W3C Trace Context Level 1 (Recommendation, 23 November
// 2021) fixes their form:
//   traceparent = 00-<trace-id: 32 hex>-<parent-id: 16 hex>-<trace-flags: 2 hex>
//   tracestate  = up to 32 comma-separated "key=value" members
// and asks a new parent-id for each request sent. OSCAR draws the ids; the
// Test Framework says whether to send them, the sampled flag, and a
// tracestate template whose {{traceId}}, {{uuid}} and {{parentId}} OSCAR
// fills in (`traceContext`, absent = the defaults).
//
// One implementation for the Test Framework editor (its preview), the three
// framework writers (their check) and the server's own calls to a provider.
// A run gets `runSettingsOf()` from the runner: the template already parsed,
// so no "{{" reaches Bruno, which would fill it in itself. The collection's
// library-bruno/traceContext.js fills it; a test holds the two alike.
//
// Loaded by scenarios.html before scenarios.js (browser global
// OscarTraceContext) and required by the server and the tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OscarTraceContext = api;
}(globalThis, function () {
  'use strict';

  const SETTINGS = new Set(['send', 'sampled', 'tracestate']);
  // What OSCAR fills in. traceId and uuid are one id per sale flow, written
  // two ways; parentId is new for each request.
  const PLACEHOLDERS = ['traceId', 'uuid', 'parentId'];
  // W3C's own example ids, for the preview and for checking a template.
  const SAMPLE = Object.freeze({
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    uuid: '4bf92f35-77b3-4da6-a3ce-929d0e0e4736',
    parentId: '00f067aa0ba902b7',
  });
  // W3C: a vendor SHOULD pass on at least 512 characters of tracestate, so a
  // longer one may be cut on its way.
  const MAX_TRACESTATE = 512;
  const MAX_MEMBERS = 32;
  const MAX_VALUE = 256;

  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const placeholderList = () => PLACEHOLDERS.map((p) => `{{${p}}}`).join(', ');

  /** { send, sampled, tracestate } of a Test Framework, the defaults filled in. */
  function settingsOf(framework) {
    const tc = isObject(framework?.traceContext) ? framework.traceContext : {};
    return {
      send: tc.send !== false,
      sampled: tc.sampled !== false,
      tracestate: typeof tc.tracestate === 'string' ? tc.tracestate.trim() : '',
    };
  }

  /** The canonical name of a placeholder ("UUID" → "uuid"), or null. */
  function placeholderNamed(text) {
    const want = String(text).trim().toLowerCase();
    return PLACEHOLDERS.find((p) => p.toLowerCase() === want) || null;
  }

  /**
   * A template as parts: ['t', text] or ['v', placeholder]. { parts } or
   * { problem }. Read with indexOf, never a pattern: a template is typed by a
   * person and checked on every save.
   */
  function parseTemplate(template) {
    const text = String(template ?? '');
    const parts = [];
    const pushText = (t) => { if (t) parts.push(['t', t]); };
    let at = 0;
    while (at < text.length) {
      const open = text.indexOf('{{', at);
      const stray = text.indexOf('}}', at);
      if (stray >= 0 && (open < 0 || stray < open)) {
        return { problem: `A "}}" with no "{{" before it. The values OSCAR fills in are ${placeholderList()}.` };
      }
      if (open < 0) { pushText(text.slice(at)); break; }
      const close = text.indexOf('}}', open + 2);
      if (close < 0) return { problem: `A "{{" with no "}}" after it. The values OSCAR fills in are ${placeholderList()}.` };
      const inner = text.slice(open + 2, close);
      const name = placeholderNamed(inner);
      if (!name) {
        return { problem: `"{{${inner.trim().slice(0, 40)}}}" is not a value OSCAR fills in: ${placeholderList()}.` };
      }
      pushText(text.slice(at, open));
      parts.push(['v', name]);
      at = close + 2;
    }
    return { parts };
  }

  /** The text of parsed parts with `values` ({ traceId, uuid, parentId }). */
  function render(parts, values) {
    return (Array.isArray(parts) ? parts : []).map(([kind, v]) => (kind === 'v' ? String(values?.[v] ?? '') : String(v))).join('');
  }

  const isHex = (s, n) => typeof s === 'string' && s.length === n && /^[0-9a-f]+$/.test(s);
  const allZero = (s) => /^0+$/.test(s);

  /** True for a W3C version-00 traceparent (lowercase hex, no all-zero id). */
  function isTraceparent(text) {
    const fields = String(text ?? '').split('-');
    if (fields.length !== 4) return false;
    const [version, traceId, parentId, flags] = fields;
    return version === '00' && isHex(traceId, 32) && !allZero(traceId)
      && isHex(parentId, 16) && !allZero(parentId) && isHex(flags, 2);
  }

  /** The traceparent of a trace id, a parent id and the sampled flag. */
  function traceparentOf(traceId, parentId, sampled) {
    return `00-${traceId}-${parentId}-${sampled === false ? '00' : '01'}`;
  }

  // W3C keys: a simple key, or tenant@system. Checked by length and a single
  // character class each, so nothing can backtrack.
  const KEY_CHARS = /^[a-z0-9_*/-]*$/;
  const keyPart = (text, max, first) => text.length >= 1 && text.length <= max && first.test(text) && KEY_CHARS.test(text);
  function keyProblem(key) {
    const at = key.indexOf('@');
    const ok = at < 0
      ? keyPart(key, 256, /^[a-z]/)
      : !key.includes('@', at + 1) && keyPart(key.slice(0, at), 241, /^[a-z0-9]/) && keyPart(key.slice(at + 1), 14, /^[a-z]/);
    if (ok) return null;
    return `"${key.slice(0, 60)}" is not a tracestate key: lowercase letters, digits and _ - * /, starting with a letter (or tenant@system), and no space around "=".`;
  }

  // W3C values: 1 to 256 printable characters but "," and "=", not ending in a space.
  function valueProblem(key, value) {
    if (value.length >= 1 && value.length <= MAX_VALUE && /^[\x20-\x2b\x2d-\x3c\x3e-\x7e]+$/.test(value) && !value.endsWith(' ')) return null;
    return `The value of "${key.slice(0, 60)}" is not a tracestate value: 1 to ${MAX_VALUE} printable characters, without "," or "=", not ending in a space.`;
  }

  // W3C's optional white space around a member: spaces and tabs only.
  function trimOws(text) {
    const ows = (c) => c === ' ' || c === '\t';
    let start = 0;
    let end = text.length;
    while (start < end && ows(text[start])) start++;
    while (end > start && ows(text[end - 1])) end--;
    return text.slice(start, end);
  }

  /** Why a tracestate text is not W3C's, or null. */
  function tracestateProblem(text) {
    const value = String(text ?? '');
    if (value.length > MAX_TRACESTATE) return `The tracestate is ${value.length} characters long once filled in; W3C asks a provider to keep only ${MAX_TRACESTATE}.`;
    const members = value.split(',').map(trimOws);
    if (members.length > MAX_MEMBERS) return `The tracestate has ${members.length} members; W3C allows ${MAX_MEMBERS}.`;
    const keys = new Set();
    for (const member of members) {
      if (member === '') return 'The tracestate has an empty member (two commas, or a comma at an end).';
      const eq = member.indexOf('=');
      if (eq < 0) return `"${member.slice(0, 60)}" is not a tracestate member: key=value.`;
      const key = member.slice(0, eq);
      const problem = keyProblem(key) || valueProblem(key, member.slice(eq + 1));
      if (problem) return problem;
      if (keys.has(key)) return `The tracestate names "${key.slice(0, 60)}" twice.`;
      keys.add(key);
    }
    return null;
  }

  /** Why a tracestate template is refused, or null (an empty one is none). */
  function tracestateTemplateProblem(template) {
    const text = String(template ?? '').trim();
    if (text === '') return null;
    if (text.length > MAX_TRACESTATE) return `The tracestate template is ${text.length} characters long; ${MAX_TRACESTATE} at most.`;
    const { parts, problem } = parseTemplate(text);
    if (problem) return problem;
    return tracestateProblem(render(parts, SAMPLE));
  }

  /**
   * Why a framework's `traceContext` is refused, or null. The three framework
   * writers answer 400 with it.
   */
  function traceContextProblem(traceContext) {
    if (traceContext === undefined || traceContext === null) return null;
    if (!isObject(traceContext)) return 'The trace context (traceContext) is an object: { send, sampled, tracestate }.';
    const unknown = Object.keys(traceContext).find((k) => !SETTINGS.has(k));
    if (unknown !== undefined) return `The trace context has no setting "${unknown.slice(0, 40)}": send, sampled and tracestate.`;
    for (const k of ['send', 'sampled']) {
      if (k in traceContext && typeof traceContext[k] !== 'boolean') return `The trace context's "${k}" is true or false.`;
    }
    if ('tracestate' in traceContext && typeof traceContext.tracestate !== 'string') return 'The trace context\'s tracestate is text.';
    return tracestateTemplateProblem(traceContext.tracestate);
  }

  /**
   * What a run needs, without a template: { send, flags, tracestate: parts }.
   * A stored tracestate that is refused is left out, never sent half-right.
   */
  function runSettingsOf(framework) {
    const s = settingsOf(framework);
    const parsed = s.tracestate && !tracestateTemplateProblem(s.tracestate) ? parseTemplate(s.tracestate).parts : [];
    return { send: s.send, flags: s.sampled ? '01' : '00', tracestate: parsed };
  }

  /** The trace id of a flow's UUID: its 32 hex digits. */
  function traceIdOf(uuid) {
    return String(uuid ?? '').toLowerCase().replaceAll('-', '');
  }

  /**
   * The headers of one request: { traceparent, tracestate? }, or {} when the
   * framework sends none. `uuid` is the flow's, `parentId` the request's.
   */
  function headersFor(settings, uuid, parentId) {
    const s = { send: true, sampled: true, tracestate: '', ...settings };
    if (!s.send) return {};
    const values = { traceId: traceIdOf(uuid), uuid: String(uuid).toLowerCase(), parentId };
    const headers = { traceparent: traceparentOf(values.traceId, parentId, s.sampled) };
    if (s.tracestate && !tracestateTemplateProblem(s.tracestate)) {
      headers.tracestate = render(parseTemplate(s.tracestate).parts, values);
    }
    return headers;
  }

  /** The two headers a framework gives, with W3C's example ids (the editor's preview). */
  function preview(framework) {
    const s = settingsOf(framework);
    if (!s.send) return { traceparent: '', tracestate: '', problem: null };
    const problem = tracestateTemplateProblem(s.tracestate);
    const headers = headersFor({ ...s, tracestate: problem ? '' : s.tracestate }, SAMPLE.uuid, SAMPLE.parentId);
    return { traceparent: headers.traceparent, tracestate: headers.tracestate || '', problem };
  }

  return {
    PLACEHOLDERS, SAMPLE, MAX_TRACESTATE,
    settingsOf, parseTemplate, render, isTraceparent, traceparentOf,
    tracestateProblem, tracestateTemplateProblem, traceContextProblem,
    runSettingsOf, traceIdOf, headersFor, preview,
  };
}));
