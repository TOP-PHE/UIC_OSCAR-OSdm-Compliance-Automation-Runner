/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * offerOptions.js — which optional members of the offer request does a
 * provider support? (#227)
 *
 * One scenario (`offerOptionDiscovery`) runs four phases:
 *   1. the request with the mandatory members only (the passengers' externalRef
 *      and type, and the trip): a refusal or no offer FAILS, an optional member
 *      cannot be required;
 *   2. the same request plus one option, for each option;
 *   3. random combinations of the options found supported (seeded, so a run
 *      can be replayed);
 *   4. every supported option at once.
 * Only phase 1 can fail; the others are reported.
 *
 * Each answer is read at two levels: the HTTP status (2xx supported, 4xx
 * refused, 501 not implemented, other error), then, for a 2xx, its content:
 * honoured, ignored (said with PARAMETER_NOT_SUPPORTED, or silently), no
 * offer (with or without a message), or accepted when the answer cannot show
 * it. A value OSCAR made up because the provider declared none (a card, a
 * promotion or corporate code…) is invalid on purpose: it must be refused or
 * said, and taken silently is reported.
 *
 * The options are those of the scenario's OSDM version: an option is offered
 * only when its member is in that version's request schema
 * (osdmRequestSchemas.js, generated).
 *
 * The pure part has no Bruno globals; the glue at the bottom has.
 */

const { requestSchemas } = require('./osdmRequestSchemas.js');
const { pickVersion } = require('./osdmRequestSchema.js');
const { checkOfferCriteria } = require('./offerCriteria.js');

const DEFAULT_MAX_REQUESTS = 30;
const PHASE3_RESERVE = 3;
const MAX_COMBINATION_SIZE = 4;
const MIN_REQUESTS = 3;
const MAX_REQUESTS = 200;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const copy = (v) => JSON.parse(JSON.stringify(v));

// ── Seeded random (mulberry32, as #780's combinations) ───────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 32-bit seed from a text (the scenario code), so a run is repeatable. */
function seedOf(text) {
  let h = 2166136261;
  for (const ch of String(text || '')) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

const token = (rand) => Math.floor(rand() * 0xFFFFFF).toString(16).toUpperCase().padStart(6, '0');

// ── Dates ────────────────────────────────────────────────────────────────────

function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function laterTime(dateTime, hours) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(:\d{2})?(.*)$/.exec(String(dateTime || ''));
  if (!m) return null;
  const minutes = Number(m[2]) * 60 + Number(m[3]) + hours * 60;
  if (minutes >= 24 * 60) return `${m[1]}T23:59:00${m[5]}`;
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${m[1]}T${hh}:${mm}:00${m[5]}`;
}

// ── The trip of a request ────────────────────────────────────────────────────

/** 'TRIP_IDS', 'SPECIFICATION' or 'SEARCH', from the members a request holds. */
function tripFormOf(request) {
  if (Array.isArray(request?.tripIds) && request.tripIds.length > 0) return 'TRIP_IDS';
  if (Array.isArray(request?.tripSpecifications) && request.tripSpecifications.length > 0) return 'SPECIFICATION';
  return 'SEARCH';
}

// The first and last stop places of the request's trip, as PlaceRefs, or null.
function tripEnds(request) {
  if (isObj(request?.tripSearchCriteria)) {
    const { origin, destination } = request.tripSearchCriteria;
    return isObj(origin) && isObj(destination) ? { start: origin, end: destination } : null;
  }
  const legs = (request?.tripSpecifications?.[0]?.legs || []).filter(Boolean);
  const first = legs[0]?.timedLeg?.start?.stopPlaceRef;
  const last = legs.at(-1)?.timedLeg?.end?.stopPlaceRef;
  return first && last ? { start: first, end: last } : null;
}

function departureOf(request) {
  if (isObj(request?.tripSearchCriteria)) return request.tripSearchCriteria.departureTime || null;
  return request?.tripSpecifications?.[0]?.legs?.[0]?.timedLeg?.start?.serviceDeparture?.timetabledTime || null;
}

/**
 * The request with the mandatory members only: each passenger's externalRef
 * and type, and the trip. A search keeps its origin, destination and time
 * (a search with no time is not a trip); a specification or trip ids are kept
 * as they are.
 */
function mandatoryRequest(request) {
  const passengers = (Array.isArray(request?.anonymousPassengerSpecifications) ? request.anonymousPassengerSpecifications : [])
    .filter(isObj)
    .map((p) => ({ externalRef: p.externalRef, type: p.type || 'PERSON' }));
  const out = { anonymousPassengerSpecifications: passengers };
  const form = tripFormOf(request);
  if (form === 'TRIP_IDS') out.tripIds = copy(request.tripIds);
  else if (form === 'SPECIFICATION') out.tripSpecifications = copy(request.tripSpecifications);
  else if (isObj(request?.tripSearchCriteria)) {
    const t = request.tripSearchCriteria;
    out.tripSearchCriteria = { origin: copy(t.origin), destination: copy(t.destination) };
    if (t.departureTime) out.tripSearchCriteria.departureTime = t.departureTime;
  }
  return out;
}

// ── The options ──────────────────────────────────────────────────────────────

// Where an option lives: the schema that holds its member, and how it is set
// on a copy of the mandatory request.
const IN = {
  criteria: (member) => ({ schema: 'OfferSearchCriteria', member,
    set: (req, v) => { req.offerSearchCriteria = { ...(req.offerSearchCriteria || {}), [member]: v }; } }),
  passenger: (member, { dropBirth = false } = {}) => ({ schema: 'AnonymousPassengerSpecification', member,
    set: (req, v) => req.anonymousPassengerSpecifications.forEach((p, i) => {
      if (dropBirth) delete p.dateOfBirth;
      p[member] = Array.isArray(v) && v.perPassenger ? v[i % v.length] : v;
    }) }),
  search: (member) => ({ schema: 'TripSearchCriteria', member, searchOnly: true,
    set: (req, v) => { req.tripSearchCriteria = { ...req.tripSearchCriteria, [member]: v }; } }),
  root: (member) => ({ schema: 'OfferCollectionRequest', member,
    set: (req, v) => { req[member] = v; } }),
};

// A value the scenario or its declarations give, else OSCAR's generic one.
const given = (ctx, key) => (ctx.values && ctx.values[key] !== undefined && ctx.values[key] !== null ? ctx.values[key] : undefined);

const perPassenger = (list) => Object.assign(list, { perPassenger: true });

/**
 * The option list. Each option:
 *   key, group, where (IN.*), conflicts (a group name; two options of one
 *   group are never combined), value(ctx) → { value, source } | null, and
 *   check(request, body) → 'honoured' | 'not-kept' | null (null: the answer
 *   cannot show it).
 * Sources: 'declared' (the scenario's offerOptionValues, filled from the Test
 * Framework), 'scenario' (the scenario's own request), 'default' (an OSDM
 * value valid for any provider), 'invalid' (made up on purpose).
 */
function criteriaCheck(member) {
  return (request, body) => {
    const checks = checkOfferCriteria({ [member]: request.offerSearchCriteria?.[member] }, body, []);
    if (checks.length === 0) return null;
    return checks.every((c) => c.ok) ? 'honoured' : 'not-kept';
  };
}

const OPTIONS = [
  // Passenger
  { key: 'passenger.dateOfBirth', group: 'passenger', where: IN.passenger('dateOfBirth'), conflicts: 'birth',
    value: (ctx) => {
      const births = ctx.passengers.map((p) => p.dateOfBirth).filter(Boolean);
      return births.length === ctx.passengers.length && births.length > 0
        ? { value: perPassenger(births), source: 'scenario' }
        : { value: '1990-06-15', source: 'default' };
    } },
  { key: 'passenger.age', group: 'passenger', where: IN.passenger('age', { dropBirth: true }), conflicts: 'birth',
    value: (ctx) => ({ value: given(ctx, 'passenger.age') ?? 35, source: given(ctx, 'passenger.age') !== undefined ? 'declared' : 'default' }) },
  { key: 'passenger.gender', group: 'passenger', where: IN.passenger('gender'),
    value: (ctx) => {
      const genders = ctx.passengers.map((p) => p.gender).filter(Boolean);
      return genders.length === ctx.passengers.length && genders.length > 0
        ? { value: perPassenger(genders), source: 'scenario' }
        : { value: 'FEMALE', source: 'default' };
    } },
  { key: 'passenger.cards', group: 'passenger', where: IN.passenger('cards'), invalidAllowed: true,
    value: (ctx) => {
      const declared = given(ctx, 'passenger.cards');
      if (Array.isArray(declared) && declared.length > 0) return { value: declared, source: 'declared' };
      const own = ctx.passengers.find((p) => Array.isArray(p.cards) && p.cards.length > 0);
      if (own) return { value: own.cards, source: 'scenario' };
      return invalid(ctx, () => [{ type: 'REDUCTION_CARD', code: `OSCAR-UNKNOWN-CARD-${token(ctx.rand)}` }]);
    } },
  { key: 'passenger.prmNeeds', group: 'passenger', where: IN.passenger('prmNeeds'),
    value: (ctx) => ({ value: given(ctx, 'passenger.prmNeeds') || ['WHEELCHAIR'], source: given(ctx, 'passenger.prmNeeds') ? 'declared' : 'default' }) },
  { key: 'passenger.residency', group: 'passenger', where: IN.passenger('residency'),
    value: (ctx) => ({ value: given(ctx, 'passenger.residency') || 'FR', source: given(ctx, 'passenger.residency') ? 'declared' : 'default' }) },
  { key: 'passenger.transportable', group: 'passenger', where: IN.passenger('transportable'),
    value: (ctx) => ({ value: given(ctx, 'passenger.transportable') || { type: 'BICYCLE' }, source: given(ctx, 'passenger.transportable') ? 'declared' : 'default' }) },

  // Offer search criteria
  { key: 'offerSearchCriteria.requestedOfferParts', group: 'offer', where: IN.criteria('requestedOfferParts'), check: criteriaCheck('requestedOfferParts'),
    value: (ctx) => ({ value: ['ADMISSION'], source: 'default' }) },
  { key: 'offerSearchCriteria.productTags', group: 'offer', where: IN.criteria('productTags'), check: criteriaCheck('productTags'),
    value: (ctx) => ({ value: given(ctx, 'offerSearchCriteria.productTags') || ['ADMISSION_POINT2POINT'], source: given(ctx, 'offerSearchCriteria.productTags') ? 'declared' : 'default' }) },
  { key: 'offerSearchCriteria.productSelections', group: 'offer', where: IN.criteria('productSelections'), invalidAllowed: true,
    check: (request, body) => {
      const codes = (request.offerSearchCriteria?.productSelections || []).map((s) => s.productCode).filter(Boolean);
      const offers = Array.isArray(body?.offers) ? body.offers : [];
      if (codes.length === 0 || offers.length === 0) return null;
      return offers.some((o) => (o?.products || []).some((p) => codes.includes(p?.code))) ? 'honoured' : 'not-kept';
    },
    value: (ctx) => {
      const declared = given(ctx, 'offerSearchCriteria.productSelections');
      if (Array.isArray(declared) && declared.length > 0) return { value: declared, source: 'declared' };
      return invalid(ctx, () => [{ productCode: `OSCAR-UNKNOWN-PRODUCT-${token(ctx.rand)}` }]);
    } },
  { key: 'offerSearchCriteria.flexibilities', group: 'offer', where: IN.criteria('flexibilities'), check: criteriaCheck('flexibilities'),
    value: (ctx) => ({ value: given(ctx, 'offerSearchCriteria.flexibilities') || ['FULL_FLEXIBLE'], source: given(ctx, 'offerSearchCriteria.flexibilities') ? 'declared' : 'default' }) },
  { key: 'offerSearchCriteria.travelClasses', group: 'offer', where: IN.criteria('travelClasses'), conflicts: 'class', check: criteriaCheck('travelClasses'),
    value: (ctx) => ({ value: given(ctx, 'offerSearchCriteria.travelClasses') || ['FIRST'], source: given(ctx, 'offerSearchCriteria.travelClasses') ? 'declared' : 'default' }) },
  { key: 'offerSearchCriteria.serviceClassTypes', group: 'offer', where: IN.criteria('serviceClassTypes'), conflicts: 'class', check: criteriaCheck('serviceClassTypes'),
    value: (ctx) => ({ value: given(ctx, 'offerSearchCriteria.serviceClassTypes') || ['HIGH'], source: given(ctx, 'offerSearchCriteria.serviceClassTypes') ? 'declared' : 'default' }) },
  { key: 'offerSearchCriteria.offerMode', group: 'offer', where: IN.criteria('offerMode'), check: criteriaCheck('offerMode'),
    value: (ctx) => ({ value: ctx.passengers.length > 1 ? 'COLLECTIVE' : 'INDIVIDUAL', source: 'default' }) },
  { key: 'offerSearchCriteria.currency', group: 'offer', where: IN.criteria('currency'),
    check: (request, body) => {
      const asked = request.offerSearchCriteria?.currency;
      const offers = Array.isArray(body?.offers) ? body.offers : [];
      const currencies = offers.map((o) => o?.offerSummary?.minimalPrice?.currency).filter(Boolean);
      if (!asked || currencies.length === 0) return null;
      return currencies.every((c) => c === asked) ? 'honoured' : 'not-kept';
    },
    value: (ctx) => ({ value: given(ctx, 'offerSearchCriteria.currency') || 'EUR', source: given(ctx, 'offerSearchCriteria.currency') ? 'declared' : 'default' }) },
  { key: 'offerSearchCriteria.inboundDate', group: 'offer', where: IN.criteria('inboundDate'),
    value: (ctx) => {
      const back = ctx.travelDay ? addDays(ctx.travelDay, 2) : null;
      return back ? { value: `${back}T16:00:00`, source: 'default' } : null;
    } },

  // Trip search (search criteria only)
  { key: 'tripSearchCriteria.arrivalTime', group: 'trip', where: IN.search('arrivalTime'),
    value: (ctx) => {
      const at = laterTime(departureOf(ctx.request), 6);
      return at ? { value: at, source: 'default' } : null;
    } },
  { key: 'tripSearchCriteria.vias', group: 'trip', where: IN.search('vias'),
    value: (ctx) => (given(ctx, 'tripSearchCriteria.vias') ? { value: given(ctx, 'tripSearchCriteria.vias'), source: 'declared' } : null) },
  { key: 'tripSearchCriteria.notVias', group: 'trip', where: IN.search('notVias'),
    value: (ctx) => (given(ctx, 'tripSearchCriteria.notVias') ? { value: given(ctx, 'tripSearchCriteria.notVias'), source: 'declared' } : null) },
  { key: 'tripSearchCriteria.parameters', group: 'trip', where: IN.search('parameters'),
    check: (request, body) => {
      const n = request.tripSearchCriteria?.parameters?.numberOfResults;
      const trips = Array.isArray(body?.trips) ? body.trips.length : null;
      if (!n || trips === null || trips === 0) return null;
      return trips <= n ? 'honoured' : 'not-kept';
    },
    value: () => ({ value: { numberOfResults: 1 }, source: 'default' }) },
  { key: 'tripSearchCriteria.returnSearchParameters', group: 'trip', where: IN.search('returnSearchParameters'),
    value: (ctx) => {
      const back = ctx.travelDay ? addDays(ctx.travelDay, 2) : null;
      return back ? { value: { inwardReturnDate: `${back}T16:00:00` }, source: 'default' } : null;
    } },

  // Other members of the request
  { key: 'requestedSections', group: 'other', where: IN.root('requestedSections'),
    value: (ctx) => {
      const ends = tripEnds(ctx.request);
      return ends ? { value: [{ startPlace: ends.start, endPlace: ends.end }], source: 'default' } : null;
    } },
  { key: 'requestedFulfillmentOptions', group: 'other', where: IN.root('requestedFulfillmentOptions'),
    value: (ctx) => {
      const own = ctx.request?.requestedFulfillmentOptions;
      return Array.isArray(own) && own.length > 0
        ? { value: own, source: 'scenario' }
        : { value: [{ type: 'ETICKET', media: 'PDF_A4' }], source: 'default' };
    } },
  { key: 'corporateCodes', group: 'other', where: IN.root('corporateCodes'), invalidAllowed: true,
    value: (ctx) => {
      const declared = given(ctx, 'corporateCodes');
      if (Array.isArray(declared) && declared.length > 0) return { value: declared, source: 'declared' };
      return invalid(ctx, () => [{ code: `OSCAR-UNKNOWN-${token(ctx.rand)}`, issuer: 'urn:x_oscar:unknown-issuer' }]);
    } },
  { key: 'promotionCodes', group: 'other', where: IN.root('promotionCodes'), invalidAllowed: true,
    value: (ctx) => {
      const declared = given(ctx, 'promotionCodes');
      if (Array.isArray(declared) && declared.length > 0) return { value: declared, source: 'declared' };
      return invalid(ctx, () => [{ code: `OSCAR-UNKNOWN-${token(ctx.rand)}` }]);
    } },
  { key: 'tripResponseParameters', group: 'other', where: IN.root('tripResponseParameters'),
    value: () => ({ value: { stopBehavior: 'REAL_BOARDING_ALIGHTING' }, source: 'default' }) },
  { key: 'embed', group: 'other', where: IN.root('embed'),
    value: () => ({ value: ['ALL'], source: 'default' }) },
];

// A value made up on purpose, unless the scenario asks not to test it.
function invalid(ctx, make) {
  return ctx.invalidValues === 'skip' ? null : { value: make(), source: 'invalid' };
}

// Whether a member is in the request schema of a version.
function memberIn(version, schema, member) {
  const v = pickVersion(version);
  const props = requestSchemas[v]?.schemas?.[schema]?.properties;
  return !!(props && Object.hasOwn(props, member));
}

/**
 * The options of a scenario, in the fixed order, each with its value or the
 * reason it is not tested.
 * @returns {Array<{ option, value, source } | { option, skipped: string }>}
 */
function optionsFor({ request, version, values = {}, invalidValues = 'random', seed = 1, travelDay = null }) {
  const rand = mulberry32(seed);
  const passengers = (request?.anonymousPassengerSpecifications || []).filter(isObj);
  const ctx = { request, values, invalidValues, rand, travelDay, passengers };
  const form = tripFormOf(request);
  return OPTIONS.filter((o) => memberIn(version, o.where.schema, o.where.member)).map((option) => {
    if (option.where.searchOnly && form !== 'SEARCH') return { option, skipped: `only for a trip given by search criteria (the scenario's is ${form.toLowerCase().replace('_', ' ')})` };
    const v = option.value(ctx);
    if (!v) return { option, skipped: option.invalidAllowed ? 'no value declared, and invalid values are not sent' : 'no value declared or known' };
    return { option, value: v.value, source: v.source };
  });
}

