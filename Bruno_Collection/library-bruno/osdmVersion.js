/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * osdmVersion.js — single source of truth for OSDM version handling
 * =================================================================
 * Centralises version parsing/comparison and the two DISTINCT version concepts
 * the collection needs (issue #105):
 *
 *   getComplianceVersion()   → the version compliance is judged against. This is
 *                              the TEST-FRAMEWORK version: the per-scenario
 *                              `osdmVersion` from the data file, which OSCAR also
 *                              sends to the system as Content-Type ;version=X.
 *                              That is "where the truth is" — it deliberately
 *                              IGNORES the system's /versions (apiVersionsAvailable),
 *                              because compliance must not defer to what the system
 *                              claims it can support.
 *
 *   resolveEffectiveVersion()→ the NEGOTIATED version, used only for endpoint
 *                              selection (e.g. coach-layouts vs coach-deck-layouts).
 *                              Prefers an explicit override, then the system's
 *                              advertised versions, then the test-framework version.
 *                              Preserves the historic Coach before-request behaviour
 *                              (previously duplicated inline in two scenarios).
 *
 * Pure helpers (parseVersion / compareVersions / atLeast / …) take their inputs as
 * arguments so they unit-test without a Bruno sandbox.
 */

// Latest known OSDM version — last-resort fallback only. In normal operation
// osdmVersion is always present (it is a required data-file field), so this is
// reached only in degenerate cases.
const DEFAULT_OSDM_VERSION = '3.9.0';

// "3.8" / "3.8.1" / " v3.5.0 " → { major, minor, patch }; otherwise null.
function parseVersion(v) {
  if (v == null) return null;
  const m = String(v).trim().match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] || 0) };
}

// Monotonic comparable score. Accepts a parsed object or a raw version value.
function versionScore(v) {
  const p = (v && typeof v === 'object' && 'major' in v) ? v : parseVersion(v);
  if (!p) return -1;
  return (p.major * 1000000) + (p.minor * 1000) + p.patch;
}

// -1 if a < b, 0 if equal, 1 if a > b. Accepts parsed objects or raw values.
function compareVersions(a, b) {
  const sa = versionScore(a);
  const sb = versionScore(b);
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

// version >= target ?
function atLeast(version, target) {
  return compareVersions(version, target) >= 0;
}

// "3.5, 3.8, 3.7" → the highest as a parsed object (or null).
function pickLatestFromList(raw) {
  if (!raw) return null;
  return String(raw)
    .split(',')
    .map((s) => parseVersion(s))
    .filter(Boolean)
    .sort((a, b) => versionScore(b) - versionScore(a))[0] || null;
}

// Read an env var defensively — `bru` is absent in unit tests.
function readEnv(name) {
  try {
    return (typeof bru !== 'undefined' && bru.getEnvVar) ? bru.getEnvVar(name) : undefined;
  } catch (e) {
    return undefined;
  }
}

function isPresent(v) {
  return v != null && String(v).trim() !== '' && !/^null$/i.test(String(v).trim());
}

/**
 * The authoritative OSDM version for compliance pass/fail.
 * Resolution: apiVersion (operator/requestor override — reserved, currently
 * never set) → osdmVersion (per-scenario test-framework version) → default.
 * Deliberately ignores apiVersionsAvailable (the system's /versions).
 * Returns a normalised "major.minor.patch" string.
 */
function getComplianceVersion() {
  const candidates = [readEnv('apiVersion'), readEnv('osdmVersion')];
  for (const c of candidates) {
    if (!isPresent(c)) continue;
    const p = parseVersion(c);
    if (p) return `${p.major}.${p.minor}.${p.patch}`;
  }
  return DEFAULT_OSDM_VERSION;
}

/**
 * The negotiated OSDM version for endpoint selection (NOT compliance).
 * apiVersion → system /versions (apiVersionsAvailable) → osdmVersion → default.
 * Returns a parsed { major, minor, patch }.
 */
function resolveEffectiveVersion() {
  return parseVersion(readEnv('apiVersion'))
    || pickLatestFromList(readEnv('apiVersionsAvailable'))
    || parseVersion(readEnv('osdmVersion'))
    || parseVersion(DEFAULT_OSDM_VERSION);
}

// ── System-Information endpoint applicability by OSDM version ───────────
// Minimum OSDM version that INTRODUCED each System-Information endpoint,
// derived from the published specs (v3.4–v3.8). Endpoints not listed have
// existed since at least 3.4. Used to decide, per the test-framework version,
// whether an endpoint is in scope: a 404 on an endpoint that did not yet exist
// in the declared version is "out of scope", not a compliance failure.
//   /coach-deck-layouts, /product-tags → 3.5
//   /versions, /passenger-categories   → 3.6
//   /promotion-codes                   → 3.8
const ENDPOINT_MIN_VERSION = {
  '/versions': '3.6.0',
  '/coach-deck-layouts': '3.5.0',
  '/passenger-categories': '3.6.0',
  '/promotion-codes': '3.8.0',
  '/product-tags': '3.5.0',
};

function endpointMinVersion(endpoint) {
  return Object.prototype.hasOwnProperty.call(ENDPOINT_MIN_VERSION, endpoint)
    ? ENDPOINT_MIN_VERSION[endpoint]
    : null;
}

// Is this endpoint part of the OSDM version the test framework declares?
// `version` defaults to getComplianceVersion() (the test-framework truth).
function isEndpointApplicable(endpoint, version) {
  const min = endpointMinVersion(endpoint);
  if (!min) return true; // present since >= 3.4
  return atLeast(version || getComplianceVersion(), min);
}

module.exports = {
  DEFAULT_OSDM_VERSION,
  parseVersion,
  versionScore,
  compareVersions,
  atLeast,
  pickLatestFromList,
  getComplianceVersion,
  resolveEffectiveVersion,
  ENDPOINT_MIN_VERSION,
  endpointMinVersion,
  isEndpointApplicable,
};

// Expose to globalThis for convenience inside the Bruno sandbox (collection
// convention). The logged catch keeps lint/CodeQL happy about empty blocks.
try {
  Object.assign(globalThis, module.exports);
} catch (e) {
  console.log('[DEBUG] [library-bruno] globalThis exposure skipped: ' + (e && e.message));
}
