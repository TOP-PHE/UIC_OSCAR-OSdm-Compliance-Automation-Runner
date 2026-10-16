// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * timetable-discovery.js — pure harvest / group / merge logic (issue #157).
 *
 * "Train Timetable Discovery" reverse-engineers train-set test data from the
 * trips a sandbox actually returns. The caller fires POST /trips-collection for
 * an O&D across the next N days; this module turns those responses into
 * route-keyed train sets and merges them into the company's existing TRAIN
 * test resources WITHOUT clobbering manual edits.
 *
 * There is deliberately NO I/O in this file — the live HTTP call and DB writes
 * live in the route handler. Everything here is a pure function of its inputs
 * so the harvest/group/merge behaviour is unit-testable from captured JSON.
 *
 * Design decisions locked in issue #157:
 *   • Harvest EVERY timed leg of every returned trip as a service on its own
 *     sub-route (origin + destination of that leg), not just the whole-trip O&D.
 *   • Group services by route key = origin URN + destination URN + product
 *     category ref. Each group becomes one train set.
 *   • MERGE into existing TRAIN resources matched on the same route key:
 *     append new services (dedup on vehicle# + departure + arrival), union the
 *     operating-days calendar, and only fill operator / product-category
 *     name fields when they are currently empty. Manual edits survive.
 */

// Day-of-week codes in JS getUTCDay() order (0 = Sunday) — matches WIZ_DAYS
// values used by the Test Data UI (scenarios.js).
const DAY_CODES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
// Canonical Mon-first ordering for stable, human-friendly output.
const DAY_ORDER = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

/**
 * Map an OSDM ServiceTime (offset date-time, e.g. "2026-06-01T09:10:00+02:00")
 * to its operating-day code. We read the calendar date straight from the
 * string so the weekday reflects the service's own local date — going through
 * `new Date(...).getUTCDay()` would drift across midnight for non-UTC offsets.
 * @returns {string} 'MON'..'SUN', or '' when unparseable.
 */
function dayOfWeekCode(isoLike) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoLike || ''));
  if (!m) return '';
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(dt.getTime())) return '';
  return DAY_CODES[dt.getUTCDay()] || '';
}

/**
 * Keep only the time-of-day portion of an OSDM offset date-time, matching how
 * train-set services are stored by the UI ("09:10:00+02:00"). The set's
 * operating-days calendar carries the date dimension, so storing a full
 * date-time per service would be both redundant and brittle across days.
 */
function timePartOf(iso) {
  const s = String(iso || '');
  const i = s.indexOf('T');
  return (i >= 0 ? s.slice(i + 1) : s).trim();
}

/**
 * Build the list of calendar dates to search, starting at `from`.
 * @param {number} days  how many consecutive days (clamped to 1..14)
 * @param {Date|string|number} from  the first day (defaults to now)
 * @returns {string[]} 'YYYY-MM-DD' local dates, length = clamped days
 */
function searchDates(days, from) {
  const n = Math.max(1, Math.min(14, Number.parseInt(days, 10) || 7));
  const base = from instanceof Date ? from : new Date(from || Date.now());
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    out.push(`${d.getFullYear()}-${mm}-${dd}`);
  }
  return out;
}

// A leg endpoint's stopPlaceRef may arrive as the OSDM object form
// ({ objectType, stopPlaceRef }) or, defensively, as a bare URN string.
function _stopRef(end) {
  if (!end) return '';
  const r = end.stopPlaceRef;
  if (!r) return '';
  if (typeof r === 'string') return r;
  return r.stopPlaceRef || '';
}

/**
 * Harvest every timed leg of every trip into a flat list of service records.
 *
 * Non-timed legs (transfers / walking connections / continuous legs) carry no
 * service and are skipped — only `timedLeg` entries describe a train run.
 *
 * When `opts.searchedOrigin` / `opts.searchedDestination` are supplied, the
 * clean O&D the tester searched with replaces the sandbox's own refs at the
 * route endpoints — the FIRST timed leg's origin and the LAST timed leg's
 * destination of each trip (every returned trip spans the searched O&D). This
 * keeps tidy UIC codes for the endpoints instead of a vendor's internal stop
 * refs (e.g. Bileto's urn:x_bileto:stn:<uuid>), while intermediate connection
 * stations the sandbox resolves itself are left untouched (#163 follow-up).
 *
 * @param {object} resp  parsed TripCollectionResponse / OfferCollectionResponse ({ trips: [...] })
 * @param {{searchedOrigin?:string, searchedDestination?:string}} [opts]
 * @returns {Array<object>} one record per timed leg:
 *   { originURN, destinationURN, originName, destName, operatorCode,
 *     productCategoryRef, productCategoryName, productCategoryShortName,
 *     vehicleNumber, departureTime, arrivalTime, dayOfWeek }
 */