/** The mandatory request plus the options of `picks` ({ option, value }). */
function withOptions(mandatory, picks) {
  const req = copy(mandatory);
  for (const { option, value } of picks) {
    const v = copy(value);
    if (Array.isArray(value) && value.perPassenger) perPassenger(v);
    option.where.set(req, v);
  }
  return req;
}

// ── Reading an answer ───────────────────────────────────────────────────────

const problemsOf = (body) => [
  ...(isObj(body) && (body.code || body.title) && !Array.isArray(body.offers) ? [body] : []),
  ...(Array.isArray(body?.problems) ? body.problems : []),
  ...(Array.isArray(body?.warnings) ? body.warnings : []),
  ...(Array.isArray(body?.warnings?.warnings) ? body.warnings.warnings : []),
].filter(isObj);

const pointersOf = (p) => (Array.isArray(p.pointers) ? p.pointers : [])
  .map((x) => (typeof x === 'string' ? x : x?.requestPointer || x?.pointer || x?.responsePointer))
  .filter((x) => typeof x === 'string');

/** A problem as one line: code, title, detail and the request members it points at. */
const problemText = (p) => {
  const at = pointersOf(p);
  return `${[p.code, p.title, p.detail].filter(Boolean).join(': ').slice(0, 200)}${at.length > 0 ? ` (at ${at.join(', ')})` : ''}`;
};

