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
function classifySystemInfoStatus(statusCode, endpoint) {
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
    return { outcome: 'fail', name: `GET ${endpoint} → 401 Unauthorized (FAIL)`, message: 'Expected 200, got 401 Unauthorized — check access token', log: `[ERROR] GET ${endpoint} → 401 Unauthorized — check access token` };
  }
  if (statusCode === 403) {
    return { outcome: 'fail', name: `GET ${endpoint} → 403 Forbidden (FAIL)`, message: 'Expected 200, got 403 Forbidden — insufficient permissions', log: `[ERROR] GET ${endpoint} → 403 Forbidden — insufficient permissions` };
  }
  if (statusCode === 404) {
    return { outcome: 'fail', name: `GET ${endpoint} → 404 Not Found (FAIL)`, message: `Expected 200, got 404 — endpoint expected in OSDM ${getComplianceVersion()} but not implemented by this vendor`, log: `[ERROR] GET ${endpoint} → 404 Not Found — endpoint not implemented by this vendor` };
  }
  if (statusCode >= 500) {
    return { outcome: 'fail', name: `GET ${endpoint} → ${statusCode} Server Error (FAIL)`, message: `Expected 200, got ${statusCode} server error`, log: `[ERROR] GET ${endpoint} → ${statusCode} Server Error` };
  }
  return { outcome: 'fail', name: `GET ${endpoint} → unexpected status ${statusCode}`, message: `Unexpected status ${statusCode}, expected 200`, log: `[WARNING] GET ${endpoint} → unexpected status ${statusCode}` };
}

// Apply the status classification to the Bruno report. Pass the scenario's
// { bruTest, validationLogger }. Returns true iff the status is 200 (caller
// then runs its body + compliance checks); false otherwise (caller returns).
// Out-of-version endpoints are logged as skipped — no pass/fail registered.
function handleSystemInfoStatus(statusCode, endpoint, ctx) {
  const bruTest = ctx && ctx.bruTest;
  const validationLogger = ctx && ctx.validationLogger;
  const cls = classifySystemInfoStatus(statusCode, endpoint);
  if (cls.log && validationLogger) validationLogger(cls.log);
  if (cls.outcome === 'ok') {
    if (bruTest) bruTest(cls.name, () => { expect(statusCode).to.eql(200); });
    return true;
  }
  if (cls.outcome === 'fail' && bruTest) {
    bruTest(cls.name, () => { expect(statusCode, cls.message).to.eql(200); });
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