function harvestTrips(resp, opts) {
  const trips = (resp && Array.isArray(resp.trips)) ? resp.trips : [];
  return trips.flatMap(trip => tripLegRecords(trip, opts));
}

// The records of one trip's timed legs, in order (see harvestTrips).
function tripLegRecords(trip, opts) {
  opts = opts || {};
  const searchedOrigin = opts.searchedOrigin || '';
  const searchedDestination = opts.searchedDestination || '';
  const legs = (trip && Array.isArray(trip.legs)) ? trip.legs : [];
  const timed = legs.map(l => l?.timedLeg).filter(Boolean);
  return timed.map((tl, idx) => {
    const svc = tl.service || {};
    const pc = svc.productCategory || {};
    const veh = Array.isArray(svc.vehicleNumbers) ? svc.vehicleNumbers.filter(Boolean) : [];
    const carrier = (Array.isArray(svc.carriers) && svc.carriers.length) ? svc.carriers[0] : null;
    const start = tl.start || {};
    const end = tl.end || {};
    const dep = start.serviceDeparture?.timetabledTime;
    const arr = end.serviceArrival?.timetabledTime;
    let originURN = _stopRef(start);
    let destinationURN = _stopRef(end);
    // Substitute the searched O&D at the route endpoints (first/last leg).
    if (searchedOrigin && idx === 0) originURN = searchedOrigin;
    if (searchedDestination && idx === timed.length - 1) destinationURN = searchedDestination;
    return {
      originURN,
      destinationURN,
      originName:     start.stopPlaceName || '',
      destName:       end.stopPlaceName || '',
      operatorCode:   carrier ? (carrier.ref || '') : '',
      productCategoryRef:       pc.productCategoryRef || '',
      productCategoryName:      pc.name || '',
      productCategoryShortName: pc.shortName || '',
      vehicleNumber:  veh.join('/'),
      departureTime:  timePartOf(dep),
      arrivalTime:    timePartOf(arr),
      dayOfWeek:      dayOfWeekCode(dep)
    };
  });
}

// ── Connections as journeys (#715) ────────────────────────────────────────
// A trip of 2 or 3 timed legs is a connection the provider itself offers.
// Discovery stores each leg as a train service (groupAndMerge); these turn the
// connection into a JOURNEY resource pointing at those services.

const CONNECTION_LEGS = { min: 2, max: 3 };

/** The leg records of each trip of 2 or 3 timed legs (records as harvestTrips). */
function harvestConnections(resp, opts) {
  const trips = (resp && Array.isArray(resp.trips)) ? resp.trips : [];
  return trips.map(trip => tripLegRecords(trip, opts))
    .filter(legs => legs.length >= CONNECTION_LEGS.min && legs.length <= CONNECTION_LEGS.max);
}