/** Level 1: the status alone. */
function statusClass(status) {
  const s = Number(status) || 0;
  if (s >= 200 && s < 300) return 'supported';
  if (s === 501) return 'not-implemented';
  if (s >= 400 && s < 500) return 'refused';
  return 'error';
}

/**
 * Level 2, for a 2xx: what the answer did with the options of `picks`.
 * ignoredNames: the members the answer says it ignored, lower-cased
 * (ignoredParameters.js).
 * @returns {{ result, message }}
 *   result: 'honoured' | 'accepted' | 'ignored-said' | 'ignored-silent' |
 *           'no-offer-said' | 'no-offer-silent' | 'invalid-said' | 'invalid-silent'
 */
function contentClass(request, body, picks, ignoredNames = []) {
  const offers = Array.isArray(body?.offers) ? body.offers.filter(Boolean) : [];
  const problems = problemsOf(body);
  const said = problems.map(problemText).join(' | ');
  if (offers.length === 0) {
    return problems.length > 0
      ? { result: 'no-offer-said', message: said }
      : { result: 'no-offer-silent', message: 'no offer, and nothing says why (OSDM: the answer should say no offer fits the options, or offer others)' };
  }
  const ignored = picks.filter(({ option }) => ignoredNames.includes(option.where.member.toLowerCase()));
  if (ignored.length > 0) {
    return { result: 'ignored-said', message: `said ignored: ${ignored.map(({ option }) => option.key).join(', ')}${said ? ` (${said})` : ''}` };
  }
  if (picks.some((p) => p.source === 'invalid')) {
    return problems.length > 0
      ? { result: 'invalid-said', message: `offers given, the invalid value is said: ${said}` }
      : { result: 'invalid-silent', message: 'a value OSCAR made up (unknown code) was taken without a word' };
  }
  const results = picks.map(({ option }) => (option.check ? option.check(request, body) : null));
  if (results.some((r) => r === 'not-kept')) {
    const off = picks.filter((_, i) => results[i] === 'not-kept').map(({ option }) => option.key);
    return problems.length > 0
      ? { result: 'ignored-said', message: `not kept: ${off.join(', ')} (${said})` }
      : { result: 'ignored-silent', message: `the offers do not keep to ${off.join(', ')}, and nothing says so` };
  }
  if (results.some((r) => r === 'honoured')) return { result: 'honoured', message: `${offers.length} offer(s) keep to it` };
  return { result: 'accepted', message: `${offers.length} offer(s); the answer cannot show the option was used` };
}

