/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
*/

/**
 * A provider's answer is data, never instructions. Three kinds of content
 * end the run before the next request is sent (the collection's
 * after-response), each with one failed check and one line tagged
 * "[INTRUSION]" that the OSCAR server reads:
 *
 * - template: "{{" — the test engine fills a "{{name}}" in with the value of
 *   a variable wherever a value is used, and values read from an answer go
 *   into the next requests;
 * - script: markup meant to run in a browser (a script or frame element, an
 *   event handler attribute inside a tag, a javascript: address) — answers
 *   are shown in reports and pages;
 * - redirect: a 3xx whose Location names a loopback, private or link-local
 *   address, or a scheme other than http(s).
 *
 * Only the first kind found in an answer is reported. Every look is linear
 * in the size of the answer. Pure but for checkAnswerThreats().
 */

const OPEN = '{' + '{';
const MAX_TAG = 1000;
const MAX_REASON = 160;

// ── Reading the answer ──────────────────────────────────────────────────────

// The text of an answer body, whatever form the engine gives it in.
function bodyText(body) {
  if (body === null || body === undefined) return '';
  if (typeof body === 'string') return body;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(body)) return body.toString('utf8');
  try { return JSON.stringify(body); } catch { return String(body); }
}

function statusOf(res) {
  try {
    const s = typeof res.getStatus === 'function' ? res.getStatus() : res.status;
    return Number(s) || 0;
  } catch { return 0; }
}

// The Location header of an answer, whatever the case of its name.
function locationOf(res) {
  let headers;
  try { headers = typeof res.getHeaders === 'function' ? res.getHeaders() : res.headers; } catch { headers = null; }
  if (!headers || typeof headers !== 'object') return '';
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === 'location') {
      const value = headers[name];
      return String(Array.isArray(value) ? value[0] : value || '');
    }
  }
  return '';
}

// ── Template text ───────────────────────────────────────────────────────────

/** True when the answer body holds "{{". */
function holdsTemplate(body) {
  return bodyText(body).includes(OPEN);
}

// ── Markup meant to run in a browser ────────────────────────────────────────

const ELEMENTS = [['<script', 'a script element'], ['<iframe', 'an iframe element'], ['<object', 'an object element'], ['<embed', 'an embed element']];
const SCHEMES = ['javascript:', 'vbscript:'];
const isLetter = (c) => c >= 'a' && c <= 'z';
const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

// True when the text of one tag ("<img src=x onerror=…") holds an event
// handler attribute: on<letters> after a separator, then "=" (spaces allowed).
function tagHasHandler(tag) {
  let from = 0;
  for (;;) {
    const at = tag.indexOf('on', from);
    if (at < 0) return false;
    from = at + 2;
    const before = tag[at - 1];
    if (!(isSpace(before) || before === '"' || before === '\'' || before === '/')) continue;
    let i = at + 2;
    if (!isLetter(tag[i])) continue;
    while (i < tag.length && isLetter(tag[i])) i++;
    while (i < tag.length && isSpace(tag[i])) i++;
    if (tag[i] === '=') return true;
  }
}

/**
 * What markup meant to run in a browser the text holds: a short neutral
 * reason, or '' when none. A "<" or ">" alone ("Paris <-> Lyon", "a > b")
 * is ordinary text.
 */
function scriptReason(text) {
  const lower = String(text).toLowerCase();
  for (const [element, reason] of ELEMENTS) if (lower.includes(element)) return reason;
  for (const scheme of SCHEMES) if (lower.includes(scheme)) return `a ${scheme} address`;
  // Each tag ends at the next ">" or "<", so the tags never overlap.
  let at = lower.indexOf('<');
  while (at >= 0) {
    const next = lower.indexOf('<', at + 1);
    if (isLetter(lower[at + 1])) {
      const close = lower.indexOf('>', at + 1);
      let end = Math.min(at + MAX_TAG, lower.length);
      if (close >= 0) end = Math.min(end, close);
      if (next >= 0) end = Math.min(end, next);
      if (tagHasHandler(lower.slice(at, end))) return 'an event handler attribute in a tag';
    }
    at = next;
  }
  return '';
}

/** True when the answer body holds markup meant to run in a browser. */
function holdsScript(body) {
  return scriptReason(bodyText(body)) !== '';
}

// ── A redirect to a local or private address ────────────────────────────────

function ipv4Parts(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const numbers = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : -1));
  return numbers.every((n) => n >= 0 && n <= 255) ? numbers : null;
}

function isInternalIpv4(host) {
  const p = ipv4Parts(host);
  if (!p) return false;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127);
}

function isInternalIpv6(host) {
  const h = host.toLowerCase();
  if (h === '::1' || h === '::') return true;
  if (h.startsWith('::ffff:')) {
    const rest = h.slice(7);
    if (rest.includes('.')) return isInternalIpv4(rest);
    // ::ffff:7f00:1 — the IPv4 address written in hexadecimal.
    const words = rest.split(':');
    if (words.length === 2) {
      const value = Number.parseInt(words[0], 16);
      return isInternalIpv4(`${(value >> 8) & 255}.${value & 255}.0.0`);
    }
    return false;
  }
  return /^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h);
}

function isInternalHost(host) {
  const h = String(host).toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.startsWith('[') && h.endsWith(']')) return isInternalIpv6(h.slice(1, -1));
  if (h.includes(':')) return isInternalIpv6(h);
  return isInternalIpv4(h);
}

