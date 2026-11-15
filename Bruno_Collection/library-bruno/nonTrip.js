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

const BY = new Set(['PLACES', 'ZONES']);

/**
 * What a NON_TRIP trip requirement asks, read from the data file:
 * `{ by, places, placeLookup, zones, validFrom }` with places as
 * StopPlaceRefs, or `{ problem }` naming what is wrong.
 */
function nonTripRequirementOf(requirement) {
  const nonTrip = isObject(requirement?.nonTrip) ? requirement.nonTrip : null;
  if (!nonTrip) return { problem: 'has tripType=NON_TRIP but no nonTrip object' };
  const by = String(nonTrip.by || 'PLACES').toUpperCase();
  if (!BY.has(by)) return { problem: `nonTrip.by must be PLACES or ZONES (got ${JSON.stringify(nonTrip.by).slice(0, 40)})` };
  const lookup = typeof nonTrip.placeLookup === 'string' ? nonTrip.placeLookup.trim().slice(0, 120) : '';
  const out = { by, validFrom: typeof nonTrip.validFrom === 'string' ? nonTrip.validFrom : null, places: [], placeLookup: lookup || null, zones: [] };
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

/** The criteria sent: places or zones, and the start of the validity. */
function nonTripCriteria(asked) {
  const criteria = {};
  if (asked.validFrom) criteria.validFrom = asked.validFrom;
  if (asked.by === 'ZONES') criteria.zones = asked.zones.map((z) => ({ id: z.id, carrier: z.carrier }));
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

/**
 * The checks of a GET /zones answer, and the zone it gives:
 * `{ checks, zone, notImplemented }`.
 */
function checkZonesAnswer(status, body) {
  if (isNotImplemented(status)) return { checks: [], zone: null, notImplemented: true };
  const checks = [{ name: `GET /zones: HTTP 200 — actual ${status}`, ok: status === 200, message: `HTTP ${status}` }];
  if (status !== 200) return { checks, zone: null };
  const zones = list(body?.zones).filter((z) => isObject(z) && typeof z.id === 'string' && z.id.length > 0 && typeof z.carrier === 'string' && z.carrier.length > 0);
  checks.push({ name: 'GET /zones: at least one zone with its id and carrier (ZoneDefinition.id, .carrier required)', ok: zones.length > 0, message: `${list(body?.zones).length} zone(s), none with both` });
  return { checks, zone: zones[0] || null };
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
    if (asked?.by === 'ZONES') {
      const carriers = validities.map((v) => v?.zone?.carrier).filter(Boolean);
      const want = list(asked.zones).map((z) => z.carrier);
      if (!validities.some((v) => isObject(v?.zone)) || (carriers.length > 0 && !want.some((c) => carriers.includes(c)))) missing.push(where);
    } else if (asked?.by === 'PLACES') {
      const named = stopPlacesNamedIn(validities);
      const absent = list(asked.places).filter((p) => !named.some((n) => sameStopPlace(n, p.stopPlaceRef)));
      if (absent.length > 0) missing.push(`${where} (${absent.map((p) => p.stopPlaceRef).join(', ')})`);
    }
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
    const what = asked?.by === 'ZONES' ? 'a zone of the carrier asked' : 'every stop place asked';
    checks.push({ name: `${label}: the regional validity names ${what}`, ok: false, level: 'warn', message: firstFew(missing) });
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
function checkNonTripOffers(body, asked, version) {
  const offers = list(body?.offers);
  const checks = [];
  checks.push({ name: 'Non-trip offers: the answer gives no trip', ok: list(body?.trips).length === 0, message: `${list(body?.trips).length} trip(s) in the answer` });
  const covered = [];
  offers.forEach((offer, i) => {
    if (offer?.tripCoverage != null || offer?.inboundTripCoverage != null) covered.push(`offers[${i}]`);
    for (const key of ['admissionOfferParts', 'reservationOfferParts', 'ancillaryOfferParts']) {
      list(offer?.[key]).forEach((part, k) => { if (part?.tripCoverage != null) covered.push(`offers[${i}].${key}[${k}]`); });
    }
  });
  checks.push({ name: 'Non-trip offers: no offer or offer part covers a trip (tripCoverage absent)', ok: covered.length === 0, message: firstFew(covered) });
  const parts = offers.flatMap((offer, i) => admissionsOfOffer(offer).map((part, k) => ({ part, where: `offers[${i}].admissionOfferParts[${k}]` })));
  return checks.concat(admissionValidityChecks(parts, asked, version, { label: 'Non-trip offers', summary: true }));
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
  const criteria = nonTripCriteria(want);
  const request = parseJson(bruEnv('OfferCollectionRequest'), {}) || {};
  bru.setEnvVar('OfferCollectionRequest', JSON.stringify(nonTripOfferRequest(request, criteria)));
  bru.setEnvVar('__nonTripAsked', JSON.stringify({ by: want.by, places: want.places, zones: want.zones }));
  bru.setEnvVar('__nonTripOutcome', JSON.stringify({ checks }));
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

/** 02, 05, 07: the booking's non-trip checks. */
function recordNonTripBookingChecks(booking, step, test) {
  if (!isNonTripSale()) return;
  const version = require('./osdmVersion.js').getComplianceVersion();
  record(checkNonTripBooking(booking, asked(), version, step), test);
}

module.exports = {
  stopPlaceRefOf, sameStopPlace, isAuto, nonTripRequirementOf, nonTripCriteria, nonTripOfferRequest, placeRequest,
  checkPlaceAnswer, checkZonesAnswer, validityListExpected, validitiesOf, stopPlacesNamedIn, admissionValidityChecks,
  checkNonTripOffers, checkNonTripBooking,
  isNonTripSale, prepareNonTripRequest, checkNonTripLookup, recordNonTripOfferChecks, recordNonTripBookingChecks,
};