/** Both levels, for one answer. */
function classify(status, body, request, picks, ignoredNames = []) {
  const level1 = statusClass(status);
  if (level1 !== 'supported') {
    const problems = problemsOf(body);
    return { status: Number(status) || 0, level1, result: level1, message: problems.map(problemText).join(' | ') || `HTTP ${status}` };
  }
  return { status: Number(status), level1, ...contentClass(request, body, picks, ignoredNames) };
}

/**
 * An option counts as supported for the combinations when its answer was a
 * 2xx that honoured it or could not show it, with a value that is not made up.
 */
const SUPPORTED_RESULTS = new Set(['honoured', 'accepted']);
const isSupported = (row) => row.source !== 'invalid' && SUPPORTED_RESULTS.has(row.result);

/** Phase 1 passes when the mandatory request is answered with offers. */
function mandatoryOutcome(status, body) {
  const level1 = statusClass(status);
  const offers = Array.isArray(body?.offers) ? body.offers.filter(Boolean).length : 0;
  if (level1 !== 'supported') return { ok: false, message: `HTTP ${status}: the request holding only the mandatory members is not answered (${problemsOf(body).map(problemText).join(' | ') || 'no problem given'})` };
  if (offers === 0) return { ok: false, message: `HTTP ${status} but no offer for the request holding only the mandatory members (${problemsOf(body).map(problemText).join(' | ') || 'nothing says why'})` };
  return { ok: true, message: `${offers} offer(s)` };
}