// The scheme and host of an absolute address, without URL when the sandbox lacks it.
function partsOf(location) {
  if (typeof URL === 'function') {
    try {
      const u = new URL(location);
      return { scheme: u.protocol.slice(0, -1).toLowerCase(), host: u.hostname };
    } catch { /* read by hand below */ }
  }
  const colon = location.indexOf(':');
  if (colon <= 0) return null;
  const scheme = location.slice(0, colon).toLowerCase();
  let rest = location.slice(colon + 1);
  if (!rest.startsWith('//')) return { scheme, host: '' };
  rest = rest.slice(2);
  let end = rest.length;
  for (const c of ['/', '?', '#']) { const i = rest.indexOf(c); if (i >= 0 && i < end) end = i; }
  let host = rest.slice(0, end);
  const atSign = host.lastIndexOf('@');
  if (atSign >= 0) host = host.slice(atSign + 1);
  host = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return { scheme, host };
}

/**
 * Why a redirect is not to be followed: a short neutral reason, or '' when
 * the answer is no redirect or goes to a public http(s) address. A relative
 * Location ("/bookings/1") stays with the provider.
 */
function redirectReason(status, location) {
  if (status < 300 || status > 399 || status === 304) return '';
  const target = String(location || '').trim();
  if (!target) return '';
  if (target.startsWith('/') && !target.startsWith('//')) return '';
  const absolute = target.startsWith('//') ? `http:${target}` : target;
  const parts = partsOf(absolute);
  if (!parts) return '';
  if (parts.scheme !== 'http' && parts.scheme !== 'https') return `a redirect to a ${parts.scheme.slice(0, 20)}: address`;
  if (isInternalHost(parts.host)) return 'a redirect to a loopback, private or link-local address';
  return '';
}

// ── Bruno glue ──────────────────────────────────────────────────────────────

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

function stepNameOf(req) {
  try {
    const name = req && typeof req.getName === 'function' ? String(req.getName() || '') : '';
    return name.replace(/[\r\n[\]]/g, ' ').slice(0, 120);
  } catch { return ''; }
}

const CHECKS = {
  template: {
    name: '[OSDM] The answer holds no template text ("{' + '{")',
    message: () => 'The answer holds "{' + '{", which the test engine would fill in with its own variables in the next requests.',
  },
  script: {
    name: '[OSDM] The answer holds no markup meant to run in a browser',
    message: (reason) => `The answer holds ${reason}: markup meant to run in a browser.`,
  },
  redirect: {
    name: '[OSDM] The answer does not redirect to a local or private address',
    message: (reason) => `The answer is ${reason}, where a test must never be sent.`,
  },
};

/** The first threat an answer holds: { kind, reason, said }, or null. */
function threatOf(res) {
  const redirect = redirectReason(statusOf(res), locationOf(res));
  if (redirect) return { kind: 'redirect', reason: redirect, said: `the answer is ${redirect}` };
  let body;
  try { body = typeof res.getBody === 'function' ? res.getBody() : res.body; } catch { return null; }
  const text = bodyText(body);
  if (text.includes(OPEN)) return { kind: 'template', reason: 'template text', said: 'the answer holds template text' };
  const script = scriptReason(text);
  if (script) return { kind: 'script', reason: script, said: `the answer holds ${script}` };
  return null;
}

/** The line the OSCAR server reads: "[INTRUSION] kind=<kind> step=<name> [ERROR] <reason>". */
function intrusionLine(kind, step, reason) {
  return `[INTRUSION] kind=${kind} step=${step} [ERROR] ${String(reason).slice(0, MAX_REASON)}; the run stops here.`;
}

/**
 * Fails one check, logs one "[INTRUSION]" line and stops the run when the
 * answer holds a threat. Returns its kind, or '' when there is none. Never
 * throws.
 */
function checkAnswerThreats(res, bruTest, expectFn, req) {
  let threat;
  try { threat = res ? threatOf(res) : null; } catch { threat = null; }
  if (!threat) return '';
  const check = CHECKS[threat.kind];
  try {
    bruTest(check.name, () => {
      expectFn(false, `${check.message(threat.reason)} The run stops here.`).to.equal(true);
    });
  } catch { /* the check is recorded or not; the run stops either way */ }
  log(intrusionLine(threat.kind, stepNameOf(req), threat.said));
  try { bru.runner.stopExecution(); } catch { /* not in a runner context */ }
  return threat.kind;
}

/**
 * The same look at an answer to a request a step's script sends itself
 * (bru.sendRequest: { status, headers, data }), which the collection's
 * after-response never sees: values read from it go into the next requests
 * too. On a threat: one failed check, one "[INTRUSION]" line, the run stopped,
 * and the threat returned, so the caller uses nothing of the answer. Null
 * otherwise. Never throws.
 */
function stopOnScriptAnswer(r, label) {
  if (!r) return null;
  let threat;
  try {
    threat = threatOf({ status: r.status ?? r.statusCode, headers: r.headers, body: r.data ?? r.body });
  } catch { threat = null; }
  if (!threat) return null;
  const check = CHECKS[threat.kind];
  try {
    require('./testCapture.js').bruTest(check.name, () => {
      throw new Error(`${check.message(threat.reason)} The run stops here.`);
    });
  } catch { /* the check is recorded or not; the run stops either way */ }
  const step = `script request ${String(label || '').split('?')[0]}`.replace(/[\r\n[\]]/g, ' ').slice(0, 120);
  log(intrusionLine(threat.kind, step, threat.said));
  try { bru.runner.stopExecution(); } catch { /* not in a runner context */ }
  return threat;
}

module.exports = {
  holdsTemplate, holdsScript, scriptReason, redirectReason, isInternalHost, threatOf, intrusionLine, checkAnswerThreats,
  stopOnScriptAnswer,
};
