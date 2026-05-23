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
 * @param {object} resp  parsed TripCollectionResponse ({ trips: [...] })
 * @returns {Array<object>} one record per timed leg:
 *   { originURN, destinationURN, originName, destName, operatorCode,
 *     productCategoryRef, productCategoryName, productCategoryShortName,
 *     vehicleNumber, departureTime, arrivalTime, dayOfWeek }
 */
function harvestTrips(resp) {
  const out = [];
  const trips = (resp && Array.isArray(resp.trips)) ? resp.trips : [];
  for (const trip of trips) {
    const legs = (trip && Array.isArray(trip.legs)) ? trip.legs : [];
    for (const leg of legs) {
      const tl = leg && leg.timedLeg;
      if (!tl) continue;   // skip transfer / walk / continuous legs
      const svc = tl.service || {};
      const pc = svc.productCategory || {};
      const veh = Array.isArray(svc.vehicleNumbers) ? svc.vehicleNumbers.filter(Boolean) : [];
      const carrier = (Array.isArray(svc.carriers) && svc.carriers.length) ? svc.carriers[0] : null;
      const start = tl.start || {};
      const end = tl.end || {};
      const dep = start.serviceDeparture && start.serviceDeparture.timetabledTime;
      const arr = end.serviceArrival && end.serviceArrival.timetabledTime;
      out.push({
        originURN:      _stopRef(start),
        destinationURN: _stopRef(end),
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
    }
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

// Recursively collect every string value stored under `key` anywhere in a
// (possibly deeply nested) offer object. Depth-guarded. Used to harvest
// travelClass / serviceClass without depending on the exact offer-part path,
// which varies across vendors and OSDM versions.
function _collectStrings(node, key, out, depth) {
  if (depth > 8 || node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const x of node) _collectStrings(x, key, out, depth + 1);
    return;
  }
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (k === key && typeof v === 'string' && v) out.add(v);
    else _collectStrings(v, key, out, depth + 1);
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
    _collectStrings(o, 'travelClass', tc, 0);
    _collectStrings(o, 'serviceClass', sc, 0);
    _collectAncillaries(o, anc, 0);
  }
  return { travelClasses: [...tc], serviceClasses: [...sc], ancillaries: [...anc] };
}

/**
 * Group harvested service records into desired train sets, then reconcile
 * against the company's existing TRAIN resources.
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
  // 1. Collapse harvested records into per-route groups.
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
        services: new Map(),   // serviceKey -> { vehicleNumber, departureTime, arrivalTime }
        days: new Set()
      };
      groups.set(key, g);
    }
    // First non-empty wins for descriptive fields.
    if (!g.operatorCode && rec.operatorCode) g.operatorCode = rec.operatorCode;
    if (!g.productCategoryName && rec.productCategoryName) g.productCategoryName = rec.productCategoryName;
    if (!g.productCategoryShortName && rec.productCategoryShortName) g.productCategoryShortName = rec.productCategoryShortName;
    if (!g.originName && rec.originName) g.originName = rec.originName;
    if (!g.destName && rec.destName) g.destName = rec.destName;
    if (rec.dayOfWeek) g.days.add(rec.dayOfWeek);
    const svc = {
      vehicleNumber: rec.vehicleNumber || '',
      departureTime: rec.departureTime || '',
      arrivalTime:   rec.arrivalTime || ''
    };
    g.services.set(serviceKey(svc), svc);
  }

  // 2. Index existing TRAIN resources by route key (first wins on collision).
  const existingByKey = new Map();
  for (const r of (existing || [])) {
    if (!r || r.resource_type !== 'TRAIN') continue;
    const d = r.data || {};
    const k = `${d.originURN || ''}|${d.destinationURN || ''}|${d.productCategoryRef || ''}`;
    if (!existingByKey.has(k)) existingByKey.set(k, r);
  }

  // 3. Reconcile.
  const toCreate = [];
  const toUpdate = [];
  let servicesAdded = 0;
  let servicesDiscovered = 0;

  for (const [key, g] of groups) {
    const discovered = [...g.services.values()];
    servicesDiscovered += discovered.length;
    const existingRes = existingByKey.get(key);

    if (!existingRes) {
      // New set — sort services by departure for readability.
      const services = discovered.slice().sort((a, b) => String(a.departureTime).localeCompare(String(b.departureTime)));
      toCreate.push({
        label: _newSetLabel(g),
        data: {
          originURN: g.originURN || '',
          destinationURN: g.destinationURN || '',
          operatorCode: g.operatorCode || '',
          productCategoryRef: g.productCategoryRef || '',
          productCategoryName: g.productCategoryName || '',
          productCategoryShortName: g.productCategoryShortName || '',
          daysOfWeek: sortDays([...g.days]),
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

    // Existing set — merge non-destructively into a clone of its data.
    const data = JSON.parse(JSON.stringify(existingRes.data || {}));
    if (!Array.isArray(data.services)) data.services = [];
    const seen = new Set(data.services.map(serviceKey));
    let addedHere = 0;
    for (const svc of discovered) {
      const k = serviceKey(svc);
      if (seen.has(k)) continue;
      data.services.push(svc);
      seen.add(k);
      addedHere++;
    }
    // Union the operating-days calendar.
    const beforeDays = Array.isArray(data.daysOfWeek) ? data.daysOfWeek : [];
    const mergedDays = sortDays([...beforeDays, ...g.days]);
    const daysChanged = mergedDays.length !== beforeDays.length;
    data.daysOfWeek = mergedDays;
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

    if (addedHere > 0 || daysChanged || catalogFilled) {
      toUpdate.push({ id: existingRes.id, label: existingRes.label, data });
      servicesAdded += addedHere;
    }
  }

  return {
    toCreate,
    toUpdate,
    summary: {
      routesDiscovered: groups.size,
      servicesDiscovered,
      created: toCreate.length,
      updated: toUpdate.length,
      servicesAdded
    }
  };
}

module.exports = {
  dayOfWeekCode,
  timePartOf,
  searchDates,
  harvestTrips,
  harvestOfferCatalog,
  routeKey,
  serviceKey,
  groupAndMerge,
};
