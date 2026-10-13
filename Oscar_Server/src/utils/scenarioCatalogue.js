// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * scenarioCatalogue.js — the scenario catalogue (#612): reference scenarios a
 * company can pick and copy. Pure: plain objects in, plain objects out; the
 * route reads the two files.
 *
 * The catalogue file (Bruno_Collection/data_base/scenario_catalogue.json)
 * lists reference scenarios by a generic code. Each names the scenario of the
 * simulator's data file it is made from (`source`), so that the catalogue
 * holds no scenario data of its own: one copy, proven by the replay on the
 * simulator (#611), with the number of checks it gave there (`checks`).
 * `set` overrides a few fields for a real provider (a longer wait), and
 * `purpose` says what it tests.
 *
 * From the two files, catalogueDatafile() makes a data file: the reference
 * scenarios under their catalogue codes, and every list entry they use. It is
 * the source of the ordinary scenario copy (utils/scenarioCopy.js), which
 * re-maps trips onto the company's Test Data and gives every entry a fresh id.
 *
 * requirementsOf() says what a reference scenario needs the Test Framework to
 * declare (sales flow, return model, OSDM version, passenger types), and
 * missingFor() which of those a framework does not: the golden rule (#218).
 *
 * #681: each entry also says what it needs from the provider's data
 * (`needs`): the trip, the reservations its trains carry, the tariff, the
 * passengers, the values only the provider can give. dataNeedsOf() works
 * them out from the source scenario and the simulator's profile, and a test
 * keeps the file equal to it; the copy will use them to pick a provider's
 * train and tariff, and needsText() says them to the person copying.
 */

const { scenarioReturnModel } = require('./frameworkGating');

const arr = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => structuredClone(v);
const ARMED = new Set(['on', 'true', 'yes', true]);
const LISTS = [
  ['tripRequirementId', 'tripRequirements'],
  ['passengersListId', 'passengersList'],
  ['purchaserListId', 'purchaserList'],
  ['offerSearchCriteriaListId', 'offerSearchCriteriaList'],
  ['requestedFulfillmentOptionsListId', 'requestedFulfillmentOptionsList'],
];
const CODE = /^(OTST|NHF)_[A-Z0-9_]{3,60}$/;
// Fields of a scenario that `set` may change: waits and nothing that points
// at another entry or changes what the scenario is.
const SETTABLE = /^[a-z][A-Za-z]*MaxWaitMinutes$/;
// #699: an entry that tests the provider's passenger limit: its passengers
// become the Test Framework's maxPassengers (MAX_PASSENGERS) or one more
// (OVER_MAX_PASSENGERS) at copy time.
const LIMITS = ['MAX_PASSENGERS', 'OVER_MAX_PASSENGERS'];
// The keys of `needs` (#681), in the order dataNeedsOf() writes them.
const NEEDS_KEYS = ['trip', 'legs', 'return', 'reservations', 'legClasses', 'tariff', 'passengers',
  'reductionCards', 'providerValues', 'requestedInformation', 'expiry'];

// The problems of one entry of the catalogue.
function entryProblems(e, at, scenarios, codes) {
  if (!isObj(e)) return [`${at} is not an object`];
  const problems = [];
  if (typeof e.code !== 'string' || !CODE.test(e.code)) problems.push(`${at}.code "${e.code}" is not OTST_… or NHF_… in capitals`);
  if (codes.has(e.code)) problems.push(`${at}.code "${e.code}" appears twice`);
  if (!scenarios.has(e.source)) problems.push(`${at}.source "${e.source}" is not a scenario of the simulator's data file`);
  if (typeof e.purpose !== 'string' || e.purpose.length < 10) problems.push(`${at}.purpose is missing`);
  if (!Number.isInteger(e.checks) || e.checks <= 0) problems.push(`${at}.checks must be the number of checks it gives on the simulator`);
  for (const key of Object.keys(e.set || {})) if (!SETTABLE.test(key)) problems.push(`${at}.set.${key} is not a field the catalogue may change`);
  if (String(e.source).startsWith('SIM_WRONG_')) problems.push(`${at}.source is a deliberately wrong scenario`);
  if (e.limit !== undefined && !LIMITS.includes(e.limit)) problems.push(`${at}.limit "${e.limit}" is not one of ${LIMITS.join(', ')}`);
  problems.push(...needsProblems(e.needs, at));
  return problems;
}

// The problems of an entry's `needs` (#681): there, and only known keys.
function needsProblems(needs, at) {
  if (!isObj(needs)) return [`${at}.needs is missing`];
  return Object.keys(needs).filter((key) => !NEEDS_KEYS.includes(key)).map((key) => `${at}.needs.${key} is not a known need`);
}

/** The problems of a catalogue against the simulator's data file; none when it is sound. */
function catalogueProblems(catalogue, simulator) {
  const problems = [];
  const entries = arr(catalogue?.entries);
  if (entries.length === 0) problems.push('the catalogue has no entry');
  const codes = new Set();
  const scenarios = new Map(arr(simulator?.scenarios).filter(isObj).map((s) => [s.code, s]));
  for (const [i, e] of entries.entries()) {
    problems.push(...entryProblems(e, `entries[${i}]`, scenarios, codes));
    if (isObj(e)) codes.add(e.code);
  }
  return problems;
}

const kindOf = (code) => (String(code).startsWith('NHF_') ? 'NHF' : 'OTST');

/** The sales flows a scenario uses, as the Test Framework names them. */
function salesFlowsOf(scenario) {
  const type = String(scenario.scenarioType || 'SALE').toUpperCase();
  const flows = ['SALE'];
  if (type === 'SALE') return flows;
  const partial = ['partialRefundByLeg', 'partialRefundByPax', 'partialRefundByFulfillment'].some((f) => ARMED.has(scenario[f]));
  flows.push(type === 'REFUND' && partial ? 'REFUND_PARTIAL' : `${type}_FULL`);
  // #700: the exchange of a refunded ticket is asked of a provider that exchanges.
  if (ARMED.has(scenario.exchangeRefundedProbe) && !flows.includes('EXCHANGE_FULL')) flows.push('EXCHANGE_FULL');
  return flows;
}

const versionAtLeast = (version, major, minor) => {
  const [a, b] = String(version || '').split('.').map((n) => Number.parseInt(n, 10));
  return Number.isInteger(a) && Number.isInteger(b) && (a > major || (a === major && b >= minor));
};

/** What a reference scenario needs the Test Framework to declare. */
function requirementsOf(scenario, datafile) {
  const list = arr(datafile.passengersList).find((l) => isObj(l) && l.id === scenario.passengersListId);
  const types = [...new Set(arr(list?.passengers).map((p) => p?.type).filter((t) => typeof t === 'string' && t !== 'PERSON'))];
  const model = scenarioReturnModel(scenario);
  return {
    salesFlows: salesFlowsOf(scenario),
    returnModel: model,
    minOsdmVersion: model === 'COMBINED' ? '3.7' : null,
    passengerTypes: types,
  };
}

/** The declarations a framework lacks for these requirements, as sentences. */
function missingFor(requirements, framework) {
  let fw = isObj(framework) ? framework : {};
  if (isObj(framework?.config)) fw = framework.config;
  const missing = [];
  const flows = arr(fw.salesFlows);
  for (const flow of requirements.salesFlows) if (!flows.includes(flow)) missing.push(`sales flow ${flow}`);
  if (requirements.returnModel && Array.isArray(fw.returnModels) && !fw.returnModels.includes(requirements.returnModel)) {
    missing.push(`return model ${requirements.returnModel}`);
  }
  if (requirements.minOsdmVersion && !versionAtLeast(fw.osdmVersion, 3, 7)) missing.push(`OSDM ${requirements.minOsdmVersion} or later`);
  const declared = arr(fw.passengerTypes);
  for (const type of requirements.passengerTypes) if (!declared.includes(type)) missing.push(`passenger type ${type}`);
  if (requirements.maxPassengers && !maxPassengersOf(fw)) missing.push('the maximum number of passengers (Passenger Types)');
  return missing;
}

// ─── #681: what a reference scenario needs from the provider's data ───────

/** What dataNeedsOf() reads from the simulator's profile of the source's provider. */
function simulatorFacts(profile) {
  return {
    reservations: isObj(profile?.reservations) ? profile.reservations : {},
    requestedInformationFrom: profile?.personChecks?.requestedInformationFrom || null,
  };
}

const EXPIRY_TESTS = [
  ['expiredOfferTest', 'OFFER'], ['expiredBookingTest', 'BOOKING'],
  ['expiredRefundOfferTest', 'REFUND_OFFER'], ['expiredExchangeOfferTest', 'EXCHANGE_OFFER'],
];
const NO_OVERRULE = new Set(['', 'null', 'CODE_DOES_NOT_EXIST']);

// The tariff a scenario needs: one that can be refunded or exchanged for an
// after-sale, the non-flexible one when the sale asks for it. An overrule
// code refunds whatever the tariff, so it needs none.
function tariffNeed(scenario, overrule) {
  const type = String(scenario.scenarioType || 'SALE').toUpperCase();
  if (type === 'REFUND') return overrule ? null : 'REFUNDABLE';
  if (type === 'EXCHANGE') return 'EXCHANGEABLE';
  return scenario.desiredFlexibility === 'NON_FLEXIBLE' ? 'NON_FLEXIBLE' : null;
}

// The reservation a scenario exercises: an optional one when it says how to
// book it (reservationBookingForm), else a mandatory one when its trip has
// it. A reservation the trip merely carries is not a need.
function reservationNeed(scenario, kinds) {
  if (scenario.reservationBookingForm) return kinds.has('OPTIONAL') ? ['OPTIONAL'] : [];
  return kinds.has('MANDATORY') ? ['MANDATORY'] : [];
}

/**
 * What a scenario needs from the provider's data, worked out from the
 * scenario, the data file it lives in and the facts of the simulator that
 * answers it (simulatorFacts). Only the needs that apply are written.
 */
function dataNeedsOf(scenario, datafile, facts) {
  const trip = arr(datafile.tripRequirements).find((t) => isObj(t) && t.id === scenario.tripRequirementId) || {};
  const legs = arr(trip.legs).filter(isObj);
  const stops = [trip.trip?.origin, trip.trip?.destination, ...legs.flatMap((l) => [l.origin, l.destination])];
  const passengers = arr(arr(datafile.passengersList).find((l) => isObj(l) && l.id === scenario.passengersListId)?.passengers);
  const kinds = new Set(legs.map((l) => facts.reservations[l.productCategoryShortName]).filter(Boolean));
  const overrule = typeof scenario.overruleCode === 'string' && !NO_OVERRULE.has(scenario.overruleCode) ? scenario.overruleCode : null;
  const providerValues = [
    ...(overrule ? ['overruleCode'] : []),
    ...(scenario.expectedProduct ? ['expectedProduct'] : []),
  ];
  const needs = {
    trip: trip.tripType === 'SPECIFICATION' ? 'SPECIFICATION' : 'SEARCH',
    legs: legs.length > 1 ? legs.length : null,
    return: scenarioReturnModel(scenario),
    reservations: reservationNeed(scenario, kinds),
    legClasses: arr(scenario.legTravelClasses).length ? [...scenario.legTravelClasses] : null,
    tariff: tariffNeed(scenario, overrule),
    passengers: passengers.length,
    reductionCards: passengers.some((p) => arr(p?.reductionCards).length > 0),
    providerValues,
    requestedInformation: Boolean(scenario.requestedInformationProbe)
      || (facts.requestedInformationFrom !== null && stops.includes(facts.requestedInformationFrom)),
    expiry: EXPIRY_TESTS.filter(([flag]) => ARMED.has(scenario[flag])).map(([, name]) => name),
  };
  const out = {};
  for (const key of NEEDS_KEYS) {
    const v = needs[key];
    if (v === null || v === false || (Array.isArray(v) && v.length === 0)) continue;
    out[key] = v;
  }
  return out;
}

const TARIFF_TEXT = { REFUNDABLE: 'a refundable tariff', EXCHANGEABLE: 'an exchangeable tariff', NON_FLEXIBLE: 'a non-flexible tariff' };
const RETURN_TEXT = { COMBINED: 'one offer for both directions', SEPARATE: 'one offer per direction' };

// The phrase of each need, in the order of NEEDS_KEYS; null when it says nothing.
const NEED_PHRASES = {
  legs: (v) => `a journey of ${v} legs`,
  return: (v) => `a return (${RETURN_TEXT[v] || v})`,
  reservations: (v) => v.map((kind) => `a train with ${kind === 'MANDATORY' ? 'a mandatory' : 'an optional'} seat reservation`),
  legClasses: (v) => `travel classes per leg: ${v.join(', ')}`,
  tariff: (v) => TARIFF_TEXT[v] || `tariff ${v}`,
  passengers: (v) => `${v} passenger${v > 1 ? 's' : ''}`,
  reductionCards: () => 'a reduction card the provider accepts',
  providerValues: (v) => v.map((field) => `the provider's own ${field}`),
  requestedInformation: () => 'a trip where the provider asks for passenger details',
  expiry: (v) => (v.length ? `waits for the provider's deadline: ${v.join(', ').toLowerCase().replaceAll('_', ' ')}` : null),
};

/** The needs of an entry, as short phrases for the person copying it. */
function needsText(needs) {
  const n = isObj(needs) ? needs : {};
  return NEEDS_KEYS.filter((key) => NEED_PHRASES[key] && n[key]).flatMap((key) => NEED_PHRASES[key](n[key])).filter(Boolean);
}

/**
 * The data file the catalogue makes: its reference scenarios, under their
 * catalogue codes, and the list entries they use. Throws when the catalogue
 * is not sound.
 */
function catalogueDatafile(catalogue, simulator) {
  const problems = catalogueProblems(catalogue, simulator);
  if (problems.length) throw new Error(`The scenario catalogue is not valid: ${problems.join('; ')}`);
  const out = { scenarios: [] };
  for (const [, list] of LISTS) out[list] = [];
  for (const entry of catalogue.entries) {
    const source = simulator.scenarios.find((s) => isObj(s) && s.code === entry.source);
    const scenario = { ...clone(source), ...clone(entry.set || {}), code: entry.code, description: entry.purpose, shared: true };
    delete scenario.created_by;
    out.scenarios.push(scenario);
    for (const [field, list] of LISTS) {
      const item = arr(simulator[list]).find((e) => isObj(e) && e.id === scenario[field]);
      if (item && !out[list].some((e) => e.id === item.id)) out[list].push(clone(item));
    }
  }
  return out;
}

/** #699: the maximum number of passengers a framework declares, or null. */
function maxPassengersOf(framework) {
  const fw = isObj(framework?.config) ? framework.config : framework;
  const n = fw?.maxPassengers;
  return Number.isInteger(n) && n >= 1 && n <= 999 ? n : null;
}

// #699: the needs of a limit entry say the framework's number, not the simulator's.
function limitNeedsText(needs, limit) {
  const text = needsText({ ...needs, passengers: undefined });
  const count = limit === 'OVER_MAX_PASSENGERS' ? 'one passenger more than the maximum' : 'the maximum number of passengers';
  return [`${count} the Test Framework declares`, ...text];
}

/** The catalogue as a company sees it: each entry, what it needs, what is missing. */
function catalogueFor(catalogue, simulator, framework) {
  const datafile = catalogueDatafile(catalogue, simulator);
  return catalogue.entries.map((entry) => {
    const scenario = datafile.scenarios.find((s) => s.code === entry.code);
    const requirements = requirementsOf(scenario, datafile);
    if (entry.limit) requirements.maxPassengers = true;
    return {
      code: entry.code,
      kind: kindOf(entry.code),
      area: String(scenario.scenarioType || 'SALE').toLowerCase(),
      purpose: entry.purpose,
      checks: entry.checks,
      requirements,
      missing: missingFor(requirements, framework),
      needs: entry.needs,
      needsText: entry.limit ? limitNeedsText(entry.needs, entry.limit) : needsText(entry.needs),
      ...(entry.limit ? { limit: entry.limit } : {}),
    };
  });
}

module.exports = {
  catalogueProblems, catalogueDatafile, catalogueFor, requirementsOf, missingFor, salesFlowsOf,
  dataNeedsOf, needsText, simulatorFacts, maxPassengersOf, NEEDS_KEYS, LIMITS,
};