// "HH:MM[:SS]" on the clock, in minutes; null when not a time.
function _clockMinutes(time) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(time || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Every leg of a journey runs on the trip date (trip-apply.js gives them all
// %TRIP_DATE%): each leg leaves no earlier on the clock than the previous one
// arrived, and only the last may arrive after midnight.
function _fitsOneTripDate(legs) {
  for (let i = 0; i < legs.length; i++) {
    const dep = _clockMinutes(legs[i].departureTime);
    const arr = _clockMinutes(legs[i].arrivalTime);
    if (dep === null || arr === null) return false;
    const last = i === legs.length - 1;
    if (!last && arr < dep) return false;
    if (i > 0 && dep < _clockMinutes(legs[i - 1].arrivalTime)) return false;
  }
  return true;
}

// The train service a leg record names among `trains` (TRAIN resources with
// object data): same route and product category, same service, running that
// day (a set without days runs every day). { trainResourceId, serviceIndex } or null.
function _legRef(rec, trains) {
  const key = serviceKey(rec);
  for (const t of trains) {
    const d = t.data || {};
    if (d.originURN !== rec.originURN || d.destinationURN !== rec.destinationURN) continue;
    if ((d.productCategoryRef || '') !== (rec.productCategoryRef || '')) continue;
    const days = Array.isArray(d.daysOfWeek) ? d.daysOfWeek : [];
    if (days.length && rec.dayOfWeek && !days.includes(rec.dayOfWeek)) continue;
    const services = Array.isArray(d.services) ? d.services : [];
    const serviceIndex = services.findIndex(s => serviceKey(s) === key);
    if (serviceIndex !== -1) return { trainResourceId: t.id, serviceIndex };
  }
  return null;
}

const _legsKey = legs => legs.map(l => `${l.trainResourceId}#${l.serviceIndex}`).join('>');

function _stopShort(urn) { return String(urn || '').split(':').pop(); }

function _journeyLabel(legs) {
  const first = legs[0];
  const last = legs.at(-1);
  const name = (n, urn) => n || _stopShort(urn);
  // A change of train: the next leg's start, else the previous leg's end.
  const via = legs.slice(1).map((l, i) => name(l.originName || legs[i].destName, l.originURN)).join(', ');
  return `${name(first.originName, first.originURN)} → ${name(last.destName, last.destinationURN)} via ${via} (${String(first.departureTime).slice(0, 5)})`;
}

/**
 * The JOURNEY resources to create for `connections` (harvestConnections), once
 * their legs are stored as train services in `trains`. A connection whose leg
 * has no service, or that does not fit one trip date, is skipped; one whose
 * legs a journey in `existingJourneys` (or an earlier connection) already
 * holds is not created again.
 * @returns {{ toCreate: Array<{label, data:{legs}}>, skipped: number }}
 */
function journeysFromConnections(connections, trains, existingJourneys) {
  const seen = new Set((existingJourneys || []).map(j => _legsKey(Array.isArray(j?.data?.legs) ? j.data.legs : [])));
  const toCreate = [];
  let skipped = 0;
  for (const recs of connections || []) {
    if (!_fitsOneTripDate(recs)) { skipped++; continue; }
    const legs = recs.map(r => _legRef(r, trains || []));
    if (legs.includes(null)) { skipped++; continue; }
    const key = _legsKey(legs);
    if (seen.has(key)) continue;
    seen.add(key);
    toCreate.push({ label: _journeyLabel(recs), data: { legs } });
  }
  return { toCreate, skipped };
}

// Route key — a train set is identified by where the leg runs and what kind of
// service it is. Product category distinguishes e.g. a high-speed run from a
// regional one on the same physical O&D.
function routeKey(rec) {
  return `${rec.originURN || ''}|${rec.destinationURN || ''}|${rec.productCategoryRef || ''}`;
}

// Service dedup key within a set — matches the UI's snapshot key
// (scenarios.js): vehicle number + departure + arrival.
function serviceKey(svc) {
  return `${svc.vehicleNumber || ''}|${svc.departureTime || ''}|${svc.arrivalTime || ''}`;
}

function sortDays(days) {
  return [...new Set(days)].filter(Boolean).sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
}

// Short, human-friendly station label from a name or URN tail.
function _stnLabel(name, urn) {
  if (name) return name;
  const s = String(urn || '');
  const i = s.lastIndexOf(':');
  return i >= 0 ? s.slice(i + 1) : s;
}

function _newSetLabel(group) {
  const o = _stnLabel(group.originName, group.originURN);
  const d = _stnLabel(group.destName, group.destinationURN);
  const tag = group.productCategoryShortName || group.productCategoryName || 'Train';
  const route = (o || d) ? `${o || '?'}→${d || '?'}` : 'route';
  return `${tag} ${route}`.trim();
}

// Pull a class value out of whatever shape a *Class field takes. OSDM uses two
// forms: a bare enum string ("SECOND") for travelClass, and an object
// ({ name, type }) for serviceClass / overallServiceClass. Prefer `type`, then
// `name`. Returns '' for anything else.
function _classValue(v) {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    if (typeof v.type === 'string' && v.type) return v.type;
    if (typeof v.name === 'string' && v.name) return v.name;
  }
  return '';
}

// Recursively collect every class value stored under any of `keys` anywhere in
// a (possibly deeply nested) offer object. Depth-guarded. Decoupled from the
// exact offer-part path, which varies across vendors / OSDM versions.
function _collectClasses(node, keys, out, depth) {
  if (depth > 8 || node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const x of node) _collectClasses(x, keys, out, depth + 1);
    return;
  }
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (keys.includes(k)) {
      const s = _classValue(v);
      if (s) out.add(s);
    }
    _collectClasses(v, keys, out, depth + 1);
  }
}

// Recursively collect ancillary identifiers from any `ancillaryOfferParts`
// array found in the offer tree. Prefers the OSDM AncillaryType (`type`,
// which aligns with the framework's OSDM_ANCILLARY_TYPES catalog), falling
// back to the free-text `category`.
function _collectAncillaries(node, out, depth) {
  if (depth > 8 || node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const x of node) _collectAncillaries(x, out, depth + 1);
    return;
  }
  if (Array.isArray(node.ancillaryOfferParts)) {
    for (const a of node.ancillaryOfferParts) {
      if (a && typeof a === 'object') {
        // #369: per spec, 'type' is the AncillaryType ENUM (FOOD_ON_BOARD,
        // WIFI, ...) and 'category' a free-text label ('Meal'). Keep
        // type-first, but never seed the catalog with a discriminator-shaped
        // value (some providers echo the objectType there) - fall back to
        // category in that case.
        const tv = (typeof a.type === 'string' && a.type && !/offerpart$/i.test(a.type)) ? a.type : '';
        const v = tv || (typeof a.category === 'string' ? a.category : '');
        if (v) out.add(v);
      }
    }
  }
  for (const k of Object.keys(node)) _collectAncillaries(node[k], out, depth + 1);
}

