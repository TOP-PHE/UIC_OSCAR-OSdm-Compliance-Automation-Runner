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

// ── Generic OSDM collection validator ───────────────────────────────────
// Drives the standard collection-response shape AND bare-array responses from
// a small declarative spec, so each System-Information endpoint needs only a
// thin wrapper. Rules are AGGREGATED (one result per rule); offending entry
// indices are named in the failure message.
//
// spec = {
//   endpoint:   '/zones',          // for human-readable check names
//   payloadKey: 'zones' | null,    // array property name; null = body IS the array
//   itemLabel:  'ZoneDefinition',
//   required:   { id: 'string', carrier: 'object' },  // present (non-null) + typed
//   optional:   { name: 'string' },                   // typed only when present
//   enums:      { field: ['A', 'B'] },                // membership only when present
// }
function validateOsdmCollection(body, spec) {
  const checks = [];
  const ep = spec.endpoint;
  let items;

  if (spec.payloadKey == null) {
    const isArr = Array.isArray(body);
    checks.push({
      name: `GET ${ep} → response is an array<${spec.itemLabel}>`,
      ok: isArr,
      message: isArr ? '' : `Expected a JSON array, got ${body === null ? 'null' : typeof body}`,
    });
    if (!isArr) return checks;
    items = body;
  } else {
    const isObj = isType(body, 'object');
    checks.push({
      name: `GET ${ep} → response is a collection object`,
      ok: isObj,
      message: isObj ? '' : `Expected an object envelope, got ${body === null ? 'null' : (Array.isArray(body) ? 'array' : typeof body)}`,
    });
    if (!isObj) return checks;

    const arr = body[spec.payloadKey];
    const isArr = Array.isArray(arr);
    checks.push({
      name: `GET ${ep} → "${spec.payloadKey}" is an array<${spec.itemLabel}>`,
      ok: isArr,
      message: isArr ? '' : `Property "${spec.payloadKey}" should be an array, got ${arr === undefined ? 'undefined' : typeof arr}`,
    });
    if (!isArr) return checks;
    items = arr;

    // Envelope hygiene: "problems" must be an array of Problem when present.
    if (body.problems !== undefined) {
      checks.push({
        name: `GET ${ep} → "problems" (when present) is an array`,
        ok: Array.isArray(body.problems),
        message: Array.isArray(body.problems) ? '' : '"problems" must be an array of Problem objects',
      });
    }
  }

  checks.push({
    name: `GET ${ep} → at least one ${spec.itemLabel} entry`,
    ok: items.length > 0,
    message: items.length > 0 ? '' : `Collection is empty — expected at least one ${spec.itemLabel}`,
  });

  const aggregate = (fields, predicate, label) => {
    Object.entries(fields || {}).forEach(([field, type]) => {
      const bad = [];
      items.forEach((it, i) => { if (predicate(it, field, type)) bad.push(i); });
      checks.push({
        name: label(field, type),
        ok: bad.length === 0,
        message: bad.length === 0 ? '' : `Entries with issue on "${field}": index ${bad.join(', ')}`,
      });
    });
  };

  aggregate(spec.required, (it, f, t) => !isType(it, 'object') || it[f] == null || !isType(it[f], t),
    (f, t) => `GET ${ep} → every ${spec.itemLabel} has required "${f}" (${t})`);
  aggregate(spec.optional, (it, f, t) => isType(it, 'object') && it[f] != null && !isType(it[f], t),
    (f, t) => `GET ${ep} → "${f}" (when present) is ${t}`);

  Object.entries(spec.enums || {}).forEach(([field, allowed]) => {
    const bad = [];
    items.forEach((it, i) => { if (isType(it, 'object') && it[field] != null && !allowed.includes(it[field])) bad.push(i); });
    checks.push({
      name: `GET ${ep} → "${field}" (when present) is a known OSDM value`,
      ok: bad.length === 0,
      message: bad.length === 0 ? '' : `Entries with unknown "${field}": index ${bad.join(', ')}`,
    });
  });

  return checks;
}

// ── Per-endpoint wrappers (OSDM System-Information collections) ──────────
function validateReductionCards(body) {
  return validateOsdmCollection(body, {
    endpoint: '/reduction-cards',
    payloadKey: 'reductionCardTypes',
    itemLabel: 'ReductionCardType',
    required: { code: 'string', issuer: 'object', name: 'object' },
    optional: { shortCode: 'string', cardIdRequired: 'boolean' },
  });
}

