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
 *       bruTest(c.name, () => { if (!c.ok) throw new Error(c.message); }));
 *
 * Keeping the logic here (rather than inline in the .bru script) makes it
 * unit-testable under Jest and reusable across every System-Information
 * scenario. This is "Layer 1": full JSON-Schema (AJV) validation against the
 * version-matched OSDM spec is applied separately as "Layer 2".
 */

// Version-applicability helpers (osdmVersion.js) — used by the shared
// System-Information status classifier below.
const { getComplianceVersion, endpointMinVersion, isEndpointApplicable } = require('./osdmVersion.js');

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
//   required:   { id: 'string', carrier: 'string' },  // present (non-null) + typed
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

  // NOTE: an empty collection is OSDM-valid (a vendor may legitimately have no
  // reduction cards, zones, promotion codes, etc.), so there is deliberately NO
  // "at least one entry" compliance rule here. Data-presence/liveness remains a
  // separate scenario-level check.
  const aggregate = (fields, predicate, label, describe) => {
    Object.entries(fields || {}).forEach(([field, type]) => {
      const bad = [];
      items.forEach((it, i) => { if (predicate(it, field, type)) bad.push(i); });
      // Log-audit round 2: plain-language failure summary instead of a raw
      // dump of every failing index (the old message printed "index 0, 1,
      // 2, … 207" — 208 numbers a tester can do nothing with). When every
      // entry fails, say ALL; otherwise give the count and a 10-index
      // sample so the tester can open a concrete example.
      let message = '';
      if (bad.length > 0) {
        const where = bad.length === items.length
          ? `ALL ${items.length} ${spec.itemLabel} entries`
          : `${bad.length} of ${items.length} ${spec.itemLabel} entries (index ${bad.slice(0, 10).join(', ')}${bad.length > 10 ? `, … +${bad.length - 10} more` : ''})`;
        message = `${describe(field, type)} on ${where}.`;
      }
      checks.push({ name: label(field, type), ok: bad.length === 0, message });
    });
  };

  aggregate(spec.required, (it, f, t) => !isType(it, 'object') || it[f] == null || !isType(it[f], t),
    (f, t) => `GET ${ep} → every ${spec.itemLabel} has required "${f}" (${t})`,
    (f, t) => `required property "${f}" is missing or not of type ${t}`);
  aggregate(spec.optional, (it, f, t) => isType(it, 'object') && it[f] != null && !isType(it[f], t),
    (f, t) => `GET ${ep} → "${f}" (when present) is ${t}`,
    (f, t) => `optional property "${f}" is present but not of type ${t}`);

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
    // issuer is a CompanyRef (string URN); name is a Text object.
    required: { code: 'string', issuer: 'string', name: 'object' },
    optional: { shortCode: 'string', cardIdRequired: 'boolean' },
  });
}