/**
 * Harvest the offer "catalog" — the travel classes, service classes and
 * ancillary types the sandbox actually offered on this O&D — from an
 * OfferCollectionResponse. Used to PREFILL a discovered train set's Service
 * Configuration (a TripCollectionResponse has no `offers[]`, so this returns
 * empty arrays for the /trips-collection path).
 *
 * @param {object} resp parsed OfferCollectionResponse ({ offers: [...] })
 * @returns {{ travelClasses:string[], serviceClasses:string[], ancillaries:string[] }}
 */
function harvestOfferCatalog(resp) {
  const offers = (resp && Array.isArray(resp.offers)) ? resp.offers : [];
  const tc = new Set();
  const sc = new Set();
  const anc = new Set();
  for (const o of offers) {
    // travelClass is a string; serviceClass is { name, type }. The offerSummary
    // mirrors them as overallTravelClass / overallServiceClass.
    _collectClasses(o, ['travelClass', 'overallTravelClass'], tc, 0);
    _collectClasses(o, ['serviceClass', 'overallServiceClass'], sc, 0);
    _collectAncillaries(o, anc, 0);
  }
  return { travelClasses: [...tc], serviceClasses: [...sc], ancillaries: [...anc] };
}

// #369: turn a probe accumulator { daysProbed, daysWithOffers, classes:Set,
// flex:Set, noOffer:[{date,finding}] } into the persisted offerProbe object
// (null when nothing was probed). Shared by discovery and re-probe.
function summarizeOfferProbe(probe) {
  if (!probe || probe.daysProbed <= 0) return null;
  const findings = [];
  if (probe.daysWithOffers === 0) {
    const echoed = probe.noOffer.find(x => /provider says/.test(x.finding));
    findings.push('No offer for an anonymous adult on any of the ' + probe.daysProbed + ' probed day(s)' +
      (echoed ? ' - ' + echoed.finding : ' - trip(s) found but offers[] stayed empty, no warning/problem explains why'));
  } else {
    const cls = [...probe.classes];
    if (cls.length > 0 && cls.includes('SECOND') && !cls.includes('FIRST')) {
      findings.push('Offers only in SECOND class (no FIRST offered to an anonymous adult)');
    }
    const fl = [...probe.flex];
    if (fl.length > 0 && fl.every(f => /NON_?FLEX/i.test(f))) {
      findings.push('Offers only NON-FLEXIBLE (no flexible tier - scenarios selecting by Desired Flexibility will not match)');
    }
    if (probe.daysWithOffers < probe.daysProbed) {
      findings.push('Offers on ' + probe.daysWithOffers + ' of ' + probe.daysProbed + ' probed day(s) (none on: ' +
        probe.noOffer.map(x => x.date).join(', ') + ')');
    }
  }
  return {
    probedAt: new Date().toISOString(),
    daysProbed: probe.daysProbed,
    daysWithOffers: probe.daysWithOffers,
    classes: [...probe.classes],
    flexibilities: [...probe.flex],
    findings
  };
}

// #365: classify ONE offers response for route-level availability findings -
// did an anonymous-adult search actually yield offers, and of what shape?
// Returns null for a trips-collection response (no offers[] member at all).
function classifyOfferProbe(resp) {
  if (!resp || typeof resp !== 'object' || !Array.isArray(resp.offers)) return null;
  const trips = Array.isArray(resp.trips) ? resp.trips.length : 0;
  if (resp.offers.length === 0) {
    // #787: OSDM 3.5+ gives warnings as a WarningCollection { warnings: [...] }.
    const warnings = Array.isArray(resp.warnings) ? resp.warnings : (Array.isArray(resp.warnings?.warnings) ? resp.warnings.warnings : []);
    const echo = []
      .concat(warnings, Array.isArray(resp.problems) ? resp.problems : [])
      .map(w => w && (w.code || w.title)).filter(Boolean).slice(0, 3);
    const explanation = echo.length
      ? ' (provider says: ' + echo.join('; ') + ')'
      : ', no warning/problem explains why';
    return {
      offers: 0, trips, classes: [], flexibilities: [],
      finding: trips > 0
        ? 'trip(s) found but offers[] empty' + explanation
        : 'no trip and no offer on this date'
    };
  }
  const classes = new Set(); const flex = new Set();
  for (const o of resp.offers) {
    const tc = o.travelClass || o.offerSummary?.overallTravelClass;
    if (typeof tc === 'string' && tc) classes.add(tc.toUpperCase());
    const fl = o.offerSummary?.overallFlexibility || o.flexibility;
    if (typeof fl === 'string' && fl) flex.add(fl.toUpperCase());
  }
  return { offers: resp.offers.length, trips, classes: [...classes], flexibilities: [...flex], finding: null };
}