// ── Planning ────────────────────────────────────────────────────────────────

/** The request budget: 30 by default, within [3, 200]. */
function budgetOf(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return DEFAULT_MAX_REQUESTS;
  return Math.min(MAX_REQUESTS, Math.max(MIN_REQUESTS, n));
}

/**
 * How many requests each phase gets. Phase 1 (the step's own request) and
 * phase 4 always run; phase 2 goes through the options in order, keeping
 * PHASE3_RESERVE for phase 3 when the budget allows; phase 3 takes the rest.
 */
function plan(budget, optionCount) {
  const left = Math.max(0, budget - 2);
  const reserve = Math.min(PHASE3_RESERVE, Math.max(0, left - 1));
  const phase2 = Math.min(optionCount, left - reserve);
  return { phase1: 1, phase2, phase3: left - phase2, phase4: 1 };
}

/**
 * `count` random combinations of the supported rows, 2 to 4 options each,
 * never two options of one `conflicts` group, each combination once.
 */
function drawCombinations(rows, count, seed) {
  const rand = mulberry32(seed ^ 0x5EED);
  const out = [];
  const seen = new Set();
  if (rows.length < 2) return out;
  for (let attempt = 0; out.length < count && attempt < count * 20; attempt++) {
    const size = 2 + Math.floor(rand() * (Math.min(MAX_COMBINATION_SIZE, rows.length) - 1));
    const pool = [...rows];
    const picked = [];
    const groups = new Set();
    while (picked.length < size && pool.length > 0) {
      const [row] = pool.splice(Math.floor(rand() * pool.length), 1);
      const g = row.option.conflicts;
      if (g && groups.has(g)) continue;
      if (g) groups.add(g);
      picked.push(row);
    }
    if (picked.length < 2) continue;
    const key = picked.map((r) => r.option.key).sort().join('+');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(picked);
  }
  return out;
}

