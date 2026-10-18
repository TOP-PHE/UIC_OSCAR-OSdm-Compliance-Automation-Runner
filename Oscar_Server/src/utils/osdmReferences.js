// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * osdmReferences.js — extracts of the OSDM specification for the AI analysis
 * (#827 PR B). Reads osdm-references.json, generated from the OSDM
 * specification files by scripts/generate-osdm-references.js; no network.
 *
 * For the operations the failures concern (found from each request's method
 * and URL, the URL never sent), the extract gives the operation's summary,
 * its request and success response schemas, and the schemas they name, two
 * levels down, in the specification of the version the provider declares. A
 * version OSCAR has no file of uses the nearest one, and says so.
 */

const MAX_REFERENCE_CHARS = 30000;   // about 7,500 tokens in all
const MAX_OPERATIONS = 12;
const DEPTH = 2;

let loaded = null;
function data() {
  loaded ||= require('./osdm-references.json');
  return loaded;
}

const rankOf = (v) => {
  const [major, minor, patch] = String(v).split('.').map((x) => Number.parseInt(x, 10) || 0);
  return major * 10000 + minor * 100 + patch;
};

/**
 * The specification to quote for a declared version: { version, exact }.
 * "3.8" and "3.8.0" are 3.8.0; one OSCAR has no file of takes the nearest
 * (the lower on a tie); none declared takes the latest.
 */
function versionFor(declared, available = Object.keys(data().versions)) {
  const sorted = [...available].sort((a, b) => rankOf(a) - rankOf(b));
  if (!sorted.length) return null;
  const text = typeof declared === 'string' ? declared.trim() : '';
  if (!/^\d+(\.\d+){0,2}$/.test(text)) return { version: sorted.at(-1), exact: false };
  const parts = text.split('.');
  while (parts.length < 3) parts.push('0');
  const wanted = parts.join('.');
  if (sorted.includes(wanted)) return { version: wanted, exact: true };
  let best = sorted[0];
  for (const v of sorted) {
    if (Math.abs(rankOf(v) - rankOf(wanted)) < Math.abs(rankOf(best) - rankOf(wanted))) best = v;
  }
  return { version: best, exact: false };
}

function pathOf(url) {
  const text = String(url || '');
  try { return new URL(text).pathname; } catch { return text.split(/[?#]/)[0]; }
}

/**
 * The operation of a request ("POST /bookings/{bookingId}/fulfillments"), or
 * null: the operation of that method whose path ends the URL's path, a
 * `{…}` segment standing for any one segment, the one with the most fixed
 * segments winning. The provider's own base path is whatever comes before.
 */
function operationOf(method, url, version) {
  const ops = data().versions[version]?.operations || {};
  const m = String(method || '').toUpperCase();
  const segments = pathOf(url).split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  let best = null;
  let bestFixed = -1;
  for (const key of Object.keys(ops)) {
    const space = key.indexOf(' ');
    if (key.slice(0, space) !== m) continue;
    const template = key.slice(space + 1).split('/').filter(Boolean);
    if (template.length === 0 || template.length > segments.length) continue;
    const tail = segments.slice(segments.length - template.length);
    let fixed = 0;
    const fits = template.every((t, i) => {
      if (t.startsWith('{') && t.endsWith('}')) return tail[i] !== '';
      if (t !== tail[i]) return false;
      fixed++;
      return true;
    });
    if (fits && (fixed > bestFixed || (fixed === bestFixed && template.length > best.length))) {
      best = { key, length: template.length };
      bestFixed = fixed;
    }
  }
  return best ? best.key : null;
}

const bare = (name) => String(name).replace(/\[\]$/, '');

/**
 * The extract for some operations, the most failing first:
 * { version, declared, exact, operations: [{ operation, summary, request, responses }],
 *   schemas: { name: text }, cut }. `cut` counts the schemas left out for size.
 */
function referencesFor(operations, declared) {
  const chosen = versionFor(declared);
  if (!chosen) return null;
  const spec = data().versions[chosen.version];
  const out = { version: chosen.version, declared: typeof declared === 'string' && declared.trim() ? declared.trim() : null,
    exact: chosen.exact, operations: [], schemas: {}, cut: 0 };
  let chars = 0;
  const add = (name) => {
    if (Object.hasOwn(out.schemas, name) || !spec.schemas[name]) return false;
    const text = spec.schemas[name].text;
    if (chars + text.length > MAX_REFERENCE_CHARS) { out.cut++; return false; }
    out.schemas[name] = text;
    chars += text.length;
    return true;
  };
  // Level by level across all the operations, so that each one gets its own
  // request and response before any gets the schemas two levels down.
  let level = [];
  for (const key of [...new Set(operations)].filter((k) => spec.operations[k]).slice(0, MAX_OPERATIONS)) {
    const op = spec.operations[key];
    out.operations.push({ operation: key, summary: op.summary, request: op.request, responses: op.responses });
    level.push(...[op.request, ...Object.values(op.responses)].filter(Boolean).map(bare));
  }
  for (let depth = 0; depth <= DEPTH && level.length; depth++) {
    const next = [];
    for (const name of level) {
      if (add(name)) next.push(...spec.schemas[name].refs);
    }
    level = next;
  }
  return out;
}

module.exports = { versionFor, operationOf, referencesFor, MAX_REFERENCE_CHARS };