const _DAY_SHORT = { MON: 'Mon', TUE: 'Tue', WED: 'Wed', THU: 'Thu', FRI: 'Fri', SAT: 'Sat', SUN: 'Sun' };

// Human label for an operating-days pattern, used to distinguish split sets.
// '' for daily / unknown (no suffix), else 'Mon–Fri', 'weekend', or 'Mon,Wed,Fri'.
function _dayPatternLabel(days) {
  const d = sortDays(days);
  if (d.length === 0 || d.length === 7) return '';
  const set = new Set(d);
  if (d.length === 5 && ['MON', 'TUE', 'WED', 'THU', 'FRI'].every(x => set.has(x))) return 'Mon–Fri';
  if (d.length === 2 && set.has('SAT') && set.has('SUN')) return 'weekend';
  return d.map(x => _DAY_SHORT[x] || x).join(',');
}

/**
 * Group harvested service records into desired train sets, then reconcile
 * against the company's existing TRAIN resources.
 *
 * Services on the same route are SPLIT into separate sets by their observed
 * operating-days pattern (e.g. weekday 1xx trains vs weekend 8xx trains), so
 * each set keeps a single, accurate operating-days calendar (the model #141
 * established — one calendar per set). The reconcile key therefore includes
 * the calendar: origin + destination + product-category ref + sorted days.
 *
 * @param {Array<object>} harvested   output of harvestTrips() (possibly across many days)
 * @param {Array<object>} existing    existing TRAIN resources: { id, resource_type, label, data }
 *                                     `data` already parsed to an object.
 * @param {object} [catalog]          optional offer catalog (harvestOfferCatalog):
 *                                     { travelClasses, serviceClasses, ancillaries }.
 *                                     Seeds NEW sets and fills EMPTY arrays on
 *                                     existing sets (never overwrites manual edits).
 * @returns {{
 *   toCreate: Array<{ label:string, data:object }>,
 *   toUpdate: Array<{ id:string, label:string, data:object }>,
 *   summary: object
 * }}
 */
// #717: an existing set of the group's route and product category, with no
// operating days, holding one of `services`, not already taken by another
// pattern of the same route (the first pattern takes it).
function _uncalendaredTwin(existing, g, services, taken) {
  const keys = new Set(services.map(serviceKey));
  return (existing || []).find(r => {
    if (!r || r.resource_type !== 'TRAIN') return false;
    const d = r.data || {};
    if (d.originURN !== g.originURN || d.destinationURN !== g.destinationURN) return false;
    if ((d.productCategoryRef || '') !== (g.productCategoryRef || '')) return false;
    if (Array.isArray(d.daysOfWeek) && d.daysOfWeek.length) return false;
    if (taken.has(r.id)) return false;
    const hit = (Array.isArray(d.services) ? d.services : []).some(s => keys.has(serviceKey(s)));
    if (hit) taken.add(r.id);
    return hit;
  }) || null;
}

