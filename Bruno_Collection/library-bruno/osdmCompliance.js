/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * osdmCompliance.js — OSDM response compliance assertions (Layer 1)
 * =================================================================
 * Pure, dependency-free helpers that check an already-parsed response body
 * against the OSDM specification at a STRUCTURAL level: collection-envelope
 * shape, required fields, value types and enum membership.
 *
 * Each validator returns an array of plain result objects:
 *     { name: string, ok: boolean, message: string }
 * The calling scenario maps each result into bruTest() so failures surface
 * in the Bruno UI and the HTML report:
 *
 *     const { validateApiVersions } =
 *       require(bru.getEnvVar("library_base") + "osdmCompliance.js");
 *     validateApiVersions(res.getBody()).forEach((c) =>
 *       bruTest(c.name, () => { expect(c.ok, c.message).to.be.true; }));
 *
 * Keeping the logic here (rather than inline in the .bru script) makes it
 * unit-testable under Jest and reusable across every System-Information
 * scenario. This is "Layer 1": full JSON-Schema (AJV) validation against the
 * version-matched OSDM spec is applied separately as "Layer 2".
 */

// ── Primitive JSON-Schema-style type check ──────────────────────────────
function isType(value, type) {
  switch (type) {
    case 'string':  return typeof value === 'string';
    case 'number':  return typeof value === 'number' && !Number.isNaN(value);
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array':   return Array.isArray(value);
    case 'object':  return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'null':    return value === null;
    default:        return false;
  }
}

// ── Lenient ISO-8601 date-time check ────────────────────────────────────
// OSDM uses RFC 3339 date-time strings (e.g. ApiVersion.sunset). We accept
// anything that both looks date-ish and is parseable, to avoid false
// negatives on valid timezone offsets while still catching obvious garbage.
function isDateTime(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  if (!/\d{4}-\d{2}-\d{2}/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

// ── GET /versions  →  array<ApiVersion> ─────────────────────────────────
// OSDM ApiVersion: { version: string (required),
//                    sunset?: date-time,
//                    nextVersion?: ApiNextVersion (object) }
// Rules are AGGREGATED (one result per rule, not per array entry) so a long
// version list does not flood the report; offending indices are named in the
// failure message instead.
function validateApiVersions(body) {
  const checks = [];

  const isArr = Array.isArray(body);
  checks.push({
    name: 'GET /versions → response is an array<ApiVersion>',
    ok: isArr,
    message: isArr ? '' : `Expected a JSON array of ApiVersion objects, got ${body === null ? 'null' : typeof body}`,
  });
  if (!isArr) return checks;

  checks.push({
    name: 'GET /versions → at least one ApiVersion entry',
    ok: body.length > 0,
    message: body.length > 0 ? '' : 'Version array is empty — a conformant system advertises at least one supported version',
  });

  // required: version (non-empty string)
  const missingVersion = [];
  body.forEach((v, i) => {
    if (!isType(v, 'object') || !isType(v.version, 'string') || v.version.trim() === '') {
      missingVersion.push(i);
    }
  });
  checks.push({
    name: 'GET /versions → every entry has required "version" (non-empty string)',
    ok: missingVersion.length === 0,
    message: missingVersion.length === 0 ? '' : `Entries with missing/invalid "version": index ${missingVersion.join(', ')}`,
  });

  // optional: sunset (date-time) when present and non-null
  const badSunset = [];
  body.forEach((v, i) => {
    if (isType(v, 'object') && v.sunset != null && !isDateTime(v.sunset)) badSunset.push(i);
  });
  checks.push({
    name: 'GET /versions → "sunset" (when present) is an ISO-8601 date-time',
    ok: badSunset.length === 0,
    message: badSunset.length === 0 ? '' : `Entries with non-date-time "sunset": index ${badSunset.join(', ')}`,
  });

  // optional: nextVersion (object) when present and non-null
  const badNext = [];
  body.forEach((v, i) => {
    if (isType(v, 'object') && v.nextVersion != null && !isType(v.nextVersion, 'object')) badNext.push(i);
  });
  checks.push({
    name: 'GET /versions → "nextVersion" (when present) is an object',
    ok: badNext.length === 0,
    message: badNext.length === 0 ? '' : `Entries with non-object "nextVersion": index ${badNext.join(', ')}`,
  });

  return checks;
}

module.exports = { isType, isDateTime, validateApiVersions };

// Expose to globalThis for convenience inside the Bruno sandbox (collection
// convention). The logged catch keeps lint/CodeQL happy about empty blocks.
try {
  Object.assign(globalThis, module.exports);
} catch (e) {
  console.log('[library-bruno] globalThis exposure skipped: ' + (e && e.message));
}