function validateZones(body) {
  return validateOsdmCollection(body, {
    endpoint: '/zones',
    payloadKey: 'zones',
    itemLabel: 'ZoneDefinition',
    required: { id: 'string', carrier: 'object' },
    optional: { name: 'string', nutsCodes: 'array' },
  });
}

function validatePromotionCodes(body) {
  return validateOsdmCollection(body, {
    endpoint: '/promotion-codes',
    payloadKey: 'promotionCodes',
    itemLabel: 'PromotionCode',
    required: { code: 'string' },
    optional: { issuer: 'string' },
  });
}

function validatePassengerCategories(body) {
  return validateOsdmCollection(body, {
    endpoint: '/passenger-categories',
    payloadKey: null, // OSDM v3.8: GET /passenger-categories returns a bare array
    itemLabel: 'PassengerCategory',
    required: { title: 'object', specification: 'object' },
    optional: { base: 'boolean', additional: 'boolean' },
  });
}

// ── GET /product-tags → ProductTagsResponse (non-standard dual-array shape) ─
// { productTagNames*: array<ProductTagName>, productTagGroups*: array<ProductTagGroup>,
//   problems?: array<Problem> }
function validateProductTags(body) {
  const checks = [];
  const ep = '/product-tags';
  const isObj = isType(body, 'object');
  checks.push({
    name: `GET ${ep} → response is a ProductTagsResponse object`,
    ok: isObj,
    message: isObj ? '' : `Expected an object, got ${body === null ? 'null' : (Array.isArray(body) ? 'array' : typeof body)}`,
  });
  if (!isObj) return checks;

  const names = body.productTagNames;
  const namesArr = Array.isArray(names);
  checks.push({
    name: `GET ${ep} → required "productTagNames" is an array<ProductTagName>`,
    ok: namesArr,
    message: namesArr ? '' : '"productTagNames" must be an array',
  });

  const groups = body.productTagGroups;
  const groupsArr = Array.isArray(groups);
  checks.push({
    name: `GET ${ep} → required "productTagGroups" is an array<ProductTagGroup>`,
    ok: groupsArr,
    message: groupsArr ? '' : '"productTagGroups" must be an array',
  });

  if (namesArr) {
    const badTag = [];
    const badDesc = [];
    names.forEach((n, i) => {
      if (!isType(n, 'object') || !isType(n.tag, 'string')) badTag.push(i);
      if (!isType(n, 'object') || !isType(n.description, 'object')) badDesc.push(i);
    });
    checks.push({ name: `GET ${ep} → every productTagName has required "tag" (string)`, ok: badTag.length === 0, message: badTag.length === 0 ? '' : `index ${badTag.join(', ')}` });
    checks.push({ name: `GET ${ep} → every productTagName has required "description" (Text object)`, ok: badDesc.length === 0, message: badDesc.length === 0 ? '' : `index ${badDesc.join(', ')}` });
  }

  if (groupsArr) {
    const badCode = [];
    const badDesc = [];
    groups.forEach((g, i) => {
      if (!isType(g, 'object') || !isType(g.code, 'string')) badCode.push(i);
      if (!isType(g, 'object') || !isType(g.description, 'object')) badDesc.push(i);
    });
    checks.push({ name: `GET ${ep} → every productTagGroup has required "code" (string)`, ok: badCode.length === 0, message: badCode.length === 0 ? '' : `index ${badCode.join(', ')}` });
    checks.push({ name: `GET ${ep} → every productTagGroup has required "description" (Text object)`, ok: badDesc.length === 0, message: badDesc.length === 0 ? '' : `index ${badDesc.join(', ')}` });
  }

  return checks;
}

module.exports = {
  isType,
  isDateTime,
  validateApiVersions,
  validateOsdmCollection,
  validateReductionCards,
  validateZones,
  validatePromotionCodes,
  validatePassengerCategories,
  validateProductTags,
};

// Expose to globalThis for convenience inside the Bruno sandbox (collection
// convention). The logged catch keeps lint/CodeQL happy about empty blocks.
try {
  Object.assign(globalThis, module.exports);
} catch (e) {
  console.log('[library-bruno] globalThis exposure skipped: ' + (e && e.message));
}