function groupAndMerge(harvested, existing, catalog) {
  catalog = catalog || {};
  const catTravel  = Array.isArray(catalog.travelClasses)  ? catalog.travelClasses  : [];
  const catService = Array.isArray(catalog.serviceClasses) ? catalog.serviceClasses : [];
  const catAnc     = Array.isArray(catalog.ancillaries)    ? catalog.ancillaries    : [];
  // 1. Collapse harvested records into per-route groups, tracking the set of
  //    operating days observed PER service (so a route can be split into
  //    separate sets by day-pattern — e.g. weekday vs weekend trains).
  const groups = new Map();   // routeKey -> group accumulator
  for (const rec of (harvested || [])) {
    // A leg with neither endpoint nor a vehicle is noise — ignore.
    if (!rec.originURN && !rec.destinationURN && !rec.vehicleNumber) continue;
    const key = routeKey(rec);
    let g = groups.get(key);
    if (!g) {
      g = {
        originURN: rec.originURN, destinationURN: rec.destinationURN,
        originName: rec.originName, destName: rec.destName,
        operatorCode: rec.operatorCode,
        productCategoryRef: rec.productCategoryRef,
        productCategoryName: rec.productCategoryName,
        productCategoryShortName: rec.productCategoryShortName,
        services: new Map()   // serviceKey -> { svc, days:Set }
      };
      groups.set(key, g);
    }
    // First non-empty wins for descriptive fields.
    if (!g.operatorCode && rec.operatorCode) g.operatorCode = rec.operatorCode;
    if (!g.productCategoryName && rec.productCategoryName) g.productCategoryName = rec.productCategoryName;
    if (!g.productCategoryShortName && rec.productCategoryShortName) g.productCategoryShortName = rec.productCategoryShortName;
    if (!g.originName && rec.originName) g.originName = rec.originName;
    if (!g.destName && rec.destName) g.destName = rec.destName;
    const svc = {
      vehicleNumber: rec.vehicleNumber || '',
      departureTime: rec.departureTime || '',
      arrivalTime:   rec.arrivalTime || ''
    };
    const sk = serviceKey(svc);
    let entry = g.services.get(sk);
    if (!entry) { entry = { svc, days: new Set() }; g.services.set(sk, entry); }
    if (rec.dayOfWeek) entry.days.add(rec.dayOfWeek);
  }

  // 2. Split each route into desired sets — one per distinct operating-days
  //    pattern. A service that ran Mon..Fri and one that ran Sat/Sun end up in
  //    two sets, each with its own calendar.
  const desired = [];   // { g, daysOfWeek:[], patternLabel, services:[] }
  let servicesDiscovered = 0;
  for (const g of groups.values()) {
    const byPattern = new Map();   // sortedDaysCsv -> { days:[], services:[] }
    for (const { svc, days } of g.services.values()) {
      servicesDiscovered++;
      const sorted = sortDays([...days]);
      const csv = sorted.join(',');
      let p = byPattern.get(csv);
      if (!p) { p = { days: sorted, services: [] }; byPattern.set(csv, p); }
      p.services.push(svc);
    }
    for (const p of byPattern.values()) {
      desired.push({ g, daysOfWeek: p.days, patternLabel: _dayPatternLabel(p.days), services: p.services });
    }
  }

  // 3. Index existing TRAIN resources by route + calendar (first wins).
  const existingByKey = new Map();
  for (const r of (existing || [])) {
    if (r?.resource_type !== 'TRAIN') continue;
    const d = r.data || {};
    const cal = sortDays(Array.isArray(d.daysOfWeek) ? d.daysOfWeek : []).join(',');
    const k = `${d.originURN || ''}|${d.destinationURN || ''}|${d.productCategoryRef || ''}|${cal}`;
    if (!existingByKey.has(k)) existingByKey.set(k, r);
  }

  // 4. Reconcile each desired set against the matching existing set.
  const takenTwins = new Set();   // #717: sets without calendar already given one
  const toCreate = [];
  const toUpdate = [];
  let servicesAdded = 0;

  for (const set of desired) {
    const g = set.g;
    const dkey = `${g.originURN || ''}|${g.destinationURN || ''}|${g.productCategoryRef || ''}|${set.daysOfWeek.join(',')}`;
    // #717: a set of the same route with no calendar yet, sharing a service,
    // is this one: it gets the calendar instead of a second set appearing.
    const existingRes = existingByKey.get(dkey) || _uncalendaredTwin(existing, g, set.services, takenTwins);

    if (!existingRes) {
      const services = set.services.slice().sort((a, b) => String(a.departureTime).localeCompare(String(b.departureTime)));
      const base = _newSetLabel(g);
      toCreate.push({
        label: set.patternLabel ? `${base} (${set.patternLabel})` : base,
        data: {
          originURN: g.originURN || '',
          destinationURN: g.destinationURN || '',
          // The stop place names the provider gave (#733): the place lookup
          // offers Test Data's stop places by name when the provider has no
          // GET /places.
          originName: g.originName || '',
          destinationName: g.destName || '',
          operatorCode: g.operatorCode || '',
          productCategoryRef: g.productCategoryRef || '',
          productCategoryName: g.productCategoryName || '',
          productCategoryShortName: g.productCategoryShortName || '',
          daysOfWeek: set.daysOfWeek.slice(),
          services,
          ticketTypes: [],
          travelClasses:  catTravel.slice(),
          serviceClasses: catService.slice(),
          accommodations: [],
          ancillaries:    catAnc.slice(),
          fulfillmentTypes: [], fulfillmentMedia: []
        }
      });
      servicesAdded += services.length;
      continue;
    }

    // Existing set with the SAME route + calendar — merge non-destructively.
    const data = structuredClone(existingRes.data || {});
    if (!Array.isArray(data.services)) data.services = [];
    const seen = new Set(data.services.map(serviceKey));
    let addedHere = 0;
    for (const svc of set.services) {
      const k = serviceKey(svc);
      if (seen.has(k)) continue;
      data.services.push(svc);
      seen.add(k);
      addedHere++;
    }
    // Calendar is part of the match key; only set it if the existing set had none.
    const calendarFilled = (!Array.isArray(data.daysOfWeek) || data.daysOfWeek.length === 0) && set.daysOfWeek.length > 0;
    if (calendarFilled) data.daysOfWeek = set.daysOfWeek.slice();
    // Fill descriptive fields only when currently empty (preserve manual edits).
    if (!data.operatorCode && g.operatorCode) data.operatorCode = g.operatorCode;
    if (!data.productCategoryName && g.productCategoryName) data.productCategoryName = g.productCategoryName;
    if (!data.productCategoryShortName && g.productCategoryShortName) data.productCategoryShortName = g.productCategoryShortName;
    if (!data.originName && g.originName) data.originName = g.originName;
    if (!data.destinationName && g.destName) data.destinationName = g.destName;

    // Prefill Service Configuration from the offer catalog, but ONLY into arrays
    // that are currently empty — a set the tester has already configured is
    // never re-seeded (and a class they removed is never re-added).
    let catalogFilled = false;
    const fillEmpty = (field, vals) => {
      if (vals.length && (!Array.isArray(data[field]) || data[field].length === 0)) {
        data[field] = vals.slice();
        catalogFilled = true;
      }
    };
    fillEmpty('travelClasses', catTravel);
    fillEmpty('serviceClasses', catService);
    fillEmpty('ancillaries', catAnc);

    if (addedHere > 0 || catalogFilled || calendarFilled) {
      toUpdate.push({ id: existingRes.id, label: existingRes.label, data });
      servicesAdded += addedHere;
    }
  }

  return {
    toCreate,
    toUpdate,
    summary: {
      routesDiscovered: groups.size,
      setsDiscovered: desired.length,
      servicesDiscovered,
      created: toCreate.length,
      updated: toUpdate.length,
      servicesAdded
    }
  };
}

