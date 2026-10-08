// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * scenarioCopy.js — copying scenarios from one company or provider to another
 * (#540). Pure: plain objects in, plain objects out; the route reads and
 * writes the files.
 *
 * A scenario is flags plus references to entries of the datafile's lists.
 * On copy:
 *   - flags (type, action, sales flow, flexibility, expiry tests...) are
 *     copied as they are;
 *   - passengers, purchaser, offer criteria and fulfillment entries are
 *     copied to fresh ids; scenarios of one copy that shared an entry in the
 *     source share its copy. An entry already in the target is never reused:
 *     it may belong to other people's scenarios, some hidden from a tester;
 *   - the trip is re-pointed to the target's Test Data: each source trip entry
 *     is mapped once, to a train (and service) or a journey, and rebuilt with
 *     the editor's own "Apply test data" code (public/js/trip-apply.js);
 *   - fulfillment options keep what the target's Test Framework declares, and
 *     osdmVersion is the target framework's;
 *   - features the target framework does not declare are reported before the
 *     copy (frameworkGating.scenarioWarnings);
 *   - nothing else crosses: no endpoint, credentials, known deviations,
 *     findings, systemInfoParameters or run lists.
 * A copied scenario belongs to whoever copies it (created_by, not shared), and
 * takes the next free code when its code is already used in the target.
 */

const { scenarioWarnings } = require('./frameworkGating');
const TripApply = require('../../public/js/trip-apply');
const { idAllocator } = require('./datafileOwnership');

const arr = v => (Array.isArray(v) ? v : []);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = v => JSON.parse(JSON.stringify(v));

// [scenario field, list] copied entry by entry. Trips and fulfillment have
// their own rules below.
const COPIED_LISTS = Object.freeze([
  ['passengersListId', 'passengersList'],
  ['purchaserListId', 'purchaserList'],
  ['offerSearchCriteriaListId', 'offerSearchCriteriaList'],
]);

/** The framework config as stored (legacy rows nest it under `config`). */
function frameworkOf(config) {
  if (isObj(config) && isObj(config.config)) return config.config;
  return isObj(config) ? config : {};
}

const findById = (list, id) => arr(list).find(e => isObj(e) && e.id === id) || null;

/** What a trip entry looks like, for the person choosing its target train. */
function tripSummary(entry) {
  const legs = arr(entry.legs).filter(isObj);
  const spec = entry.tripType === 'SPECIFICATION' && legs.length > 0;
  let first = isObj(entry.trip) ? entry.trip : {};
  if (spec) first = legs[0];
  const last = spec ? legs.at(-1) : first;
  return {
    id: entry.id,
    tripType: entry.tripType || 'SEARCH',
    legs: spec ? legs.length : 1,
    origin: first.origin || '',
    destination: last.destination || '',
    vehicleNumber: first.vehicleNumber || '',
  };
}

const needsJourney = entry => entry.tripType === 'SPECIFICATION' && arr(entry.legs).length > 1;

// The fulfillment options of `entry` the framework declares. An empty
// declaration list means "not restricted", as fwFilter() in the editor.
function declaredOptions(entry, framework) {
  const types = arr(framework.fulfillment?.types);
  const media = arr(framework.fulfillment?.media);
  const options = arr(entry?.requestedFulfillmentOptions).filter(isObj);
  const kept = options.filter(o => (!types.length || types.includes(o.fulfillmentType))
    && (!media.length || media.includes(o.fulfillmentMedia)));
  if (kept.length) return { options: kept, changed: kept.length !== options.length };
  if (types.length && media.length) {
    return { options: [{ fulfillmentType: types[0], fulfillmentMedia: media[0] }], changed: true };
  }
  return { options, changed: false };
}

function selectScenarios(source, codes) {
  const all = arr(source.scenarios).filter(s => isObj(s) && typeof s.code === 'string' && s.code !== '');
  const wanted = new Set(arr(codes).filter(c => typeof c === 'string'));
  const selected = all.filter(s => wanted.has(s.code));
  const found = new Set(selected.map(s => s.code));
  return { selected, missing: [...wanted].filter(c => !found.has(c)) };
}

function warningsFor(sc, source, framework) {
  const out = scenarioWarnings(sc, framework).map(f =>
    `${f} is set, but the target's Test Framework does not declare it.`);
  const fulfillment = findById(source.requestedFulfillmentOptionsList, sc.requestedFulfillmentOptionsListId);
  if (fulfillment && declaredOptions(fulfillment, framework).changed) {
    out.push('Fulfillment options are reduced to what the target\'s Test Framework declares.');
  }
  if (framework.osdmVersion && sc.osdmVersion && String(framework.osdmVersion) !== String(sc.osdmVersion)) {
    out.push(`OSDM version becomes ${framework.osdmVersion} (the target's Test Framework).`);
  }
  return out;
}

/**
 * What a copy of `codes` from `source` would involve, before anything is
 * written: the scenarios with their warnings, and each trip entry to map once.
 */
function planCopy(source, codes, frameworkConfig) {
  const framework = frameworkOf(frameworkConfig);
  const { selected, missing } = selectScenarios(source, codes);
  const trips = new Map();
  for (const sc of selected) {
    const entry = findById(source.tripRequirements, sc.tripRequirementId);
    if (!entry) continue;
    if (!trips.has(entry.id)) trips.set(entry.id, { ...tripSummary(entry), needsJourney: needsJourney(entry), usedBy: [] });
    trips.get(entry.id).usedBy.push(sc.code);
  }
  return {
    scenarios: selected.map(sc => ({
      code: sc.code,
      scenarioType: sc.scenarioType || 'SALE',
      scenarioAction: sc.scenarioAction || null,
      tripRequirementId: sc.tripRequirementId,
      warnings: warningsFor(sc, source, framework),
    })),
    trips: [...trips.values()],
    missing,
  };
}

function mapToTrain(entry, out, mapping, resources) {
  if (needsJourney(entry)) return { error: 'has several legs: map it to a journey' };
  const picked = TripApply.trainService(resources, mapping.train_id, Number.parseInt(mapping.service_index, 10) || 0);
  if (!picked) return { error: 'is mapped to a train that is not in the target\'s Test Data' };
  if (out.tripType === 'SPECIFICATION' && arr(out.legs).length === 1) {
    out.legs = [TripApply.applyTrainService(isObj(out.legs[0]) ? out.legs[0] : {}, picked.d, picked.svc)];
  } else {
    out.trip = TripApply.applyTrainService(isObj(out.trip) ? out.trip : {}, picked.d, picked.svc);
  }
  return { entry: out };
}

function mapToJourney(out, mapping, resources) {
  const journey = arr(resources).find(r => String(r.id) === String(mapping.journey_id) && r.resource_type === 'JOURNEY');
  if (!journey) return { error: 'is mapped to a journey that is not in the target\'s Test Data' };
  const legs = TripApply.journeyToTripLegs(journey, resources);
  if (!legs.length) return { error: 'is mapped to a journey whose trains are not in the target\'s Test Data' };
  out.tripType = 'SPECIFICATION';
  out.legs = legs;
  return { entry: out };
}

// The rebuilt trip entry for one mapping, or { error }.
function mappedTrip(entry, mapping, resources) {
  const out = clone(entry);
  delete out.id;
  if (mapping?.type === 'train') return mapToTrain(entry, out, mapping, resources);
  if (mapping?.type === 'journey') return mapToJourney(out, mapping, resources);
  return { error: 'has no train or journey chosen' };
}

// Put `entry` (without id) in `list` under the id `allocate()` gives; returns it.
function addEntry(datafile, list, entry, allocate) {
  datafile[list] = arr(datafile[list]);
  const id = allocate();
  datafile[list].push({ id, ...entry });
  return id;
}

const withoutId = e => { const c = clone(e); delete c.id; return c; };

// The next free code among `scenarios`, as `CODE_2`, `CODE_3`… on a clash.
function codeAllocator(scenarios) {
  const taken = new Set(scenarios.filter(isObj).map(s => s.code));
  return code => {
    let candidate = code;
    for (let n = 2; taken.has(candidate); n++) candidate = `${code}_${n}`;
    taken.add(candidate);
    return candidate;
  };
}

// The target trip id for `tripEntry`, mapped once however many scenarios use
// it; null when its mapping fails (the error is recorded once).
function copiedTrip(ctx, tripEntry) {
  if (!ctx.tripIds.has(tripEntry.id)) {
    const mapping = isObj(ctx.tripMap) ? ctx.tripMap[String(tripEntry.id)] : null;
    const built = mappedTrip(tripEntry, mapping, ctx.resources);
    if (built.error) ctx.errors.push(`Trip ${tripEntry.id} ${built.error}.`);
    ctx.tripIds.set(tripEntry.id, built.error ? null : addEntry(ctx.out, 'tripRequirements', built.entry, ctx.allocate));
  }
  return ctx.tripIds.get(tripEntry.id);
}

// The target id of a copy of `sourceEntry`, made once per entry.
function copiedEntry(ctx, list, sourceEntry, build) {
  const key = `${list}:${sourceEntry.id}`;
  if (!ctx.entryIds.has(key)) ctx.entryIds.set(key, addEntry(ctx.out, list, build(withoutId(sourceEntry)), ctx.allocate));
  return ctx.entryIds.get(key);
}

// `sc` re-pointed at copies of its entries in the target, or null (errors recorded).
function copiedScenario(ctx, sc) {
  const { source, errors } = ctx;
  const tripEntry = findById(source.tripRequirements, sc.tripRequirementId);
  if (!tripEntry) { errors.push(`Scenario ${sc.code} points to a trip the source does not hold.`); return null; }
  const tripId = copiedTrip(ctx, tripEntry);
  if (tripId === null) return null;

  const copy = clone(sc);
  for (const k of Object.keys(copy)) if (k.startsWith('__')) delete copy[k];
  copy.tripRequirementId = tripId;

  for (const [field, list] of COPIED_LISTS) {
    if (copy[field] == null) continue;
    const entry = findById(source[list], sc[field]);
    if (entry) copy[field] = copiedEntry(ctx, list, entry, e => e);
    else delete copy[field];   // a dangling optional reference is not carried over
  }
  let broken = false;
  const fulfillment = findById(source.requestedFulfillmentOptionsList, sc.requestedFulfillmentOptionsListId);
  if (fulfillment) {
    copy.requestedFulfillmentOptionsListId = copiedEntry(ctx, 'requestedFulfillmentOptionsList', fulfillment,
      e => ({ ...e, requestedFulfillmentOptions: declaredOptions(fulfillment, ctx.framework).options }));
  } else {
    errors.push(`Scenario ${sc.code} points to fulfillment options the source does not hold.`);
    broken = true;
  }
  if (copy.passengersListId == null) { errors.push(`Scenario ${sc.code} points to passengers the source does not hold.`); broken = true; }
  return broken ? null : copy;
}

/**
 * Copy `codes` from `source` into `target`. `tripMap` maps each source trip
 * entry id to { type: 'train', train_id, service_index } or
 * { type: 'journey', journey_id } among `resources` (the target's Test Data).
 * Returns { datafile, copied: [{ from, to }] } or { errors: [text] }; on
 * errors nothing is changed.
 */
function applyCopy(source, target, { codes, tripMap, frameworkConfig, resources, email }) {
  const framework = frameworkOf(frameworkConfig);
  const { selected, missing } = selectScenarios(source, codes);
  const errors = missing.map(c => `Scenario ${c} is not in the source.`);
  if (!selected.length && !errors.length) errors.push('No scenario to copy.');

  const out = isObj(target) ? clone(target) : {};
  out.scenarios = arr(out.scenarios);
  const ctx = {
    source, out, tripMap, resources, framework, errors,
    // Fresh ids avoid every id and every reference in the target, dangling ones
    // included: max+1 over one list could land on another scenario's reference.
    allocate: idAllocator(out),
    tripIds: new Map(),     // source trip id -> target trip id, once per trip
    entryIds: new Map(),    // "list:source id" -> target id, once per entry
  };
  const freeCode = codeAllocator(out.scenarios);
  const copied = [];
  for (const sc of selected) {
    const copy = copiedScenario(ctx, sc);
    if (!copy) continue;
    if (framework.osdmVersion) copy.osdmVersion = String(framework.osdmVersion);
    copy.code = freeCode(sc.code);
    copy.created_by = email;
    copy.shared = false;
    out.scenarios.push(copy);
    copied.push({ from: sc.code, to: copy.code });
  }
  if (errors.length) return { errors };
  return { datafile: out, copied };
}

module.exports = { planCopy, applyCopy, frameworkOf, tripSummary };