function validateZones(body) {
  return validateOsdmCollection(body, {
    endpoint: '/zones',
    payloadKey: 'zones',
    itemLabel: 'ZoneDefinition',
    // carrier is a CompanyRef (string URN), not an object.
    required: { id: 'string', carrier: 'string' },
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

// ── Generic OSDM single-resource validator ──────────────────────────────
// For "get one" endpoints whose response wraps a single object under a key,
// e.g. ProductResponse = { warnings, problems[], product }. Validates the
// envelope, the wrapped object's presence/type, then its required/optional
// fields. Extensible-enum fields (x-extensible-enum) are type-checked only,
// never value-checked, since OSDM permits values beyond the published list.
function validateOsdmResource(body, spec) {
  const checks = [];
  const ep = spec.endpoint;

  const isObj = isType(body, 'object');
  checks.push({
    name: `GET ${ep} → response is a resource object`,
    ok: isObj,
    message: isObj ? '' : `Expected an object envelope, got ${body === null ? 'null' : (Array.isArray(body) ? 'array' : typeof body)}`,
  });
  if (!isObj) return checks;

  const item = body[spec.resourceKey];
  const itemOk = isType(item, 'object');
  checks.push({
    name: `GET ${ep} → "${spec.resourceKey}" is a ${spec.itemLabel} object`,
    ok: itemOk,
    message: itemOk ? '' : `Expected "${spec.resourceKey}" to be a ${spec.itemLabel} object (OSDM wraps the resource under "${spec.resourceKey}")`,
  });
  if (!itemOk) return checks;

  Object.entries(spec.required || {}).forEach(([field, type]) => {
    const ok = item[field] != null && isType(item[field], type);
    checks.push({
      name: `GET ${ep} → ${spec.itemLabel} has required "${field}" (${type})`,
      ok,
      message: ok ? '' : `Missing/invalid required "${field}"`,
    });
  });
  Object.entries(spec.optional || {}).forEach(([field, type]) => {
    const ok = item[field] == null || isType(item[field], type);
    checks.push({
      name: `GET ${ep} → "${field}" (when present) is ${type}`,
      ok,
      message: ok ? '' : `Wrong-typed "${field}" (expected ${type})`,
    });
  });

  return checks;
}

// ── Products: collection (/products) + single resource (/products/{id}) ──
// Product required: id, code, owner, flexibility. type / flexibility /
// travelClass are x-extensible-enum strings → type-checked, not value-checked.
// NB: owner is a CompanyRef, which OSDM defines as a STRING (a RICS/ERA
// company-code URN, e.g. "urn:uic:rics:1185:000011") — not an object.
const PRODUCT_REQUIRED = { id: 'string', code: 'string', owner: 'string', flexibility: 'string' };
const PRODUCT_OPTIONAL = {
  type: 'string', summary: 'string', description: 'string',
  serviceClass: 'object', travelClass: 'string',
  isTrainBound: 'boolean', isReturnProduct: 'boolean',
  tariff: 'string', productTags: 'array',
};

function validateProducts(body) {
  return validateOsdmCollection(body, {
    endpoint: '/products',
    payloadKey: 'products',
    itemLabel: 'Product',
    required: PRODUCT_REQUIRED,
    optional: PRODUCT_OPTIONAL,
  });
}

function validateProduct(body) {
  return validateOsdmResource(body, {
    endpoint: '/products/{productId}',
    resourceKey: 'product',
    itemLabel: 'Product',
    required: PRODUCT_REQUIRED,
    optional: PRODUCT_OPTIONAL,
  });
}

// ── Coach layouts: collection + single resource ─────────────────────────
// The scenario picks the resource by effective OSDM version:
//   >= 3.8 → /coach-deck-layouts  (CoachDeckLayoutCollectionResponse → coachDeckLayouts[]; item CoachDeckLayout)
//   <  3.8 → /coach-layouts       (CoachLayoutCollectionResponse → layouts[];            item CoachLayout)
// Both endpoints accept an optional `endpoint` arg so the check names reflect
// the actual resource that was called. dimension/gridSize are objects;
// deckLevel is an x-extensible-enum string (type-checked only).
const COACH_LAYOUT_REQUIRED = { id: 'string', gridSize: 'object' };
const COACH_LAYOUT_OPTIONAL = {
  summary: 'string', places: 'array', signs: 'array',
  internals: 'array', directedInternals: 'array', compartmentNumbers: 'array',
};
const COACH_DECK_REQUIRED = { id: 'string', name: 'string', dimension: 'object', deckLevel: 'string' };
const COACH_DECK_OPTIONAL = {
  lowFloorEntry: 'boolean', placeGroups: 'array', graphicElements: 'array', serviceIcons: 'array',
};

function validateCoachLayouts(body, endpoint) {
  return validateOsdmCollection(body, {
    endpoint: endpoint || '/coach-layouts',
    payloadKey: 'layouts',
    itemLabel: 'CoachLayout',
    required: COACH_LAYOUT_REQUIRED,
    optional: COACH_LAYOUT_OPTIONAL,
  });
}

function validateCoachDeckLayouts(body, endpoint) {
  return validateOsdmCollection(body, {
    endpoint: endpoint || '/coach-deck-layouts',
    payloadKey: 'coachDeckLayouts',
    itemLabel: 'CoachDeckLayout',
    required: COACH_DECK_REQUIRED,
    optional: COACH_DECK_OPTIONAL,
  });
}

function validateCoachLayout(body, endpoint) {
  return validateOsdmResource(body, {
    endpoint: endpoint || '/coach-layouts/{id}',
    resourceKey: 'coachLayout',
    itemLabel: 'CoachLayout',
    required: COACH_LAYOUT_REQUIRED,
    optional: COACH_LAYOUT_OPTIONAL,
  });
}

function validateCoachDeckLayout(body, endpoint) {
  return validateOsdmResource(body, {
    endpoint: endpoint || '/coach-deck-layouts/{id}',
    resourceKey: 'coachDeckLayout',
    itemLabel: 'CoachDeckLayout',
    required: COACH_DECK_REQUIRED,
    optional: COACH_DECK_OPTIONAL,
  });
}

// ── Place availability (/availabilities/place-map) — issue #104 ──────────
// PlaceAvailabilityResponse: { warnings?, problems?[], vehicleAvailability? }.
// vehicleAvailability (PlaceAvailability) wraps a REQUIRED "vehicle" (Vehicle)
// plus optional reference + preSelections[]. The response is transaction-scoped
// (needs an OFFER + RESERVATION context), so vehicleAvailability may be absent —
// that is reported as a check, not crashed. This is a bespoke validator (not
// validateOsdmResource) because the resource is nested under vehicleAvailability.
function validatePlaceAvailability(body, endpoint) {
  const ep = endpoint || '/availabilities/place-map';
  const checks = [];

  const isObj = isType(body, 'object');
  checks.push({
    name: `GET ${ep} → response is a PlaceAvailabilityResponse object`,
    ok: isObj,
    message: isObj ? '' : `Expected an object envelope, got ${body === null ? 'null' : (Array.isArray(body) ? 'array' : typeof body)}`,
  });
  if (!isObj) return checks;

  const problemsOk = body.problems == null || isType(body.problems, 'array');
  checks.push({
    name: `GET ${ep} → "problems" (when present) is an array`,
    ok: problemsOk,
    message: problemsOk ? '' : 'Envelope "problems" must be an array when present',
  });

  const va = body.vehicleAvailability;
  const vaPresent = va != null;
  const vaOk = !vaPresent || isType(va, 'object');
  checks.push({
    name: `GET ${ep} → "vehicleAvailability" (when present) is a PlaceAvailability object`,
    ok: vaOk,
    message: vaOk ? '' : 'Expected "vehicleAvailability" to be an object',
  });

  if (vaPresent && vaOk) {
    const vehicleOk = va.vehicle != null && isType(va.vehicle, 'object');
    checks.push({
      name: `GET ${ep} → PlaceAvailability has required "vehicle" (object)`,
      ok: vehicleOk,
      message: vehicleOk ? '' : 'Missing/invalid required "vehicle" in vehicleAvailability',
    });
    const refOk = va.reference == null || isType(va.reference, 'object');
    checks.push({
      name: `GET ${ep} → "reference" (when present) is an object`,
      ok: refOk,
      message: refOk ? '' : 'Wrong-typed "reference" (expected object)',
    });
    const psOk = va.preSelections == null || isType(va.preSelections, 'array');
    checks.push({
      name: `GET ${ep} → "preSelections" (when present) is an array`,
      ok: psOk,
      message: psOk ? '' : 'Wrong-typed "preSelections" (expected array)',
    });
  }

  return checks;
}

// ── Add-offer-part to a booking (issue #104 Stage B / ADD_TO_BOOKING) ─────
// POST /bookings/{id}/booked-offers/{id}/offer-parts (>=3.7) responds with a
// BookedOfferPartResponse, and the deprecated .../reservations (<3.7) with a
// BookedOfferReservationResponse. Both are envelopes:
//   { warnings?, problems?[], bookedOffers?[] }
// Neither field is "required" by the schema, but a successful add returns the
// updated bookedOffers, so we assert envelope hygiene + that bookedOffers (when
// present) is a non-empty array. `endpoint` lets the check names reflect the
// resolved resource (offer-parts vs reservations).
function validateBookedOfferPartResponse(body, endpoint) {
  const ep = endpoint || '/bookings/{id}/booked-offers/{id}/offer-parts';
  const checks = [];

  const isObj = isType(body, 'object');
  checks.push({
    name: `POST ${ep} → response is a BookedOfferPartResponse object`,
    ok: isObj,
    message: isObj ? '' : `Expected an object envelope, got ${body === null ? 'null' : (Array.isArray(body) ? 'array' : typeof body)}`,
  });
  if (!isObj) return checks;

  const problemsOk = body.problems == null || isType(body.problems, 'array');
  checks.push({
    name: `POST ${ep} → "problems" (when present) is an array`,
    ok: problemsOk,
    message: problemsOk ? '' : 'Envelope "problems" must be an array when present',
  });

  const boOk = body.bookedOffers == null || isType(body.bookedOffers, 'array');
  checks.push({
    name: `POST ${ep} → "bookedOffers" (when present) is an array`,
    ok: boOk,
    message: boOk ? '' : 'Expected "bookedOffers" to be an array of BookedOffer',
  });
  if (body.bookedOffers != null && boOk) {
    const nonEmpty = body.bookedOffers.length > 0;
    checks.push({
      name: `POST ${ep} → "bookedOffers" is non-empty (the added part is returned)`,
      ok: nonEmpty,
      message: nonEmpty ? '' : 'A successful add-offer-part returns the updated bookedOffers',
    });
  }

  return checks;
}

// ── Offer-time AncillaryOfferPart compliance (issue #108) ──────────────────
// Validates the OSDM structural shape of an Offer's ancillaryOfferParts[].
// Lenient (Layer 1) and emitted ONLY when the offer carries ancillary parts —
// so it is a pure no-op for offers without ancillaries (most vendors) and lights
// up only where there is something to check (e.g. Sqills). Each AncillaryOfferPart
// requires a non-empty string "id" (AbstractOfferPart) and a string "type"
// (AncillaryType — an x-extensible-enum, so type-checked, not value-checked);
// "category" is an optional string. Pass the parsed Offer object.
function validateAncillaryOfferParts(offer, endpoint) {
  const ep = endpoint || '/offers';
  const checks = [];
  const parts = offer && typeof offer === 'object' ? offer.ancillaryOfferParts : undefined;
  if (parts == null) return checks; // no ancillary parts → nothing to assert

  const isArr = isType(parts, 'array');
  checks.push({
    name: `${ep} → "ancillaryOfferParts" is an array<AncillaryOfferPart>`,
    ok: isArr,
    message: isArr ? '' : `Expected "ancillaryOfferParts" to be an array, got ${typeof parts}`,
  });
  if (!isArr || parts.length === 0) return checks;

  const badId = [], badType = [], badCategory = [];
  parts.forEach((p, i) => {
    const obj = isType(p, 'object');
    if (!obj || !isType(p.id, 'string') || p.id.trim() === '') badId.push(i);
    if (!obj || !isType(p.type, 'string') || p.type.trim() === '') badType.push(i);
    if (obj && p.category != null && !isType(p.category, 'string')) badCategory.push(i);
  });
  checks.push({
    name: `${ep} → every AncillaryOfferPart has required "id" (non-empty string)`,
    ok: badId.length === 0,
    message: badId.length === 0 ? '' : `AncillaryOfferParts with missing/invalid "id": index ${badId.join(', ')}`,
  });
  checks.push({
    name: `${ep} → every AncillaryOfferPart has required "type" (AncillaryType string)`,
    ok: badType.length === 0,
    message: badType.length === 0 ? '' : `AncillaryOfferParts with missing/invalid "type": index ${badType.join(', ')}`,
  });
  checks.push({
    name: `${ep} → AncillaryOfferPart "category" (when present) is a string`,
    ok: badCategory.length === 0,
    message: badCategory.length === 0 ? '' : `AncillaryOfferParts with non-string "category": index ${badCategory.join(', ')}`,
  });
  return checks;
}

// ── Shared System-Information response-status classification ─────────────
// Pure classification of a System-Information GET response status, made
// version-aware via the test-framework OSDM version (osdmVersion.js). Returns:
//   { outcome: 'ok'  }                       → 200; caller proceeds to body+compliance
//   { outcome: 'skip', log }                 → 404 on an endpoint not yet part of the
//                                              declared OSDM version → out of scope
//                                              (INFO log only; not pass nor fail)
//   { outcome: 'fail', name, message, log }  → auth / not-found(when expected) / server
//   { outcome: 'ok',   name }                → name carries the "200 OK" assertion label
//
// Log-audit round 2: also PROBLEM-BODY-aware — when the provider answers a
// non-2xx with an RFC-9457/OSDM Problem whose code says the operation is
// unsupported (e.g. urn:uic:problem:OPERATION_NOT_PERMITTED), say exactly
// that in ONE decoded line instead of the generic "unexpected status 400"
// cascade. HTTP 501 (RFC 9110's not-implemented code; an OSDM-listed status) gets the same
// decoded treatment instead of being mislabelled "Server Error".

// Best-effort extraction of the first OSDM Problem from a non-2xx body.
// Accepts a bare Problem object ({ code, title, detail, … }) or the
// envelope form ({ problems: [ … ] }). Returns null when the body doesn't
// look like a Problem.
function extractOsdmProblem(body) {
  if (body == null || typeof body !== 'object') return null;
  if (Array.isArray(body.problems) && body.problems.length > 0 &&
      body.problems[0] != null && typeof body.problems[0] === 'object') {
    return body.problems[0];
  }
  if (typeof body.code === 'string' || typeof body.title === 'string') return body;
  return null;
}

function classifySystemInfoStatus(statusCode, endpoint, body) {
  if (statusCode === 200) {
    return { outcome: 'ok', name: `GET ${endpoint} → 200 OK` };
  }
  if (statusCode === 404 && !isEndpointApplicable(endpoint)) {
    return {
      outcome: 'skip',
      log: `[INFO] GET ${endpoint} → 404 — endpoint introduced in OSDM ${endpointMinVersion(endpoint)}; test-framework version is ${getComplianceVersion()} → out of scope (skipped)`,
    };
  }
  if (statusCode === 401) {
    // A token problem, never an availability signal — stays a hard FAIL
    // regardless of how lenient the "not supported" detection below gets.
    return { outcome: 'fail', name: `GET ${endpoint} → 401 Unauthorized (FAIL)`, message: 'Expected 200, got 401 Unauthorized — check access token', log: `[ERROR] GET ${endpoint} → 401 Unauthorized — check access token` };
  }

  // Provider declares (or, per field evidence below, effectively signals)
  // the operation unsupported. #353: this is a SKIP, like out-of-version
  // endpoints — not a failure.
  //
  // #488/#489 field review (Farruggia + Heuguet, OTST, 2026-07/08): this
  // ORIGINALLY auto-skipped only on an unambiguous, self-describing signal —
  // HTTP 501, or a Problem body whose `code` says the operation is not
  // permitted. Real testing against SBB showed that bar is too strict: SBB
  // (and evidently other providers) answer an unimplemented optional
  // endpoint with a bare 403/404/405/500 and NO Problem body at all — the
  // original design still hard-failed every one of those. Widened to trust
  // the STATUS ALONE for the specific codes providers actually use for "not
  // supported" in practice, still preferring the Problem-body-confirmed
  // wording when one IS present. This only ever applies to the read-only,
  // non-mandatory endpoints that call this classifier (System-Info catalog
  // lookups, GET Passenger, GET Refund/Exchange Offer) — never a
  // booking/refund/exchange MUTATION, which keeps its own strict, bespoke
  // 200-equality assertion.
  //
  // Standards check (Heuguet, 2026-09-03 — osdm.io/spec/errors-problems and
  // RFC 9110 §15): OSDM defines NO endpoint-level "not implemented" signal
  // of its own; it adopts the standard HTTP status codes and leaves their
  // meaning to RFC 9110. By that standard only 501 ("does not support the
  // functionality required"), 404 ("cannot find the requested resource")
  // and 405 ("target resource doesn't support this method") genuinely mean
  // "not implemented/supported here". 403 is an authorization refusal and
  // 500 a generic server error — neither means "not implemented"; both are
  // trusted here purely on the SBB field evidence, hence WARNING-tier below.
  // 406 was dropped from the list in that review: it is not even among
  // OSDM's prescribed statuses, and its RFC meaning (content negotiation
  // failed) most plausibly signals an unsupported OSDM VERSION / media type
  // — a different problem a tester should see, not have auto-skipped. A
  // provider that genuinely answers 406 can still be baselined per company
  // via the known-deviation mechanism (#430 path in handleSystemInfoStatus).
  const _problem = extractOsdmProblem(body);
  const _problemCode = _problem && typeof _problem.code === 'string' ? _problem.code : '';
  // OSDM's problem registry has exactly one on-point code for this,
  // OPERATION_NOT_PERMITTED. The other tokens are kept only as tolerance for
  // vendor-extension codes (OSDM enums are extensible by design). But two
  // REAL OSDM codes contain "NOT_SUPPORTED" and describe a problem with the
  // REQUEST, not the endpoint — PARAMETER_NOT_SUPPORTED (a required request
  // parameter the provider doesn't support) and VALUE_NOT_SUPPORTED (a
  // warning about a sent value) — so they must NOT read as "endpoint not
  // implemented"; those fall through to the normal failure path.
  const _requestLevelCode = /PARAMETER_NOT_SUPPORTED|VALUE_NOT_SUPPORTED/i.test(_problemCode);
  const _saysUnsupported = !_requestLevelCode &&
    /OPERATION_NOT_PERMITTED|NOT_IMPLEMENTED|NOT_SUPPORTED|UNSUPPORTED/i.test(_problemCode);
  const _bareNotSupportedStatus = [403, 404, 405, 500].includes(statusCode);
  if (statusCode === 501 || _saysUnsupported || _bareNotSupportedStatus) {
    const _title = _problem && _problem.title ? ` ("${_problem.title}")` : '';
    const _via = _saysUnsupported
      ? `HTTP ${statusCode} with OSDM Problem code ${_problemCode}${_title}`
      : (statusCode === 501 ? 'HTTP 501 Not Implemented' : `HTTP ${statusCode}`);
    // A clean, unambiguous signal (501, 404, or a confirming Problem body)
    // is INFO — the provider told us clearly. A bare 403/405/500 with no
    // confirming body is a WARNING — accepted as "not supported" per this
    // baseline, but the provider should say so explicitly: per RFC 9110
    // (whose status semantics OSDM adopts) a resource or functionality the
    // server does not provide answers 404 or 501, ideally with an OSDM
    // Problem body; 403 means "authorization refused", 405 "method not
    // allowed on this resource" and 500 "server error", so on their own
    // they are ambiguous. (OSDM itself prescribes nothing here — do not
    // word this line as "OSDM expects"; vendors read it.)
    const _rightSignal = statusCode === 501 || statusCode === 404 || _saysUnsupported;
    return {
      outcome: 'skip',
      log: _rightSignal
        ? `[INFO] GET ${endpoint} → not implemented by this provider (${_via}) — endpoint out of scope, skipped (404/501 are the RFC 9110 codes for a resource or functionality the server does not provide; both are OSDM-listed statuses)`
        : `[WARNING] GET ${endpoint} → treated as not supported by this provider (${_via}, no confirming OSDM Problem body) — endpoint skipped. Note for the provider: per RFC 9110 (the HTTP status semantics OSDM adopts), an endpoint the server does not provide should answer 404 Not Found or 501 Not Implemented, ideally with an OSDM Problem body — a bare ${statusCode} is ambiguous (403 = authorization refused, 405 = method not allowed on the resource, 500 = server error).`,
    };
  }

  if (statusCode >= 500) {
    return { outcome: 'fail', name: `GET ${endpoint} → ${statusCode} Server Error (FAIL)`, message: `Expected 200, got ${statusCode} server error`, log: `[ERROR] GET ${endpoint} → ${statusCode} Server Error` };
  }
  return { outcome: 'fail', name: `GET ${endpoint} → unexpected status ${statusCode}`, message: `Unexpected status ${statusCode}, expected 200`, log: `[WARNING] GET ${endpoint} → unexpected status ${statusCode}` };
}

// Apply the status classification to the Bruno report. Pass the scenario's
// { bruTest, validationLogger, body } — body (the parsed response body) is
// optional but enables the Problem-code-aware "not supported" decoding.
// Returns true iff the status is 200 (caller then runs its body + compliance
// checks); false otherwise (caller returns).
// Out-of-version endpoints are logged as skipped — no pass/fail registered.
function handleSystemInfoStatus(statusCode, endpoint, ctx) {
  const bruTest = ctx && ctx.bruTest;
  const validationLogger = ctx && ctx.validationLogger;
  const cls = classifySystemInfoStatus(statusCode, endpoint, ctx && ctx.body);
  if (cls.log && validationLogger) validationLogger(cls.log);
  if (cls.outcome === 'ok') {
    if (bruTest) bruTest(cls.name, () => { expect(statusCode).to.eql(200); });
    return true;
  }
  if (cls.outcome === 'fail' && bruTest) {
    // #430: a non-2xx the tester has baselined as a known deviation (e.g. a
    // provider that answers 403 "endpoint not supported" on a system-info GET)
    // is reported as a documented known deviation — a [WARNING], NOT a failure —
    // consistent with the refund/exchange 405 baseline. The step label comes
    // from the global `req` (the Bruno sandbox exposes it to library modules).
    try {
      const stepLabel = (typeof req !== 'undefined' && req && typeof req.getName === 'function') ? req.getName() : '';
      const { knownDeviationFor, noteKnownDeviation } = require(bru.getEnvVar('library_base') + 'loopback.js');
      const dev = stepLabel ? knownDeviationFor(stepLabel, statusCode) : null;
      if (dev) {
        noteKnownDeviation(stepLabel, statusCode, dev);
        return false; // documented deviation — no failure registered, skip body checks
      }
    } catch (_e) { /* loopback unavailable — fall through to the normal failure */ }
    // Plain throw (not expect) so the failure text is exactly cls.message —
    // no chai ": expected 400 to deeply equal 200" tail (log-audit round 2).
    bruTest(cls.name, () => { throw new Error(cls.message); });
  }
  // 'skip' → INFO log only, no bruTest (not counted as pass or fail)
  return false;
}

module.exports = {
  isType,
  isDateTime,
  validateApiVersions,
  validateOsdmCollection,
  validateOsdmResource,
  validateReductionCards,
  validateZones,
  validatePromotionCodes,
  validatePassengerCategories,
  validateProductTags,
  validateProducts,
  validateProduct,
  validateCoachLayouts,
  validateCoachDeckLayouts,
  validateCoachLayout,
  validateCoachDeckLayout,
  validatePlaceAvailability,
  validateBookedOfferPartResponse,
  validateAncillaryOfferParts,
  classifySystemInfoStatus,
  handleSystemInfoStatus,
};

// Expose to globalThis for convenience inside the Bruno sandbox (collection
// convention). The logged catch keeps lint/CodeQL happy about empty blocks.
try {
  Object.assign(globalThis, module.exports);
} catch (e) {
  console.log('[DEBUG] [library-bruno] globalThis exposure skipped: ' + (e && e.message));
}