/** Every supported row, one per conflict group (the first). */
function allSupported(rows) {
  const groups = new Set();
  return rows.filter((row) => {
    const g = row.option.conflicts;
    if (!g) return true;
    if (groups.has(g)) return false;
    groups.add(g);
    return true;
  });
}

// ── The report ──────────────────────────────────────────────────────────────

const short = (v) => {
  const t = typeof v === 'string' ? v : JSON.stringify(v);
  return t.length > 80 ? `${t.slice(0, 77)}…` : t;
};

const SUMMARY_ORDER = ['honoured', 'accepted', 'ignored-said', 'ignored-silent', 'no-offer-said', 'no-offer-silent',
  'invalid-said', 'invalid-silent', 'refused', 'not-implemented', 'error', 'not-tested', 'not-reached'];

/** The lines of the report, for the run log. */
function reportLines(report) {
  const lines = [];
  lines.push(`[INFO] 🧭 Offer request options (#227) — OSDM ${report.version}, budget ${report.budget} request(s), ${report.used} used, seed ${report.seed}.`);
  lines.push(`[INFO] 🧭 Phase 1, mandatory members only: ${report.mandatory.ok ? 'answered' : 'NOT answered'} — ${report.mandatory.message}`);
  const counts = {};
  for (const row of report.options) counts[row.result] = (counts[row.result] || 0) + 1;
  lines.push(`[INFO] 🧭 Phase 2, one option at a time: ${SUMMARY_ORDER.filter((k) => counts[k]).map((k) => `${counts[k]} ${k}`).join(', ')}.`);
  for (const row of report.options) {
    const value = row.value === undefined ? '' : ` = ${short(row.value)} (${row.source})`;
    const status = row.status ? ` HTTP ${row.status},` : '';
    lines.push(`[INFO] 🧭   ${row.option}${value}:${status} ${row.result}${row.message ? ` — ${row.message}` : ''}`);
  }
  for (const c of report.combinations) {
    lines.push(`[INFO] 🧭 Phase 3, ${c.options.join(' + ')}: HTTP ${c.status}, ${c.result}${c.message ? ` — ${c.message}` : ''}`);
  }
  if (report.all) {
    lines.push(`[INFO] 🧭 Phase 4, every supported option (${report.all.options.length}): HTTP ${report.all.status}, ${report.all.result}${report.all.message ? ` — ${report.all.message}` : ''}`);
  } else {
    lines.push('[INFO] 🧭 Phase 4 not run: no option was found supported.');
  }
  const silent = report.options.filter((r) => ['ignored-silent', 'no-offer-silent', 'invalid-silent'].includes(r.result));
  if (silent.length > 0) {
    lines.push(`[WARNING] 🧭 Offer request options taken without a word: ${silent.map((r) => r.option).join(', ')} — a distributor cannot tell what the offers answer.`);
  }
  return lines;
}