// ── Filling a missing calendar (#717) ─────────────────────────────────────
// A train set with no operating days learns them from the provider: the days
// on which every one of its services was seen over the days searched.

// "09:10" of "09:10:00+02:00" / "2026-10-19T09:10:00"; '' when none.
function _clock(value) {
  const m = /(\d{2}):(\d{2})/.exec(String(value || ''));
  return m ? `${m[1]}:${m[2]}` : '';
}

// A harvested record is a run of `svc` on the set's route: same train number
// when both have one, else the same departure time.
function _sameService(rec, svc) {
  const a = String(rec.vehicleNumber || '').trim();
  const b = String(svc.vehicleNumber || '').trim();
  if (a && b) return a === b;
  return Boolean(_clock(svc.departureTime)) && _clock(rec.departureTime) === _clock(svc.departureTime);
}

/**
 * The operating days of a train set (`data`, its route and services) from the
 * records of a search of its route. { daysOfWeek } when every service was seen
 * and they share days; else { reason } in words, nothing guessed.
 */
function calendarFromHarvest(data, harvested) {
  const services = Array.isArray(data?.services) ? data.services.filter(Boolean) : [];
  if (services.length === 0) return { reason: 'it has no service' };
  const onRoute = (harvested || []).filter(r => r.originURN === data.originURN && r.destinationURN === data.destinationURN && r.dayOfWeek);
  const unseen = [];
  let days = null;
  for (const svc of services) {
    const seen = [...new Set(onRoute.filter(r => _sameService(r, svc)).map(r => r.dayOfWeek))];
    if (seen.length === 0) { unseen.push(svc.vehicleNumber || _clock(svc.departureTime) || '?'); continue; }
    days = days === null ? seen : days.filter(d => seen.includes(d));
  }
  if (unseen.length) return { reason: `the provider did not offer ${unseen.join(', ')} on the days searched` };
  if (days.length === 0) return { reason: 'its services run on different days: Discover timetable splits them into sets' };
  return { daysOfWeek: sortDays(days) };
}

// ── Each service against the provider's answers (#787) ────────────────────
// The offer probe searches a route, so it shows the route sells; it says
// nothing of a train number or a time typed wrong. These compare each service
// of a set with the direct trains of its route the provider answered.

const DAY_NAMES = { MON: 'Mon', TUE: 'Tue', WED: 'Wed', THU: 'Thu', FRI: 'Fri', SAT: 'Sat', SUN: 'Sun' };
const MAX_SERVICE_FINDINGS = 8;

