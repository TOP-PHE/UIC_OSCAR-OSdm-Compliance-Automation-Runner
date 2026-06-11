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
  opts = opts || {};
  const searchedOrigin = opts.searchedOrigin || '';
  const searchedDestination = opts.searchedDestination || '';
  const out = [];
  const trips = (resp && Array.isArray(resp.trips)) ? resp.trips : [];
  for (const trip of trips) {
    const legs = (trip && Array.isArray(trip.legs)) ? trip.legs : [];
    const timed = legs.map(l => l && l.timedLeg).filter(Boolean);
    timed.forEach((tl, idx) => {
      const svc = tl.service || {};
      const pc = svc.productCategory || {};
      const veh = Array.isArray(svc.vehicleNumbers) ? svc.vehicleNumbers.filter(Boolean) : [];
      const carrier = (Array.isArray(svc.carriers) && svc.carriers.length) ? svc.carriers[0] : null;
      const start = tl.start || {};
      const end = tl.end || {};
      const dep = start.serviceDeparture && start.serviceDeparture.timetabledTime;
      const arr = end.serviceArrival && end.serviceArrival.timetabledTime;
      let originURN = _stopRef(start);
      let destinationURN = _stopRef(end);
      // Substitute the searched O&D at the route endpoints (first/last leg).
      if (searchedOrigin && idx === 0) originURN = searchedOrigin;
      if (searchedDestination && idx === timed.length - 1) destinationURN = searchedDestination;
      out.push({
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
      });
    });
  }
  return out;
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
        const v = (typeof a.type === 'string' && a.type) ? a.type
          : (typeof a.category === 'string' ? a.category : '');
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

// #365: classify ONE offers response for route-level availability findings -
// did an anonymous-adult search actually yield offers, and of what shape?
// Returns null for a trips-collection response (no offers[] member at all).
function classifyOfferProbe(resp) {
  if (!resp || typeof resp !== 'object' || !Array.isArray(resp.offers)) return null;
  const trips = Array.isArray(resp.trips) ? resp.trips.length : 0;
  if (resp.offers.length === 0) {
    const echo = []
      .concat(Array.isArray(resp.warnings) ? resp.warnings : [], Array.isArray(resp.problems) ? resp.problems : [])
      .map(w => w && (w.code || w.title)).filter(Boolean).slice(0, 3);
    return {
      offers: 0, trips, classes: [], flexibilities: [],
      finding: trips > 0
        ? ('trip(s) found but offers[] empty' + (echo.length ? ' (provider says: ' + echo.join('; ') + ')' : ', no warning/problem explains why'))
        : 'no trip and no offer on this date'
    };
  }
  const classes = new Set(); const flex = new Set();
  for (const o of resp.offers) {
    const tc = o.travelClass || (o.offerSummary && o.offerSummary.overallTravelClass);
    if (typeof tc === 'string' && tc) classes.add(tc.toUpperCase());
    const fl = (o.offerSummary && o.offerSummary.overallFlexibility) || o.flexibility;
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
    if (!r || r.resource_type !== 'TRAIN') continue;
    const d = r.data || {};
    const cal = sortDays(Array.isArray(d.daysOfWeek) ? d.daysOfWeek : []).join(',');
    const k = `${d.originURN || ''}|${d.destinationURN || ''}|${d.productCategoryRef || ''}|${cal}`;
    if (!existingByKey.has(k)) existingByKey.set(k, r);
  }

  // 4. Reconcile each desired set against the matching existing set.
  const toCreate = [];
  const toUpdate = [];
  let servicesAdded = 0;

  for (const set of desired) {
    const g = set.g;
    const dkey = `${g.originURN || ''}|${g.destinationURN || ''}|${g.productCategoryRef || ''}|${set.daysOfWeek.join(',')}`;
    const existingRes = existingByKey.get(dkey);

    if (!existingRes) {
      const services = set.services.slice().sort((a, b) => String(a.departureTime).localeCompare(String(b.departureTime)));
      const base = _newSetLabel(g);
      toCreate.push({
        label: set.patternLabel ? `${base} (${set.patternLabel})` : base,
        data: {
          originURN: g.originURN || '',
          destinationURN: g.destinationURN || '',
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
    const data = JSON.parse(JSON.stringify(existingRes.data || {}));
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
    if (!Array.isArray(data.daysOfWeek) || data.daysOfWeek.length === 0) data.daysOfWeek = set.daysOfWeek.slice();
    // Fill descriptive fields only when currently empty (preserve manual edits).
    if (!data.operatorCode && g.operatorCode) data.operatorCode = g.operatorCode;
    if (!data.productCategoryName && g.productCategoryName) data.productCategoryName = g.productCategoryName;
    if (!data.productCategoryShortName && g.productCategoryShortName) data.productCategoryShortName = g.productCategoryShortName;

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

    if (addedHere > 0 || catalogFilled) {
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

module.exports = {
  classifyOfferProbe,
  dayOfWeekCode,
  timePartOf,
  searchDates,
  harvestTrips,
  harvestOfferCatalog,
  routeKey,
  serviceKey,
  groupAndMerge,
};