/**
 * Every phase, given a `send(body)` that answers { status, body }. Returns the
 * report (see reportLines). Pure but for `send`.
 */
async function discover({ request, version, values, invalidValues, seed, travelDay, budget, mandatory, send, ignoredOf }) {
  const rows = optionsFor({ request, version, values, invalidValues, seed, travelDay });
  const testable = rows.filter((r) => !r.skipped);
  const share = plan(budget, testable.length);
  const base = mandatoryRequest(request);
  const report = { version, budget, used: 1, seed, mandatory, options: [], combinations: [], all: null };
  const ask = async (picks) => {
    const body = withOptions(base, picks);
    const answer = await send(body);
    report.used += 1;
    return classify(answer.status, answer.body, body, picks, ignoredOf(answer.body));
  };
  const tried = [];
  for (const [i, r] of testable.entries()) {
    if (i >= share.phase2) {
      report.options.push({ option: r.option.key, group: r.option.group, value: r.value, source: r.source, result: 'not-reached', message: 'the request budget ran out' });
      continue;
    }
    const outcome = await ask([r]);
    const entry = { option: r.option.key, group: r.option.group, value: r.value, source: r.source, ...outcome };
    report.options.push(entry);
    tried.push({ ...r, result: entry.result });
  }
  for (const r of rows.filter((x) => x.skipped)) {
    report.options.push({ option: r.option.key, group: r.option.group, result: 'not-tested', message: r.skipped });
  }
  const supported = tried.filter(isSupported);
  for (const combo of drawCombinations(supported, share.phase3, seed)) {
    const outcome = await ask(combo);
    report.combinations.push({ options: combo.map((r) => r.option.key), ...outcome });
  }
  if (supported.length >= 2) {
    const all = allSupported(supported);
    report.all = { options: all.map((r) => r.option.key), ...(await ask(all)) };
  }
  return report;
}