// A train number with its punctuation and case taken out: OSDM-104 = osdm_104.
const _bareNumber = (v) => String(v || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();

function _serviceName(svc) {
  const clock = _clock(svc.departureTime);
  if (svc.vehicleNumber) return clock ? `Train ${svc.vehicleNumber} (${clock})` : `Train ${svc.vehicleNumber}`;
  return `The train at ${clock || '?'}`;
}

// What is wrong with one service the answers do not show by its number.
function _unseenFinding(svc, onRoute, probedDays) {
  const name = _serviceName(svc);
  const bare = _bareNumber(svc.vehicleNumber);
  const like = bare ? onRoute.find((r) => _bareNumber(r.vehicleNumber) === bare) : null;
  if (like) return `${name}: the provider names it ${like.vehicleNumber}; a scenario naming ${svc.vehicleNumber} gets no offer`;
  const clock = _clock(svc.departureTime);
  const atTime = clock ? onRoute.find((r) => _clock(r.departureTime) === clock && r.vehicleNumber) : null;
  if (atTime) return `${name}: not found; the provider's train at ${clock} is ${atTime.vehicleNumber}`;
  return `${name}: not found in the provider's answers on ${probedDays.map((d) => d.date).join(', ')}`;
}

// The times and days of one service the answers show by its number.
function _seenFindings(svc, seen, data, probedDays) {
  const out = [];
  const name = _serviceName(svc);
  const dep = _clock(svc.departureTime);
  const arr = _clock(svc.arrivalTime);
  if (dep && !seen.some((r) => _clock(r.departureTime) === dep)) out.push(`${name}: leaves at ${_clock(seen[0].departureTime)} at the provider`);
  if (arr && !seen.some((r) => _clock(r.arrivalTime) === arr)) out.push(`${name}: arrives at ${_clock(seen[0].arrivalTime)} at the provider, ${arr} here`);
  const runs = Array.isArray(data.daysOfWeek) && data.daysOfWeek.length ? data.daysOfWeek : null;
  if (!runs) return out;
  const seenDays = new Set(seen.map((r) => r.dayOfWeek));
  const missing = probedDays.filter((d) => runs.includes(d.dayOfWeek) && !seenDays.has(d.dayOfWeek));
  if (missing.length) out.push(`${name}: not offered on ${missing.map((d) => `${DAY_NAMES[d.dayOfWeek] || d.dayOfWeek} ${d.date}`).join(', ')}, a day the set says it runs`);
  const extra = probedDays.filter((d) => !runs.includes(d.dayOfWeek) && seenDays.has(d.dayOfWeek));
  if (extra.length) out.push(`${name}: offered on ${extra.map((d) => `${DAY_NAMES[d.dayOfWeek] || d.dayOfWeek} ${d.date}`).join(', ')}, a day the set does not list`);
  return out;
}

/**
 * #787: each service of a train set (`data`) against the records the probe
 * harvested on its route (`harvestTrips`) and the days that got an answer
 * (`probedDays`: [{ date, dayOfWeek }]). Findings in words: a train number the
 * provider does not know (and the one it uses), a time or a day that differs,
 * a product category or operator the provider names otherwise. [] when every
 * service is found as stored, or nothing was probed.
 */
function serviceFindings(data, records, probedDays) {
  const services = Array.isArray(data?.services) ? data.services.filter(Boolean) : [];
  const days = Array.isArray(probedDays) ? probedDays : [];
  if (!services.length || !days.length) return [];
  const onRoute = (records || []).filter((r) => r.originURN === data.originURN && r.destinationURN === data.destinationURN);
  const out = [];
  const seenAll = [];
  for (const svc of services) {
    const seen = onRoute.filter((r) => _sameService(r, svc));
    if (!seen.length) { out.push(_unseenFinding(svc, onRoute, days)); continue; }
    seenAll.push(...seen);
    out.push(..._seenFindings(svc, seen, data, days));
  }
  const otherOf = (key, own) => (own ? [...new Set(seenAll.map((r) => r[key]).filter((v) => v && v !== own))] : []);
  const categories = otherOf('productCategoryRef', data.productCategoryRef);
  if (categories.length) out.push(`Product category: the provider names ${categories.join(', ')}, the set ${data.productCategoryRef}`);
  const operators = otherOf('operatorCode', data.operatorCode);
  if (operators.length) out.push(`Operator: the provider names ${operators.join(', ')}, the set ${data.operatorCode}`);
  if (out.length <= MAX_SERVICE_FINDINGS) return out;
  return [...out.slice(0, MAX_SERVICE_FINDINGS), `… and ${out.length - MAX_SERVICE_FINDINGS} more`];
}

/** #787: the services of a set no answer showed by its number, for a search at their own time. */
function servicesUnseen(data, records) {
  const services = Array.isArray(data?.services) ? data.services.filter(Boolean) : [];
  const onRoute = (records || []).filter((r) => r.originURN === data.originURN && r.destinationURN === data.destinationURN);
  return services.filter((svc) => _clock(svc.departureTime) && !onRoute.some((r) => _sameService(r, svc)));
}

module.exports = {
  serviceFindings,
  servicesUnseen,
  classifyOfferProbe,
  summarizeOfferProbe,
  dayOfWeekCode,
  timePartOf,
  searchDates,
  harvestTrips,
  harvestConnections,
  journeysFromConnections,
  calendarFromHarvest,
  harvestOfferCatalog,
  routeKey,
  serviceKey,
  groupAndMerge,
};
