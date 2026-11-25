/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * nonTrip.js — offers without a trip (#1258): an OfferCollectionRequest with
 * `nonTripSearchCriteria` and no trip member, by stop places or by zones.
 *
 * - Places are stop places only (`StopPlaceRef`); of the other Place kinds
 *   (address, point of interest, geo position) none is sent. With a name to
 *   look up, `POST /places` (type STOP) names them; a place of another kind
 *   in its answer is a WARNING and is not used.
 * - Zones come from `GET /zones` when the scenario names none: the first
 *   zone, its id and carrier as given (OSCAR does not guess a carrier).
 * - NUTS codes (#1266): those the scenario names, else those of the first
 *   zone of `GET /zones` that lists some (ZoneDefinition.nutsCodes). OSDM:
 *   the offers are valid "within the area specified", or "in a relevant part
 *   of the region"; a validity naming no code asked (Zone.nutsCode) is a
 *   WARNING, as for places and zones. `nutsCodeExpectRejection` expects an
 *   unknown code refused or answered without an offer.
 * - The zone of a stop place of the trip (#1449): `nonTrip.zoneOf` names a
 *   stop place, and the zone (or its NUTS codes) asked is the zone of
 *   `GET /zones` whose places hold it: the link a distributor makes between
 *   the trip of its product-based sale and the provider's zones. No zone
 *   holding it is a failed check, and the scenario ends.
 * - Fares (#1444): OSDM's page on fares says online fares are "always part
 *   of an offer for a specified trip", and its page on sales without a trip
 *   names none; the OSDM architect (2026-11-25): implicitly trip-related,
 *   theoretically sold without a trip. `nonTripFaresExpectRejection` asks
 *   fares without a trip of a provider that does not declare them sold so:
 *   refused, or answered without a fare, passes; fares given are a WARNING.
 *   A sale of them (#1449) is checked in fares.js and fareBooking.js
 *   (nonTripFares.js).
 * - The answer has no trip and no trip coverage; each admission says where it
 *   is valid: `regionalValidities` from OSDM 3.7 (the single
 *   `regionalValidity`, which 3.7 deprecated, is then a WARNING), the single
 *   member in 3.6, and a `regionalValiditySummary`. Whether the validity
 *   names what was asked is a WARNING only: OSDM leaves its reading open.
 *
 * The first half is pure (tested without Bruno); the glue at the end reads
 * and writes the run's variables.
 */

const MAX_PLACES_ASKED = 10;
const LOOKUP_RESULTS = 5;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);

// A stop place of the data file as an OSDM StopPlaceRef: a URN as it is, a
// bare UIC code as urn:uic:stn:<code>. null for anything else.
function stopPlaceRefOf(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (/^\d{5,9}$/.test(text)) return { objectType: 'StopPlaceRef', stopPlaceRef: `urn:uic:stn:${text}` };
  if (/^urn:\S{3,117}$/.test(text)) return { objectType: 'StopPlaceRef', stopPlaceRef: text };
  return null;
}

// Two stop place references for the same place: a UIC code may be written
// with or without its leading zeros (#644).
function sameStopPlace(a, b) {
  const key = (ref) => {
    const text = String(ref || '').trim().toLowerCase();
    const m = /^urn:uic:stn:0*(\d+)$/.exec(text);
    return m ? `uic:${m[1]}` : text;
  };
  return key(a) !== '' && key(a) === key(b);
}

// "AUTO", or nothing given: OSCAR looks it up.
const isAuto = (value) => value === undefined || value === null || value === ''
  || (typeof value === 'string' && value.trim().toUpperCase() === 'AUTO')
  || (Array.isArray(value) && value.length === 0);

const BY = new Set(['PLACES', 'ZONES', 'NUTS']);
// A NUTS code: two letters of a country, then up to three letters or digits.
const NUTS_CODE = /^[A-Z]{2}[A-Z0-9]{0,3}$/;

/**
 * What a NON_TRIP trip requirement asks, read from the data file:
 * `{ by, places, placeLookup, zones, nutsCodes, validFrom }` with places as
 * StopPlaceRefs, or `{ problem }` naming what is wrong.
 */
function nonTripRequirementOf(requirement) {
  const nonTrip = isObject(requirement?.nonTrip) ? requirement.nonTrip : null;
  if (!nonTrip) return { problem: 'has tripType=NON_TRIP but no nonTrip object' };
  const by = String(nonTrip.by || 'PLACES').toUpperCase();
  if (!BY.has(by)) return { problem: `nonTrip.by must be PLACES, ZONES or NUTS (got ${JSON.stringify(nonTrip.by).slice(0, 40)})` };
  const lookup = typeof nonTrip.placeLookup === 'string' ? nonTrip.placeLookup.trim().slice(0, 120) : '';
  const out = { by, validFrom: typeof nonTrip.validFrom === 'string' ? nonTrip.validFrom : null, places: [], placeLookup: lookup || null, zones: [], nutsCodes: [] };
  // #1449: the stop place of the trip whose zone is asked.
  const zoneOf = zoneOfRequirement(nonTrip, by);
  if (zoneOf?.problem) return zoneOf;
  if (zoneOf) out.zoneOf = zoneOf;
  if (by === 'NUTS') return withNutsCodes(out, nonTrip.nutsCodes);
  if (by === 'PLACES') {
    if (!isAuto(nonTrip.places)) {
      const given = list(nonTrip.places);
      const refs = given.map(stopPlaceRefOf);
      const wrong = given.filter((_, i) => !refs[i]);
      if (wrong.length > 0) return { problem: `nonTrip.places holds what is not a stop place (a URN or a UIC code): ${wrong.slice(0, 3).map((w) => JSON.stringify(w).slice(0, 40)).join(', ')}` };
      if (refs.length < 2 || refs.length > MAX_PLACES_ASKED) return { problem: `nonTrip.places must name 2 to ${MAX_PLACES_ASKED} stop places, or none to look them up` };
      out.places = refs;
    } else if (!out.placeLookup) {
      return { problem: 'nonTrip names no stop place and no name to look them up with (nonTrip.placeLookup)' };
    }
    return out;
  }
  if (!isAuto(nonTrip.zones)) {
    const zones = list(nonTrip.zones).map((z) => ({ id: typeof z?.id === 'string' ? z.id.trim() : '', carrier: typeof z?.carrier === 'string' ? z.carrier.trim() : '' }));
    if (zones.length === 0 || zones.length > MAX_PLACES_ASKED || zones.some((z) => !z.id || !z.carrier)) {
      return { problem: `nonTrip.zones must hold 1 to ${MAX_PLACES_ASKED} zones, each with its id and carrier, or none to take one from GET /zones` };
    }
    out.zones = zones;
  }
  return out;
}

// #1449: `nonTrip.zoneOf`, a stop place (a URN or a UIC code) whose zone of
// GET /zones is asked: for ZONES and NUTS only, when the zones or codes are
// left to the lookup. null when absent, or { problem }.
function zoneOfRequirement(nonTrip, by) {
  if (isAuto(nonTrip.zoneOf)) return null;
  const ref = stopPlaceRefOf(nonTrip.zoneOf);
  if (!ref) return { problem: `nonTrip.zoneOf must be a stop place (a URN or a UIC code), got ${JSON.stringify(nonTrip.zoneOf).slice(0, 40)}` };
  if (by === 'PLACES') return { problem: 'nonTrip.zoneOf names the stop place whose zone is asked: for nonTrip.by ZONES or NUTS, not PLACES' };
  const named = by === 'ZONES' ? !isAuto(nonTrip.zones) : !isAuto(nonTrip.nutsCodes);
  if (named) return { problem: `nonTrip names its ${by === 'ZONES' ? 'zones' : 'NUTS codes'} and a stop place to look its zone up with (nonTrip.zoneOf): one or the other` };
  return ref;
}

// #1266: the NUTS codes a trip names (NUTS form, 1 to 10), or none to take
// them from GET /zones.
function withNutsCodes(out, given) {
  if (isAuto(given)) return out;
  const codes = list(given).map((c) => (typeof c === 'string' ? c.trim() : ''));
  const wrong = codes.filter((c) => !NUTS_CODE.test(c));
  if (wrong.length > 0 || codes.length > MAX_PLACES_ASKED || new Set(codes).size !== codes.length) {
    return { problem: `nonTrip.nutsCodes must hold 1 to ${MAX_PLACES_ASKED} NUTS codes (two capital letters, then up to three letters or digits), each once, or none to take them from GET /zones` };
  }
  out.nutsCodes = codes;
  return out;
}

/** Whether a requirement names where its offers are valid (none: a lookup gives it). */
function namesWhere(want) {
  if (want?.by === 'ZONES') return list(want.zones).length > 0;
  if (want?.by === 'NUTS') return list(want.nutsCodes).length > 0;
  return list(want?.places).length > 0;
}

/** The criteria sent: places, zones or NUTS codes, and the start of the validity. */
function nonTripCriteria(asked) {
  const criteria = {};
  if (asked.validFrom) criteria.validFrom = asked.validFrom;
  if (asked.by === 'NUTS') criteria.nutsCodes = [...list(asked.nutsCodes)];
  else if (asked.by === 'ZONES') criteria.zones = asked.zones.map((z) => ({ id: z.id, carrier: z.carrier }));
  else criteria.places = asked.places.map((p) => ({ objectType: 'StopPlaceRef', stopPlaceRef: p.stopPlaceRef }));
  return criteria;
}

/** An OfferCollectionRequest asking non-trip offers: no trip member at all. */
function nonTripOfferRequest(request, criteria) {
  const out = { ...(isObject(request) ? request : {}) };
  for (const member of ['tripIds', 'tripSpecifications', 'tripSearchCriteria', 'inboundTripIds', 'inboundTripSpecifications', 'requestedSections', 'returnSearchParameters']) {
    delete out[member];
  }
  out.nonTripSearchCriteria = criteria;
  return out;
}

/** POST /places, the request: a name, stop places only, a few results. */
function placeRequest(name) {
  return { placeInput: { name }, restrictions: { type: 'STOP', numberOfResults: LOOKUP_RESULTS } };
}

const isNotImplemented = (status) => status === 501 || status === 404 || status === 405;

/**
 * The checks of a POST /places answer, and the stop places it gives (at most
 * two are used). `{ checks, stops, notImplemented }`.
 */
function checkPlaceAnswer(status, body, name) {
  if (isNotImplemented(status)) {
    return { checks: [], stops: [], notImplemented: true };
  }
  const checks = [{ name: `POST /places (“${name}”): HTTP 200 — actual ${status}`, ok: status === 200, message: `HTTP ${status}` }];
  if (status !== 200) return { checks, stops: [] };
  const places = list(body?.places);
  checks.push({ name: 'POST /places: the answer holds places (PlaceResponse.places, minItems 1)', ok: places.length > 0, message: 'no place in the answer' });
  const stops = places.filter((p) => isObject(p) && p.objectType === 'StopPlace' && typeof p.id === 'string' && p.id.length > 0);
  const others = places.filter((p) => !stops.includes(p));
  checks.push({
    name: 'POST /places: only stop places for a request of type STOP',
    ok: others.length === 0,
    level: 'warn',
    message: `${others.length} place(s) of another kind (${[...new Set(others.map((p) => String(p?.objectType)))].join(', ')}), not used`,
  });
  const named = stops.filter((p) => typeof p.name === 'string' && p.name.length > 0);
  checks.push({ name: 'POST /places: each stop place has its name (StopPlace.name required)', ok: named.length === stops.length, message: `${stops.length - named.length} stop place(s) without a name` });
  checks.push({ name: 'POST /places: at least two stop places to ask offers between', ok: stops.length >= 2, message: `${stops.length} stop place(s) found` });
  return { checks, stops };
}

// #1449: whether a zone's places (ZoneDefinition.places: PlaceRefs, or ids
// as text) hold a stop place.
function zoneHolds(zone, stopPlaceRef) {
  return list(zone?.places).some((place) => sameStopPlace(typeof place === 'string' ? place : place?.stopPlaceRef || place?.id, stopPlaceRef));
}

/**
 * The checks of a GET /zones answer, the zone it gives and (#1266) the first
 * zone that lists NUTS codes: `{ checks, zone, nutsZone, holding,
 * notImplemented }`. #1449: with a stop place (`zoneOf`, a StopPlaceRef),
 * `holding` is the first zone, with its id and carrier, whose places hold it.
 */
function checkZonesAnswer(status, body, zoneOf = null) {
  if (isNotImplemented(status)) return { checks: [], zone: null, nutsZone: null, holding: null, notImplemented: true };
  const checks = [{ name: `GET /zones: HTTP 200 — actual ${status}`, ok: status === 200, message: `HTTP ${status}` }];
  if (status !== 200) return { checks, zone: null, nutsZone: null, holding: null };
  const zones = list(body?.zones).filter((z) => isObject(z) && typeof z.id === 'string' && z.id.length > 0 && typeof z.carrier === 'string' && z.carrier.length > 0);
  checks.push({ name: 'GET /zones: at least one zone with its id and carrier (ZoneDefinition.id, .carrier required)', ok: zones.length > 0, message: `${list(body?.zones).length} zone(s), none with both` });
  const nutsZone = list(body?.zones).find((z) => isObject(z) && list(z.nutsCodes).some((c) => typeof c === 'string' && c.length > 0)) || null;
  const holding = zoneOf ? zones.find((z) => zoneHolds(z, zoneOf.stopPlaceRef)) || null : null;
  return { checks, zone: zones[0] || null, nutsZone, holding };
}

/**
 * #1449: the check of the zone looked up for a stop place of the trip
 * (`nonTrip.zoneOf`): a zone of GET /zones holds it and, for NUTS, names
 * NUTS codes. `{ check, zone }`; the zone is null when it fails.
 */
function zoneOfCheck(found, zoneOf, by) {
  const stop = zoneOf.stopPlaceRef;
  const zone = found.holding;
  if (!zone) {
    const why = found.notImplemented ? 'GET /zones is not implemented by this provider' : `no zone of GET /zones lists it in its places (ZoneDefinition.places)`;
    return { check: { name: `Non-trip offers: a zone of GET /zones holds stop place ${stop} of the trip (nonTrip.zoneOf)`, ok: false, message: why }, zone: null };
  }
  const codes = list(zone.nutsCodes).filter((c) => typeof c === 'string' && c.length > 0);
  if (by === 'NUTS' && codes.length === 0) {
    return { check: { name: `Non-trip offers: the zone holding stop place ${stop} of the trip names NUTS codes (nonTrip.zoneOf)`, ok: false, message: `zone ${zone.id} lists no NUTS code (ZoneDefinition.nutsCodes)` }, zone: null };
  }
  return { check: { name: `Non-trip offers: a zone of GET /zones holds stop place ${stop} of the trip (nonTrip.zoneOf)`, ok: true, message: '' }, zone };
}

// ── The answer to the offer request ─────────────────────────────────────────

// From 3.7 an admission holds a list of regional validities; in 3.6 one.
function validityListExpected(version) {
  const m = /^(\d+)\.(\d+)/.exec(String(version || ''));
  if (!m) return true;
  const major = Number(m[1]);
  return major > 3 || (major === 3 && Number(m[2]) >= 7);
}

const admissionsOfOffer = (offer) => list(offer?.admissionOfferParts);
const VALIDITY_KINDS = ['zone', 'route', 'trainLink', 'line', 'polygon', 'viaStation', 'viaStations'];

// The regional validities of an admission (or booked admission), with how
// they are given: { validities, form: 'list' | 'single' | 'none' }.
function validitiesOf(part) {
  const many = list(part?.regionalValidities);
  if (many.length > 0) return { validities: many, form: 'list' };
  if (isObject(part?.regionalValidity)) return { validities: [part.regionalValidity], form: 'single' };
  return { validities: [], form: 'none' };
}

// Every stop place named anywhere in the validities (a route's stations, a
// zone's entry and terminal stations, a line's ends…), as text.
function stopPlacesNamedIn(validities) {
  const found = [];
  const walk = (value, depth) => {
    if (depth > 12) return;
    if (Array.isArray(value)) { value.forEach((v) => walk(v, depth + 1)); return; }
    if (!isObject(value)) return;
    if (value.objectType === 'StopPlace' && typeof value.id === 'string') found.push(value.id);
    if (typeof value.stopPlaceRef === 'string') found.push(value.stopPlaceRef);
    for (const child of Object.values(value)) walk(child, depth + 1);
  };
  walk(validities, 0);
  return found;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const firstFew = (items) => items.slice(0, 3).join('; ') + (items.length > 3 ? `; … (${items.length} in all)` : '');

/**
 * Whether regional validities name what was asked: a NUTS code asked
 * (Zone.nutsCode), a zone of the carrier asked, every stop place asked. null
 * when they do, else what they lack, as text ('' when nothing more is to be
 * said). Shared by admissions and (#1449) fares. Pure.
 */
function validityMissing(validities, asked) {
  if (asked?.by === 'NUTS') {
    const named = validities.map((v) => v?.zone?.nutsCode).filter((c) => typeof c === 'string');
    if (list(asked.nutsCodes).some((c) => named.includes(c))) return null;
    return named.length > 0 ? named.join(', ') : 'no Zone.nutsCode';
  }
  if (asked?.by === 'ZONES') {
    const carriers = validities.map((v) => v?.zone?.carrier).filter(Boolean);
    const want = list(asked.zones).map((z) => z.carrier);
    return !validities.some((v) => isObject(v?.zone)) || (carriers.length > 0 && !want.some((c) => carriers.includes(c))) ? '' : null;
  }
  if (asked?.by === 'PLACES') {
    const named = stopPlacesNamedIn(validities);
    const absent = list(asked.places).filter((p) => !named.some((n) => sameStopPlace(n, p.stopPlaceRef)));
    return absent.length > 0 ? absent.map((p) => p.stopPlaceRef).join(', ') : null;
  }
  return null;
}

/** What validityMissing() says is missing, in a check's words. */
const validityWanted = (asked) => ({ ZONES: 'a zone of the carrier asked', NUTS: 'a NUTS code asked (Zone.nutsCode)' }[asked?.by] || 'every stop place asked');

/**
 * The checks of the admissions of a non-trip sale, offered (`where`
 * "offers[i]") or booked: the validity is given in the form of the version,
 * names something, and names what was asked. `summary` checks the
 * `regionalValiditySummary` too (offer parts only: a booked part has none).
 */
function admissionValidityChecks(parts, asked, version, { label, summary }) {
  const checks = [];
  const listExpected = validityListExpected(version);
  const none = [];
  const deprecated = [];
  const empty = [];
  const missing = [];
  const noSummary = [];
  for (const { part, where } of parts) {
    if (summary) {
      const s = part?.regionalValiditySummary;
      if (!isObject(s) || typeof s.description !== 'string' || s.description.length === 0) noSummary.push(where);
    }
    const { validities, form } = validitiesOf(part);
    if (form === 'none') { none.push(where); continue; }
    if (form === 'single' && listExpected) deprecated.push(where);
    if (validities.some((v) => !isObject(v) || !VALIDITY_KINDS.some((k) => v[k] != null))) empty.push(where);
    const lack = validityMissing(validities, asked);
    if (lack !== null) missing.push(lack ? `${where} (${lack})` : where);
  }
  const member = listExpected ? 'regionalValidities' : 'regionalValidity';
  checks.push({
    name: `${label}: each admission says where it is valid (${member}) — ${plural(parts.length, 'admission')}`,
    ok: parts.length > 0 && none.length === 0,
    message: parts.length === 0 ? 'no admission' : `no regional validity: ${firstFew(none)}`,
  });
  if (deprecated.length > 0) {
    checks.push({ name: `${label}: regionalValidities, not the deprecated regionalValidity (OSDM 3.7+)`, ok: false, level: 'warn', message: firstFew(deprecated) });
  }
  if (empty.length > 0) {
    checks.push({ name: `${label}: each regional validity names a zone, route, train link, line or polygon`, ok: false, message: firstFew(empty) });
  }
  if (missing.length > 0) {
    checks.push({ name: `${label}: the regional validity names ${validityWanted(asked)}`, ok: false, level: 'warn', message: firstFew(missing) });
  }
  if (summary) {
    checks.push({
      name: `${label}: each admission has a regionalValiditySummary with its description`,
      ok: noSummary.length === 0,
      level: 'warn',
      message: firstFew(noSummary),
    });
  }
  return checks;
}

/**
 * The checks of a non-trip OfferCollectionResponse (#1258): no trip, no trip
 * coverage, and the admissions' validity. Pure.
 */
function checkNonTripOffers(body, asked, version, label = 'Non-trip offers') {
  const offers = list(body?.offers);
  const checks = [];
  checks.push({ name: `${label}: the answer gives no trip`, ok: list(body?.trips).length === 0, message: `${list(body?.trips).length} trip(s) in the answer` });
  const covered = [];
  offers.forEach((offer, i) => {
    if (offer?.tripCoverage != null || offer?.inboundTripCoverage != null) covered.push(`offers[${i}]`);
    for (const key of ['admissionOfferParts', 'reservationOfferParts', 'ancillaryOfferParts']) {
      list(offer?.[key]).forEach((part, k) => { if (part?.tripCoverage != null) covered.push(`offers[${i}].${key}[${k}]`); });
    }
  });
  checks.push({ name: `${label}: no offer or offer part covers a trip (tripCoverage absent)`, ok: covered.length === 0, message: firstFew(covered) });
  const parts = offers.flatMap((offer, i) => admissionsOfOffer(offer).map((part, k) => ({ part, where: `offers[${i}].admissionOfferParts[${k}]` })));
  return checks.concat(admissionValidityChecks(parts, asked, version, { label, summary: true }));
}

/**
 * #1266: the nonTripSearchCriteria of an exchange of a sale without a trip:
 * the stop places or zones of the exchange's plan when it names them, else
 * those the sale sent (after its lookups); the plan's validFrom, else the
 * sale's. Null when neither is known. Pure.
 */
function exchangeNonTripCriteria(saleCriteria, plan) {
  const base = isObject(saleCriteria) ? saleCriteria : null;
  const own = isObject(plan) && isObject(plan.criteria) ? plan.criteria : null;
  const chosen = own || base;
  if (!chosen) return null;
  const where = { ...chosen };
  delete where.validFrom;
  const validFrom = (isObject(plan) && typeof plan.validFrom === 'string' && plan.validFrom) || base?.validFrom;
  return validFrom ? { validFrom, ...where } : where;
}

/** #1266: what a nonTripSearchCriteria asks, in the shape nonTripRequirementOf() gives (by, places, zones, nutsCodes). Pure. */
function askedOfCriteria(criteria) {
  if (!isObject(criteria)) return null;
  if (list(criteria.nutsCodes).length > 0) return { by: 'NUTS', places: [], zones: [], nutsCodes: list(criteria.nutsCodes) };
  if (list(criteria.zones).length > 0) return { by: 'ZONES', places: [], zones: list(criteria.zones), nutsCodes: [] };
  return { by: 'PLACES', places: list(criteria.places), zones: [], nutsCodes: [] };
}

/**
 * The checks of a non-trip booking (02, 05, 07): no trip coverage on the
 * booked offers and their parts, each admission keeps its validity. Pure.
 */
function checkNonTripBooking(booking, asked, version, step) {
  const bookedOffers = list(booking?.bookedOffers);
  const covered = [];
  const admissions = [];
  bookedOffers.forEach((bo, i) => {
    if (bo?.tripCoverage != null) covered.push(`bookedOffers[${i}]`);
    for (const key of ['admissions', 'reservations', 'ancillaries']) {
      list(bo?.[key]).forEach((part, k) => {
        if (part?.tripCoverage != null) covered.push(`bookedOffers[${i}].${key}[${k}]`);
        if (key === 'admissions') admissions.push({ part, where: `bookedOffers[${i}].admissions[${k}]` });
      });
    }
  });
  list(booking?.fulfillments).forEach((f, i) => { if (f?.tripCoverage != null) covered.push(`fulfillments[${i}]`); });
  const label = `${step}: non-trip booking`;
  return [{ name: `${label} — nothing covers a trip (tripCoverage absent)`, ok: covered.length === 0, message: firstFew(covered) }]
    .concat(admissionValidityChecks(admissions, asked, version, { label, summary: false }));
}

// ── Glue: the run's variables ───────────────────────────────────────────────

/* istanbul ignore next */
function bruEnv(name) {
  try { return bru.getEnvVar(name); } catch { return undefined; }
}

function parseJson(text, fallback) {
  if (text == null || text === '') return fallback;
  if (typeof text === 'object') return text;
  try { return JSON.parse(text); } catch { return fallback; }
}

/** True while the scenario being run sells without a trip. */
function isNonTripSale() {
  return bruEnv('TripType') === 'NON_TRIP';
}

const asked = () => parseJson(bruEnv('__nonTripAsked'), null);

function log(line) {
  const logger = globalThis.validationLogger || require('./displays.js').validationLogger;
  logger(line);
}

// A request to the provider from the step's script: GET or POST, with the
// headers of the request files (osdmPost.js).
async function sendFromScript(method, path, body) {
  const { postOsdm, getOsdm } = require('./osdmPost.js');
  try {
    return method === 'GET' ? await getOsdm(path) : await postOsdm(path, body);
  } catch (err) {
    log(`[ERROR] ${method} ${path} could not be sent: ${err?.message || err}`);
    return { status: 0, body: null };
  }
}

/**
 * 01's before-request, for a non-trip sale: looks the stop places or the zone
 * up when the scenario leaves them to OSCAR, then writes the offer request
 * with `nonTripSearchCriteria` and no trip. What it found is kept for 01's
 * after-response (`__nonTripOutcome`).
 */
async function prepareNonTripRequest() {
  bru.setEnvVar('__nonTripOutcome', null);
  bru.setEnvVar('__nonTripAsked', null);
  if (!isNonTripSale()) return;
  const want = parseJson(bruEnv('nonTripRequirement'), null);
  if (!want) {
    bru.setEnvVar('__nonTripOutcome', JSON.stringify({ checks: [{ name: 'Non-trip offers: the scenario\'s trip requirement names stop places or zones', ok: false, message: 'nothing read from the data file (see the [ERROR] above)' }], failed: true }));
    return;
  }
  const checks = [];
  if (want.by === 'PLACES' && want.places.length === 0) {
    log(`[INFO] 📍 Non-trip offers — POST /places: stop places named “${want.placeLookup}”`);
    const { status, body } = await sendFromScript('POST', '/places', placeRequest(want.placeLookup));
    const found = checkPlaceAnswer(status, body, want.placeLookup);
    checks.push(...found.checks);
    if (found.notImplemented) {
      log(`[INFO] POST /places → ${status}: not implemented by this provider; the scenario names no stop place to ask offers between.`);
    }
    if (found.stops.length < 2) {
      checks.push({ name: 'Non-trip offers: two stop places to ask offers between', ok: false, message: found.notImplemented ? `POST /places answered ${status} and the scenario names no stop place (nonTrip.places)` : 'the lookup gave fewer than two stop places' });
      bru.setEnvVar('__nonTripOutcome', JSON.stringify({ checks, failed: true }));
      return;
    }
    want.places = found.stops.slice(0, 2).map((p) => ({ objectType: 'StopPlaceRef', stopPlaceRef: p.id }));
    log(`[INFO] 📍 Non-trip offers — between ${found.stops.slice(0, 2).map((p) => `${p.name || '?'} (${p.id})`).join(' and ')}`);
  }
  if (want.zoneOf && !(await lookUpZoneOf(want, checks))) return;
  if (want.by === 'ZONES' && want.zones.length === 0) {
    log('[INFO] 🗺️ Non-trip offers — GET /zones');
    const { status, body } = await sendFromScript('GET', '/zones');
    const found = checkZonesAnswer(status, body);
    checks.push(...found.checks);
    if (!found.zone) {
      checks.push({ name: 'Non-trip offers: a zone to ask offers in', ok: false, message: found.notImplemented ? `GET /zones answered ${status} and the scenario names no zone (nonTrip.zones)` : 'GET /zones gave no zone with an id and a carrier' });
      bru.setEnvVar('__nonTripOutcome', JSON.stringify({ checks, failed: true }));
      return;
    }
    want.zones = [{ id: found.zone.id, carrier: found.zone.carrier }];
    log(`[INFO] 🗺️ Non-trip offers — in zone ${found.zone.id}${found.zone.name ? ` (${found.zone.name})` : ''} of ${found.zone.carrier}`);
  }
  if (want.by === 'NUTS' && list(want.nutsCodes).length === 0 && !(await lookUpNutsCodes(want, checks))) return;
  const criteria = nonTripCriteria(want);
  const request = parseJson(bruEnv('OfferCollectionRequest'), {}) || {};
  bru.setEnvVar('OfferCollectionRequest', JSON.stringify(nonTripOfferRequest(request, criteria)));
  bru.setEnvVar('__nonTripAsked', JSON.stringify({ by: want.by, places: want.places, zones: want.zones, nutsCodes: list(want.nutsCodes) }));
  bru.setEnvVar('__nonTripOutcome', JSON.stringify({ checks }));
}

// #1449: the zone of GET /zones holding the stop place of the trip
// (nonTrip.zoneOf): its id and carrier, or its NUTS codes. False when none
// is found (the scenario ends at 01).
async function lookUpZoneOf(want, checks) {
  log(`[INFO] 🗺️ Non-trip offers — GET /zones, for the zone of stop place ${want.zoneOf.stopPlaceRef} of the trip`);
  const { status, body } = await sendFromScript('GET', '/zones');
  const found = checkZonesAnswer(status, body, want.zoneOf);
  checks.push(...found.checks);
  const { check, zone } = zoneOfCheck(found, want.zoneOf, want.by);
  checks.push(check);
  if (!zone) {
    bru.setEnvVar('__nonTripOutcome', JSON.stringify({ checks, failed: true }));
    return false;
  }
  if (want.by === 'NUTS') want.nutsCodes = list(zone.nutsCodes).filter((c) => typeof c === 'string' && c.length > 0).slice(0, MAX_PLACES_ASKED);
  else want.zones = [{ id: zone.id, carrier: zone.carrier }];
  const codes = want.by === 'NUTS' ? ', NUTS code(s) ' + want.nutsCodes.join(', ') : '';
  const named = zone.name ? ' (' + zone.name + ')' : '';
  log(`[INFO] 🗺️ Non-trip offers — stop place ${want.zoneOf.stopPlaceRef} is in zone ${zone.id}${named} of ${zone.carrier}${codes}`);
  return true;
}

// #1266: the NUTS codes of the first zone of GET /zones that lists some.
// False when none is found (the scenario ends at 01).
async function lookUpNutsCodes(want, checks) {
  log('[INFO] 🗺️ Non-trip offers — GET /zones, for its NUTS codes');
  const { status, body } = await sendFromScript('GET', '/zones');
  const found = checkZonesAnswer(status, body);
  checks.push(...found.checks);
  if (!found.nutsZone) {
    checks.push({ name: 'Non-trip offers: a NUTS code to ask offers in', ok: false, message: found.notImplemented ? `GET /zones answered ${status} and the scenario names no NUTS code (nonTrip.nutsCodes)` : 'no zone of GET /zones lists NUTS codes (ZoneDefinition.nutsCodes), and the scenario names none (nonTrip.nutsCodes)' });
    bru.setEnvVar('__nonTripOutcome', JSON.stringify({ checks, failed: true }));
    return false;
  }
  want.nutsCodes = list(found.nutsZone.nutsCodes).filter((c) => typeof c === 'string' && c.length > 0).slice(0, MAX_PLACES_ASKED);
  const zoneName = found.nutsZone.name ? ' (' + found.nutsZone.name + ')' : '';
  log(`[INFO] 🗺️ Non-trip offers — NUTS code(s) ${want.nutsCodes.join(', ')}, of zone ${found.nutsZone.id}${zoneName}`);
  return true;
}

// #1266: a NUTS code the provider does not know must be refused, or given no
// offer. True when armed (the scenario ends at 01).
function checkUnknownNutsRefused(status, body) {
  if (String(bruEnv('nutsCodeExpectRejection')) !== 'true') return false;
  const codes = list(asked()?.nutsCodes).join(', ') || '(none)';
  log(`[INFO] 🧪 Unknown NUTS code probe — offers asked for NUTS code(s) ${codes}, which the provider should not know.`);
  const offers = list(body?.offers);
  if (typeof status === 'number' && status >= 300) {
    const { validateProblemResponse } = require('./requestedInformation.js');
    validateProblemResponse({
      status,
      body,
      targets: [],
      prefix: '🧪 Unknown NUTS code probe',
      label: 'POST /offers',
      assert: (name, ok, msg) => test(name, () => { if (!ok) throw new Error(msg); }),
      log: (level, msg) => log(`[${level}] ${msg}`),
    });
    return true;
  }
  test('🧪 Unknown NUTS code probe [POST /offers]: no offer is given', () => {
    if (offers.length > 0) throw new Error(`POST /offers gave ${offers.length} offer(s) for NUTS code(s) ${codes}`);
  });
  if (offers.length === 0) {
    const problems = list(body?.problems);
    log(problems.length
      ? `[INFO] 🧪 Unknown NUTS code probe: the answer explains it with ${problems.length} problem(s): ${problems.map((p) => p?.code || p?.title).filter(Boolean).join(', ')}.`
      : '[WARNING] 🧪 Unknown NUTS code probe: no offer and no problem saying why; a Problem naming the code helps a distributor.');
  }
  return true;
}

// #1444: an offer holding fares (FARE_ADMISSION), or fare reservations.
const holdsFares = (offer) => list(offer?.fares).length > 0
  || list(offer?.reservationOfferParts).some((part) => part?.mode === 'FARE_MODE');

/**
 * #1444: fares asked without a trip must be refused, or answered without a
 * fare; fares given are a WARNING. True when armed (the scenario ends at 01).
 */
function checkNonTripFaresRefused(status, body) {
  if (String(bruEnv('nonTripFaresExpectRejection')) !== 'true') return false;
  log('[INFO] 🧪 Fares without a trip probe — fares asked (requestedOfferParts) by a request without a trip, of a provider that does not declare them sold so; OSDM describes online fares for a trip (osdm.io, Constructing products from fares), and the OSDM architect reads a sale without a trip as theoretical only.');
  if (typeof status === 'number' && status >= 300) {
    const { validateProblemResponse } = require('./requestedInformation.js');
    validateProblemResponse({
      status,
      body,
      targets: [],
      prefix: '🧪 Fares without a trip probe',
      label: 'POST /offers',
      assert: (name, ok, msg) => test(name, () => { if (!ok) throw new Error(msg); }),
      log: (level, msg) => log(`[${level}] ${msg}`),
    });
    return true;
  }
  const withFares = list(body?.offers).filter(holdsFares);
  if (withFares.length > 0) {
    log(`[WARNING] 🧪 Fares without a trip probe: ${withFares.length} offer(s) hold fares for a request without a trip (${withFares.map((o) => o?.offerId).filter(Boolean).slice(0, 5).join(', ') || 'no id'}). OSDM describes online fares as part of an offer for a trip; if this provider sells fares without a trip, declare it (Test Framework › Fares) and test the sale instead.`);
    return true;
  }
  test('🧪 Fares without a trip probe [POST /offers]: no fare is given', () => {});
  return true;
}

function record(checks, test) {
  for (const c of checks) {
    if (c.level === 'warn') {
      if (!c.ok) log(`[WARNING] ${c.name} — ${c.message}`);
      continue;
    }
    test(c.name, () => { if (!c.ok) throw new Error(c.message); });
  }
}

/**
 * 01's after-response: records the lookups' checks. True when the scenario
 * ends here (nothing to ask offers for).
 */
function checkNonTripLookup(test) {
  const outcome = parseJson(bruEnv('__nonTripOutcome'), null);
  if (!outcome) return false;
  record(list(outcome.checks), test);
  return outcome.failed === true;
}

/** 01's after-response, once offers were read: the non-trip checks. */
function recordNonTripOfferChecks(body, test) {
  if (!isNonTripSale()) return;
  const version = require('./osdmVersion.js').getComplianceVersion();
  record(checkNonTripOffers(body, asked(), version), test);
}

/**
 * #1266, step 10 of an exchange: the exchange offers of a sale without a trip
 * give no trip, cover none and say where they are valid, against what the
 * exchange asked (its request), else what the sale asked.
 */
function recordNonTripExchangeOfferChecks(body, test) {
  if (!isNonTripSale()) return;
  const version = require('./osdmVersion.js').getComplianceVersion();
  const sent = parseJson(bruEnv('requestExchangeOffersBodyData'), null);
  const askedNow = askedOfCriteria(sent?.nonTripSearchCriteria) || asked();
  const answer = { offers: list(body?.exchangeOffers), trips: list(body?.trips) };
  record(checkNonTripOffers(answer, askedNow, version, 'Non-trip exchange offers'), test);
}

/**
 * #1266, 13 and 15 of an exchange: the parts the exchange added (from
 * splitExchangeBooking) cover no trip, and each new admission says where it
 * is valid, against what the exchange asked.
 */
function recordNonTripExchangedPartsChecks(added, stage, test) {
  if (!isNonTripSale() || !Array.isArray(added) || added.length === 0) return;
  const bookedOffer = {};
  for (const { list: key, part } of added) {
    if (!bookedOffer[key]) bookedOffer[key] = [];
    bookedOffer[key].push(part);
  }
  const version = require('./osdmVersion.js').getComplianceVersion();
  const sent = parseJson(bruEnv('requestExchangeOffersBodyData'), null);
  const askedNow = askedOfCriteria(sent?.nonTripSearchCriteria) || asked();
  record(checkNonTripBooking({ bookedOffers: [bookedOffer] }, askedNow, version, stage), test);
}

/** 02, 05, 07: the booking's non-trip checks. */
function recordNonTripBookingChecks(booking, step, test) {
  if (!isNonTripSale()) return;
  const version = require('./osdmVersion.js').getComplianceVersion();
  record(checkNonTripBooking(booking, asked(), version, step), test);
}

module.exports = {
  stopPlaceRefOf, sameStopPlace, isAuto, nonTripRequirementOf, nonTripCriteria, nonTripOfferRequest, placeRequest,
  checkPlaceAnswer, checkZonesAnswer, zoneHolds, zoneOfCheck, validityListExpected, validityMissing, validityWanted, firstFew, askedOfRun: asked, validitiesOf, stopPlacesNamedIn, admissionValidityChecks,
  checkNonTripOffers, checkNonTripBooking, exchangeNonTripCriteria, askedOfCriteria, namesWhere, checkUnknownNutsRefused, checkNonTripFaresRefused, holdsFares,
  isNonTripSale, prepareNonTripRequest, checkNonTripLookup, recordNonTripOfferChecks, recordNonTripBookingChecks,
  recordNonTripExchangeOfferChecks, recordNonTripExchangedPartsChecks,
};