// ── Bruno glue ──────────────────────────────────────────────────────────────

const armed = () => String(bru.getEnvVar('offerOptionDiscovery')) === 'true';

function envJson(name, fallback) {
  const raw = bru.getEnvVar(name);
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw || 'null') ?? fallback; } catch { return fallback; }
}

/**
 * Step 01, before the request: keeps the scenario's whole request and sends
 * the one with the mandatory members only (phase 1).
 */
function prepareOptionDiscovery() {
  if (!armed()) return;
  const full = envJson('OfferCollectionRequest', {});
  bru.setEnvVar('__offerOptionFull', JSON.stringify(full));
  bru.setEnvVar('OfferCollectionRequest', JSON.stringify(mandatoryRequest(full)));
  validationLogger('[INFO] 🧭 Offer request options (#227) — phase 1: POST /offers with the mandatory members only (passengers\' externalRef and type, and the trip).');
}

async function sendOffers(body) {
  try {
    return await require('./osdmPost.js').postOsdm('/offers', body);
  } catch (err) {
    validationLogger(`[ERROR] 🧭 An offer request with options could not be sent: ${err?.message || err}`);
    return { status: 0, body: null };
  }
}

/**
 * Step 01, after the response, before the status check. True when the
 * discovery is armed: phase 1 is graded (the one check that can fail), phases
 * 2 to 4 are sent from here, the report is logged and kept in
 * `__offerOptionReport`, and the scenario ends.
 */
async function runOptionDiscovery(status, body) {
  if (!armed()) return false;
  const mandatory = mandatoryOutcome(status, body);
  test(`🧭 Offer request with the mandatory members only — answered with offers (HTTP ${status})`, () => {
    if (!mandatory.ok) throw new Error(`${mandatory.message}. OSDM requires only the passengers and the trip: a provider must answer such a request.`);
  });
  const { ignoredParameters } = require('./ignoredParameters.js');
  const report = await discover({
    request: envJson('__offerOptionFull', {}),
    version: bru.getEnvVar('osdmVersion'),
    values: envJson('offerOptionValues', {}) || {},
    invalidValues: bru.getEnvVar('offerOptionInvalidValues') === 'skip' ? 'skip' : 'random',
    seed: Number.parseInt(bru.getEnvVar('offerOptionSeed'), 10) || seedOf(bru.getEnvVar('scenarioCode') || 'offerOptionDiscovery'),
    travelDay: bru.getEnvVar('__travelDay') || null,
    budget: budgetOf(bru.getEnvVar('offerOptionMaxRequests')),
    mandatory,
    send: sendOffers,
    ignoredOf: (b) => ignoredParameters(b),
  });
  for (const line of reportLines(report)) validationLogger(line);
  bru.setEnvVar('__offerOptionReport', JSON.stringify(report));
  return true;
}

module.exports = {
  DEFAULT_MAX_REQUESTS,
  discover,
  prepareOptionDiscovery,
  runOptionDiscovery,
  OPTIONS,
  mulberry32,
  seedOf,
  tripFormOf,
  mandatoryRequest,
  memberIn,
  optionsFor,
  withOptions,
  statusClass,
  contentClass,
  classify,
  isSupported,
  mandatoryOutcome,
  budgetOf,
  plan,
  drawCombinations,
  allSupported,
  reportLines,
};
